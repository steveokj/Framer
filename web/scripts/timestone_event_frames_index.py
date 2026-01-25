#!/usr/bin/env python3
"""
List event ids that have frames.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional


DEFAULT_DB = Path("data/timestone/timestone_events.sqlite3")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="List event ids that have frames.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="Path to timestone sqlite db.")
    parser.add_argument("--session-id", type=str, default=None, help="Session id to filter.")
    return parser.parse_args()


def open_db(path: Path) -> sqlite3.Connection:
    if not path.exists():
        raise SystemExit(f"Timestone DB not found: {path}")
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    return conn


def query_frames(conn: sqlite3.Connection, session_id: Optional[str]) -> Dict[str, Any]:
    params: List[Any] = []
    where = ""
    if session_id:
        where = "WHERE e.session_id = ?"
        params.append(session_id)
    rows = conn.execute(
        f"""
        SELECT DISTINCT ef.event_id
        FROM event_frames ef
        JOIN events e ON e.id = ef.event_id
        {where}
        """,
        params,
    ).fetchall()
    event_ids = [row["event_id"] for row in rows]
    return {"event_ids": event_ids}


def main() -> int:
    args = parse_args()
    conn = open_db(args.db)
    try:
        payload = query_frames(conn, args.session_id)
        print(json.dumps(payload))
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
