use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection};
use std::collections::{HashSet, VecDeque};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::net::UdpSocket;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const APP_DIR: &str = "data\\timestone";
const DB_NAME: &str = "timestone_events.sqlite3";
const LOCK_FILE: &str = "recorder.lock";
const DEFAULT_STREAM: &str = "rtmp://127.0.0.1/live/timestone";
const DEFAULT_FPS: u32 = 2;
const DEFAULT_BEFORE_MS: i64 = 500;
const DEFAULT_AFTER_MS: i64 = 1500;
const DEFAULT_BUFFER_SEC: i64 = 20;
const DEFAULT_SCALE_WIDTH: u32 = 1280;
const DEFAULT_CONTROL_HOST: &str = "127.0.0.1";
const DEFAULT_CONTROL_PORT: u16 = 40777;
const STREAM_STATE_FILE: &str = "stream.state";
const STARTUP_GRACE_MS: i64 = 5000;

#[derive(Clone)]
struct FrameMeta {
    path: PathBuf,
    wall_ms: i64,
}

struct PendingEvent {
    event_id: i64,
    ts_wall_ms: i64,
    ready_at_ms: i64,
}

#[derive(Default)]
struct Args {
    stream_url: String,
    fps: u32,
    before_ms: i64,
    after_ms: i64,
    buffer_sec: i64,
    scale_width: u32,
    db_path: Option<PathBuf>,
    session_id: Option<String>,
    frames_dir: Option<PathBuf>,
    verbose: bool,
    control_host: String,
    control_port: u16,
}

#[derive(Default)]
struct LockInfo {
    session_id: Option<String>,
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
        .unwrap_or_else(|| base_dir.join("frames").join("live"));
    let stream_state_path = base_dir.join(STREAM_STATE_FILE);
    let lock_path = base_dir.join(LOCK_FILE);
    let lock_info = read_lock_info(&lock_path).unwrap_or_default();
    let session_id = args
        .session_id
        .clone()
        .or(lock_info.session_id)
        .ok_or_else(|| anyhow!("Missing session id. Start timestone_recorder or pass --session-id."))?;

    fs::create_dir_all(&frames_dir).context("Failed to create frames dir")?;

    let conn = Connection::open(&db_path).context("Failed to open timestone DB")?;
    conn.busy_timeout(Duration::from_millis(2000)).ok();
    init_db(&conn)?;

    let control_addr = format!("{}:{}", args.control_host, args.control_port);
    let control_socket = UdpSocket::bind(&control_addr)
        .with_context(|| format!("Failed to bind control socket on {control_addr}"))?;
    control_socket.set_nonblocking(true)?;
    log_line(
        args.verbose,
        &format!("Control listener on {control_addr}. Waiting for recording:start..."),
    );

    let mut processed = load_processed_events(&conn)?;
    let mut pending: Vec<PendingEvent> = Vec::new();
    let mut frames: VecDeque<FrameMeta> = VecDeque::new();
    let mut seen_files: HashSet<String> = HashSet::new();
    let mut last_event_id = latest_event_id(&conn, &session_id)?;

    let mut ffmpeg: Option<Child> = None;
    let mut active = read_stream_state(&stream_state_path).unwrap_or(false);
    let mut retry_delay_ms: i64 = 2000;
    let mut next_retry_at_ms: i64 = 0;
    log_line(args.verbose, "Frame tapper running.");
    if active {
        log_line(args.verbose, "State: active (from stream.state)");
    }

