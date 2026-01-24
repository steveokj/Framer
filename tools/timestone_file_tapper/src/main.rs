use anyhow::{Context, Result};
use rusqlite::{params, Connection};
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
}

fn main() -> Result<()> {
    let args = parse_args()?;
    let base_dir = ensure_app_dir()?;
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
            for event in events {
                if event_frames_exist(&conn, event.id)? {
                    continue;
                }
                let offset_ms = offset_before_ms + event.ts_wall_ms.saturating_sub(segment.start_wall_ms);
                if offset_ms < 0 {
                    continue;
                }
                let frame_path = frames_dir.join(format!(
                    "event_{}_{}.jpg",
                    event.id, event.ts_wall_ms
                ));
                if extract_frame(&obs_path, offset_ms, &frame_path, args.scale_width, args.jpeg_quality, args.verbose)? {
                    insert_event_frame(&conn, event.id, &frame_path, event.ts_wall_ms)?;
                }
            }
            if !segment_audio_exists(&conn, segment.id)? {
                let audio_path = audio_dir.join(format!("segment_{}.wav", segment.id));
                if extract_audio_segment(
                    &obs_path,
                    offset_before_ms,
                    duration_ms,
                    &audio_path,
                    args.verbose,
                )? {
                    insert_segment_audio(&conn, segment.id, &audio_path, offset_before_ms, duration_ms)?;
                }
            }
            mark_segment_processed(&conn, segment.id)?;
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
            "--verbose" => {
                args.verbose = true;
            }
            _ => {}
        }
    }
    Ok(args)
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
        "
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
            "SELECT id, ts_wall_ms FROM events WHERE session_id = ? AND ts_wall_ms BETWEEN ? AND ? ORDER BY ts_wall_ms",
        )?;
        let rows = stmt.query_map(params![session_id, start, end], |row| {
            Ok(EventInfo {
                id: row.get(0)?,
                ts_wall_ms: row.get(1)?,
            })
        })?;
        for row in rows {
            events.push(row?);
        }
    } else {
        let mut stmt = conn.prepare(
            "SELECT id, ts_wall_ms FROM events WHERE ts_wall_ms BETWEEN ? AND ? ORDER BY ts_wall_ms",
        )?;
        let rows = stmt.query_map(params![start, end], |row| {
            Ok(EventInfo {
                id: row.get(0)?,
                ts_wall_ms: row.get(1)?,
            })
        })?;
        for row in rows {
            events.push(row?);
        }
    }
    Ok(events)
}

fn event_frames_exist(conn: &Connection, event_id: i64) -> Result<bool> {
    let mut stmt = conn.prepare("SELECT COUNT(*) FROM event_frames WHERE event_id = ?")?;
    let count: i64 = stmt.query_row(params![event_id], |row| row.get(0))?;
    Ok(count > 0)
}

fn extract_frame(
    obs_path: &str,
    offset_ms: i64,
    dest_path: &Path,
    scale_width: u32,
    quality: u8,
    verbose: bool,
) -> Result<bool> {
    let offset_sec = (offset_ms.max(0) as f64) / 1000.0;
    let offset_arg = format!("{offset_sec:.3}");
    let vf = format!("scale={}: -1", scale_width).replace(": ", ":");
    let mut cmd = Command::new("ffmpeg");
    cmd.arg("-hide_banner")
        .arg("-loglevel")
        .arg(if verbose { "info" } else { "error" })
        .arg("-i")
        .arg(obs_path)
        .arg("-ss")
        .arg(offset_arg)
        .arg("-frames:v")
        .arg("1")
        .arg("-vf")
        .arg(vf)
        .arg("-q:v")
        .arg(quality.to_string())
        .arg(dest_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(if verbose { Stdio::inherit() } else { Stdio::null() });
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

fn segment_audio_exists(conn: &Connection, segment_id: i64) -> Result<bool> {
    let mut stmt = conn.prepare("SELECT COUNT(*) FROM segment_audio WHERE segment_id = ?")?;
    let count: i64 = stmt.query_row(params![segment_id], |row| row.get(0))?;
    Ok(count > 0)
}

fn extract_audio_segment(
    obs_path: &str,
    start_offset_ms: i64,
    duration_ms: i64,
    dest_path: &Path,
    verbose: bool,
) -> Result<bool> {
    let start_sec = (start_offset_ms.max(0) as f64) / 1000.0;
    let duration_sec = (duration_ms.max(0) as f64) / 1000.0;
    let mut cmd = Command::new("ffmpeg");
    cmd.arg("-hide_banner")
        .arg("-loglevel")
        .arg(if verbose { "info" } else { "error" })
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
        .stderr(if verbose { Stdio::inherit() } else { Stdio::null() });
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

fn mark_segment_processed(conn: &Connection, segment_id: i64) -> Result<()> {
    conn.execute(
        "UPDATE record_segments SET processed = 1 WHERE id = ?",
        params![segment_id],
    )?;
    Ok(())
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
