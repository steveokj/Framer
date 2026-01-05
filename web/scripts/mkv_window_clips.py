#!/usr/bin/env python3
"""
Generate window-based clip metadata for an MKV ingest recording.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import List, Optional, Sequence, Set, Tuple


DEFAULT_MKV_DB = Path(r"C:\Users\steve\Desktop\Framer\data\mkv_ingest.sqlite3")


@dataclass
class FrameRow:
    offset_index: int
    timestamp: Optional[datetime]
    window_name: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create window-aligned clips for an MKV ingest video.")
    parser.add_argument("--video", required=True, type=Path, help="Path to the ingested video file.")
    parser.add_argument(
        "--mkv-db",
        type=Path,
        default=DEFAULT_MKV_DB,
        help="Path to mkv_ingest sqlite database.",
    )
    return parser.parse_args()


def normalize_candidates(path: Path) -> Set[str]:
    variants: Set[str] = set()
    raw = str(path)
    variants.add(raw)
    variants.add(raw.replace("\\", "/"))
    variants.add(raw.replace("/", "\\"))
    try:
        rel = path.relative_to(Path.cwd())
        variants.add(str(rel))
        variants.add(str(rel).replace("\\", "/"))
        variants.add(str(rel).replace("/", "\\"))
    except ValueError:
        pass
    variants.add(path.name)
    return variants


def fetch_video_row(conn: sqlite3.Connection, video_path: Path) -> Tuple[int, str]:
    candidates = normalize_candidates(video_path.resolve())
    row = None
    for cand in candidates:
        row = conn.execute(
            "SELECT id, file_path FROM video_chunks WHERE file_path = ?",
            (cand,),
        ).fetchone()
        if row:
            break
    if row is None:
        row = conn.execute(
            "SELECT id, file_path FROM video_chunks WHERE file_path LIKE ? ORDER BY id DESC LIMIT 1",
            (f"%{video_path.name}",),
        ).fetchone()
    if row is None:
        raise SystemExit(f"No video record found for {video_path}")
    return int(row["id"]), str(row["file_path"])


def parse_ts(value: object) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, (bytes, bytearray)):
        value = value.decode("utf-8")
    try:
        return datetime.fromisoformat(str(value))
    except Exception:
        return None


def fetch_frames(conn: sqlite3.Connection, video_chunk_id: int) -> List[FrameRow]:
    rows = conn.execute(
        """
        SELECT offset_index, timestamp, window_name, app_name
        FROM frames
        WHERE video_chunk_id = ?
        ORDER BY offset_index ASC
        """,
        (video_chunk_id,),
    ).fetchall()
    frames: List[FrameRow] = []
    for row in rows:
        ts = parse_ts(row["timestamp"])
        window = row["window_name"] or row["app_name"] or "Unknown window"
        frames.append(
            FrameRow(
                offset_index=int(row["offset_index"]),
                timestamp=ts,
                window_name=window,
            )
        )
    return frames


def fetch_fps(conn: sqlite3.Connection, video_chunk_id: int) -> Optional[float]:
    row = conn.execute(
        "SELECT fps FROM video_metadata WHERE video_chunk_id = ?",
        (video_chunk_id,),
    ).fetchone()
    if row and row["fps"] is not None:
        try:
            return float(row["fps"])
        except Exception:
            return None
    return None


def build_seconds(frames: List[FrameRow], fps: Optional[float]) -> Tuple[List[float], Optional[datetime], Optional[datetime]]:
    first_ts = next((frame.timestamp for frame in frames if frame.timestamp), None)
    last_ts = next((frame.timestamp for frame in reversed(frames) if frame.timestamp), None)
    seconds: List[float] = []
    for frame in frames:
        if first_ts and frame.timestamp:
            seconds.append((frame.timestamp - first_ts).total_seconds())
        else:
            if fps and fps > 0:
                seconds.append(frame.offset_index / fps)
            else:
                seconds.append(float(frame.offset_index))
    return seconds, first_ts, last_ts


def build_clips(frames: List[FrameRow], seconds_list: List[float], fallback_delta: float) -> List[dict]:
    if not frames:
        return []
    clips: List[dict] = []
    start_idx = 0
    for idx in range(1, len(frames)):
        if frames[idx].window_name != frames[idx - 1].window_name:
            clips.append(_clip_from_slice(frames, seconds_list, start_idx, idx - 1, fallback_delta))
            start_idx = idx
    clips.append(_clip_from_slice(frames, seconds_list, start_idx, len(frames) - 1, fallback_delta))
    return clips


def _clip_from_slice(
    frames: List[FrameRow],
    seconds_list: List[float],
    start_idx: int,
    end_idx: int,
    fallback_delta: float,
) -> dict:
    start_seconds = seconds_list[start_idx]
    end_seconds = seconds_list[end_idx]
    if end_idx + 1 < len(seconds_list):
        end_seconds = seconds_list[end_idx + 1]
    else:
        end_seconds = seconds_list[end_idx] + fallback_delta
    return {
        "window_name": frames[start_idx].window_name or "Unknown window",
        "start_seconds": start_seconds,
        "end_seconds": end_seconds,
        "start_timestamp": frames[start_idx].timestamp.isoformat() if frames[start_idx].timestamp else "",
        "end_timestamp": frames[end_idx].timestamp.isoformat() if frames[end_idx].timestamp else "",
        "start_offset_index": frames[start_idx].offset_index,
        "end_offset_index": frames[end_idx].offset_index,
        "frame_count": end_idx - start_idx + 1,
    }


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args()
    if not args.video.exists():
        raise SystemExit(f"Video file not found: {args.video}")
    if not args.mkv_db.exists():
        raise SystemExit(f"MKV ingest DB not found: {args.mkv_db}")

    conn = sqlite3.connect(str(args.mkv_db))
    conn.row_factory = sqlite3.Row
    try:
        video_id, _ = fetch_video_row(conn, args.video)
        frames = fetch_frames(conn, video_id)
        if not frames:
            raise SystemExit("No frames found for video in MKV ingest DB.")
        fps = fetch_fps(conn, video_id)
    finally:
        conn.close()

    seconds_list, first_ts, last_ts = build_seconds(frames, fps)
    deltas = [j - i for i, j in zip(seconds_list, seconds_list[1:]) if (j - i) > 0]
    fallback_delta = deltas[0] if deltas else (1 / fps if fps and fps > 0 else 1 / 30)
    clips = build_clips(frames, seconds_list, fallback_delta)

    payload = {
        "first_timestamp": first_ts.isoformat() if first_ts else None,
        "last_timestamp": last_ts.isoformat() if last_ts else None,
        "clips": clips,
    }
    print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