    loop {
        if let Some(next_active) = poll_control(&control_socket)? {
            if next_active != active {
                active = next_active;
                if active {
                    last_event_id = latest_event_id(&conn, &session_id)?;
                    pending.clear();
                    log_line(args.verbose, "State: active");
                    log_line(args.verbose, "Recording active. Waiting for stream...");
                    retry_delay_ms = 2000;
                    next_retry_at_ms = now_wall_ms() + STARTUP_GRACE_MS;
                } else {
                    pending.clear();
                    log_line(args.verbose, "State: inactive");
                    log_line(args.verbose, "Recording inactive. Pausing capture.");
                    retry_delay_ms = 2000;
                    next_retry_at_ms = 0;
                }
            }
        }

        if active && ffmpeg.is_none() {
            let now = now_wall_ms();
            if now >= next_retry_at_ms {
                ffmpeg = Some(spawn_ffmpeg(&args, &frames_dir)?);
                log_line(args.verbose, "ffmpeg started.");
            }
        }
        if !active {
            if let Some(mut child) = ffmpeg.take() {
                let _ = child.kill();
                let _ = child.wait();
                log_line(args.verbose, "ffmpeg stopped (recording inactive).");
            }
            std::thread::sleep(Duration::from_millis(250));
            continue;
        }

        let new_frames = refresh_frames(&frames_dir, &mut frames, &mut seen_files, args.buffer_sec)?;
        if new_frames > 0 {
            retry_delay_ms = 1000;
            next_retry_at_ms = 0;
        }
        poll_events(
            &conn,
            &session_id,
            &mut pending,
            &mut processed,
            &mut last_event_id,
            args.after_ms,
        )?;
        flush_pending(&conn, &mut pending, &frames, &frames_dir, args.before_ms, args.after_ms)?;
        cleanup_frames(&mut frames, &mut seen_files, args.buffer_sec)?;

        if let Some(child) = ffmpeg.as_mut() {
            if let Some(status) = child.try_wait()? {
                log_line(
                    args.verbose,
                    &format!("ffmpeg exited with status {status}. Restarting soon..."),
                );
                ffmpeg = None;
                let now = now_wall_ms();
                next_retry_at_ms = now + retry_delay_ms;
                retry_delay_ms = (retry_delay_ms * 2).min(8000);
            }
        }

        std::thread::sleep(Duration::from_millis(250));
    }
}

fn parse_args() -> Result<Args> {
    let mut args = Args {
        stream_url: DEFAULT_STREAM.to_string(),
        fps: DEFAULT_FPS,
        before_ms: DEFAULT_BEFORE_MS,
        after_ms: DEFAULT_AFTER_MS,
        buffer_sec: DEFAULT_BUFFER_SEC,
        scale_width: DEFAULT_SCALE_WIDTH,
        db_path: None,
        session_id: None,
        frames_dir: None,
        verbose: false,
        control_host: DEFAULT_CONTROL_HOST.to_string(),
        control_port: DEFAULT_CONTROL_PORT,
    };
    let mut iter = env::args().skip(1).peekable();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--stream" => {
                args.stream_url = iter.next().unwrap_or_else(|| DEFAULT_STREAM.to_string());
            }
            "--fps" => {
                if let Some(value) = iter.next() {
                    args.fps = value.parse().unwrap_or(DEFAULT_FPS);
                }
            }
            "--before-ms" => {
                if let Some(value) = iter.next() {
                    args.before_ms = value.parse().unwrap_or(DEFAULT_BEFORE_MS);
                }
            }
            "--after-ms" => {
                if let Some(value) = iter.next() {
                    args.after_ms = value.parse().unwrap_or(DEFAULT_AFTER_MS);
                }
            }
            "--buffer-sec" => {
                if let Some(value) = iter.next() {
                    args.buffer_sec = value.parse().unwrap_or(DEFAULT_BUFFER_SEC);
                }
            }
            "--scale-width" => {
                if let Some(value) = iter.next() {
                    args.scale_width = value.parse().unwrap_or(DEFAULT_SCALE_WIDTH);
                }
            }
            "--db" => {
                if let Some(value) = iter.next() {
                    args.db_path = Some(PathBuf::from(value));
                }
            }
            "--session-id" => {
                args.session_id = iter.next();
            }
            "--frames-dir" => {
                if let Some(value) = iter.next() {
                    args.frames_dir = Some(PathBuf::from(value));
                }
            }
            "--verbose" => {
                args.verbose = true;
            }
            "--control-host" => {
                if let Some(value) = iter.next() {
                    args.control_host = value;
                }
            }
            "--control-port" => {
                if let Some(value) = iter.next() {
                    if let Ok(parsed) = value.parse::<u16>() {
                        args.control_port = parsed;
                    }
                }
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

fn read_lock_info(path: &Path) -> Option<LockInfo> {
    let contents = fs::read_to_string(path).ok()?;
    let mut info = LockInfo::default();
    for line in contents.lines() {
        let mut parts = line.splitn(2, '=');
        let key = parts.next().unwrap_or("").trim();
        let value = parts.next().unwrap_or("").trim();
        if key == "session_id" {
            info.session_id = Some(value.to_string());
        }
    }
    Some(info)
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
        ",
    )?;
    Ok(())
}

