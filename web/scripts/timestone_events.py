#!/usr/bin/env python3
"""
Query timestone recorder sessions and events.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional


DEFAULT_DB = Path("data/timestone/timestone_events.sqlite3")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Query timestone sessions/events.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="Path to timestone sqlite db.")
    parser.add_argument("--list-sessions", action="store_true", help="List sessions only.")
    parser.add_argument("--session-id", type=str, help="Session id to filter events.")
    parser.add_argument("--start-ms", type=int, default=None, help="Filter events by ts_wall_ms >= start.")
    parser.add_argument("--end-ms", type=int, default=None, help="Filter events by ts_wall_ms <= end.")
    parser.add_argument("--event-types", type=str, default=None, help="Comma-separated event types.")
    parser.add_argument("--search", type=str, default=None, help="Text search over window/process/payload.")
    parser.add_argument("--limit", type=int, default=None, help="Limit number of events.")
    return parser.parse_args()


def open_db(path: Path) -> sqlite3.Connection:
    if not path.exists():
        raise SystemExit(f"Timestone DB not found: {path}")
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    return conn


def list_sessions(conn: sqlite3.Connection) -> Dict[str, Any]:
    rows = conn.execute(
        "SELECT session_id, start_wall_ms, start_wall_iso, obs_video_path FROM sessions ORDER BY start_wall_ms DESC"
    ).fetchall()
    sessions = []
    for row in rows:
        sessions.append(
            {
                "session_id": row["session_id"],
                "start_wall_ms": row["start_wall_ms"],
                "start_wall_iso": row["start_wall_iso"],
                "obs_video_path": row["obs_video_path"],
            }
        )
    return {"sessions": sessions}


def query_events(
    conn: sqlite3.Connection,
    session_id: str,
    start_ms: Optional[int],
    end_ms: Optional[int],
    event_types: Optional[List[str]],
    search: Optional[str],
    limit: Optional[int],
) -> Dict[str, Any]:
    clauses = ["session_id = ?"]
    params: List[Any] = [session_id]

    if start_ms is not None:
        clauses.append("ts_wall_ms >= ?")
        params.append(start_ms)
    if end_ms is not None:
        clauses.append("ts_wall_ms <= ?")
        params.append(end_ms)
    if event_types:
        placeholders = ", ".join(["?"] * len(event_types))
        clauses.append(f"event_type IN ({placeholders})")
        params.extend(event_types)

    search_clause = None
    if search:
        search_clause = (
            "(lower(process_name) LIKE ? OR lower(window_title) LIKE ? "
            "OR lower(window_class) LIKE ? OR lower(payload) LIKE ?)"
        )
        like = f"%{search.lower()}%"
        params.extend([like, like, like, like])

    where_clause = " AND ".join(clauses)
    if search_clause:
        where_clause = f"{where_clause} AND {search_clause}"

    sql = (
        "SELECT id, session_id, ts_wall_ms, ts_mono_ms, event_type, process_name, window_title, "
        "window_class, window_rect, mouse, payload "
        "FROM events "
        f"WHERE {where_clause} "
        "ORDER BY ts_wall_ms ASC"
    )
    if limit is not None and limit > 0:
        sql += " LIMIT ?"
        params.append(limit)

    rows = conn.execute(sql, params).fetchall()
    events = []
    for row in rows:
        events.append(
            {
                "id": row["id"],
                "session_id": row["session_id"],
                "ts_wall_ms": row["ts_wall_ms"],
                "ts_mono_ms": row["ts_mono_ms"],
                "event_type": row["event_type"],
                "process_name": row["process_name"],
                "window_title": row["window_title"],
                "window_class": row["window_class"],
                "window_rect": row["window_rect"],
                "mouse": row["mouse"],
                "payload": row["payload"],
            }
        )
    return {"events": events}


def main() -> int:
    args = parse_args()
    conn = open_db(args.db)
    try:
        if args.list_sessions:
            payload = list_sessions(conn)
        else:
            if not args.session_id:
                raise SystemExit("--session-id is required when querying events.")
            event_types = [e.strip() for e in (args.event_types or "").split(",") if e.strip()] or None
            payload = query_events(
                conn,
                args.session_id,
                args.start_ms,
                args.end_ms,
                event_types,
                args.search,
                args.limit,
            )
        print(json.dumps(payload))
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
