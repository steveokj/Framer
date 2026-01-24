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
    parser.add_argument("--event-id", type=int, help="Event id to load frames for.")
    parser.add_argument("--list-event-ids", action="store_true", help="List event ids that have frames.")
    parser.add_argument("--start-ms", type=int, default=None, help="Filter event ids by ts_wall_ms >= start.")
    parser.add_argument("--end-ms", type=int, default=None, help="Filter event ids by ts_wall_ms <= end.")
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


def query_event_ids(conn: sqlite3.Connection, start_ms: int | None, end_ms: int | None) -> Dict[str, Any]:
    clauses = []
    params: list[Any] = []
    if start_ms is not None:
        clauses.append("e.ts_wall_ms >= ?")
        params.append(start_ms)
    if end_ms is not None:
        clauses.append("e.ts_wall_ms <= ?")
        params.append(end_ms)
    where_clause = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    sql = (
        "SELECT DISTINCT ef.event_id "
        "FROM event_frames ef "
        "JOIN events e ON e.id = ef.event_id "
        f"{where_clause} "
        "ORDER BY ef.event_id ASC"
    )
    rows = conn.execute(sql, params).fetchall()
    return {"event_ids": [row[0] for row in rows]}


def main() -> int:
    args = parse_args()
    conn = open_db(args.db)
    try:
        if args.list_event_ids:
            payload = query_event_ids(conn, args.start_ms, args.end_ms)
        else:
            if args.event_id is None:
                raise SystemExit("--event-id is required when not listing ids.")
            payload = query_frames(conn, args.event_id)
        print(json.dumps(payload))
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
