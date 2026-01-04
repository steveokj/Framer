# Time Stone Event Recorder Plan

## Summary
Build a Windows event recorder that runs alongside OBS and writes a time-aligned event log
(mouse, keyboard, active window, UI element under cursor, and manual markers). Events align
with video and transcript so playback can show "what happened at this moment" across inputs,
apps, and windows. The implementation target is Rust for low overhead and long-session stability.

## Goals
- Manual start/stop recording with a clear session boundary.
- Reconstructed text logging when safe (not raw keystrokes by default).
- Shortcut logging (Ctrl+C, Ctrl+V, etc).
- 1 Hz state snapshots for active window + cursor + UI element.
- Event-driven hooks for mouse/keyboard + window changes.
- Timeline alignment with OBS video and transcript search results.
- Configurable privacy controls and allow/block lists.

## Non-goals (for MVP)
- Full OS-level screen capture (OBS already handles video).
- Remote sync or cloud storage.
- Real-time streaming to a server (local-only first).

## Architecture
1) Recorder service (Rust, Windows)
   - Global input hooks (mouse + keyboard).
   - Window focus and position hooks.
   - UI Automation for element under cursor and "safe text" checks.
   - Background writer thread batching events to SQLite (WAL).
2) Local storage
   - SQLite database per session (or per day) in `data/timestone/`.
3) Player integration
   - Existing Next.js UI loads events for the selected session.
   - Timeline shows events aligned with transcript and video time.

## Timebase and Alignment
- Record both wall time (ms since epoch) and monotonic time (QueryPerformanceCounter).
- Session stores:
  - `start_wall_ms`
  - `start_perf_counter`
  - `perf_frequency`
- Convert to "session-relative time" for UI playback.
- Optional: "sync marker" hotkey that logs a marker and (optionally) plays a beep in OBS
  so alignment can be validated once per session.

## Event Types
Event data is normalized (base fields) plus a JSON payload for specifics.

Base fields:
- `ts_wall_ms` (int)
- `ts_mono_ms` (int)
- `event_type` (text)
- `process_name` (text, optional)
- `window_title` (text, optional)
- `window_class` (text, optional)
- `window_rect` (json, optional)
- `mouse` (json: x, y, screen_id, buttons, wheel, optional)
- `payload` (json)

Types:
- `mouse_move` (rate-limited, e.g., 30-60 Hz)
- `mouse_click` (button, down/up, position)
- `mouse_scroll` (delta, position)
- `key_shortcut` (Ctrl+X, Alt+Tab, etc)
- `text_input` (reconstructed, safe only)
- `active_window_changed`
- `window_rect_changed`
- `ui_element_hover` (name, control_type, class, is_password)
- `snapshot` (1 Hz state snapshot)
- `marker` (manual "interesting" moment with optional note)
- `session_start`, `session_stop`

## Storage Schema (SQLite)
Suggested tables:

sessions
- id INTEGER PRIMARY KEY
- session_id TEXT UNIQUE
- start_wall_ms INTEGER
- start_perf_counter INTEGER
- perf_frequency INTEGER
- obs_video_path TEXT
- notes TEXT

events
- id INTEGER PRIMARY KEY
- session_id TEXT
- ts_wall_ms INTEGER
- ts_mono_ms INTEGER
- event_type TEXT
- process_name TEXT
- window_title TEXT
- window_class TEXT
- window_rect TEXT (JSON)
- mouse TEXT (JSON)
- payload TEXT (JSON)
- FOREIGN KEY(session_id) REFERENCES sessions(session_id)

indexes:
- events(session_id, ts_mono_ms)
- events(session_id, event_type)

## Safe Text Reconstruction
Default behavior: only emit reconstructed text when safe.
- Use UI Automation to check:
  - `IsPassword` flag or password control type.
  - Process allowlist/blocklist (config).
- Log shortcuts separately.
- Config toggles:
  - `safe_text_only` (default true)
  - `raw_keys` (default false)
  - `blocklist_processes`
  - `allowlist_processes`

## Performance and Batching
- Use a bounded channel between hooks and DB writer.
- Batch inserts (e.g., 100-500 events or 250ms) for performance.
- Enable WAL and set a busy timeout.
- Drop or coalesce high-frequency mouse moves if queue is full.

## Manual Control
Manual start/stop via:
- Tray icon or CLI `timestone_recorder start/stop`.
- Hotkey to add markers (user-defined).

## Integration with Player
UI steps:
- Load transcript from video.
- Load events for the same session id.
- "At time t" show:
  - Active window info
  - Last text input / shortcut
  - Mouse position
  - Marker notes

## Milestones
M0: Scaffolding
- Rust crate `tools/timestone_recorder` with CLI and config stubs.
- Basic DB initialization and session start/stop.

M1: Input + snapshots
- Mouse and keyboard hooks.
- 1 Hz snapshot loop for active window + cursor.

M2: Window and UIA
- WinEvent hooks for focus/rect changes.
- UI Automation element under cursor.

M3: Privacy controls
- Safe text reconstruction logic and allow/block list config.

M4: Player integration
- Simple API to query events by time range.
- UI panel to display event context.

## Open Questions
- Preferred storage location for sessions? (`data/timestone` default)
- Marker hotkey choice?
- How to associate OBS video path with session (manual selection or config)?
