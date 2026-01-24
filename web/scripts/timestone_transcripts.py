import argparse
import json
import sqlite3


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--session-id", default="")
    parser.add_argument("--start-ms", type=int, default=None)
    parser.add_argument("--end-ms", type=int, default=None)
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    where = []
    params = []
    if args.session_id:
        where.append("segment_id IN (SELECT id FROM record_segments WHERE session_id = ?)")
        params.append(args.session_id)
    if args.start_ms is not None:
        where.append("wall_end_ms >= ?")
        params.append(args.start_ms)
    if args.end_ms is not None:
        where.append("wall_start_ms <= ?")
        params.append(args.end_ms)

    clause = " WHERE " + " AND ".join(where) if where else ""
    sql = (
        "SELECT segment_id, start_ms, end_ms, wall_start_ms, wall_end_ms, text, engine "
        "FROM segment_transcriptions" + clause + " ORDER BY wall_start_ms"
    )
    cur.execute(sql, params)
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    print(json.dumps({"transcripts": rows}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
