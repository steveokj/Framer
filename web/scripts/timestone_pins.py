#!/usr/bin/env python3
"""
Manage pinned sessions for mkv_tapper.
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
    parser = argparse.ArgumentParser(description="Manage pinned sessions.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="Path to timestone sqlite db.")
    parser.add_argument("--list", action="store_true", help="List pinned sessions.")
    parser.add_argument("--pin", default="", help="Pin a session id.")
    parser.add_argument("--unpin", default="", help="Unpin a session id.")
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
        CREATE TABLE IF NOT EXISTS pinned_sessions (
            session_id TEXT PRIMARY KEY,
            pinned_at INTEGER
        );
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_pinned_sessions_at ON pinned_sessions(pinned_at)")


def list_pins(conn: sqlite3.Connection) -> Dict[str, Any]:
    rows = conn.execute(
        "SELECT session_id, pinned_at FROM pinned_sessions ORDER BY pinned_at DESC"
    ).fetchall()
    pins: List[Dict[str, Any]] = []
    for row in rows:
        pins.append({"session_id": row["session_id"], "pinned_at": row["pinned_at"]})
    return {"pins": pins}


def pin_session(conn: sqlite3.Connection, session_id: str) -> Dict[str, Any]:
    pinned_at = int(time.time() * 1000)
    conn.execute(
        "INSERT OR REPLACE INTO pinned_sessions (session_id, pinned_at) VALUES (?, ?)",
        (session_id, pinned_at),
    )
    conn.commit()
    return {"ok": True, "session_id": session_id, "pinned": True, "pinned_at": pinned_at}


def unpin_session(conn: sqlite3.Connection, session_id: str) -> Dict[str, Any]:
    conn.execute("DELETE FROM pinned_sessions WHERE session_id = ?", (session_id,))
    conn.commit()
    return {"ok": True, "session_id": session_id, "pinned": False}


def main() -> int:
    args = parse_args()
    conn = open_db(args.db)
    try:
        ensure_table(conn)
        if args.list:
            payload = list_pins(conn)
        elif args.pin:
            payload = pin_session(conn, args.pin)
        elif args.unpin:
            payload = unpin_session(conn, args.unpin)
        else:
            raise SystemExit("Specify --list, --pin, or --unpin.")
        print(json.dumps(payload))
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
