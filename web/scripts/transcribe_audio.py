#!/usr/bin/env python3
"""
Utility script that transcribes an audio file using faster-whisper and prints JSON.
The script is designed to be invoked from Next.js API routes.
"""

import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

from faster_whisper import WhisperModel

ROOT_DIR = Path(__file__).resolve().parents[2]
if os.name == "nt":
    os.add_dll_directory(str(ROOT_DIR))
    os.environ["PATH"] = f"{str(ROOT_DIR)}{os.pathsep}{os.environ.get('PATH', '')}"

if str(ROOT_DIR) not in sys.path:
    sys.path.append(str(ROOT_DIR))

from path_utils import canonicalize_path

DEFAULT_DB_PATH = ROOT_DIR / "transcriptions.sqlite3"


def ensure_cache_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS api_transcriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            model_size TEXT NOT NULL,
            transcription TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(name, model_size)
        )
        """
    )
    cur = conn.execute("PRAGMA table_info(api_transcriptions)")
    cols = [row[1] for row in cur.fetchall()]
    desired = ["id", "name", "model_size", "transcription", "created_at"]
    if cols == desired:
        return
    if "canonical_path" in cols and "name" not in cols:
        with conn:
            conn.execute("ALTER TABLE api_transcriptions RENAME TO api_transcriptions_old")
            conn.execute(
                """
                CREATE TABLE api_transcriptions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    model_size TEXT NOT NULL,
                    transcription TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE(name, model_size)
                )
                """
            )
            conn.execute(
                """
                INSERT INTO api_transcriptions (id, name, model_size, transcription, created_at)
                SELECT id, canonical_path, model_size, transcription, created_at
                FROM api_transcriptions_old
                """
            )
            conn.execute("DROP TABLE api_transcriptions_old")
        return
    # Fallback for unexpected legacy layouts: rebuild empty table
    with conn:
        conn.execute("DROP TABLE IF EXISTS api_transcriptions")
    ensure_cache_table(conn)



def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Transcribe audio with faster-whisper.")
    parser.add_argument("--audio-path", required=True, help="Path to the audio file to transcribe.")
    parser.add_argument(
        "--model-size",
        default="large-v2",
        help="Whisper model size (e.g. small, medium, large-v2). Default: large-v2.",
    )
    parser.add_argument(
        "--device",
        default="cuda",
        help="Device to run inference on (cuda or cpu). Default: cuda.",
    )
    parser.add_argument(
        "--compute-type",
        default="float32",
        help="Compute type for inference (float16, float32, int8_float16, etc.). Default: float32.",
    )
    parser.add_argument(
        "--beam-size",
        type=int,
        default=5,
        help="Beam search size. Larger values improve accuracy at the cost of speed.",
    )
    parser.add_argument(
        "--temperature",
        type=float,
        default=0.0,
        help="Temperature for whisper decoding. Default: 0.0.",
    )
    parser.add_argument(
        "--vad-filter",
        action="store_true",
        help="Enable voice activity detection filtering.",
    )
    parser.add_argument(
        "--db-path",
        default=str(DEFAULT_DB_PATH),
        help="Path to SQLite database for cached API transcriptions.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    audio_path = Path(args.audio_path)
    if not audio_path.exists():
        print(json.dumps({"error": f"Audio file not found: {audio_path}"}))
        return 1

    db_conn: sqlite3.Connection | None = None
    cached_row: sqlite3.Row | None = None
    try:
        db_path = Path(args.db_path)
        db_conn = sqlite3.connect(str(db_path))
        db_conn.row_factory = sqlite3.Row
        ensure_cache_table(db_conn)
        canonical = canonicalize_path(audio_path)
        cached_row = db_conn.execute(
            "SELECT transcription FROM api_transcriptions WHERE name = ? AND model_size = ?",
            (canonical, args.model_size),
        ).fetchone()
        if cached_row:
            cached_json = cached_row["transcription"]
            print(cached_json)
            db_conn.close()
            return 0
    except Exception:
        if db_conn is not None:
            db_conn.close()
        db_conn = None
        cached_row = None

    try:
        model = WhisperModel(
            args.model_size,
            device=args.device,
            compute_type=args.compute_type,
        )
    except Exception as exc:  # pragma: no cover - delegated to CLI caller
        if db_conn is not None:
            db_conn.close()
        print(json.dumps({"error": f"Failed to load model: {exc}"}))
        return 1

    try:
        segments, info = model.transcribe(
            str(audio_path),
            beam_size=args.beam_size,
            temperature=args.temperature,
            vad_filter=args.vad_filter,
        )
    except Exception as exc:
        if db_conn is not None:
            db_conn.close()
        print(json.dumps({"error": f"Transcription failed: {exc}"}))
        return 1

    payload = {
        "language": info.language,
        "languageProbability": info.language_probability,
        "duration": info.duration,
        "segments": [
            {
                "id": idx,
                "start": float(segment.start or 0.0),
                "end": float(segment.end or 0.0),
                "text": (segment.text or "").strip(),
            }
            for idx, segment in enumerate(segments)
        ],
    }

    result_json = json.dumps(payload, ensure_ascii=False)
    print(result_json)

    if db_conn is not None:
        try:
            canonical = canonicalize_path(audio_path)
            db_conn.execute(
                """
                INSERT INTO api_transcriptions (name, model_size, transcription, created_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(name, model_size)
                DO UPDATE SET
                    transcription = excluded.transcription,
                    created_at = excluded.created_at
                """,
                (
                    canonical,
                    args.model_size,
                    result_json,
                    datetime.utcnow().isoformat(timespec="seconds"),
                ),
            )
            db_conn.commit()
        except Exception:
            # Swallow caching errors; transcription already printed.
            pass
        finally:
            db_conn.close()

    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
