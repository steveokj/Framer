#!/usr/bin/env python3
"""
Variation of merge_media that derives frame timestamps directly from the Screenpipe
SQLite database (frames table), keyed by the video file name. This avoids needing
manual TSV exports before running the merge.
"""

import argparse
import json
import sqlite3
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import List, Optional, Sequence, Set


DEFAULT_SCREENPIPE_DB = Path(r"C:\Users\steve\Desktop\state\db.sqlite")
MIN_FRAME_DURATION = 1 / 30  # seconds; avoid zero-duration frames


@dataclass
class FrameStamp:
    offset_index: int
    timestamp: datetime


@dataclass
class AudioMeta:
    session_id: Optional[int]
    start: datetime
    end: datetime


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Merge Screenpipe video with audio using timestamps from Screenpipe's frames table."
    )
    parser.add_argument("--video", required=True, type=Path, help="Path to the screen video chunk (MP4).")
    parser.add_argument("--audio", required=True, type=Path, help="Path to the recorded audio file (WAV/MP3/etc.).")
    parser.add_argument("--output", required=True, type=Path, help="Destination path for the merged MP4.")
    parser.add_argument(
        "--screenpipe-db",
        type=Path,
        default=DEFAULT_SCREENPIPE_DB,
        help=f"Path to Screenpipe SQLite database (frames table). Default: {DEFAULT_SCREENPIPE_DB}",
    )
    parser.add_argument(
        "--transcriptions-db",
        type=Path,
        help="Transcriptions SQLite (audio_sessions) for precise audio start/end timestamps.",
    )
    parser.add_argument(
        "--ffmpeg",
        default="ffmpeg",
        help="ffmpeg executable to use (defaults to ffmpeg on PATH).",
    )
    parser.add_argument(
        "--ffprobe",
        default=None,
        help="Optional ffprobe executable (defaults to ffmpeg name with probe replacement).",
    )
    parser.add_argument(
        "--target-fps",
        type=float,
        default=None,
        help="Force constant frame rate output (e.g. 30.0). Useful when players struggle with VFR timelines.",
    )
    parser.add_argument(
        "--gop-seconds",
        type=float,
        default=None,
        help="Set maximum keyframe interval in seconds (requires --target-fps). Helps seeking without creating all-intra streams.",
    )
    parser.add_argument(
        "--intra-only",
        action="store_true",
        help="Encode every frame as a keyframe (sets GOP=1) for seek-friendly playback.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Allow overwriting the output file if it already exists.",
    )
    return parser.parse_args(argv)


def normalize_candidates(path: Path) -> Set[str]:
    variants: Set[str] = set()
    raw = str(path)
    variants.add(raw)
    variants.add(raw.replace("\\", "/"))
    variants.add(raw.replace("/", "\\"))
    try:
        rel = path.relative_to(Path.cwd())
        variants.add(str(rel))
        variants.add(str(rel).replace("\\", "/"))
        variants.add(str(rel).replace("/", "\\"))
    except ValueError:
        pass
    variants.add(path.name)
    return variants


def load_frames_from_db(db_path: Path, video_path: Path) -> List[FrameStamp]:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    candidates = normalize_candidates(video_path.resolve())

    rows = []
    try:
        for cand in candidates:
            rows = conn.execute(
                "SELECT offset_index, timestamp FROM frames WHERE name = ? ORDER BY offset_index ASC",
                (cand,),
            ).fetchall()
            if rows:
                break

        if not rows:
            chunk_id = None
            for cand in candidates:
                r = conn.execute(
                    "SELECT id FROM video_chunks WHERE file_path = ?",
                    (cand,),
                ).fetchone()
                if r:
                    chunk_id = r["id"]
                    break
            if chunk_id is None:
                raise SystemExit(f"No frames or video_chunks rows found for {video_path} in {db_path}")

            rows = conn.execute(
                "SELECT offset_index, timestamp FROM frames WHERE video_chunk_id = ? ORDER BY offset_index ASC",
                (chunk_id,),
            ).fetchall()
    finally:
        conn.close()

    frames: List[FrameStamp] = []
    for r in rows:
        try:
            ts = datetime.fromisoformat(r["timestamp"])
            frames.append(FrameStamp(int(r["offset_index"]), ts))
        except Exception:
            continue

    if not frames:
        raise SystemExit(f"No usable frame timestamps found for {video_path}")

    return frames


