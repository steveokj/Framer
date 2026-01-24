import argparse
import json
import sqlite3


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--event-id", type=int, default=None)
    parser.add_argument("--frame-path", default="")
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    if args.event_id is None and not args.frame_path:
        print(json.dumps({"ocr": []}))
        return 0

    if args.frame_path:
        cur.execute(
            "SELECT event_id, frame_path, ocr_text, ocr_engine FROM event_ocr WHERE frame_path = ?",
            (args.frame_path,),
        )
    else:
        cur.execute(
            "SELECT event_id, frame_path, ocr_text, ocr_engine FROM event_ocr WHERE event_id = ?",
            (args.event_id,),
        )

    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    print(json.dumps({"ocr": rows}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
