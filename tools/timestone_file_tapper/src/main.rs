use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const APP_DIR: &str = "data\\timestone";
const DB_NAME: &str = "timestone_events.sqlite3";
const DEFAULT_SCALE_WIDTH: u32 = 1280;
const DEFAULT_JPEG_QUALITY: u8 = 4;
const DEFAULT_POLL_MS: u64 = 1500;
const DEFAULT_GRACE_MS: i64 = 2000;
const DEFAULT_FRAME_OFFSET_MS: i64 = 200;
const DEFAULT_TRANSCRIBE_MODEL: &str = "medium";
const DEFAULT_OCR_LANG: &str = "eng";
const AUDIO_RETRY_COUNT: usize = 3;
const AUDIO_RETRY_DELAY_MS: u64 = 800;

#[derive(Default)]
struct Args {
    db_path: Option<PathBuf>,
    frames_dir: Option<PathBuf>,
    audio_dir: Option<PathBuf>,
    session_id: Option<String>,
    scale_width: u32,
    jpeg_quality: u8,
    poll_ms: u64,
    grace_ms: i64,
    frame_offset_ms: i64,
    transcribe_model: String,
    ocr_lang: String,
    event_types: Option<HashSet<String>>,
    ocr_keydown_mode: OcrKeydownMode,
    quiet_ffmpeg: bool,
    verbose: bool,
}

#[derive(Clone)]
struct RecordSegment {
    id: i64,
    session_id: Option<String>,
    start_wall_ms: i64,
    end_wall_ms: i64,
    obs_path: Option<String>,
}