def load_audio_metadata(db_path: Optional[Path], audio_path: Path) -> Optional[AudioMeta]:
    if db_path is None:
        return None
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    candidates = normalize_candidates(audio_path.resolve())
    try:
        row = None
        for cand in candidates:
            row = conn.execute(
                "SELECT id, start_time, end_time FROM audio_sessions WHERE file_path = ? ORDER BY id DESC LIMIT 1",
                (cand,),
            ).fetchone()
            if row:
                break
        if row is None:
            row = conn.execute(
                "SELECT id, start_time, end_time FROM audio_sessions WHERE file_path LIKE ? ORDER BY id DESC LIMIT 1",
                (f"%{audio_path.name}",),
            ).fetchone()
    finally:
        conn.close()

    if row is None:
        return None

    try:
        start = datetime.fromisoformat(row["start_time"])
        end = datetime.fromisoformat(row["end_time"])
    except Exception:
        return None

    return AudioMeta(session_id=row["id"], start=start, end=end)


def ffprobe_duration(exe: str, media: Path) -> float:
    cmd = [
        exe,
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=duration",
        "-of",
        "json",
        str(media),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise SystemExit(f"ffprobe failed: {proc.stderr.strip()}")
    info = json.loads(proc.stdout or "{}")
    try:
        duration = float(info["streams"][0]["duration"])
    except Exception as exc:
        raise SystemExit(f"Unable to read audio duration from ffprobe: {info}") from exc
    return duration


def ensure_positive(value: float) -> float:
    return value if value > MIN_FRAME_DURATION else MIN_FRAME_DURATION


def write_concat_manifest(
    frames: Sequence[Path],
    stamps: Sequence[FrameStamp],
    timeline_end: datetime,
    manifest_path: Path,
) -> float:
    lengths: List[float] = []
    for idx, stamp in enumerate(stamps):
        if idx + 1 < len(stamps):
            next_stamp = stamps[idx + 1].timestamp
            span = (next_stamp - stamp.timestamp).total_seconds()
        else:
            span = (timeline_end - stamp.timestamp).total_seconds()
        lengths.append(ensure_positive(span))

    total_duration = sum(lengths)
    with manifest_path.open("w", encoding="utf-8") as fh:
        fh.write("ffconcat version 1.0\n")
        for frame_path, duration in zip(frames, lengths):
            fh.write(f"file '{frame_path.as_posix()}'\n")
            fh.write(f"duration {duration:.6f}\n")
        fh.write(f"file '{frames[-1].as_posix()}'\n")

    return total_duration


def extract_frames(ffmpeg: str, video: Path, dest_dir: Path) -> List[Path]:
    dest_dir.mkdir(parents=True, exist_ok=True)
    frame_pattern = dest_dir / "frame_%05d.png"
    cmd = [
        ffmpeg,
        "-y",
        "-i",
        str(video),
        "-vsync",
        "vfr",
        str(frame_pattern),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise SystemExit(f"ffmpeg frame extraction failed: {proc.stderr.strip()}")
    frames = sorted(dest_dir.glob("frame_*.png"))
    if not frames:
        raise SystemExit("Frame extraction produced no files.")
    return frames


def build_audio_filter(origin: datetime, meta: Optional[AudioMeta], timeline_end: datetime) -> Optional[str]:
    filters: List[str] = []
    if meta:
        if meta.start > origin:
            delay_ms = int(round((meta.start - origin).total_seconds() * 1000))
            if delay_ms:
                filters.append(f"adelay={delay_ms}|{delay_ms}")
        elif meta.start < origin:
            trim = max(0.0, (origin - meta.start).total_seconds())
            if trim:
                filters.append(f"atrim=start={trim}")
                filters.append("asetpts=N/SR/TB")

        if meta.end < timeline_end:
            pad_seconds = max(0.0, (timeline_end - meta.end).total_seconds())
            if pad_seconds > 0:
                filters.append(f"apad=pad_dur={pad_seconds}")

    return ",".join(filters) if filters else None


def run_merge(
    ffmpeg: str,
    manifest: Path,
    audio: Path,
    audio_filter: Optional[str],
    output: Path,
    overwrite: bool,
    target_fps: Optional[float],
    gop_seconds: Optional[float],
    intra_only: bool,
) -> None:
    if output.exists() and not overwrite:
        raise SystemExit(f"{output} already exists. Use --overwrite to replace it.")

    cmd: List[str] = [
        ffmpeg,
        "-y" if overwrite else "-n",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(manifest),
        "-i",
        str(audio),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
    ]

    if audio_filter:
        cmd.extend(["-af", audio_filter])

    if target_fps:
        cmd.extend(["-vf", f"fps={target_fps}", "-fps_mode", "cfr"])
    else:
        cmd.extend(["-fps_mode", "vfr", "-vsync", "vfr"])

    gop_frames: Optional[int] = None
    if intra_only:
        gop_frames = 1
    elif gop_seconds and target_fps:
        gop_frames = max(1, int(round(target_fps * gop_seconds)))

    if gop_frames is not None:
        cmd.extend(
            [
                "-g",
                str(gop_frames),
                "-keyint_min",
                str(gop_frames),
                "-sc_threshold",
                "0",
            ]
        )

    cmd.extend(["-movflags", "+faststart"])
    cmd.append(str(output))

    proc = subprocess.run(cmd)
    if proc.returncode != 0:
        raise SystemExit("ffmpeg muxing failed.")


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    video_path = args.video.resolve()
    audio_path = args.audio.resolve()
    output_path = args.output.resolve()
    screenpipe_db = args.screenpipe_db.resolve()

    if not video_path.exists():
        raise SystemExit(f"Video file not found: {video_path}")
    if not audio_path.exists():
        raise SystemExit(f"Audio file not found: {audio_path}")
    if not screenpipe_db.exists():
        raise SystemExit(f"Screenpipe DB not found: {screenpipe_db}")

    frame_stamps = load_frames_from_db(screenpipe_db, video_path)

    with tempfile.TemporaryDirectory(prefix="merge_media_db_") as tmpdir:
        frame_dir = Path(tmpdir) / "frames"
        all_frames = extract_frames(args.ffmpeg, video_path, frame_dir)
        frame_map = {idx: path for idx, path in enumerate(all_frames)}
        ordered_frames: List[Path] = []
        missing_offsets: List[int] = []
        for stamp in frame_stamps:
            frame_path = frame_map.get(stamp.offset_index)
            if frame_path is None:
                missing_offsets.append(stamp.offset_index)
            else:
                ordered_frames.append(frame_path)

        if missing_offsets:
            raise SystemExit(
                f"Missing {len(missing_offsets)} frames from video for offsets: {missing_offsets[:5]}"
            )

        frames = ordered_frames
        first_ts = frame_stamps[0].timestamp
        last_ts = frame_stamps[-1].timestamp

        audio_meta = load_audio_metadata(args.transcriptions_db, audio_path)
        ffprobe_exe = args.ffprobe or args.ffmpeg.replace("ffmpeg", "ffprobe")

        if audio_meta is None:
            duration = ffprobe_duration(ffprobe_exe, audio_path)
            audio_start = first_ts
            audio_end = first_ts + timedelta(seconds=duration)
            audio_meta = AudioMeta(session_id=None, start=audio_start, end=audio_end)

        origin = min(first_ts, audio_meta.start)
        timeline_end = max(last_ts, audio_meta.end)

        manifest_path = Path(tmpdir) / "concat.ffconcat"
        total_duration = write_concat_manifest(frames, frame_stamps, timeline_end, manifest_path)

        audio_filter = build_audio_filter(origin, audio_meta, timeline_end)

        print(
            f"Merging {len(frames)} frames over ~{total_duration:.2f}s with audio session {audio_meta.session_id}",
            file=sys.stderr,
        )
        if audio_filter:
            print(f"Audio filter: {audio_filter}", file=sys.stderr)

        run_merge(
            args.ffmpeg,
            manifest_path,
            audio_path,
            audio_filter,
            output_path,
            args.overwrite,
            args.target_fps,
            args.gop_seconds,
            args.intra_only,
        )

    return 0


if __name__ == "__main__":  # pragma: no cover
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
