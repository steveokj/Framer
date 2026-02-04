import argparse
import json
import sqlite3


def ensure_fts(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE VIRTUAL TABLE IF NOT EXISTS event_ocr_fts USING fts5(
            ocr_text,
            event_id UNINDEXED,
            frame_path UNINDEXED,
            created_ms UNINDEXED
        );
        """
    )


def bootstrap_fts(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM event_ocr_fts")
    count = cur.fetchone()[0]
    if count == 0:
        conn.execute(
            "INSERT INTO event_ocr_fts (rowid, ocr_text, event_id, frame_path, created_ms) "
            "SELECT id, ocr_text, event_id, frame_path, created_ms FROM event_ocr"
        )
        conn.commit()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--query", default="")
    parser.add_argument("--session-id", default="")
    parser.add_argument("--limit", type=int, default=30)
    args = parser.parse_args()

    query = args.query.strip()
    if not query:
        print(json.dumps({"results": []}))
        return 0

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    ensure_fts(conn)
    bootstrap_fts(conn)

    params = [query]
    sql = (
        "SELECT f.event_id, f.frame_path, f.created_ms, "
        "snippet(event_ocr_fts, 0, '', '', '...', 10) AS snippet, "
        "e.ts_wall_ms, e.event_type, e.window_title, e.process_name "
        "FROM event_ocr_fts f "
        "JOIN events e ON e.id = f.event_id "
        "WHERE event_ocr_fts MATCH ?"
    )
    if args.session_id:
        sql += " AND e.session_id = ?"
        params.append(args.session_id)
    sql += " ORDER BY bm25(event_ocr_fts) LIMIT ?"
    params.append(max(1, min(args.limit, 200)))

    rows = [dict(row) for row in conn.execute(sql, params)]
    conn.close()
    print(json.dumps({"results": rows}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
