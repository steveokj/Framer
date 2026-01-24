use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::STANDARD as Base64Engine;
use base64::Engine;
use chrono::{DateTime, Local};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::net::{TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tungstenite::{connect, Message, WebSocket};
use tungstenite::stream::MaybeTlsStream;
use url::Url;

const APP_DIR: &str = "data\\timestone";
const LOCK_FILE: &str = "recorder.lock";
const DB_NAME: &str = "timestone_events.sqlite3";
const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 4455;
const DEFAULT_EVENT_MASK: i64 = 64; // Outputs
const DEFAULT_CONTROL_HOST: &str = "127.0.0.1";
const DEFAULT_CONTROL_PORT: u16 = 40777;

#[derive(Default)]
struct Args {
    host: String,
    port: u16,
    password: Option<String>,
    db_path: Option<PathBuf>,
    session_id: Option<String>,
    lock_path: Option<PathBuf>,
    event_mask: i64,
    control_host: String,
    control_port: u16,
    verbose: bool,
}

#[derive(Default)]
struct LockInfo {
    session_id: Option<String>,
    start_wall_ms: Option<i64>,
    start_wall_iso: Option<String>,
}

struct ControlSender {
    socket: UdpSocket,
    addr: String,
}

impl ControlSender {
    fn new(host: &str, port: u16) -> Result<Self> {
        let socket = UdpSocket::bind("0.0.0.0:0").context("Failed to bind UDP socket")?;
        let addr = format!("{host}:{port}");
        Ok(Self { socket, addr })
    }

    fn send(&self, message: &str, verbose: bool) -> Result<()> {
        let _ = self.socket.send_to(message.as_bytes(), &self.addr);
        if verbose {
            log_line(verbose, &format!("Sent control '{message}' to {}", self.addr));
        }
        Ok(())
    }
}

fn main() -> Result<()> {
    let args = parse_args()?;
    let base_dir = ensure_app_dir()?;
    let db_path = args
        .db_path
        .unwrap_or_else(|| base_dir.join(DB_NAME));
    let lock_path = args
        .lock_path
        .unwrap_or_else(|| base_dir.join(LOCK_FILE));
    let lock_info = read_lock_info(&lock_path).unwrap_or_default();
    let session_id = args
        .session_id
        .or(lock_info.session_id)
        .ok_or_else(|| anyhow!("Missing session id. Start timestone_recorder or pass --session-id."))?;

    let conn = open_db(&db_path)?;
    ensure_session_row(
        &conn,
        &session_id,
        lock_info.start_wall_ms,
        lock_info.start_wall_iso,
    )?;

    let control = ControlSender::new(&args.control_host, args.control_port)?;

    log_line(args.verbose, &format!("Connecting to OBS WS {}:{}...", args.host, args.port));
    let ws_url = Url::parse(&format!("ws://{}:{}", args.host, args.port))?;
    let (mut socket, _) = connect(ws_url)?;

    let mut authenticated = false;
    let mut request_counter: u64 = 0;
    loop {
        if let Some(message) = read_json_message(&mut socket, args.verbose)? {
            let op = message.get("op").and_then(|v| v.as_i64()).unwrap_or(-1);
            if op == 0 {
                let auth = build_auth(&message, args.password.as_deref())?;
                send_identify(&mut socket, auth.as_deref(), args.event_mask)?;
            }
            if op == 2 {
                authenticated = true;
                break;
            }
        }
    }

    if !authenticated {
        return Err(anyhow!("Failed to identify with OBS WebSocket."));
    }

    log_line(args.verbose, "Connected. Listening for recording events...");
    send_request(
        &mut socket,
        "GetRecordStatus",
        json!({}),
        &mut request_counter,
        args.verbose,
    )?;

    loop {
        if let Some(message) = read_json_message(&mut socket, args.verbose)? {
            let op = message.get("op").and_then(|v| v.as_i64()).unwrap_or(-1);
            match op {
                5 => {
                    if let Some(data) = message.get("d") {
                        handle_event(
                            &conn,
                            &session_id,
                            data,
                            &mut socket,
                            &mut request_counter,
                            &control,
                            args.verbose,
                        )?;
                    }
                }
                7 => {
                    if let Some(data) = message.get("d") {
                        handle_response(data, &control, args.verbose)?;
                    }
                }
                _ => {}
            }
        }
    }
}

fn parse_args() -> Result<Args> {
    let mut args = Args {
        host: DEFAULT_HOST.to_string(),
        port: DEFAULT_PORT,
        password: None,
        db_path: None,
        session_id: None,
        lock_path: None,
        event_mask: DEFAULT_EVENT_MASK,
        control_host: DEFAULT_CONTROL_HOST.to_string(),
        control_port: DEFAULT_CONTROL_PORT,
        verbose: false,
    };
    let mut iter = env::args().skip(1).peekable();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--host" => {
                args.host = iter.next().unwrap_or_default();
            }
            "--port" => {
                if let Some(value) = iter.next() {
                    args.port = value.parse().unwrap_or(DEFAULT_PORT);
                }
            }
            "--password" => {
                args.password = iter.next();
            }
            "--db" => {
                if let Some(value) = iter.next() {
                    args.db_path = Some(PathBuf::from(value));
                }
            }
            "--session-id" => {
                args.session_id = iter.next();
            }
            "--lock" => {
                if let Some(value) = iter.next() {
                    args.lock_path = Some(PathBuf::from(value));
                }
            }
            "--event-mask" => {
                if let Some(value) = iter.next() {
                    if let Ok(parsed) = value.parse::<i64>() {
                        args.event_mask = parsed;
                    }
                }
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
            "--verbose" => {
                args.verbose = true;
            }
            _ => {}
        }
    }
    if args.password.is_none() {
        if let Ok(env_pass) = env::var("OBS_WS_PASSWORD") {
            if !env_pass.trim().is_empty() {
                args.password = Some(env_pass);
            }
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
        match key {
            "session_id" => info.session_id = Some(value.to_string()),
            "start_wall_ms" => info.start_wall_ms = value.parse::<i64>().ok(),
            "start_wall_iso" => info.start_wall_iso = Some(value.to_string()),
            _ => {}
        }
    }
    Some(info)
}