fn load_processed_events(conn: &Connection) -> Result<HashSet<i64>> {
    let mut stmt = conn.prepare("SELECT DISTINCT event_id FROM event_frames")?;
    let rows = stmt.query_map([], |row| row.get::<_, i64>(0))?;
    let mut set = HashSet::new();
    for row in rows {
        if let Ok(id) = row {
            set.insert(id);
        }
    }
    Ok(set)
}

fn latest_event_id(conn: &Connection, session_id: &str) -> Result<i64> {
    let mut stmt = conn.prepare(
        "SELECT IFNULL(MAX(id), 0) FROM events WHERE session_id = ?",
    )?;
    let id: i64 = stmt.query_row(params![session_id], |row| row.get(0))?;
    Ok(id)
}

fn poll_control(socket: &UdpSocket) -> Result<Option<bool>> {
    let mut buf = [0u8; 64];
    match socket.recv_from(&mut buf) {
        Ok((len, _)) => {
            let msg = String::from_utf8_lossy(&buf[..len]).to_string();
            if msg.starts_with("recording:start") || msg.starts_with("recording:resume") {
                return Ok(Some(true));
            }
            if msg.starts_with("recording:stop") || msg.starts_with("recording:pause") {
                return Ok(Some(false));
            }
            Ok(None)
        }
        Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => Ok(None),
        Err(err) => Err(err.into()),
    }
}

fn read_stream_state(path: &Path) -> Option<bool> {
    let contents = fs::read_to_string(path).ok()?;
    let value = contents.trim().to_lowercase();
    if value == "active" {
        return Some(true);
    }
    if value == "inactive" {
        return Some(false);
    }
    None
}

fn poll_events(
    conn: &Connection,
    session_id: &str,
    pending: &mut Vec<PendingEvent>,
    processed: &mut HashSet<i64>,
    last_event_id: &mut i64,
    after_ms: i64,
) -> Result<()> {
    let mut stmt = conn.prepare(
        "SELECT id, ts_wall_ms FROM events WHERE session_id = ? AND id > ? ORDER BY id",
    )?;
    let rows = stmt.query_map(params![session_id, *last_event_id], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
    })?;
    for row in rows {
        let (id, ts_wall_ms) = row?;
        *last_event_id = id;
        if processed.contains(&id) {
            continue;
        }
        pending.push(PendingEvent {
            event_id: id,
            ts_wall_ms,
            ready_at_ms: ts_wall_ms + after_ms,
        });
    }
    Ok(())
}

fn refresh_frames(
    frames_dir: &Path,
    frames: &mut VecDeque<FrameMeta>,
    seen: &mut HashSet<String>,
    buffer_sec: i64,
) -> Result<usize> {
    let mut entries: Vec<PathBuf> = Vec::new();
    let mut new_count = 0;
    if frames_dir.exists() {
        for entry in fs::read_dir(frames_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("jpg") {
                continue;
            }
            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            if seen.contains(&name) {
                continue;
            }
            entries.push(path);
            seen.insert(name);
            new_count += 1;
        }
    }
    if entries.is_empty() {
        return Ok(new_count);
    }
    entries.sort();
    for path in entries {
        if let Some(wall_ms) = file_wall_ms(&path)? {
            frames.push_back(FrameMeta { path, wall_ms });
        }
    }
    let cutoff = now_wall_ms() - buffer_sec * 1000;
    while let Some(front) = frames.front() {
        if front.wall_ms >= cutoff {
            break;
        }
        if let Some(front) = frames.pop_front() {
            let _ = fs::remove_file(&front.path);
        }
    }
    Ok(new_count)
}

