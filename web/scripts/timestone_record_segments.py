#!/usr/bin/env python3
"""
Query timestone record segments.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional


DEFAULT_DB = Path("data/timestone/timestone_events.sqlite3")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Query timestone record segments.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="Path to timestone sqlite db.")
    parser.add_argument("--session-id", type=str, default=None, help="Session id to filter.")
    parser.add_argument("--start-ms", type=int, default=None, help="Filter start_wall_ms >= start.")
    parser.add_argument("--end-ms", type=int, default=None, help="Filter start_wall_ms <= end.")
    parser.add_argument("--obs-path", type=str, default=None, help="Filter by obs_path.")
    return parser.parse_args()


def open_db(path: Path) -> sqlite3.Connection:
    if not path.exists():
        raise SystemExit(f"Timestone DB not found: {path}")
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    return conn


def query_segments(
    conn: sqlite3.Connection,
    session_id: Optional[str],
    start_ms: Optional[int],
    end_ms: Optional[int],
    obs_path: Optional[str],
) -> Dict[str, Any]:
    clauses = ["1=1"]
    params: List[Any] = []

    if session_id:
        clauses.append("session_id = ?")
        params.append(session_id)
    if start_ms is not None:
        clauses.append("start_wall_ms >= ?")
        params.append(start_ms)
    if end_ms is not None:
        clauses.append("start_wall_ms <= ?")
        params.append(end_ms)
    if obs_path:
        clauses.append("obs_path = ?")
        params.append(obs_path)

    where_clause = " AND ".join(clauses)
    rows = conn.execute(
        f"""
        SELECT id, session_id, start_wall_ms, end_wall_ms, obs_path, processed, created_wall_ms
        FROM record_segments
        WHERE {where_clause}
        ORDER BY start_wall_ms ASC
        """,
        params,
    ).fetchall()

    segments = []
    for row in rows:
        segments.append(
            {
                "id": row["id"],
                "session_id": row["session_id"],
                "start_wall_ms": row["start_wall_ms"],
                "end_wall_ms": row["end_wall_ms"],
                "obs_path": row["obs_path"],
                "processed": row["processed"],
                "created_wall_ms": row["created_wall_ms"],
            }
        )
    return {"segments": segments}


def main() -> int:
    args = parse_args()
    conn = open_db(args.db)
    try:
        payload = query_segments(conn, args.session_id, args.start_ms, args.end_ms, args.obs_path)
        print(json.dumps(payload))
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
