#!/usr/bin/env python3
"""
Generate alignment metadata for browser-based playback of Screenpipe recordings.
Leverages merge_media_db functions to gather frame timestamps and audio timing
information without invoking ffmpeg muxing.
"""

import argparse
import json
import os
import sys
from datetime import timedelta
from pathlib import Path
from typing import Any, Dict, Optional

# Allow imports from project root (where merge_media_db.py lives)
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

try:
    from merge_media_db import (  # type: ignore
        DEFAULT_SCREENPIPE_DB,
        AudioMeta,
        load_audio_metadata,
        load_frames_from_db,
        ffprobe_duration,
    )
except ImportError as exc:  # pragma: no cover - hard failure
    raise RuntimeError("Failed to import merge_media_db helpers") from exc


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Return JSON metadata required to align Screenpipe video and audio for web playback."
    )
    parser.add_argument("--video", required=True, type=Path, help="Path to the screen recording chunk (MP4).")
    parser.add_argument("--audio", required=True, type=Path, help="Path to the audio capture (WAV/MP3/etc.).")
    parser.add_argument(
        "--screenpipe-db",
        type=Path,
        default=Path(os.environ.get("SCREENPIPE_DB_PATH", DEFAULT_SCREENPIPE_DB)),
        help="Path to Screenpipe SQLite database (frames table). Defaults to merge_media_db default or env SCREENPIPE_DB_PATH.",
    )
    parser.add_argument(
        "--transcriptions-db",
        type=Path,
        default=None,
        help="Optional transcriptions SQLite database for precise audio start/end.",
    )
    parser.add_argument(
        "--ffprobe",
        default=None,
        help="Optional ffprobe executable path for determining audio duration when metadata is missing.",
    )
    return parser.parse_args()


def ensure_exists(path: Path, label: str) -> Path:
    if not path.exists():
        raise SystemExit(f"{label} not found: {path}")
    return path


def build_response(
    video_path: Path,
    audio_path: Path,
    frame_stamps,
    audio_meta: AudioMeta,
    fallback_duration: Optional[float],
) -> Dict[str, Any]:
    if not frame_stamps:
        raise SystemExit("No frame timestamps found for the provided video.")

    first_ts = frame_stamps[0].timestamp
    last_ts = frame_stamps[-1].timestamp

    # When audio metadata is missing start/end, patch in values relative to video timeline.
    if audio_meta.start is None or audio_meta.end is None:
        if fallback_duration is None:
            raise SystemExit("Audio metadata missing and no fallback duration available.")
        audio_meta = AudioMeta(
            session_id=None,
            start=first_ts,
            end=first_ts + timedelta(seconds=fallback_duration),
        )

    origin = min(first_ts, audio_meta.start)
    timeline_end = max(last_ts, audio_meta.end)
    offset_seconds = (first_ts - audio_meta.start).total_seconds()

    frame_entries = [
        {
            "offset_index": stamp.offset_index,
            "timestamp": stamp.timestamp.isoformat(),
            "seconds_from_video_start": (stamp.timestamp - first_ts).total_seconds(),
        }
        for stamp in frame_stamps
    ]

    response: Dict[str, Any] = {
        "video": {
            "path": str(video_path),
            "frame_count": len(frame_stamps),
            "first_timestamp": first_ts.isoformat(),
            "last_timestamp": last_ts.isoformat(),
        },
        "audio": {
            "path": str(audio_path),
            "session_id": audio_meta.session_id,
            "start_timestamp": audio_meta.start.isoformat(),
            "end_timestamp": audio_meta.end.isoformat(),
            "duration_seconds": (audio_meta.end - audio_meta.start).total_seconds(),
        },
        "alignment": {
            "origin_timestamp": origin.isoformat(),
            "timeline_end_timestamp": timeline_end.isoformat(),
            "audio_offset_seconds": offset_seconds,
            "audio_lead_seconds": max(0.0, offset_seconds),
            "audio_delay_seconds": max(0.0, -offset_seconds),
        },
        "frames": frame_entries,
    }
    return response


def main() -> int:
    args = parse_args()
    video_path = ensure_exists(args.video.resolve(), "Video file")
    audio_path = ensure_exists(args.audio.resolve(), "Audio file")
    screenpipe_db = ensure_exists(args.screenpipe_db.resolve(), "Screenpipe DB")
    transcriptions_db = args.transcriptions_db
    if transcriptions_db is not None:
        transcriptions_db = ensure_exists(transcriptions_db.resolve(), "Transcriptions DB")

    frame_stamps = load_frames_from_db(screenpipe_db, video_path)
    audio_meta = load_audio_metadata(transcriptions_db, audio_path) if transcriptions_db else None
    fallback_duration: Optional[float] = None

    if audio_meta is None or audio_meta.start is None or audio_meta.end is None:
        probe_exe = args.ffprobe or os.environ.get("FFPROBE")
        if probe_exe:
            fallback_duration = ffprobe_duration(probe_exe, audio_path)
        else:
            try:
                fallback_duration = ffprobe_duration("ffprobe", audio_path)
            except SystemExit:
                fallback_duration = None

        if fallback_duration is None:
            raise SystemExit(
                "Audio metadata missing and ffprobe could not determine duration. Provide --transcriptions-db or set FFPROBE."
            )
        audio_meta = AudioMeta(session_id=None, start=None, end=None)  # type: ignore[arg-type]

    payload = build_response(video_path, audio_path, frame_stamps, audio_meta, fallback_duration)
    print(json.dumps(payload))
    return 0


if __name__ == "__main__":  # pragma: no cover
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
