import argparse
import ctypes
import json
import os
import sqlite3
import subprocess
import sys
import time
from typing import Any, Iterable, List, Optional, Tuple


def add_dll_search_paths() -> None:
    script_dir = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.abspath(os.path.join(script_dir, "..", ".."))
    missing = []
    cuda_env = os.environ.get("CUDA_PATH")
    cudnn_env = os.environ.get("CUDNN_PATH")
    candidates = [
        ("repo_root", repo_root),
        ("CUDA_PATH", cuda_env),
        ("CUDNN_PATH", cudnn_env),
    ]
    for label, candidate in candidates:
        if not candidate:
            missing.append(f"{label}=<unset>")
            continue
        try:
            if os.path.isdir(candidate):
                os.add_dll_directory(candidate)
            else:
                missing.append(f"{label}={candidate}")
        except Exception:
            missing.append(f"{label}={candidate}")
            continue
    if missing:
        sys.stderr.write(
            "Warning: DLL search paths missing or invalid: "
            + ", ".join(missing)
            + "\n"
        )


add_dll_search_paths()

def log_env_context(repo_root: str) -> None:
    sys.stderr.write(f"[transcripts] python={sys.executable}\n")
    sys.stderr.write(f"[transcripts] cwd={os.getcwd()}\n")
    sys.stderr.write(f"[transcripts] repo_root={repo_root}\n")
    sys.stderr.flush()


def preflight_cuda(repo_root: str) -> Optional[str]:
    if os.name != "nt":
        return None
    dll_name = "cudnn_ops64_9.dll"
    candidates = [
        os.path.join(repo_root, dll_name),
        os.path.join(os.environ.get("CUDNN_PATH", ""), "bin", dll_name),
    ]
    if not any(path for path in candidates if path and os.path.exists(path)):
        return f"{dll_name} not found in repo_root or CUDNN_PATH\\bin"
    try:
        ctypes.WinDLL(dll_name)
    except Exception as exc:
        return f"Failed to load {dll_name}: {exc}"
    return None


from faster_whisper import WhisperModel


def now_ms() -> int:
    return int(time.time() * 1000)

def hard_exit(code: int) -> None:
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception:
        pass
    os._exit(code)