#[derive(Clone)]
struct EventInfo {
    id: i64,
    ts_wall_ms: i64,
    event_type: String,
    window_key: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OcrKeydownMode {
    GroupHead,
    All,
}

impl Default for OcrKeydownMode {
    fn default() -> Self {
        OcrKeydownMode::GroupHead
    }
}

#[derive(Clone)]
struct TranscriptSegment {
    start_ms: i64,
    end_ms: i64,
    text: String,
    engine: String,
}

#[derive(Clone)]
struct ProcessingCounts {
    frames_done: i64,
    frames_total: i64,
    ocr_done: i64,
    ocr_total: i64,
    audio_done: bool,
    transcribe_done: bool,
}

fn main() -> Result<()> {
    let args = parse_args()?;
    let base_dir = ensure_app_dir()?;
    let repo_root = env::current_dir().context("Failed to read current dir")?;
    let scripts_dir = repo_root.join("tools").join("scripts");
    let db_path = args
        .db_path
        .clone()
        .unwrap_or_else(|| base_dir.join(DB_NAME));
    let frames_dir = args
        .frames_dir
        .clone()
        .unwrap_or_else(|| base_dir.join("frames").join("mkv"));
    let audio_dir = args
        .audio_dir
        .clone()
        .unwrap_or_else(|| base_dir.join("audio").join("segments"));

    fs::create_dir_all(&frames_dir).context("Failed to create frames dir")?;
    fs::create_dir_all(&audio_dir).context("Failed to create audio dir")?;

    let conn = Connection::open(&db_path).context("Failed to open timestone DB")?;
    conn.busy_timeout(Duration::from_millis(2000)).ok();
    init_db(&conn)?;

    log_line(args.verbose, "File tapper running.");

    loop {
        let segments = fetch_pending_segments(&conn, args.session_id.as_deref())?;
        if segments.is_empty() {
            std::thread::sleep(Duration::from_millis(args.poll_ms));
            continue;
        }
        for segment in segments {
            if !segment_ready(&segment, args.grace_ms) {
                continue;
            }
            let Some(obs_path) = segment.obs_path.clone() else {
                log_line(args.verbose, &format!("Segment {} missing obs_path", segment.id));
                continue;
            };
            if !Path::new(&obs_path).exists() {
                log_line(args.verbose, &format!("Segment {} path not found: {}", segment.id, obs_path));
                continue;
            }
            let offset_before_ms = segment_offset_before(&conn, &obs_path, segment.start_wall_ms)?;
            let duration_ms = segment.end_wall_ms.saturating_sub(segment.start_wall_ms);
            if duration_ms <= 0 {
                log_line(args.verbose, &format!("Segment {} has non-positive duration", segment.id));
                mark_segment_processed(&conn, segment.id)?;
                continue;
            }
            let events = fetch_events_for_segment(&conn, &segment)?;
            let keydown_heads = if args.ocr_keydown_mode == OcrKeydownMode::GroupHead {
                keydown_group_heads(&events)
            } else {
                HashSet::new()
            };
            let mut counts = ProcessingCounts {
                frames_done: 0,
                frames_total: 0,
                ocr_done: 0,
                ocr_total: 0,
                audio_done: false,
                transcribe_done: false,
            };
            let session_key = segment
                .session_id
                .clone()
                .unwrap_or_else(|| "unknown".to_string());
            for event in events {
                if !event_type_allowed(&event.event_type, &args.event_types) {
                    continue;
                }
                counts.frames_total += 1;
                if event_frames_exist(&conn, event.id)? {
                    counts.frames_done += 1;
                    continue;
                }
                let offset_ms = offset_before_ms
                    + event.ts_wall_ms.saturating_sub(segment.start_wall_ms)
                    + args.frame_offset_ms;
                if offset_ms < 0 {
                    continue;
                }
                let frame_path = frames_dir.join(format!(
                    "event_{}_{}.jpg",
                    event.id, event.ts_wall_ms
                ));
                log_line(
                    args.verbose,
                    &format!("Extracting frame for event {} @ {}ms", event.id, offset_ms),
                );
                if extract_frame(
                    &obs_path,
                    offset_ms,
                    &frame_path,
                    args.scale_width,
                    args.jpeg_quality,
                    args.verbose,
                    args.quiet_ffmpeg,
                )? {
                    insert_event_frame(&conn, event.id, &frame_path, event.ts_wall_ms)?;
                    counts.frames_done += 1;
                    if event.event_type == "key_down"
                        && (args.ocr_keydown_mode == OcrKeydownMode::All
                            || keydown_heads.contains(&event.id))
                    {
                        counts.ocr_total += 1;
                        if ocr_exists_for_frame(&conn, &frame_path)? {
                            counts.ocr_done += 1;
                        } else {
                            log_line(args.verbose, &format!("Running OCR for event {}", event.id));
                            if let Some(ocr_text) = run_ocr_script(
                                &scripts_dir,
                                &frame_path,
                                &args.ocr_lang,
                                args.verbose,
                            )? {
                                insert_event_ocr(&conn, event.id, &frame_path, &ocr_text, "tesseract")?;
                                counts.ocr_done += 1;
                                log_line(args.verbose, &format!("OCR stored for event {}", event.id));
                            }
                        }
                    }
                }
            }
            update_processing_status(
                &conn,
                &session_key,
                segment.id,
                "frames",
                &build_processing_summary(&counts),
            )?;
            let audio_path = if let Some(path) = fetch_segment_audio_path(&conn, segment.id)? {
                if path.exists() {
                    Some(path)
                } else {
                    None
                }
            } else {
                let audio_path = audio_dir.join(format!("segment_{}.wav", segment.id));
                let mut extracted: Option<PathBuf> = None;
                for attempt in 1..=AUDIO_RETRY_COUNT {
                    log_line(
                        args.verbose,
                        &format!(
                            "Extracting audio for segment {} (attempt {}/{})",
                            segment.id, attempt, AUDIO_RETRY_COUNT
                        ),
                    );
                    match extract_audio_segment(
                        &obs_path,
                        offset_before_ms,
                        duration_ms,
                        &audio_path,
                        args.verbose,
                        args.quiet_ffmpeg,
                    ) {
                        Ok(true) => {
                            insert_segment_audio(&conn, segment.id, &audio_path, offset_before_ms, duration_ms)?;
                            extracted = Some(audio_path.clone());
                            break;
                        }
                        Ok(false) => {
                            log_error(&format!("Audio extract failed for segment {} (ffmpeg status)", segment.id));
                        }
                        Err(err) => {
                            log_error(&format!("Audio extract error for segment {}: {}", segment.id, err));
                        }
                    }
                    if attempt < AUDIO_RETRY_COUNT {
                        std::thread::sleep(Duration::from_millis(AUDIO_RETRY_DELAY_MS));
                    }
                }
                if extracted.is_none() {
                    log_error(&format!(
                        "Audio extraction failed after {} attempts for segment {}. Skipping transcription.",
                        AUDIO_RETRY_COUNT, segment.id
                    ));
                }
                extracted
            };
            if let Some(audio_path) = audio_path {
                counts.audio_done = true;
                update_processing_status(
                    &conn,
                    &session_key,
                    segment.id,
                    "audio",
                    &build_processing_summary(&counts),
                )?;
                if !segment_transcriptions_exist(&conn, segment.id)? {
                    log_line(args.verbose, &format!("Transcribing audio for segment {}", segment.id));
                    let segments = run_transcribe_script(
                        &scripts_dir,
                        &audio_path,
                        &args.transcribe_model,
                        args.verbose,
                    )?;
                    if !segments.is_empty() {
                        insert_segment_transcripts(&conn, segment.id, segment.start_wall_ms, &segments)?;
                        counts.transcribe_done = true;
                        log_line(
                            args.verbose,
                            &format!("Saved {} transcript segments for {}", segments.len(), segment.id),
                        );
                    }
                }
            }
            update_processing_status(
                &conn,
                &session_key,
                segment.id,
                "transcribe",
                &build_processing_summary(&counts),
            )?;
            mark_segment_processed(&conn, segment.id)?;
            update_processing_status(
                &conn,
                &session_key,
                segment.id,
                "done",
                &build_processing_summary(&counts),
            )?;
        }
        std::thread::sleep(Duration::from_millis(args.poll_ms));
    }
}

fn parse_args() -> Result<Args> {
    let mut args = Args {
        db_path: None,
        frames_dir: None,
        audio_dir: None,
        session_id: None,
        scale_width: DEFAULT_SCALE_WIDTH,
        jpeg_quality: DEFAULT_JPEG_QUALITY,
        poll_ms: DEFAULT_POLL_MS,
        grace_ms: DEFAULT_GRACE_MS,
        frame_offset_ms: DEFAULT_FRAME_OFFSET_MS,
        transcribe_model: DEFAULT_TRANSCRIBE_MODEL.to_string(),
        ocr_lang: DEFAULT_OCR_LANG.to_string(),
        event_types: None,
        ocr_keydown_mode: OcrKeydownMode::GroupHead,
        quiet_ffmpeg: false,
        verbose: false,
    };
    let mut iter = env::args().skip(1).peekable();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--db" => {
                if let Some(value) = iter.next() {
                    args.db_path = Some(PathBuf::from(value));
                }
            }
            "--frames-dir" => {
                if let Some(value) = iter.next() {
                    args.frames_dir = Some(PathBuf::from(value));
                }
            }
            "--audio-dir" => {
                if let Some(value) = iter.next() {
                    args.audio_dir = Some(PathBuf::from(value));
                }
            }
            "--session-id" => {
                args.session_id = iter.next();
            }
            "--scale-width" => {
                if let Some(value) = iter.next() {
                    args.scale_width = value.parse().unwrap_or(DEFAULT_SCALE_WIDTH);
                }
            }
            "--jpeg-quality" => {
                if let Some(value) = iter.next() {
                    args.jpeg_quality = value.parse().unwrap_or(DEFAULT_JPEG_QUALITY);
                }
            }
            "--poll-ms" => {
                if let Some(value) = iter.next() {
                    args.poll_ms = value.parse().unwrap_or(DEFAULT_POLL_MS);
                }
            }
            "--grace-ms" => {
                if let Some(value) = iter.next() {
                    args.grace_ms = value.parse().unwrap_or(DEFAULT_GRACE_MS);
                }
            }
            "--frame-offset-ms" => {
                if let Some(value) = iter.next() {
                    args.frame_offset_ms = value.parse().unwrap_or(DEFAULT_FRAME_OFFSET_MS);
                }
            }
            "--transcribe-model" => {
                if let Some(value) = iter.next() {
                    if !value.trim().is_empty() {
                        args.transcribe_model = value;
                    }
                }
            }
            "--ocr-lang" => {
                if let Some(value) = iter.next() {
                    if !value.trim().is_empty() {
                        args.ocr_lang = value;
                    }
                }
            }
            "--event-types" => {
                if let Some(value) = iter.next() {
                    let types = parse_event_types(&value);
                    if !types.is_empty() {
                        args.event_types = Some(types);
                    }
                }
            }
            "--ocr-keydown-mode" => {
                if let Some(value) = iter.next() {
                    args.ocr_keydown_mode = parse_ocr_keydown_mode(&value);
                }
            }
            "--quiet-ffmpeg" => {
                args.quiet_ffmpeg = true;
            }
            "--verbose" => {
                args.verbose = true;
            }
            _ => {}
        }
    }
    Ok(args)
}