fn open_db(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path).context("Failed to open timestone DB")?;
    conn.busy_timeout(std::time::Duration::from_millis(2000))
        .ok();
    Ok(conn)
}

fn ensure_session_row(
    conn: &Connection,
    session_id: &str,
    start_wall_ms: Option<i64>,
    start_wall_iso: Option<String>,
) -> Result<()> {
    let wall_ms = start_wall_ms.unwrap_or_else(now_wall_ms);
    let wall_iso = start_wall_iso.unwrap_or_else(|| {
        let dt: DateTime<Local> = SystemTime::now().into();
        dt.to_rfc3339()
    });
    conn.execute(
        "INSERT OR IGNORE INTO sessions (session_id, start_wall_ms, start_wall_iso, obs_video_path) VALUES (?, ?, ?, ?)",
        params![session_id, wall_ms, wall_iso, Option::<String>::None],
    )
    .context("Failed to ensure session row")?;
    Ok(())
}

fn update_session_obs_path(conn: &Connection, session_id: &str, obs_video_path: &str) -> Result<()> {
    conn.execute(
        "UPDATE sessions SET obs_video_path = ? WHERE session_id = ?",
        params![obs_video_path, session_id],
    )
    .context("Failed to update obs video path")?;
    Ok(())
}

fn now_wall_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn read_json_message(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    verbose: bool,
) -> Result<Option<Value>> {
    let msg = socket.read_message()?;
    match msg {
        Message::Text(text) => {
            if verbose {
                log_line(verbose, &format!("[obs] <- {text}"));
            }
            let parsed: Value = serde_json::from_str(&text)?;
            Ok(Some(parsed))
        }
        Message::Binary(bin) => {
            let text = String::from_utf8_lossy(&bin);
            if verbose {
                log_line(verbose, &format!("[obs] <- {text}"));
            }
            let parsed: Value = serde_json::from_str(&text)?;
            Ok(Some(parsed))
        }
        Message::Ping(payload) => {
            socket.write_message(Message::Pong(payload))?;
            Ok(None)
        }
        Message::Pong(_) => Ok(None),
        Message::Close(_) => Ok(None),
        _ => Ok(None),
    }
}

fn build_auth(hello: &Value, password: Option<&str>) -> Result<Option<String>> {
    let auth = match hello
        .get("d")
        .and_then(|d| d.get("authentication"))
        .and_then(|a| a.as_object())
    {
        Some(auth) => auth,
        None => return Ok(None),
    };
    let password = match password {
        Some(value) => value,
        None => return Ok(None),
    };
    let challenge = auth
        .get("challenge")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let salt = auth.get("salt").and_then(|v| v.as_str()).unwrap_or("");
    if challenge.is_empty() || salt.is_empty() {
        return Ok(None);
    }
    let mut sha = Sha256::new();
    sha.update(format!("{password}{salt}").as_bytes());
    let secret = Base64Engine.encode(sha.finalize_reset());
    sha.update(format!("{secret}{challenge}").as_bytes());
    let auth = Base64Engine.encode(sha.finalize());
    Ok(Some(auth))
}