def ensure_db(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS transcription_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            video_path TEXT NOT NULL,
            model TEXT NOT NULL,
            status TEXT NOT NULL,
            progress REAL NOT NULL DEFAULT 0,
            duration_s REAL,
            started_ms INTEGER,
            ended_ms INTEGER,
            error TEXT,
            last_update_ms INTEGER
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS transcriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id INTEGER NOT NULL,
            video_path TEXT NOT NULL,
            model TEXT NOT NULL,
            start_ms INTEGER NOT NULL,
            end_ms INTEGER NOT NULL,
            text TEXT NOT NULL,
            created_ms INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_transcriptions_video ON transcriptions(video_path)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_transcriptions_run ON transcriptions(run_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_runs_video ON transcription_runs(video_path)"
    )
    cols = [row[1] for row in conn.execute("PRAGMA table_info(transcription_runs)").fetchall()]
    if "last_update_ms" not in cols:
        conn.execute("ALTER TABLE transcription_runs ADD COLUMN last_update_ms INTEGER")
    conn.commit()


def ffprobe_duration(path: str) -> Optional[float]:
    ffprobe = os.environ.get("FFPROBE") or os.environ.get("FFMPEG_PATH", "ffmpeg")
    if ffprobe.lower().endswith("ffmpeg") or ffprobe.lower().endswith("ffmpeg.exe"):
        ffprobe = ffprobe[:-6] + "ffprobe" + (".exe" if ffprobe.lower().endswith(".exe") else "")
    args = [
        ffprobe,
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        path,
    ]
    try:
        if os.name == "nt":
            out = subprocess.run(
                args, capture_output=True, text=True, check=False, creationflags=subprocess.CREATE_NO_WINDOW
            )
        else:
            out = subprocess.run(args, capture_output=True, text=True, check=False)
    except Exception:
        return None
    if out.returncode != 0:
        return None
    try:
        value = float(out.stdout.strip())
        return value if value > 0 else None
    except Exception:
        return None


def insert_run(conn: sqlite3.Connection, video_path: str, model: str, duration_s: Optional[float]) -> int:
    cur = conn.execute(
        """
        INSERT INTO transcription_runs (video_path, model, status, progress, duration_s, started_ms, last_update_ms)
        VALUES (?, ?, 'running', 0, ?, ?, ?)
        """,
        (video_path, model, duration_s, now_ms(), now_ms()),
    )
    conn.commit()
    return int(cur.lastrowid)


def update_run(
    conn: sqlite3.Connection,
    run_id: int,
    *,
    status: Optional[str] = None,
    progress: Optional[float] = None,
    error: Optional[str] = None,
) -> None:
    fields = []
    params: List[object] = []
    if status is not None:
        fields.append("status = ?")
        params.append(status)
    if progress is not None:
        fields.append("progress = ?")
        params.append(progress)
    if error is not None:
        fields.append("error = ?")
        params.append(error)
    fields.append("last_update_ms = ?")
    params.append(now_ms())
    if not fields:
        return
    params.append(run_id)
    conn.execute(f"UPDATE transcription_runs SET {', '.join(fields)} WHERE id = ?", params)
    conn.commit()


def finalize_run(conn: sqlite3.Connection, run_id: int, status: str, error: Optional[str] = None) -> None:
    conn.execute(
        """
        UPDATE transcription_runs
        SET status = ?, ended_ms = ?, progress = ?, error = ?, last_update_ms = ?
        WHERE id = ?
        """,
        (status, now_ms(), 1.0 if status == "done" else 0.0, error, now_ms(), run_id),
    )
    conn.commit()


def insert_segment(
    conn: sqlite3.Connection,
    run_id: int,
    video_path: str,
    model: str,
    start_ms: int,
    end_ms: int,
    text: str,
) -> None:
    conn.execute(
        """
        INSERT INTO transcriptions (run_id, video_path, model, start_ms, end_ms, text, created_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (run_id, video_path, model, start_ms, end_ms, text, now_ms()),
    )


def transcribe_video(
    model: Any,
    conn: sqlite3.Connection,
    video_path: str,
    model_name: str,
    language: Optional[str],
) -> Tuple[int, int]:
    duration_s = ffprobe_duration(video_path)
    run_id = insert_run(conn, video_path, model_name, duration_s)
    segments_saved = 0
    last_progress = 0.0
    try:
        segments, _ = model.transcribe(
            video_path,
            language=language or None,
            beam_size=5,
            word_timestamps=False,
        )
        for seg in segments:
            text = (seg.text or "").strip()
            if not text:
                continue
            start_ms = int(seg.start * 1000)
            end_ms = int(seg.end * 1000)
            insert_segment(conn, run_id, video_path, model_name, start_ms, end_ms, text)
            segments_saved += 1
            if duration_s:
                progress = min(max(seg.end / duration_s, 0.0), 1.0)
                if progress - last_progress >= 0.01:
                    update_run(conn, run_id, progress=progress)
                    last_progress = progress
        conn.commit()
        finalize_run(conn, run_id, "done", None)
        return run_id, segments_saved
    except Exception as exc:
        conn.rollback()
        finalize_run(conn, run_id, "error", str(exc))
        return run_id, segments_saved


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Transcribe OBS videos into timestone_transcripts DB.")
    parser.add_argument("--db", required=True, help="Path to timestone_transcripts.sqlite3")
    parser.add_argument("--video", action="append", required=True, help="Path to a video file (repeatable)")
    parser.add_argument("--model", default="medium", help="Whisper model (e.g. medium, large-v2)")
    parser.add_argument("--language", default="", help="Optional language code")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    db_path = args.db
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path)
    ensure_db(conn)

    script_dir = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.abspath(os.path.join(script_dir, "..", ".."))
    log_env_context(repo_root)
    cuda_error = preflight_cuda(repo_root)
    if cuda_error:
        sys.stderr.write(f"[transcripts] preflight_error={cuda_error}\n")
        sys.stderr.flush()
        for video_path in args.video:
            if not os.path.isfile(video_path):
                continue
            run_id = insert_run(conn, video_path, args.model, ffprobe_duration(video_path))
            finalize_run(conn, run_id, "error", cuda_error)
        hard_exit(1)

    language = args.language.strip() or None
    model_name = args.model
    model = WhisperModel(model_name)

    results = []
    for video_path in args.video:
        if not os.path.isfile(video_path):
            results.append({"video": video_path, "error": "file not found"})
            continue
        run_id, segments_saved = transcribe_video(model, conn, video_path, model_name, language)
        results.append({"video": video_path, "run_id": run_id, "segments": segments_saved})

    print(json.dumps({"ok": True, "results": results}))
    hard_exit(0)


if __name__ == "__main__":
    raise SystemExit(main())