fn cleanup_frames(
    frames: &mut VecDeque<FrameMeta>,
    seen: &mut HashSet<String>,
    buffer_sec: i64,
) -> Result<()> {
    let cutoff = now_wall_ms() - buffer_sec * 1000;
    while let Some(front) = frames.front() {
        if front.wall_ms >= cutoff {
            break;
        }
        if let Some(front) = frames.pop_front() {
            if let Some(name) = front.path.file_name().and_then(|s| s.to_str()) {
                seen.remove(name);
            }
            let _ = fs::remove_file(&front.path);
        }
    }
    Ok(())
}

fn flush_pending(
    conn: &Connection,
    pending: &mut Vec<PendingEvent>,
    frames: &VecDeque<FrameMeta>,
    frames_dir: &Path,
    before_ms: i64,
    after_ms: i64,
) -> Result<()> {
    let now = now_wall_ms();
    let mut ready = Vec::new();
    let mut remaining = Vec::new();
    for event in pending.drain(..) {
        if now >= event.ready_at_ms {
            ready.push(event);
        } else {
            remaining.push(event);
        }
    }
    *pending = remaining;
    for event in ready {
        let start = event.ts_wall_ms - before_ms;
        let end = event.ts_wall_ms + after_ms;
        let selected: Vec<&FrameMeta> = frames
            .iter()
            .filter(|frame| frame.wall_ms >= start && frame.wall_ms <= end)
            .collect();
        if selected.is_empty() {
            continue;
        }
        let dest_dir = frames_dir
            .parent()
            .unwrap_or(frames_dir)
            .join("events")
            .join(event.event_id.to_string());
        fs::create_dir_all(&dest_dir)?;
        for frame in selected {
            let file_name = frame.path.file_name().unwrap_or_default();
            let dest_path = dest_dir.join(file_name);
            let _ = fs::copy(&frame.path, &dest_path);
            conn.execute(
                "INSERT INTO event_frames (event_id, frame_path, frame_wall_ms) VALUES (?, ?, ?)",
                params![event.event_id, dest_path.to_string_lossy(), frame.wall_ms],
            )?;
        }
    }
    Ok(())
}

fn file_wall_ms(path: &Path) -> Result<Option<i64>> {
    let meta = fs::metadata(path)?;
    let modified = meta.modified()?;
    Ok(Some(system_time_to_ms(modified)))
}

fn now_wall_ms() -> i64 {
    system_time_to_ms(SystemTime::now())
}

fn system_time_to_ms(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn spawn_ffmpeg(args: &Args, frames_dir: &Path) -> Result<Child> {
    let output_pattern = frames_dir
        .join("frame_%08d.jpg")
        .to_string_lossy()
        .to_string();
    let vf = format!("fps={},scale={}:-1", args.fps, args.scale_width);
    let log_level = if args.verbose { "warning" } else { "error" };
    let mut cmd = Command::new("ffmpeg");
    cmd.arg("-hide_banner")
        .arg("-loglevel")
        .arg(log_level)
        .arg("-fflags")
        .arg("+genpts")
        .arg("-use_wallclock_as_timestamps")
        .arg("1")
        .arg("-analyzeduration")
        .arg("5000000")
        .arg("-probesize")
        .arg("5000000")
        .arg("-i")
        .arg(&args.stream_url)
        .arg("-vf")
        .arg(vf)
        .arg("-q:v")
        .arg("5")
        .arg(output_pattern)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(if args.verbose { Stdio::inherit() } else { Stdio::null() });
    cmd.spawn().context("Failed to start ffmpeg")
}

fn log_line(verbose: bool, message: &str) {
    if verbose {
        println!("[timestone_frame_tapper] {message}");
    }
}
