#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from path_utils import canonicalize_path
DEFAULT_CONFIG_PATH = PROJECT_ROOT / "mkv_ingest_config.json"
ISO_FMT = "%Y-%m-%dT%H:%M:%S%z"


DEFAULT_CONFIG: Dict[str, Any] = {
    "db_path": str(PROJECT_ROOT / "data" / "mkv_ingest.sqlite3"),
    "frames_dir": str(PROJECT_ROOT / "data" / "frames"),
    "save_frames": True,
    "frame_format": "jpg",
    "jpeg_quality": 92,
    "dedup_enabled": True,
    "dedup_threshold": 0.006,
    "ocr_engine": "tesseract",
    "ocr_language": "eng",
    "ocr_save_line_boxes": False,
    "transcribe_audio": True,
    "whisper_model_size": "medium",
    "whisper_device": "cuda",
    "whisper_compute_type": "float16",
    "tesseract_path": "",
    "ffmpeg_path": "",
    "ffprobe_path": "",
}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime(ISO_FMT)


def resolve_path(raw: str | Path) -> Path:
    p = Path(str(raw)).expanduser()
    if p.is_absolute():
        return p
    return (PROJECT_ROOT / p).resolve()


def load_config(path: Optional[Path]) -> Dict[str, Any]:
    cfg = dict(DEFAULT_CONFIG)
    if path is None:
        path = DEFAULT_CONFIG_PATH if DEFAULT_CONFIG_PATH.exists() else None
    if path and path.exists():
        with path.open("r", encoding="utf-8") as fh:
            loaded = json.load(fh)
        if isinstance(loaded, dict):
            cfg.update(loaded)
    return cfg


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Ingest an MKV/MP4 into a local OCR+transcript database.")
    parser.add_argument("--video", required=True, help="Path to the source video file (MKV/MP4).")
    parser.add_argument("--config", help="Path to mkv_ingest_config.json (optional).")
    parser.add_argument("--db-path", help="SQLite database path override.")
    parser.add_argument("--frames-dir", help="Base directory for saved frames.")
    parser.add_argument("--no-save-frames", action="store_true", help="Do not save JPEGs for kept frames.")
    parser.add_argument("--no-dedup", action="store_true", help="Disable frame deduplication.")
    parser.add_argument("--dedup-threshold", type=float, help="Dedup threshold (default 0.006).")
    parser.add_argument("--save-line-boxes", action="store_true", help="Store line-level OCR boxes.")
    parser.add_argument("--no-transcribe-audio", action="store_true", help="Skip audio transcription.")
    parser.add_argument("--whisper-model-size", help="Whisper model size (e.g., small, medium, large-v3).")
    parser.add_argument("--whisper-device", help="Whisper device (cuda/cpu).")
    parser.add_argument("--whisper-compute-type", help="Whisper compute type (float16/int8).")
    parser.add_argument("--ffmpeg", help="Override ffmpeg path.")
    parser.add_argument("--ffprobe", help="Override ffprobe path.")
    parser.add_argument("--overwrite", action="store_true", help="Delete existing records for this video.")
    return parser.parse_args()


def apply_overrides(cfg: Dict[str, Any], args: argparse.Namespace) -> Dict[str, Any]:
    if args.db_path:
        cfg["db_path"] = args.db_path
    if args.frames_dir:
        cfg["frames_dir"] = args.frames_dir
    if args.no_save_frames:
        cfg["save_frames"] = False
    if args.no_dedup:
        cfg["dedup_enabled"] = False
    if args.dedup_threshold is not None:
        cfg["dedup_threshold"] = float(args.dedup_threshold)
    if args.save_line_boxes:
        cfg["ocr_save_line_boxes"] = True
    if args.no_transcribe_audio:
        cfg["transcribe_audio"] = False
    if args.whisper_model_size:
        cfg["whisper_model_size"] = args.whisper_model_size
    if args.whisper_device:
        cfg["whisper_device"] = args.whisper_device
    if args.whisper_compute_type:
        cfg["whisper_compute_type"] = args.whisper_compute_type
    if args.ffmpeg:
        cfg["ffmpeg_path"] = args.ffmpeg
    if args.ffprobe:
        cfg["ffprobe_path"] = args.ffprobe
    return cfg


def ensure_db_dir(db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)


