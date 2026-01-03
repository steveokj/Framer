#!/usr/bin/env python3
"""
Read MKV ingest SQLite DB and return video/frame metadata for web playback.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple


DEFAULT_DB = Path(r"C:\Users\steve\Desktop\Framer\data\mkv_ingest.sqlite3")


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Return MKV ingest metadata as JSON.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="Path to mkv_ingest sqlite DB.")
    parser.add_argument("--video", type=Path, default=None, help="Video file path to fetch.")
    parser.add_argument("--list", action="store_true", help="List ingested videos.")
    return parser.parse_args(argv)


def ensure_exists(path: Path, label: str) -> Path:
    if not path.exists():
        raise SystemExit(f"{label} not found: {path}")
    return path


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


def parse_ts(value: str) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(value)
    except Exception:
        return None


def list_videos(conn: sqlite3.Connection) -> List[Dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT vc.id,
               vc.file_path,
               vm.fps,
               vm.duration,
               vm.width,
               vm.height,
               vm.frame_count,
               vm.kept_frames,
               vm.creation_time
        FROM video_chunks vc
        LEFT JOIN video_metadata vm ON vm.video_chunk_id = vc.id
        ORDER BY vc.id DESC
        """
    ).fetchall()
    items: List[Dict[str, Any]] = []
    for r in rows:
        items.append(
            {
                "id": r["id"],
                "file_path": r["file_path"],
                "fps": r["fps"],
                "duration": r["duration"],
                "width": r["width"],
                "height": r["height"],
                "frame_count": r["frame_count"],
                "kept_frames": r["kept_frames"],
                "creation_time": r["creation_time"],
            }
        )
    return items


def video_metadata(
    conn: sqlite3.Connection,
    video_chunk_id: int,
    file_path: str,
) -> Dict[str, Any]:
    meta_row = conn.execute(
        """
        SELECT fps, duration, width, height, frame_count, kept_frames, creation_time
        FROM video_metadata
        WHERE video_chunk_id = ?
        """,
        (video_chunk_id,),
    ).fetchone()
    fps = float(meta_row["fps"]) if meta_row and meta_row["fps"] is not None else None
    duration = float(meta_row["duration"]) if meta_row and meta_row["duration"] is not None else None
    width = int(meta_row["width"]) if meta_row and meta_row["width"] is not None else None
    height = int(meta_row["height"]) if meta_row and meta_row["height"] is not None else None
    frame_count = int(meta_row["frame_count"]) if meta_row and meta_row["frame_count"] is not None else None
    kept_frames = int(meta_row["kept_frames"]) if meta_row and meta_row["kept_frames"] is not None else None
    creation_time = meta_row["creation_time"] if meta_row else None

    frame_rows = conn.execute(
        """
        SELECT offset_index, timestamp, name
        FROM frames
        WHERE video_chunk_id = ?
        ORDER BY offset_index ASC
        """,
        (video_chunk_id,),
    ).fetchall()
    frames: List[Dict[str, Any]] = []
    first_ts: Optional[datetime] = None
    for r in frame_rows:
        ts_val = r["timestamp"]
        ts = parse_ts(ts_val) if ts_val else None
        if first_ts is None and ts is not None:
            first_ts = ts
        frames.append(
            {
                "offset_index": int(r["offset_index"]),
                "timestamp": ts_val,
                "frame_path": r["name"],
                "seconds_from_video_start": None,
            }
        )

    if first_ts is None and frames and fps:
        for f in frames:
            f["seconds_from_video_start"] = f["offset_index"] / fps
    elif first_ts is not None:
        for f in frames:
            ts_val = f["timestamp"]
            ts = parse_ts(ts_val) if ts_val else None
            if ts is None:
                f["seconds_from_video_start"] = f["offset_index"] / fps if fps else 0.0
            else:
                f["seconds_from_video_start"] = (ts - first_ts).total_seconds()

    if kept_frames is None:
        kept_frames = len(frames)
    if frame_count is None:
        frame_count = kept_frames

    return {
        "video": {
            "path": file_path,
            "fps": fps,
            "duration": duration,
            "width": width,
            "height": height,
            "frame_count": frame_count,
            "kept_frames": kept_frames,
            "creation_time": creation_time,
        },
        "frames": frames,
    }


def main() -> int:
    args = parse_args()
    db_path = Path(os.environ.get("MKV_DB_PATH", args.db)).expanduser()
    ensure_exists(db_path, "Database")

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        if args.list:
            payload = list_videos(conn)
            print(json.dumps(payload))
            return 0
        if args.video is None:
            raise SystemExit("--video is required unless --list is used")
        video_path = args.video.expanduser()
        video_id, file_path = fetch_video_row(conn, video_path)
        payload = video_metadata(conn, video_id, file_path)
        print(json.dumps(payload))
        return 0
    finally:
        conn.close()


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
