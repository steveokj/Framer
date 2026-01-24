#!/usr/bin/env python3
"""
Query frame_tapper event frames.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path
from typing import Any, Dict, List


DEFAULT_DB = Path("data/timestone/timestone_events.sqlite3")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Query event frames.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="Path to timestone sqlite db.")
    parser.add_argument("--event-id", type=int, required=True, help="Event id to load frames for.")
    return parser.parse_args()


def open_db(path: Path) -> sqlite3.Connection:
    if not path.exists():
        raise SystemExit(f"Timestone DB not found: {path}")
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    return conn


def query_frames(conn: sqlite3.Connection, event_id: int) -> Dict[str, Any]:
    rows = conn.execute(
        "SELECT frame_path, frame_wall_ms FROM event_frames WHERE event_id = ? ORDER BY frame_wall_ms ASC",
        (event_id,),
    ).fetchall()
    frames: List[Dict[str, Any]] = []
    for row in rows:
        frames.append(
            {
                "frame_path": row["frame_path"],
                "frame_wall_ms": row["frame_wall_ms"],
            }
        )
    return {"event_id": event_id, "frames": frames}


def main() -> int:
    args = parse_args()
    conn = open_db(args.db)
    try:
        payload = query_frames(conn, args.event_id)
        print(json.dumps(payload))
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
