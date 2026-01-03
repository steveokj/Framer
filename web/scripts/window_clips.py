#!/usr/bin/env python3
"""
Generate window-based clip metadata for a Screenpipe recording.
"""

import argparse
import json
import os
import sys
import sqlite3
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import List, Optional

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

try:
    from merge_media_db import normalize_candidates  # type: ignore
except Exception as exc:  # pragma: no cover
    raise RuntimeError("Failed to import helper from merge_media_db") from exc


DEFAULT_SCREENPIPE_DB = Path(r"C:\Users\steve\Desktop\state\db.sqlite")


@dataclass
class FrameRow:
    offset_index: int
    timestamp: datetime
    window_name: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create window-aligned clips for a Screenpipe video chunk.")
    parser.add_argument("--video", required=True, type=Path, help="Path to the screen video chunk (MP4).")
    parser.add_argument(
        "--screenpipe-db",
        type=Path,
        default=DEFAULT_SCREENPIPE_DB,
        help="Path to Screenpipe SQLite database. Defaults to the standard location.",
    )
    return parser.parse_args()


def canonicalise(path: Path) -> str:
    return str(path.resolve()).replace("\\", "/")


def fetch_frames(conn: sqlite3.Connection, video_path: Path) -> List[FrameRow]:
    candidates = normalize_candidates(video_path.resolve())
    rows = []
    for cand in candidates:
        rows = conn.execute(
            "SELECT offset_index, timestamp, window_name FROM frames WHERE name = ? ORDER BY offset_index ASC",
            (cand,),
        ).fetchall()
        if rows:
            break
    if not rows:
        # Fallback via video_chunks table
        chunk_id = None
        for cand in candidates:
            res = conn.execute(
                "SELECT id FROM video_chunks WHERE file_path = ?",
                (cand,),
            ).fetchone()
            if res:
                chunk_id = res[0]
                break
        if chunk_id is None:
            raise SystemExit("No frames found for video in Screenpipe DB.")
        rows = conn.execute(
            "SELECT offset_index, timestamp, window_name FROM frames WHERE video_chunk_id = ? ORDER BY offset_index ASC",
            (chunk_id,),
        ).fetchall()
    parsed: List[FrameRow] = []
    for row in rows:
        ts_raw = row["timestamp"]
        if isinstance(ts_raw, (bytes, bytearray)):
            ts_raw = ts_raw.decode("utf-8")
        ts = datetime.fromisoformat(str(ts_raw))
        window = row["window_name"] or ""
        parsed.append(FrameRow(offset_index=row["offset_index"], timestamp=ts, window_name=window))
    return parsed


def build_clips(frames: List[FrameRow]) -> dict:
    if not frames:
        return {
            "clips": [],
            "first_timestamp": None,
            "last_timestamp": None,
        }

    first_ts = frames[0].timestamp
    seconds_list: List[float] = []
    for fr in frames:
        seconds_list.append((fr.timestamp - first_ts).total_seconds())

    # Estimate frame delta for extending clip end times
    deltas = [j - i for i, j in zip(seconds_list, seconds_list[1:]) if (j - i) > 0]
    fallback_delta = deltas[0] if deltas else 1 / 30

    clips = []
    start_idx = 0
    current_window = frames[0].window_name or "Unknown window"
    for idx in range(1, len(frames)):
        window_name = frames[idx].window_name or "Unknown window"
        prev_window = frames[idx - 1].window_name or "Unknown window"
        if window_name != prev_window:
            clips.append(_clip_from_slice(frames, seconds_list, start_idx, idx - 1, fallback_delta))
            start_idx = idx
    clips.append(_clip_from_slice(frames, seconds_list, start_idx, len(frames) - 1, fallback_delta))

    return {
        "first_timestamp": first_ts.isoformat(),
        "last_timestamp": frames[-1].timestamp.isoformat(),
        "clips": clips,
    }


def _clip_from_slice(
    frames: List[FrameRow],
    seconds_list: List[float],
    start_idx: int,
    end_idx: int,
    fallback_delta: float,
) -> dict:
    window_name = frames[start_idx].window_name or "Unknown window"
    start_seconds = seconds_list[start_idx]
    end_seconds = seconds_list[end_idx]
    if end_idx + 1 < len(seconds_list):
        end_seconds = seconds_list[end_idx + 1]
    else:
        end_seconds = seconds_list[end_idx] + fallback_delta
    return {
        "window_name": window_name,
        "start_seconds": start_seconds,
        "end_seconds": end_seconds,
        "start_timestamp": frames[start_idx].timestamp.isoformat(),
        "end_timestamp": frames[end_idx].timestamp.isoformat(),
        "start_offset_index": frames[start_idx].offset_index,
        "end_offset_index": frames[end_idx].offset_index,
        "frame_count": end_idx - start_idx + 1,
    }


def main() -> int:
    args = parse_args()
    screenpipe_db = args.screenpipe_db
    if not screenpipe_db.exists():
        raise SystemExit(f"Screenpipe DB not found: {screenpipe_db}")
    if not args.video.exists():
        raise SystemExit(f"Video file not found: {args.video}")

    conn = sqlite3.connect(str(screenpipe_db))
    conn.row_factory = sqlite3.Row
    try:
        frames = fetch_frames(conn, args.video)
    finally:
        conn.close()

    payload = build_clips(frames)
    print(json.dumps(payload))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