fn parse_event_types(value: &str) -> HashSet<String> {
    value
        .split(',')
        .map(|item| item.trim().to_lowercase())
        .filter(|item| !item.is_empty())
        .collect()
}

fn parse_ocr_keydown_mode(value: &str) -> OcrKeydownMode {
    match value.trim().to_lowercase().as_str() {
        "all" => OcrKeydownMode::All,
        _ => OcrKeydownMode::GroupHead,
    }
}

fn ensure_app_dir() -> Result<PathBuf> {
    let cwd = env::current_dir().context("Failed to read current dir")?;
    let base_dir = cwd.join(APP_DIR);
    if !base_dir.exists() {
        fs::create_dir_all(&base_dir).context("Failed to create timestone data dir")?;
    }
    Ok(base_dir)
}

fn init_db(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS event_frames (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id INTEGER,
            frame_path TEXT,
            frame_wall_ms INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_event_frames_event ON event_frames(event_id);
        CREATE TABLE IF NOT EXISTS segment_audio (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            segment_id INTEGER,
            audio_path TEXT,
            start_offset_ms INTEGER,
            duration_ms INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_segment_audio_segment ON segment_audio(segment_id);
        CREATE TABLE IF NOT EXISTS segment_transcriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            segment_id INTEGER,
            start_ms INTEGER,
            end_ms INTEGER,
            wall_start_ms INTEGER,
            wall_end_ms INTEGER,
            text TEXT,
            engine TEXT,
            created_ms INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_segment_transcripts_segment ON segment_transcriptions(segment_id);
        CREATE INDEX IF NOT EXISTS idx_segment_transcripts_wall ON segment_transcriptions(wall_start_ms);
        CREATE TABLE IF NOT EXISTS event_ocr (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id INTEGER,
            frame_path TEXT,
            ocr_text TEXT,
            ocr_engine TEXT,
            created_ms INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_event_ocr_event ON event_ocr(event_id);
        CREATE INDEX IF NOT EXISTS idx_event_ocr_frame ON event_ocr(frame_path);
        CREATE TABLE IF NOT EXISTS processing_status (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            segment_id INTEGER,
            stage TEXT,
            summary TEXT,
            updated_ms INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_processing_status_session ON processing_status(session_id, updated_ms);
        CREATE INDEX IF NOT EXISTS idx_processing_status_updated ON processing_status(updated_ms);
        "
    )?;
    Ok(())
}

fn build_processing_summary(counts: &ProcessingCounts) -> String {
    let mut parts = Vec::new();
    if counts.frames_total > 0 {
        parts.push(format!("frames {}/{}", counts.frames_done, counts.frames_total));
    }
    if counts.ocr_total > 0 {
        parts.push(format!("ocr {}/{}", counts.ocr_done, counts.ocr_total));
    }
    if counts.audio_done {
        parts.push("audio ok".to_string());
    }
    if counts.transcribe_done {
        parts.push("tx ok".to_string());
    }
    if parts.is_empty() {
        "idle".to_string()
    } else {
        parts.join(" | ")
    }
}

fn update_processing_status(
    conn: &Connection,
    session_id: &str,
    segment_id: i64,
    stage: &str,
    summary: &str,
) -> Result<()> {
    let updated_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    conn.execute(
        "INSERT INTO processing_status (session_id, segment_id, stage, summary, updated_ms) VALUES (?, ?, ?, ?, ?)",
        params![session_id, segment_id, stage, summary, updated_ms],
    )?;
    Ok(())
}

fn fetch_pending_segments(conn: &Connection, session_id: Option<&str>) -> Result<Vec<RecordSegment>> {
    let mut segments = Vec::new();
    if let Some(session_id) = session_id {
        let mut stmt = conn.prepare(
            "SELECT id, session_id, start_wall_ms, end_wall_ms, obs_path FROM record_segments WHERE processed = 0 AND end_wall_ms IS NOT NULL AND session_id = ? ORDER BY start_wall_ms",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            Ok(RecordSegment {
                id: row.get(0)?,
                session_id: row.get(1)?,
                start_wall_ms: row.get(2)?,
                end_wall_ms: row.get(3)?,
                obs_path: row.get(4)?,
            })
        })?;
        for row in rows {
            segments.push(row?);
        }
    } else {
        let mut stmt = conn.prepare(
            "SELECT id, session_id, start_wall_ms, end_wall_ms, obs_path FROM record_segments WHERE processed = 0 AND end_wall_ms IS NOT NULL ORDER BY start_wall_ms",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(RecordSegment {
                id: row.get(0)?,
                session_id: row.get(1)?,
                start_wall_ms: row.get(2)?,
                end_wall_ms: row.get(3)?,
                obs_path: row.get(4)?,
            })
        })?;
        for row in rows {
            segments.push(row?);
        }
    }
    Ok(segments)
}

fn segment_ready(segment: &RecordSegment, grace_ms: i64) -> bool {
    let now = now_wall_ms();
    segment.end_wall_ms <= now - grace_ms
}

fn segment_offset_before(conn: &Connection, obs_path: &str, start_wall_ms: i64) -> Result<i64> {
    let mut stmt = conn.prepare(
        "SELECT IFNULL(SUM(end_wall_ms - start_wall_ms), 0) FROM record_segments WHERE obs_path = ? AND end_wall_ms IS NOT NULL AND start_wall_ms < ?",
    )?;
    let total: i64 = stmt.query_row(params![obs_path, start_wall_ms], |row| row.get(0))?;
    Ok(total)
}

fn fetch_events_for_segment(conn: &Connection, segment: &RecordSegment) -> Result<Vec<EventInfo>> {
    let mut events = Vec::new();
    let (start, end) = (segment.start_wall_ms, segment.end_wall_ms);
    if let Some(session_id) = segment.session_id.as_deref() {
        let mut stmt = conn.prepare(
            "SELECT id, ts_wall_ms, event_type, process_name, window_title, window_class
             FROM events
             WHERE session_id = ? AND ts_wall_ms BETWEEN ? AND ?
             ORDER BY ts_wall_ms",
        )?;
        let rows = stmt.query_map(params![session_id, start, end], |row| {
            let process_name: Option<String> = row.get(3)?;
            let window_title: Option<String> = row.get(4)?;
            let window_class: Option<String> = row.get(5)?;
            Ok(EventInfo {
                id: row.get(0)?,
                ts_wall_ms: row.get(1)?,
                event_type: row.get(2)?,
                window_key: build_window_key(process_name, window_title, window_class),
            })
        })?;
        for row in rows {
            events.push(row?);
        }
    } else {
        let mut stmt = conn.prepare(
            "SELECT id, ts_wall_ms, event_type, process_name, window_title, window_class
             FROM events
             WHERE ts_wall_ms BETWEEN ? AND ?
             ORDER BY ts_wall_ms",
        )?;
        let rows = stmt.query_map(params![start, end], |row| {
            let process_name: Option<String> = row.get(3)?;
            let window_title: Option<String> = row.get(4)?;
            let window_class: Option<String> = row.get(5)?;
            Ok(EventInfo {
                id: row.get(0)?,
                ts_wall_ms: row.get(1)?,
                event_type: row.get(2)?,
                window_key: build_window_key(process_name, window_title, window_class),
            })
        })?;
        for row in rows {
            events.push(row?);
        }
    }
    Ok(events)
}

fn build_window_key(
    process_name: Option<String>,
    window_title: Option<String>,
    window_class: Option<String>,
) -> String {
    let process = process_name.unwrap_or_default();
    let title = window_title.unwrap_or_default();
    let class = window_class.unwrap_or_default();
    format!("{process}|{title}|{class}")
}

fn keydown_group_heads(events: &[EventInfo]) -> HashSet<i64> {
    let mut heads = HashSet::new();
    for (idx, event) in events.iter().enumerate() {
        if event.event_type != "key_down" {
            continue;
        }
        let next = events.get(idx + 1);
        let is_end = match next {
            None => true,
            Some(next_event) => {
                next_event.event_type != "key_down" || next_event.window_key != event.window_key
            }
        };
        if is_end {
            heads.insert(event.id);
        }
    }
    heads
}

fn event_type_allowed(event_type: &str, filter: &Option<HashSet<String>>) -> bool {
    match filter {
        None => true,
        Some(set) => set.contains(&event_type.to_lowercase()),
    }
}

fn event_frames_exist(conn: &Connection, event_id: i64) -> Result<bool> {
    let mut stmt = conn.prepare("SELECT COUNT(*) FROM event_frames WHERE event_id = ?")?;
    let count: i64 = stmt.query_row(params![event_id], |row| row.get(0))?;
    Ok(count > 0)
}

fn ocr_exists_for_frame(conn: &Connection, frame_path: &Path) -> Result<bool> {
    let mut stmt = conn.prepare("SELECT COUNT(*) FROM event_ocr WHERE frame_path = ?")?;
    let count: i64 = stmt.query_row(params![frame_path.to_string_lossy()], |row| row.get(0))?;
    Ok(count > 0)
}

fn extract_frame(
    obs_path: &str,
    offset_ms: i64,
    dest_path: &Path,
    scale_width: u32,
    quality: u8,
    verbose: bool,
    quiet_ffmpeg: bool,
) -> Result<bool> {
    let offset_sec = (offset_ms.max(0) as f64) / 1000.0;
    let offset_arg = format!("{offset_sec:.3}");
    let vf = format!("scale={}: -1", scale_width).replace(": ", ":");
    let mut cmd = Command::new("ffmpeg");
    let log_level = if quiet_ffmpeg {
        "error"
    } else if verbose {
        "info"
    } else {
        "error"
    };
    cmd.arg("-hide_banner")
        .arg("-loglevel")
        .arg(log_level)
        .arg("-i")
        .arg(obs_path)
        .arg("-ss")
        .arg(offset_arg)
        .arg("-update")
        .arg("1")
        .arg("-frames:v")
        .arg("1")
        .arg("-vf")
        .arg(vf)
        .arg("-q:v")
        .arg(quality.to_string())
        .arg(dest_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(if verbose && !quiet_ffmpeg {
            Stdio::inherit()
        } else {
            Stdio::null()
        });
    let status = cmd.status().context("Failed to run ffmpeg for frame")?;
    Ok(status.success())
}

fn insert_event_frame(conn: &Connection, event_id: i64, frame_path: &Path, frame_wall_ms: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO event_frames (event_id, frame_path, frame_wall_ms) VALUES (?, ?, ?)",
        params![event_id, frame_path.to_string_lossy(), frame_wall_ms],
    )?;
    Ok(())
}

fn insert_event_ocr(
    conn: &Connection,
    event_id: i64,
    frame_path: &Path,
    ocr_text: &str,
    engine: &str,
) -> Result<()> {
    let created_ms = now_wall_ms();
    conn.execute(
        "INSERT INTO event_ocr (event_id, frame_path, ocr_text, ocr_engine, created_ms) VALUES (?, ?, ?, ?, ?)",
        params![event_id, frame_path.to_string_lossy(), ocr_text, engine, created_ms],
    )?;
    Ok(())
}

fn fetch_segment_audio_path(conn: &Connection, segment_id: i64) -> Result<Option<PathBuf>> {
    let mut stmt = conn.prepare("SELECT audio_path FROM segment_audio WHERE segment_id = ? LIMIT 1")?;
    let mut rows = stmt.query(params![segment_id])?;
    if let Some(row) = rows.next()? {
        let path: String = row.get(0)?;
        return Ok(Some(PathBuf::from(path)));
    }
    Ok(None)
}

fn extract_audio_segment(
    obs_path: &str,
    start_offset_ms: i64,
    duration_ms: i64,
    dest_path: &Path,
    verbose: bool,
    quiet_ffmpeg: bool,
) -> Result<bool> {
    let start_sec = (start_offset_ms.max(0) as f64) / 1000.0;
    let duration_sec = (duration_ms.max(0) as f64) / 1000.0;
    let mut cmd = Command::new("ffmpeg");
    let log_level = if quiet_ffmpeg {
        "error"
    } else if verbose {
        "info"
    } else {
        "error"
    };
    cmd.arg("-hide_banner")
        .arg("-loglevel")
        .arg(log_level)
        .arg("-i")
        .arg(obs_path)
        .arg("-ss")
        .arg(format!("{start_sec:.3}"))
        .arg("-t")
        .arg(format!("{duration_sec:.3}"))
        .arg("-vn")
        .arg("-acodec")
        .arg("pcm_s16le")
        .arg("-ar")
        .arg("16000")
        .arg("-ac")
        .arg("1")
        .arg(dest_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(if verbose && !quiet_ffmpeg {
            Stdio::inherit()
        } else {
            Stdio::null()
        });
    let status = cmd.status().context("Failed to run ffmpeg for audio")?;
    Ok(status.success())
}

fn insert_segment_audio(
    conn: &Connection,
    segment_id: i64,
    audio_path: &Path,
    start_offset_ms: i64,
    duration_ms: i64,
) -> Result<()> {
    conn.execute(
        "INSERT INTO segment_audio (segment_id, audio_path, start_offset_ms, duration_ms) VALUES (?, ?, ?, ?)",
        params![segment_id, audio_path.to_string_lossy(), start_offset_ms, duration_ms],
    )?;
    Ok(())
}

fn segment_transcriptions_exist(conn: &Connection, segment_id: i64) -> Result<bool> {
    let mut stmt = conn.prepare("SELECT COUNT(*) FROM segment_transcriptions WHERE segment_id = ?")?;
    let count: i64 = stmt.query_row(params![segment_id], |row| row.get(0))?;
    Ok(count > 0)
}

fn insert_segment_transcripts(
    conn: &Connection,
    segment_id: i64,
    segment_start_wall_ms: i64,
    segments: &[TranscriptSegment],
) -> Result<()> {
    let created_ms = now_wall_ms();
    for seg in segments {
        let wall_start = segment_start_wall_ms + seg.start_ms;
        let wall_end = segment_start_wall_ms + seg.end_ms;
        conn.execute(
            "INSERT INTO segment_transcriptions (segment_id, start_ms, end_ms, wall_start_ms, wall_end_ms, text, engine, created_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                segment_id,
                seg.start_ms,
                seg.end_ms,
                wall_start,
                wall_end,
                seg.text,
                seg.engine,
                created_ms
            ],
        )?;
    }
    Ok(())
}

fn mark_segment_processed(conn: &Connection, segment_id: i64) -> Result<()> {
    conn.execute(
        "UPDATE record_segments SET processed = 1 WHERE id = ?",
        params![segment_id],
    )?;
    Ok(())
}

fn run_transcribe_script(
    scripts_dir: &Path,
    audio_path: &Path,
    model: &str,
    verbose: bool,
) -> Result<Vec<TranscriptSegment>> {
    let script_path = scripts_dir.join("timestone_transcribe_segment.py");
    if !script_path.exists() {
        return Ok(Vec::new());
    }
    let py = env::var("PYTHON").unwrap_or_else(|_| "python".to_string());
    let mut cmd = Command::new(py);
    cmd.arg(script_path)
        .arg("--audio")
        .arg(audio_path)
        .arg("--model")
        .arg(model)
        .stdout(Stdio::piped())
        .stderr(if verbose { Stdio::inherit() } else { Stdio::piped() });
    let output = cmd.output().context("Failed to run transcribe script")?;
    if !output.status.success() {
        return Ok(Vec::new());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let payload: serde_json::Value = serde_json::from_str(&stdout).unwrap_or_else(|_| serde_json::json!({}));
    let engine = payload
        .get("engine")
        .and_then(|v| v.as_str())
        .unwrap_or("whisper")
        .to_string();
    let mut segments = Vec::new();
    if let Some(items) = payload.get("segments").and_then(|v| v.as_array()) {
        for item in items {
            let start_ms = item.get("start_ms").and_then(|v| v.as_i64()).unwrap_or(0);
            let end_ms = item.get("end_ms").and_then(|v| v.as_i64()).unwrap_or(start_ms);
            let text = item.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if text.trim().is_empty() {
                continue;
            }
            segments.push(TranscriptSegment {
                start_ms,
                end_ms,
                text,
                engine: engine.clone(),
            });
        }
    }
    Ok(segments)
}

fn run_ocr_script(
    scripts_dir: &Path,
    frame_path: &Path,
    lang: &str,
    verbose: bool,
) -> Result<Option<String>> {
    let script_path = scripts_dir.join("timestone_ocr_frame.py");
    if !script_path.exists() {
        return Ok(None);
    }
    let py = env::var("PYTHON").unwrap_or_else(|_| "python".to_string());
    let mut cmd = Command::new(py);
    cmd.arg(script_path)
        .arg("--image")
        .arg(frame_path)
        .arg("--lang")
        .arg(lang)
        .stdout(Stdio::piped())
        .stderr(if verbose { Stdio::inherit() } else { Stdio::piped() });
    if let Ok(tess) = env::var("TESSERACT_CMD") {
        cmd.arg("--tesseract").arg(tess);
    } else if let Ok(tess) = env::var("TESSERACT_PATH") {
        cmd.arg("--tesseract").arg(tess);
    }
    let output = cmd.output().context("Failed to run OCR script")?;
    if !output.status.success() {
        return Ok(None);
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let payload: serde_json::Value = serde_json::from_str(&stdout).unwrap_or_else(|_| serde_json::json!({}));
    let text = payload.get("text").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if text.is_empty() {
        return Ok(None);
    }
    Ok(Some(text))
}

fn now_wall_ms() -> i64 {
    system_time_to_ms(SystemTime::now())
}

fn system_time_to_ms(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn log_line(verbose: bool, message: &str) {
    if verbose {
        println!("[timestone_file_tapper] {message}");
    }
}

fn log_error(message: &str) {
    eprintln!("[timestone_file_tapper] {message}");
}