def open_db(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA synchronous = NORMAL;")
    return conn


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS video_chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT NOT NULL,
            device_name TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS frames (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            video_chunk_id INTEGER NOT NULL,
            offset_index INTEGER NOT NULL,
            timestamp TIMESTAMP NOT NULL,
            name TEXT,
            browser_url TEXT DEFAULT NULL,
            app_name TEXT DEFAULT NULL,
            window_name TEXT DEFAULT NULL,
            focused BOOLEAN DEFAULT NULL,
            device_name TEXT NOT NULL DEFAULT '',
            FOREIGN KEY (video_chunk_id) REFERENCES video_chunks(id) ON DELETE CASCADE
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS frames_fts USING fts5(
            name,
            browser_url,
            app_name,
            window_name,
            focused,
            id UNINDEXED,
            tokenize='unicode61'
        );

        CREATE TABLE IF NOT EXISTS ocr_text (
            frame_id INTEGER NOT NULL,
            text TEXT NOT NULL,
            text_json TEXT,
            app_name TEXT NOT NULL DEFAULT '',
            ocr_engine TEXT NOT NULL DEFAULT 'unknown',
            window_name TEXT,
            focused BOOLEAN DEFAULT FALSE,
            text_length INTEGER,
            FOREIGN KEY (frame_id) REFERENCES frames(id) ON DELETE CASCADE
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS ocr_text_fts USING fts5(
            text,
            app_name,
            window_name,
            frame_id UNINDEXED,
            tokenize='unicode61'
        );

        CREATE TABLE IF NOT EXISTS ocr_boxes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            frame_id INTEGER NOT NULL,
            level INTEGER NOT NULL,
            page_num INTEGER NOT NULL,
            block_num INTEGER NOT NULL,
            par_num INTEGER NOT NULL,
            line_num INTEGER NOT NULL,
            word_num INTEGER NOT NULL,
            left INTEGER NOT NULL,
            top INTEGER NOT NULL,
            width INTEGER NOT NULL,
            height INTEGER NOT NULL,
            conf REAL,
            text TEXT NOT NULL DEFAULT '',
            FOREIGN KEY (frame_id) REFERENCES frames(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS video_metadata (
            video_chunk_id INTEGER PRIMARY KEY,
            fps REAL,
            duration REAL,
            width INTEGER,
            height INTEGER,
            frame_count INTEGER,
            kept_frames INTEGER,
            creation_time TEXT,
            creation_time_source TEXT,
            FOREIGN KEY (video_chunk_id) REFERENCES video_chunks(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS audio_sessions (
            id INTEGER PRIMARY KEY,
            title TEXT,
            file_path TEXT,
            device TEXT,
            sample_rate INTEGER,
            channels INTEGER,
            model TEXT,
            start_time TEXT NOT NULL,
            end_time TEXT,
            status TEXT DEFAULT 'active'
        );

        CREATE TABLE IF NOT EXISTS audio_transcriptions (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            model_size TEXT NOT NULL,
            transcription TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(name, model_size)
        );

        CREATE TABLE IF NOT EXISTS api_transcriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            model_size TEXT NOT NULL,
            transcription TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(name, model_size)
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS audio_transcriptions_fts
        USING fts5(transcription, content='audio_transcriptions', content_rowid='id');

        CREATE TRIGGER IF NOT EXISTS audio_transcriptions_ai
        AFTER INSERT ON audio_transcriptions BEGIN
            INSERT INTO audio_transcriptions_fts(rowid, transcription)
            VALUES (new.id, new.transcription);
        END;

        CREATE TRIGGER IF NOT EXISTS audio_transcriptions_ad
        AFTER DELETE ON audio_transcriptions BEGIN
            INSERT INTO audio_transcriptions_fts(audio_transcriptions_fts, rowid, transcription)
            VALUES('delete', old.id, old.transcription);
        END;

        CREATE TRIGGER IF NOT EXISTS audio_transcriptions_au
        AFTER UPDATE ON audio_transcriptions BEGIN
            INSERT INTO audio_transcriptions_fts(audio_transcriptions_fts, rowid, transcription)
            VALUES('delete', old.id, old.transcription);
            INSERT INTO audio_transcriptions_fts(rowid, transcription)
            VALUES (new.id, new.transcription);
        END;

        CREATE TRIGGER IF NOT EXISTS frames_ai AFTER INSERT ON frames BEGIN
            INSERT INTO frames_fts(id, name, browser_url, app_name, window_name, focused)
            VALUES (
                NEW.id,
                COALESCE(NEW.name, ''),
                COALESCE(NEW.browser_url, ''),
                COALESCE(NEW.app_name, ''),
                COALESCE(NEW.window_name, ''),
                COALESCE(NEW.focused, 0)
            );
        END;

        CREATE TRIGGER IF NOT EXISTS frames_au AFTER UPDATE ON frames
        WHEN (NEW.name IS NOT NULL AND NEW.name != '')
           OR (NEW.browser_url IS NOT NULL AND NEW.browser_url != '')
           OR (NEW.app_name IS NOT NULL AND NEW.app_name != '')
           OR (NEW.window_name IS NOT NULL AND NEW.window_name != '')
           OR (NEW.focused IS NOT NULL)
        BEGIN
            INSERT OR REPLACE INTO frames_fts(id, name, browser_url, app_name, window_name, focused)
            VALUES (
                NEW.id,
                COALESCE(NEW.name, ''),
                COALESCE(NEW.browser_url, ''),
                COALESCE(NEW.app_name, ''),
                COALESCE(NEW.window_name, ''),
                COALESCE(NEW.focused, 0)
            );
        END;

        CREATE TRIGGER IF NOT EXISTS frames_ad AFTER DELETE ON frames
        BEGIN
            DELETE FROM frames_fts WHERE id = OLD.id;
        END;

        CREATE TRIGGER IF NOT EXISTS ocr_text_ai AFTER INSERT ON ocr_text
        WHEN NEW.text IS NOT NULL AND NEW.text != '' AND NEW.frame_id IS NOT NULL
        BEGIN
            INSERT OR IGNORE INTO ocr_text_fts(frame_id, text, app_name, window_name)
            VALUES (
                NEW.frame_id,
                NEW.text,
                COALESCE(NEW.app_name, ''),
                COALESCE(NEW.window_name, '')
            );
        END;

        CREATE TRIGGER IF NOT EXISTS ocr_text_update AFTER UPDATE ON ocr_text
        WHEN NEW.text IS NOT NULL AND NEW.text != '' AND OLD.frame_id IS NOT NULL
        BEGIN
            UPDATE ocr_text_fts
            SET text = NEW.text,
                app_name = COALESCE(NEW.app_name, ''),
                window_name = COALESCE(NEW.window_name, '')
            WHERE frame_id = OLD.frame_id;
        END;

        CREATE TRIGGER IF NOT EXISTS ocr_text_delete AFTER DELETE ON ocr_text
        BEGIN
            DELETE FROM ocr_text_fts WHERE frame_id = OLD.frame_id;
        END;

        CREATE INDEX IF NOT EXISTS idx_frames_video_chunk_id ON frames(video_chunk_id);
        CREATE INDEX IF NOT EXISTS idx_frames_timestamp ON frames(timestamp);
        CREATE INDEX IF NOT EXISTS idx_frames_timestamp_offset_index ON frames(timestamp, offset_index);
        CREATE INDEX IF NOT EXISTS idx_ocr_text_frame_id ON ocr_text(frame_id);
        CREATE INDEX IF NOT EXISTS idx_ocr_text_length ON ocr_text(text_length);
        CREATE INDEX IF NOT EXISTS idx_ocr_boxes_frame_id ON ocr_boxes(frame_id);
        """
    )
    conn.commit()


def get_tool_path(config_value: str, env_key: str, fallback: str) -> str:
    if config_value:
        return config_value
    env_val = os.environ.get(env_key)
    if env_val:
        return env_val
    return fallback


def resolve_tesseract_cmd(config_value: str) -> Optional[str]:
    if config_value:
        return config_value
    env_val = os.environ.get("TESSERACT_CMD") or os.environ.get("TESSERACT_PATH")
    if env_val:
        return env_val
    candidates = [
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
    ]
    for cand in candidates:
        if Path(cand).exists():
            return cand
    return None


def parse_fraction(value: str) -> Optional[float]:
    if not value:
        return None
    if "/" in value:
        parts = value.split("/", 1)
        try:
            num = float(parts[0])
            den = float(parts[1])
            if den == 0:
                return None
            return num / den
        except ValueError:
            return None
    try:
        return float(value)
    except ValueError:
        return None


def parse_creation_time(raw: Optional[str]) -> Tuple[Optional[datetime], str]:
    if not raw:
        return None, "missing"
    raw = raw.strip()
    candidates = [
        raw.replace("Z", "+00:00"),
        raw,
    ]
    for cand in candidates:
        try:
            dt = datetime.fromisoformat(cand)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc), "ffprobe"
        except ValueError:
            continue
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M:%S.%f"):
        try:
            dt = datetime.strptime(raw, fmt).replace(tzinfo=timezone.utc)
            return dt, "ffprobe"
        except ValueError:
            continue
    return None, "unparsed"


def ffprobe_metadata(video_path: Path, ffprobe: str) -> Dict[str, Any]:
    cmd = [
        ffprobe,
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,avg_frame_rate,r_frame_rate,nb_frames",
        "-show_entries",
        "format=duration:format_tags=creation_time",
        "-of",
        "json",
        str(video_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {proc.stderr.strip()}")
    payload = json.loads(proc.stdout or "{}")
    stream = (payload.get("streams") or [{}])[0]
    fmt = payload.get("format") or {}
    tags = fmt.get("tags") or {}
    fps = parse_fraction(stream.get("avg_frame_rate")) or parse_fraction(stream.get("r_frame_rate")) or 0.0
    duration = float(fmt.get("duration") or 0.0)
    width = int(stream.get("width") or 0)
    height = int(stream.get("height") or 0)
    nb_frames = stream.get("nb_frames")
    frame_count = int(nb_frames) if nb_frames and str(nb_frames).isdigit() else None
    creation_time, creation_source = parse_creation_time(tags.get("creation_time"))
    return {
        "fps": fps,
        "duration": duration,
        "width": width,
        "height": height,
        "frame_count": frame_count,
        "creation_time": creation_time,
        "creation_source": creation_source,
    }


def ensure_creation_time(video_path: Path, meta: Dict[str, Any]) -> Tuple[datetime, str]:
    if meta.get("creation_time"):
        return meta["creation_time"], meta.get("creation_source", "ffprobe")
    ts = datetime.fromtimestamp(video_path.stat().st_mtime, tz=timezone.utc)
    return ts, "mtime"


def get_or_create_video_chunk(conn: sqlite3.Connection, video_path: Path) -> int:
    row = conn.execute("SELECT id FROM video_chunks WHERE file_path = ?", (str(video_path),)).fetchone()
    if row:
        return int(row["id"])
    cur = conn.execute(
        "INSERT INTO video_chunks (file_path, device_name) VALUES (?, ?)",
        (str(video_path), ""),
    )
    conn.commit()
    return int(cur.lastrowid)


def delete_existing_video(conn: sqlite3.Connection, video_chunk_id: int, video_path: Path) -> None:
    conn.execute("DELETE FROM frames WHERE video_chunk_id = ?", (video_chunk_id,))
    conn.execute("DELETE FROM video_metadata WHERE video_chunk_id = ?", (video_chunk_id,))
    conn.execute("DELETE FROM audio_sessions WHERE file_path = ?", (str(video_path),))
    conn.execute(
        "DELETE FROM audio_transcriptions WHERE name = ?",
        (canonicalize_path(video_path),),
    )
    conn.commit()


def extract_frames(ffmpeg: str, video_path: Path, dest_dir: Path) -> List[Path]:
    dest_dir.mkdir(parents=True, exist_ok=True)
    pattern = dest_dir / "frame_%06d.png"
    cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(video_path),
        "-vsync",
        "0",
        str(pattern),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg frame extraction failed: {proc.stderr.strip()}")
    frames = sorted(dest_dir.glob("frame_*.png"))
    if not frames:
        raise RuntimeError("Frame extraction produced no files.")
    return frames


def extract_audio(ffmpeg: str, video_path: Path, wav_path: Path) -> None:
    cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(video_path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "wav",
        str(wav_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg audio extract failed: {proc.stderr.strip()}")


def frame_index_from_path(path: Path) -> Optional[int]:
    match = re.search(r"frame_(\d+)\.png$", path.name)
    if not match:
        return None
    return int(match.group(1)) - 1


def build_output_dir(base_dir: Path, video_path: Path) -> Path:
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_name = re.sub(r"[^A-Za-z0-9_-]+", "_", video_path.stem)
    return base_dir / f"{safe_name}_{stamp}"


def histogram_distance(gray_a: Any, gray_b: Any) -> float:
    import numpy as np
    hist_a, _ = np.histogram(gray_a.flatten(), bins=256, range=(0, 255))
    hist_b, _ = np.histogram(gray_b.flatten(), bins=256, range=(0, 255))
    hist_a = hist_a.astype(np.float64)
    hist_b = hist_b.astype(np.float64)
    sum_a = hist_a.sum()
    sum_b = hist_b.sum()
    if sum_a == 0 or sum_b == 0:
        return 1.0
    hist_a /= sum_a
    hist_b /= sum_b
    bc = np.sum(np.sqrt(hist_a * hist_b))
    bc = np.clip(bc, 0.0, 1.0)
    return float(np.sqrt(max(0.0, 1.0 - bc)))


def compute_frame_delta(prev_gray: Any, curr_gray: Any) -> float:
    from skimage.metrics import structural_similarity as ssim
    if prev_gray.shape != curr_gray.shape:
        return 1.0
    hist_diff = histogram_distance(prev_gray, curr_gray)
    ssim_score = ssim(prev_gray, curr_gray, data_range=255)
    ssim_diff = 1.0 - float(ssim_score)
    return (hist_diff + ssim_diff) / 2.0


def ocr_tesseract(image: Any, lang: str) -> Tuple[str, str, List[Dict[str, Any]]]:
    import pytesseract
    from pytesseract import Output
    data = pytesseract.image_to_data(image, lang=lang, output_type=Output.DICT)
    words: List[str] = []
    boxes: List[Dict[str, Any]] = []
    for i, raw_text in enumerate(data.get("text", [])):
        text = (raw_text or "").strip()
        level = int(data.get("level", [0])[i] or 0)
        conf_raw = data.get("conf", ["-1"])[i]
        conf = None
        try:
            conf_val = float(conf_raw)
            conf = conf_val if conf_val >= 0 else None
        except ValueError:
            conf = None
        if level == 5 and text:
            words.append(text)
        if level == 5 and text:
            boxes.append(
                {
                    "level": level,
                    "page_num": int(data.get("page_num", [0])[i] or 0),
                    "block_num": int(data.get("block_num", [0])[i] or 0),
                    "par_num": int(data.get("par_num", [0])[i] or 0),
                    "line_num": int(data.get("line_num", [0])[i] or 0),
                    "word_num": int(data.get("word_num", [0])[i] or 0),
                    "left": int(data.get("left", [0])[i] or 0),
                    "top": int(data.get("top", [0])[i] or 0),
                    "width": int(data.get("width", [0])[i] or 0),
                    "height": int(data.get("height", [0])[i] or 0),
                    "conf": conf,
                    "text": text,
                }
            )
    text = " ".join(words)
    text_json = json.dumps(
        {
            "data": data,
            "image": {"width": image.width, "height": image.height},
        }
    )
    return text, text_json, boxes


def aggregate_line_boxes(word_boxes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    grouped: Dict[Tuple[int, int, int], List[Dict[str, Any]]] = {}
    for box in word_boxes:
        if box["level"] != 5:
            continue
        key = (box["block_num"], box["par_num"], box["line_num"])
        grouped.setdefault(key, []).append(box)
    lines: List[Dict[str, Any]] = []
    for (block_num, par_num, line_num), boxes in grouped.items():
        left = min(b["left"] for b in boxes)
        top = min(b["top"] for b in boxes)
        right = max(b["left"] + b["width"] for b in boxes)
        bottom = max(b["top"] + b["height"] for b in boxes)
        text = " ".join([b["text"] for b in boxes if b["text"]])
        lines.append(
            {
                "level": 4,
                "page_num": boxes[0]["page_num"],
                "block_num": block_num,
                "par_num": par_num,
                "line_num": line_num,
                "word_num": 0,
                "left": left,
                "top": top,
                "width": right - left,
                "height": bottom - top,
                "conf": None,
                "text": text,
            }
        )
    return lines


def insert_audio_session(
    conn: sqlite3.Connection,
    video_path: Path,
    model_label: str,
    start_time: datetime,
    end_time: datetime,
) -> int:
    cur = conn.execute(
        """
        INSERT INTO audio_sessions (title, file_path, device, sample_rate, channels, model, start_time, end_time, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            f"Video {video_path.name}",
            str(video_path),
            "file",
            16000,
            1,
            model_label,
            start_time.strftime(ISO_FMT),
            end_time.strftime(ISO_FMT),
            "completed",
        ),
    )
    conn.commit()
    return int(cur.lastrowid)


def upsert_transcription(
    conn: sqlite3.Connection,
    name: str,
    model_size: str,
    transcription: str,
) -> None:
    conn.execute(
        """
        INSERT INTO audio_transcriptions (name, model_size, transcription, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(name, model_size)
        DO UPDATE SET transcription = excluded.transcription, created_at = excluded.created_at
        """,
        (canonicalize_path(name), model_size, transcription, utc_now_iso()),
    )
    conn.commit()


def transcribe_audio(
    ffmpeg: str,
    video_path: Path,
    cfg: Dict[str, Any],
    conn: sqlite3.Connection,
    start_time: datetime,
    duration: float,
) -> None:
    model_size = cfg["whisper_model_size"]
    device = cfg["whisper_device"]
    compute_type = cfg["whisper_compute_type"]

    with tempfile.TemporaryDirectory(prefix="mkv_audio_") as tmpdir:
        wav_path = Path(tmpdir) / "audio.wav"
        extract_audio(ffmpeg, video_path, wav_path)
        try:
            from faster_whisper import WhisperModel

            model = WhisperModel(model_size, device=device, compute_type=compute_type)
        except Exception:
            if device != "cpu":
                from faster_whisper import WhisperModel

                model = WhisperModel(model_size, device="cpu", compute_type="int8")
            else:
                raise

        segments, _info = model.transcribe(
            audio=str(wav_path),
            beam_size=5,
            language="en",
            word_timestamps=False,
        )
        lines: List[str] = []
        for seg in segments:
            text = (seg.text or "").strip()
            if not text:
                continue
            lines.append(f"[{seg.start:.2f}s -> {seg.end:.2f}s]  {text}")

        if not lines:
            return

        model_label = f"faster-whisper:{model_size}/{compute_type}"
        end_time = start_time + timedelta(seconds=duration)
        insert_audio_session(conn, video_path, model_label, start_time, end_time)
        upsert_transcription(conn, str(video_path), model_size, "\n".join(lines))


def main() -> int:
    args = parse_args()
    cfg = load_config(resolve_path(args.config) if args.config else None)
    cfg = apply_overrides(cfg, args)

    try:
        import numpy as np
        from PIL import Image
    except ModuleNotFoundError as exc:
        raise SystemExit(
            "Missing Python deps. Activate the venv and install from requirements_mkv_ingest.txt."
        ) from exc

    tesseract_cmd = resolve_tesseract_cmd(str(cfg.get("tesseract_path", "")).strip())
    if tesseract_cmd:
        try:
            import pytesseract

            pytesseract.pytesseract.tesseract_cmd = tesseract_cmd
        except ModuleNotFoundError:
            raise SystemExit(
                "pytesseract is missing. Activate the venv and install from requirements_mkv_ingest.txt."
            )

    video_path = resolve_path(args.video)
    if not video_path.exists():
        raise SystemExit(f"Video file not found: {video_path}")

    print(f"[mkv_ingest] video: {video_path}")

    db_path = resolve_path(cfg["db_path"])
    frames_base = resolve_path(cfg["frames_dir"])
    save_frames = bool(cfg["save_frames"])

    ffmpeg = get_tool_path(cfg.get("ffmpeg_path", ""), "FFMPEG", "ffmpeg")
    ffprobe = get_tool_path(cfg.get("ffprobe_path", ""), "FFPROBE", "ffprobe")

    ensure_db_dir(db_path)
    conn = open_db(db_path)
    ensure_schema(conn)

    video_chunk_id = get_or_create_video_chunk(conn, video_path)
    if args.overwrite:
        delete_existing_video(conn, video_chunk_id, video_path)

    meta = ffprobe_metadata(video_path, ffprobe)
    start_time, creation_source = ensure_creation_time(video_path, meta)
    fps = meta.get("fps") or 0.0
    duration = meta.get("duration") or 0.0
    width = meta.get("width") or 0
    height = meta.get("height") or 0
    frame_count_hint = meta.get("frame_count")
    if fps <= 0.0 and frame_count_hint and duration > 0:
        fps = frame_count_hint / duration
    if fps <= 0.0:
        fps = 1.0

    output_dir = None
    if save_frames:
        output_dir = build_output_dir(frames_base, video_path)
        output_dir.mkdir(parents=True, exist_ok=True)
        print(f"[mkv_ingest] saving frames to: {output_dir}")

    with tempfile.TemporaryDirectory(prefix="mkv_frames_") as tmpdir:
        frame_dir = Path(tmpdir)
        frame_paths = extract_frames(ffmpeg, video_path, frame_dir)
        print(f"[mkv_ingest] extracted {len(frame_paths)} frames")

        dedup_enabled = bool(cfg["dedup_enabled"])
        dedup_threshold = float(cfg["dedup_threshold"])
        save_line_boxes = bool(cfg["ocr_save_line_boxes"])
        frame_format = str(cfg["frame_format"]).lower()

        prev_gray: Optional[np.ndarray] = None
        kept_frames = 0

        conn.execute("BEGIN")
        for idx, frame_path in enumerate(frame_paths, start=1):
            frame_index = frame_index_from_path(frame_path)
            if frame_index is None:
                continue

            with Image.open(frame_path) as img:
                img = img.convert("RGB")
                gray = np.array(img.convert("L"))

                should_keep = True
                if dedup_enabled and prev_gray is not None:
                    delta = compute_frame_delta(prev_gray, gray)
                    if delta < dedup_threshold:
                        should_keep = False

                if not should_keep:
                    continue

                prev_gray = gray
                kept_frames += 1

                frame_ts = start_time + timedelta(seconds=frame_index / max(fps, 1e-6))
                stored_path = None
                if save_frames and output_dir is not None:
                    fname = f"frame_{frame_index:06d}.{frame_format}"
                    stored_path = output_dir / fname
                    if frame_format in {"jpg", "jpeg"}:
                        img.save(
                            stored_path,
                            format="JPEG",
                            quality=int(cfg["jpeg_quality"]),
                            optimize=True,
                        )
                    else:
                        img.save(stored_path, format=frame_format.upper())

                cur = conn.execute(
                    """
                    INSERT INTO frames (video_chunk_id, offset_index, timestamp, name, device_name)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        video_chunk_id,
                        frame_index,
                        frame_ts.isoformat(),
                        str(stored_path.resolve()) if stored_path else None,
                        "",
                    ),
                )
                frame_id = int(cur.lastrowid)

                text, text_json, boxes = ocr_tesseract(img, cfg["ocr_language"])
                if text:
                    conn.execute(
                        """
                        INSERT INTO ocr_text (frame_id, text, text_json, app_name, ocr_engine, window_name, focused, text_length)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            frame_id,
                            text,
                            text_json,
                            "",
                            "tesseract",
                            None,
                            False,
                            len(text),
                        ),
                    )

                if save_line_boxes:
                    boxes.extend(aggregate_line_boxes(boxes))

                if boxes:
                    conn.executemany(
                        """
                        INSERT INTO ocr_boxes (
                            frame_id, level, page_num, block_num, par_num, line_num, word_num,
                            left, top, width, height, conf, text
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        [
                            (
                                frame_id,
                                b["level"],
                                b["page_num"],
                                b["block_num"],
                                b["par_num"],
                                b["line_num"],
                                b["word_num"],
                                b["left"],
                                b["top"],
                                b["width"],
                                b["height"],
                                b["conf"],
                                b["text"],
                            )
                            for b in boxes
                        ],
                    )

                if idx % 25 == 0:
                    conn.commit()
                    conn.execute("BEGIN")

        conn.commit()
        print(f"[mkv_ingest] kept {kept_frames} frames (dedup={'on' if dedup_enabled else 'off'})")
        conn.execute(
            """
            INSERT OR REPLACE INTO video_metadata (
                video_chunk_id, fps, duration, width, height, frame_count, kept_frames, creation_time, creation_time_source
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                video_chunk_id,
                fps,
                duration,
                width,
                height,
                len(frame_paths),
                kept_frames,
                start_time.isoformat(),
                creation_source,
            ),
        )
        conn.commit()

    if cfg["transcribe_audio"]:
        print("[mkv_ingest] transcribing audio...")
        transcribe_audio(ffmpeg, video_path, cfg, conn, start_time, duration)
        print("[mkv_ingest] transcription saved")

    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
