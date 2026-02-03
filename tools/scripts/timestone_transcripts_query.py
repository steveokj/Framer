import argparse
import json
import os
import sqlite3
from typing import Any, Dict, List, Optional


def ensure_db(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS transcription_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            video_path TEXT NOT NULL,
            model TEXT NOT NULL,
            status TEXT NOT NULL,
            progress REAL NOT NULL DEFAULT 0,
            duration_s REAL,
            started_ms INTEGER,
            ended_ms INTEGER,
            error TEXT,
            last_update_ms INTEGER
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS transcriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id INTEGER NOT NULL,
            video_path TEXT NOT NULL,
            model TEXT NOT NULL,
            start_ms INTEGER NOT NULL,
            end_ms INTEGER NOT NULL,
            text TEXT NOT NULL,
            created_ms INTEGER NOT NULL
        )
        """
    )
    conn.commit()
    cols = [row[1] for row in conn.execute("PRAGMA table_info(transcription_runs)").fetchall()]
    if "last_update_ms" not in cols:
        conn.execute("ALTER TABLE transcription_runs ADD COLUMN last_update_ms INTEGER")
        conn.commit()


def latest_run_id(conn: sqlite3.Connection, video_path: str, model: Optional[str]) -> Optional[int]:
    if model:
        row = conn.execute(
            """
            SELECT id FROM transcription_runs
            WHERE video_path = ? AND model = ?
            ORDER BY started_ms DESC
            LIMIT 1
            """,
            (video_path, model),
        ).fetchone()
    else:
        row = conn.execute(
            """
            SELECT id FROM transcription_runs
            WHERE video_path = ?
            ORDER BY started_ms DESC
            LIMIT 1
            """,
            (video_path,),
        ).fetchone()
    return int(row[0]) if row else None


def status_for_videos(conn: sqlite3.Connection, videos: List[str], model: Optional[str]) -> List[Dict[str, Any]]:
    results = []
    for path in videos:
        run_id = latest_run_id(conn, path, model)
        if run_id is None:
            results.append(
                {
                    "video_path": path,
                    "run_id": None,
                    "status": "idle",
                    "progress": 0,
                    "model": model,
                }
            )
            continue
        row = conn.execute(
            """
            SELECT id, model, status, progress, started_ms, ended_ms, error, last_update_ms
            FROM transcription_runs
            WHERE id = ?
            """,
            (run_id,),
        ).fetchone()
        if row:
            results.append(
                {
                    "video_path": path,
                    "run_id": int(row[0]),
                    "model": row[1],
                    "status": row[2],
                    "progress": float(row[3] or 0),
                    "started_ms": row[4],
                    "ended_ms": row[5],
                    "error": row[6],
                    "last_update_ms": row[7],
                }
            )
        else:
            results.append(
                {
                    "video_path": path,
                    "run_id": None,
                    "status": "idle",
                    "progress": 0,
                    "model": model,
                }
            )
    return results


def list_segments(
    conn: sqlite3.Connection,
    video_path: str,
    model: Optional[str],
    run_id: Optional[int],
) -> List[Dict[str, Any]]:
    if run_id is None:
        run_id = latest_run_id(conn, video_path, model)
    if run_id is None:
        return []
    rows = conn.execute(
        """
        SELECT start_ms, end_ms, text, model, run_id
        FROM transcriptions
        WHERE run_id = ?
        ORDER BY start_ms ASC
        """,
        (run_id,),
    ).fetchall()
    return [
        {
            "start_ms": int(row[0]),
            "end_ms": int(row[1]),
            "text": row[2],
            "model": row[3],
            "run_id": int(row[4]),
        }
        for row in rows
    ]


def search_segments(
    conn: sqlite3.Connection,
    query: str,
    model: Optional[str],
    limit: int,
) -> List[Dict[str, Any]]:
    like = f"%{query}%"
    if model:
        rows = conn.execute(
            """
            WITH latest AS (
                SELECT video_path, MAX(started_ms) AS latest_start
                FROM transcription_runs
                WHERE status = 'done' AND model = ?
                GROUP BY video_path
            )
            SELECT t.video_path, t.start_ms, t.end_ms, t.text, t.model, t.run_id
            FROM transcriptions t
            JOIN transcription_runs r ON t.run_id = r.id
            JOIN latest l ON r.video_path = l.video_path AND r.started_ms = l.latest_start
            WHERE t.text LIKE ?
            ORDER BY r.started_ms DESC, t.start_ms ASC
            LIMIT ?
            """,
            (model, like, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            """
            WITH latest AS (
                SELECT video_path, MAX(started_ms) AS latest_start
                FROM transcription_runs
                WHERE status = 'done'
                GROUP BY video_path
            )
            SELECT t.video_path, t.start_ms, t.end_ms, t.text, t.model, t.run_id
            FROM transcriptions t
            JOIN transcription_runs r ON t.run_id = r.id
            JOIN latest l ON r.video_path = l.video_path AND r.started_ms = l.latest_start
            WHERE t.text LIKE ?
            ORDER BY r.started_ms DESC, t.start_ms ASC
            LIMIT ?
            """,
            (like, limit),
        ).fetchall()
    return [
        {
            "video_path": row[0],
            "start_ms": int(row[1]),
            "end_ms": int(row[2]),
            "text": row[3],
            "model": row[4],
            "run_id": int(row[5]),
        }
        for row in rows
    ]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Query timestone_transcripts DB.")
    parser.add_argument("--db", required=True, help="Path to timestone_transcripts.sqlite3")
    parser.add_argument("--mode", choices=["status", "list", "search"], default="status")
    parser.add_argument("--video", action="append", help="Video path (repeatable)")
    parser.add_argument("--model", default="", help="Optional model filter")
    parser.add_argument("--run-id", type=int, default=0, help="Optional run id")
    parser.add_argument("--query", default="", help="Search query")
    parser.add_argument("--limit", type=int, default=200, help="Search result limit")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    db_path = args.db
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path)
    ensure_db(conn)
    model = args.model.strip() or None
    if args.mode == "status":
        videos = args.video or []
        payload = {"status": status_for_videos(conn, videos, model)}
        print(json.dumps(payload))
        return 0
    if args.mode == "list":
        if not args.video:
            print(json.dumps({"segments": []}))
            return 0
        segments = list_segments(conn, args.video[0], model, args.run_id or None)
        print(json.dumps({"segments": segments}))
        return 0
    if args.mode == "search":
        q = args.query.strip()
        if not q:
            print(json.dumps({"matches": []}))
            return 0
        matches = search_segments(conn, q, model, args.limit)
        print(json.dumps({"matches": matches}))
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
