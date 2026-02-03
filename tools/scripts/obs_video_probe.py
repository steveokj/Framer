import argparse
import json
import os
import subprocess
import time
from typing import Dict, Optional


VIDEO_EXTS = {".mkv", ".mp4", ".mov", ".webm"}


def now_ms() -> int:
    return int(time.time() * 1000)


def ffprobe_duration(path: str) -> Optional[float]:
    ffprobe = os.environ.get("FFPROBE") or os.environ.get("FFMPEG_PATH", "ffmpeg")
    if ffprobe.lower().endswith("ffmpeg") or ffprobe.lower().endswith("ffmpeg.exe"):
        ffprobe = ffprobe[:-6] + "ffprobe" + (".exe" if ffprobe.lower().endswith(".exe") else "")
    args = [
        ffprobe,
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        path,
    ]
    try:
        if os.name == "nt":
            out = subprocess.run(
                args, capture_output=True, text=True, check=False, creationflags=subprocess.CREATE_NO_WINDOW
            )
        else:
            out = subprocess.run(args, capture_output=True, text=True, check=False)
    except Exception:
        return None
    if out.returncode != 0:
        return None
    try:
        value = float(out.stdout.strip())
        return value if value > 0 else None
    except Exception:
        return None


def read_cache(path: str) -> Dict:
    try:
        with open(path, "r", encoding="utf8") as handle:
            return json.load(handle)
    except Exception:
        return {"version": 1, "items": {}}


def write_cache(path: str, cache: Dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf8") as handle:
        json.dump(cache, handle)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Hydrate OBS video duration cache.")
    parser.add_argument("--folder", required=True, help="OBS folder to scan")
    parser.add_argument("--cache", required=True, help="Cache path")
    parser.add_argument("--lock", default="", help="Optional lock file path")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    lock_path = args.lock or ""
    cache = read_cache(args.cache)
    items = cache.get("items", {})
    for name in os.listdir(args.folder):
        full = os.path.join(args.folder, name)
        if not os.path.isfile(full):
            continue
        ext = os.path.splitext(name)[1].lower()
        if ext not in VIDEO_EXTS:
            continue
        try:
            stat = os.stat(full)
        except Exception:
            continue
        size = stat.st_size
        mtime_ms = int(stat.st_mtime * 1000)
        cached = items.get(full)
        if cached and cached.get("size") == size and cached.get("mtime_ms") == mtime_ms:
            continue
        duration = ffprobe_duration(full)
        items[full] = {
            "size": size,
            "mtime_ms": mtime_ms,
            "duration_s": duration,
            "updated_ms": now_ms(),
        }
    cache["items"] = items
    cache["version"] = cache.get("version") or 1
    write_cache(args.cache, cache)
    if lock_path:
        try:
            os.remove(lock_path)
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