fn send_identify(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    auth: Option<&str>,
    event_mask: i64,
) -> Result<()> {
    let mut payload = json!({
        "op": 1,
        "d": {
            "rpcVersion": 1,
            "eventSubscriptions": event_mask,
        }
    });
    if let Some(auth) = auth {
        payload["d"]["authentication"] = Value::String(auth.to_string());
    }
    let text = payload.to_string();
    socket.write_message(Message::Text(text))?;
    Ok(())
}

fn handle_event(
    conn: &Connection,
    session_id: &str,
    data: &Value,
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    request_counter: &mut u64,
    control: &ControlSender,
    verbose: bool,
) -> Result<()> {
    let event_type = data.get("eventType").and_then(|v| v.as_str()).unwrap_or("");
    let event_data = data.get("eventData").cloned().unwrap_or(json!({}));
    match event_type {
        "RecordStateChanged" => {
            let output_state = event_data
                .get("outputState")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            let mapped = match output_state {
                "OBS_WEBSOCKET_OUTPUT_STARTED" => "obs_record_start",
                "OBS_WEBSOCKET_OUTPUT_STOPPED" => "obs_record_stop",
                "OBS_WEBSOCKET_OUTPUT_PAUSED" => "obs_record_pause",
                "OBS_WEBSOCKET_OUTPUT_RESUMED" => "obs_record_resume",
                _ => "obs_record_state",
            };
            if let Some(path) = event_data.get("outputPath").and_then(|v| v.as_str()) {
                let _ = update_session_obs_path(conn, session_id, path);
            }
            insert_event(conn, session_id, mapped, event_data.clone(), verbose)?;
            if matches!(
                output_state,
                "OBS_WEBSOCKET_OUTPUT_STARTED" | "OBS_WEBSOCKET_OUTPUT_RESUMED"
            ) {
                send_request(socket, "StartStream", json!({}), request_counter, verbose)?;
                let _ = control.send("recording:start", verbose);
            } else if matches!(
                output_state,
                "OBS_WEBSOCKET_OUTPUT_PAUSED" | "OBS_WEBSOCKET_OUTPUT_STOPPED"
            ) {
                send_request(socket, "StopStream", json!({}), request_counter, verbose)?;
                let _ = control.send("recording:stop", verbose);
            }
        }
        "RecordFileChanged" => {
            if let Some(path) = event_data.get("newOutputPath").and_then(|v| v.as_str()) {
                let _ = update_session_obs_path(conn, session_id, path);
            }
            insert_event(conn, session_id, "obs_record_file_changed", event_data.clone(), verbose)?;
        }
        _ => {}
    }
    Ok(())
}

fn send_request(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    request_type: &str,
    request_data: Value,
    counter: &mut u64,
    verbose: bool,
) -> Result<()> {
    *counter += 1;
    let request_id = format!("tstone-{}", counter);
    let payload = json!({
        "op": 6,
        "d": {
            "requestType": request_type,
            "requestId": request_id,
            "requestData": request_data
        }
    });
    if verbose {
        log_line(verbose, &format!("[obs] -> {payload}"));
    }
    socket.write_message(Message::Text(payload.to_string()))?;
    Ok(())
}

fn handle_response(data: &Value, control: &ControlSender, verbose: bool) -> Result<()> {
    let request_type = data.get("requestType").and_then(|v| v.as_str()).unwrap_or("");
    if request_type != "GetRecordStatus" {
        return Ok(());
    }
    let response = data.get("responseData").cloned().unwrap_or(json!({}));
    let output_active = response
        .get("outputActive")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let output_paused = response
        .get("outputPaused")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if output_active && !output_paused {
        let _ = control.send("recording:start", verbose);
    } else {
        let _ = control.send("recording:stop", verbose);
    }
    Ok(())
}

fn insert_event(
    conn: &Connection,
    session_id: &str,
    event_type: &str,
    payload: Value,
    verbose: bool,
) -> Result<()> {
    let ts_wall_ms = now_wall_ms();
    let payload_str = serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string());
    conn.execute(
        "INSERT INTO events (session_id, ts_wall_ms, ts_mono_ms, event_type, process_name, window_title, window_class, window_rect, mouse, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            session_id,
            ts_wall_ms,
            ts_wall_ms,
            event_type,
            Option::<String>::None,
            Option::<String>::None,
            Option::<String>::None,
            Option::<String>::None,
            Option::<String>::None,
            payload_str
        ],
    )
    .context("Failed to insert OBS event")?;
    log_line(verbose, &format!("Recorded {event_type} @ {ts_wall_ms}"));
    Ok(())
}

fn log_line(verbose: bool, message: &str) {
    if verbose {
        println!("[timestone_obs_ws] {message}");
    }
}
