import argparse
import json
import os
import sys
import time
import sqlite3


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--lang", default="eng")
    parser.add_argument("--tesseract", default="")
    parser.add_argument("--psm", type=int, default=None)
    parser.add_argument("--oem", type=int, default=None)
    parser.add_argument("--scale", type=float, default=1.0)
    parser.add_argument("--preprocess", default="none")
    parser.add_argument("--save-db", action="store_true")
    parser.add_argument("--db", default="")
    parser.add_argument("--event-id", type=int, default=None)
    parser.add_argument("--engine", default="tesseract")
    args = parser.parse_args()

    image_path = args.image
    if not os.path.exists(image_path):
        print(json.dumps({"text": ""}))
        return 0

    try:
        from PIL import Image, ImageFilter, ImageOps
    except Exception:
        print(json.dumps({"text": ""}))
        return 0

    try:
        import pytesseract
    except Exception:
        print(json.dumps({"text": ""}))
        return 0

    if args.tesseract:
        pytesseract.pytesseract.tesseract_cmd = args.tesseract

    try:
        img = Image.open(image_path)
    except Exception:
        print(json.dumps({"text": ""}))
        return 0

    def build_config() -> str:
        parts = []
        if args.psm is not None:
            parts.append(f"--psm {args.psm}")
        if args.oem is not None:
            parts.append(f"--oem {args.oem}")
        return " ".join(parts)

    def maybe_scale(source: Image.Image) -> Image.Image:
        if not args.scale or args.scale == 1.0:
            return source
        w, h = source.size
        new_w = max(1, int(round(w * args.scale)))
        new_h = max(1, int(round(h * args.scale)))
        return source.resize((new_w, new_h), Image.BICUBIC)

    def apply_threshold(source: Image.Image, adaptive: bool) -> Image.Image:
        gray = source.convert("L")
        if adaptive:
            try:
                import numpy as np
            except Exception:
                adaptive = False
        if adaptive:
            arr = np.array(gray).astype("float32")
            blur = np.array(gray.filter(ImageFilter.GaussianBlur(radius=3))).astype("float32")
            thresh = blur - 5.0
            out = (arr > thresh).astype("uint8") * 255
            return Image.fromarray(out, mode="L")
        return gray.point(lambda x: 255 if x >= 160 else 0, mode="L")

    def preprocess(source: Image.Image) -> Image.Image:
        tag = str(args.preprocess or "none").lower()
        img_local = source
        if "gray" in tag:
            img_local = img_local.convert("L")
        if "autocontrast" in tag:
            img_local = ImageOps.autocontrast(img_local)
        if "threshold" in tag or "adaptive" in tag:
            img_local = apply_threshold(img_local, "adaptive" in tag)
        return img_local

    img = maybe_scale(img)
    img = preprocess(img)

    config = build_config()
    text = pytesseract.image_to_string(img, lang=args.lang, config=config)
    boxes = []
    try:
        data = pytesseract.image_to_data(img, lang=args.lang, config=config, output_type=pytesseract.Output.DICT)
        count = len(data.get("text", []))
        for idx in range(count):
            word = str(data["text"][idx]).strip()
            if not word:
                continue
            try:
                conf = float(data.get("conf", ["-1"])[idx])
            except Exception:
                conf = -1.0
            boxes.append(
                {
                    "text": word,
                    "conf": conf,
                    "left": int(data["left"][idx]),
                    "top": int(data["top"][idx]),
                    "width": int(data["width"][idx]),
                    "height": int(data["height"][idx]),
                }
            )
    except Exception:
        boxes = []

    meta = {"scale": float(args.scale or 1.0), "width": img.size[0], "height": img.size[1]}
    payload = {"text": text.strip(), "boxes": boxes, "width": img.size[0], "height": img.size[1], "meta": meta}

    if args.save_db and args.db and args.event_id is not None:
        try:
            conn = sqlite3.connect(args.db)
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS event_ocr (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_id INTEGER,
                    frame_path TEXT,
                    ocr_text TEXT,
                    ocr_engine TEXT,
                    ocr_boxes_json TEXT,
                    created_ms INTEGER
                );
                """
            )
            columns = [row[1].lower() for row in conn.execute("PRAGMA table_info(event_ocr)")]
            if "ocr_boxes_json" not in columns:
                conn.execute("ALTER TABLE event_ocr ADD COLUMN ocr_boxes_json TEXT")
            created_ms = int(time.time() * 1000)
            boxes_payload = {"boxes": boxes, "meta": meta}
            conn.execute(
                "INSERT INTO event_ocr (event_id, frame_path, ocr_text, ocr_engine, ocr_boxes_json, created_ms) VALUES (?, ?, ?, ?, ?, ?)",
                (
                    int(args.event_id),
                    image_path,
                    payload["text"],
                    args.engine or "tesseract",
                    json.dumps(boxes_payload),
                    created_ms,
                ),
            )
            conn.commit()
            conn.close()
        except Exception:
            pass

    print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
