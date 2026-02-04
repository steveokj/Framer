#!/usr/bin/env python3
"""
Manage pinned events scoped to a session.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import time
from pathlib import Path
from typing import Any, Dict, List


DEFAULT_DB = Path("data/timestone/timestone_events.sqlite3")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Manage pinned events.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="Path to timestone sqlite db.")
    parser.add_argument("--list", action="store_true", help="List pinned events for a session.")
    parser.add_argument("--session-id", default="", help="Session id scope.")
    parser.add_argument("--pin", type=int, default=None, help="Event id to pin.")
    parser.add_argument("--unpin", type=int, default=None, help="Event id to unpin.")
    return parser.parse_args()


def open_db(path: Path) -> sqlite3.Connection:
    if not path.exists():
        raise SystemExit(f"Timestone DB not found: {path}")
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    return conn


def ensure_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS pinned_events (
            event_id INTEGER PRIMARY KEY,
            session_id TEXT,
            pinned_at INTEGER
        );
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_pinned_events_session ON pinned_events(session_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_pinned_events_at ON pinned_events(pinned_at)")


def list_pins(conn: sqlite3.Connection, session_id: str) -> Dict[str, Any]:
    rows = conn.execute(
        "SELECT event_id, session_id, pinned_at FROM pinned_events WHERE session_id = ? ORDER BY pinned_at DESC",
        (session_id,),
    ).fetchall()
    pins: List[Dict[str, Any]] = []
    for row in rows:
        pins.append(
            {
                "event_id": row["event_id"],
                "session_id": row["session_id"],
                "pinned_at": row["pinned_at"],
            }
        )
    return {"pins": pins}


def pin_event(conn: sqlite3.Connection, event_id: int, session_id: str) -> Dict[str, Any]:
    pinned_at = int(time.time() * 1000)
    conn.execute(
        "INSERT OR REPLACE INTO pinned_events (event_id, session_id, pinned_at) VALUES (?, ?, ?)",
        (event_id, session_id, pinned_at),
    )
    conn.commit()
    return {"ok": True, "event_id": event_id, "session_id": session_id, "pinned": True, "pinned_at": pinned_at}


def unpin_event(conn: sqlite3.Connection, event_id: int, session_id: str) -> Dict[str, Any]:
    conn.execute(
        "DELETE FROM pinned_events WHERE event_id = ? AND session_id = ?",
        (event_id, session_id),
    )
    conn.commit()
    return {"ok": True, "event_id": event_id, "session_id": session_id, "pinned": False}


def main() -> int:
    args = parse_args()
    session_id = args.session_id.strip()
    if not session_id:
        raise SystemExit("--session-id is required.")
    conn = open_db(args.db)
    try:
        ensure_table(conn)
        if args.list:
            payload = list_pins(conn, session_id)
        elif args.pin is not None:
            payload = pin_event(conn, args.pin, session_id)
        elif args.unpin is not None:
            payload = unpin_event(conn, args.unpin, session_id)
        else:
            raise SystemExit("Specify --list, --pin, or --unpin.")
        print(json.dumps(payload))
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
