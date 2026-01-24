import argparse
import json
import os
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--lang", default="eng")
    parser.add_argument("--tesseract", default="")
    args = parser.parse_args()

    image_path = args.image
    if not os.path.exists(image_path):
        print(json.dumps({"text": ""}))
        return 0

    try:
        from PIL import Image
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

    text = pytesseract.image_to_string(img, lang=args.lang)
    print(json.dumps({"text": text.strip()}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
