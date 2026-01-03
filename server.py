from __future__ import annotations

import re
import sqlite3
import wave
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse, FileResponse
from starlette.staticfiles import StaticFiles

from path_utils import canonicalize_path

# Root directory of the application - used for resolving relative paths
ROOT = Path(__file__).parent.resolve()
# Additional directories that are safe to serve over /files_abs
ALLOWED_FILE_ROOTS = [
    ROOT,
    (Path.home() / ".screenpipe").resolve(),
]
# Path to the SQLite database containing transcriptions
DB_PATH = ROOT / "transcriptions.sqlite3"


# Opens a connection to the transcriptions database
# Returns connection with Row factory for dict-like access to columns
def _db() -> sqlite3.Connection:
    if not DB_PATH.exists():
        raise FileNotFoundError(f"SQLite not found: {DB_PATH}")
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


# Normalizes file paths from database to OS-specific absolute paths
# Handles backslash-to-forward-slash conversion and resolves relative paths
def _norm_path(p: str) -> Path:
    # DB may contain backslashes; normalize to OS path under repo root
    pp = Path(p.replace("\\", "/"))
    if not pp.is_absolute():
        pp = ROOT / pp
    return pp


def _resolve_allowed_file(raw: str) -> Path:
    candidate = Path(raw.replace("\\", "/"))
    if not candidate.is_absolute():
        candidate = ROOT / candidate
    candidate = candidate.resolve()
    for base in ALLOWED_FILE_ROOTS:
        base_resolved = base.resolve(strict=False)
        try:
            candidate.relative_to(base_resolved)
            return candidate
        except ValueError:
            continue
    raise HTTPException(status_code=403, detail="File path outside of allowed directories")


# Generates expected file paths for speech-only audio and silence map
# Given original WAV, returns paths for derivative files created by post-processing
# Example: session.wav -> session-silenced.wav, session-silence_map.tsv
def _related_speech_paths(wav: Path) -> Tuple[Path, Path]:
    base = wav.with_suffix("")
    speech_audio = base.with_name(f"{base.name}-silenced").with_suffix(".wav")
    silence_map = base.with_name(f"{base.name}-silence_map").with_suffix(".tsv")
    return speech_audio, silence_map


# Checks which speech processing assets exist for a given WAV file
# Returns actual paths only if files exist, otherwise None
# Used to determine if post-processing has been completed
def _existing_speech_assets(wav: Path) -> Tuple[Optional[Path], Optional[Path]]:
    speech_audio, silence_map = _related_speech_paths(wav)
    return (
        speech_audio if speech_audio.exists() else None,
        silence_map if silence_map.exists() else None,
    )


# Reads silence spans from a TSV file
# Each line contains start_ms and end_ms separated by tab
# Returns sorted list of (start_ms, end_ms) tuples representing silence periods
def _read_silence_map(path: Path) -> List[Tuple[int, int]]:
    spans: List[Tuple[int, int]] = []
    try:
        with path.open("r", encoding="utf-8") as fh:
            for raw in fh:
                line = raw.strip()
                # Skip empty lines
                if not line:
                    continue
                # Skip header row
                if line.lower().startswith("start_ms"):
                    continue
                # Parse tab-separated values
                parts = line.split("	")
                if len(parts) < 2:
                    continue
                try:
                    start = int(parts[0])
                    end = int(parts[1])
                except ValueError:
                    continue
                # Validate span is valid
                if end < start:
                    continue
                spans.append((start, end))
    except FileNotFoundError:
        return []
    # Sort by start time for processing
    spans.sort()
    return spans


# Merges overlapping or adjacent silence intervals
# Takes sorted list of (start, end) tuples and combines overlapping ranges
# Example: [(0,10), (5,15), (20,30)] -> [(0,15), (20,30)]
def _merge_intervals(spans: List[Tuple[int, int]]) -> List[Tuple[int, int]]:
    if not spans:
        return []
    merged: List[Tuple[int, int]] = []
    cur_start, cur_end = spans[0]
    # Iterate through sorted spans and merge overlaps
    for start, end in spans[1:]:
        # If current span overlaps or touches previous, extend it
        if start <= cur_end:
            cur_end = max(cur_end, end)
        else:
            # No overlap - save previous span and start new one
            merged.append((cur_start, cur_end))
            cur_start, cur_end = start, end
    # Don't forget the last span
    merged.append((cur_start, cur_end))
    return merged


# Loads and processes a speech timeline from a silence map file
# Creates bidirectional mapping between original audio time and speech-only time
# Returns timeline with segments, silence spans, and total durations
# This enables playing speech-only audio while displaying original timestamps
def _load_speech_timeline(path: Path, *, total_ms: Optional[int] = None) -> Optional[Dict[str, Any]]:
    # Read raw silence spans from TSV file
    spans = _read_silence_map(path)
    if not spans and total_ms is None:
        return None
    # Merge overlapping silence periods
    merged = _merge_intervals(spans)
    if not merged and total_ms is None:
        return None
    # Determine total duration of original audio
    total_original = total_ms if total_ms is not None else (merged[-1][1] if merged else 0)
    # Build segments list - each segment maps a speech region to its original time
    segments: List[Dict[str, int]] = []
    speech_cursor = 0  # Current position in speech-only timeline
    cur = 0  # Current position in original timeline
    # Process each silence span to extract speech segments
    for start, end in merged:
        start = max(cur, start)
        # The region before this silence is speech - add it as a segment
        if start > cur:
            dur = start - cur
            if dur > 0:
                # Record this speech segment with both original and speech-only timestamps
                segments.append(
                    {
                        "original_start_ms": cur,
                        "original_end_ms": start,
                        "speech_start_ms": speech_cursor,
                        "speech_end_ms": speech_cursor + dur,
                        "duration_ms": dur,
                    }
                )
                speech_cursor += dur
        # Skip past this silence in original timeline
        cur = max(cur, end)
    # Handle any remaining speech after the last silence
    if cur < total_original:
        dur = total_original - cur
        if dur > 0:
            # Add final speech segment
            segments.append(
                {
                    "original_start_ms": cur,
                    "original_end_ms": total_original,
                    "speech_start_ms": speech_cursor,
                    "speech_end_ms": speech_cursor + dur,
                    "duration_ms": dur,
                }
            )
            speech_cursor += dur
        cur = total_original
    # Build silence spans list for reference
    silence_payload = [
        {
            "start_ms": start,
            "end_ms": end,
            "duration_ms": max(0, end - start),
        }
        for start, end in merged
    ]
    # Return complete timeline data structure
    return {
        "segments": segments,  # Speech segments with time mapping
        "silence_spans": silence_payload,  # All silence periods
        "total_original_ms": total_original,  # Duration of original audio
        "total_speech_ms": speech_cursor,  # Duration of speech-only audio
    }


# Calculates the duration of a WAV file in milliseconds
# Reads WAV metadata without loading entire audio into memory
# Returns None if file cannot be read or has invalid metadata
def _wav_duration_ms(path: Path) -> Optional[int]:
    try:
        with wave.open(str(path), "rb") as wf:
            frames = wf.getnframes()
            rate = wf.getframerate()
            # Validate metadata
            if frames < 0 or rate <= 0:
                return None
            # Calculate duration: (frames / sample_rate) * 1000
            return int(round(frames * 1000.0 / rate))
    except Exception:
        return None


# Parses transcript text with timestamp brackets into structured data
# Input format: "[1.23s -> 4.56s] transcribed text"
# Returns list of dicts with id, start_ms, end_ms, and text fields
def parse_bracketed_transcript(txt: str) -> List[Dict[str, Any]]:
    lines = []
    # Regex to match: [start_sec -> end_sec] text
    re_ln = re.compile(r"^\s*\[(\d+(?:\.\d+)?)s\s*->\s*(\d+(?:\.\d+)?)s\]\s*(.+?)\s*$")
    idx = 0
    for raw in txt.splitlines():
        m = re_ln.match(raw)
        if not m:
            # Handle non-timestamped lines
            if raw.strip():
                # Preserve as text-only line without timestamps
                lines.append({
                    "id": idx,
                    "start_ms": None,
                    "end_ms": None,
                    "text": raw.strip(),
                })
                idx += 1
            continue
        # Extract timestamps and convert seconds to milliseconds
        start_ms = int(float(m.group(1)) * 1000)
        end_ms = int(float(m.group(2)) * 1000)
        text = m.group(3)
        # Add parsed line to results
        lines.append({
            "id": idx,
            "start_ms": start_ms,
            "end_ms": max(end_ms, start_ms),  # Ensure end >= start
            "text": text,
        })
        idx += 1
    return lines


# FastAPI application for audio transcription sessions
app = FastAPI(title="Audio Sessions API")

# Enable CORS for all origins to allow web UI access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def add_files_cors_headers(request: Request, call_next):
    try:
        response = await call_next(request)
    except HTTPException as exc:
        response = JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
    if request.url.path.startswith("/files"):
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Expose-Headers"] = (
            response.headers.get("Access-Control-Expose-Headers", "Accept-Ranges, Content-Length, Content-Type")
        )
        response.headers.setdefault("Vary", "Origin")
    return response

# Serve static files (audio, silence maps, etc.) with HTTP range request support
# This enables seeking in audio players
app.mount("/files", StaticFiles(directory=str(ROOT), html=False), name="files")


@app.get("/files_abs")
def files_absolute(path: str) -> FileResponse:
    file_path = _resolve_allowed_file(path)
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(
        file_path,
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Type",
        },
    )


@app.options("/files_abs")
async def files_absolute_options() -> PlainTextResponse:
    return PlainTextResponse(
        "",
        status_code=204,
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Range, Content-Type, Accept",
            "Access-Control-Max-Age": "86400",
            "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Type",
        },
    )


# Lists all audio recording sessions from the database
# Returns session metadata including file paths and URLs to audio assets
@app.get("/sessions")
def list_sessions() -> JSONResponse:
    with _db() as conn:
        cur = conn.execute(
            "SELECT id, title, file_path, device, sample_rate, channels, model, start_time, end_time, status"
            " FROM audio_sessions ORDER BY id DESC"
        )
        rows = [dict(r) for r in cur.fetchall()]
    # Enhance each session row with file URLs for audio assets
    for r in rows:
        file_path = r.get("file_path") or ""
        wav = _norm_path(file_path)
        r["file_path"] = str(wav)
        # URL for original recorded audio
        r["original_audio_url"] = f"/files/{wav.relative_to(ROOT).as_posix()}" if wav.exists() else None
        # Check for post-processed speech-only audio and silence map
        speech_audio, silence_map = _existing_speech_assets(wav)
        has_pair = speech_audio is not None and silence_map is not None
        # URL for speech-only audio (if available)
        r["speech_audio_url"] = (
            f"/files/{speech_audio.relative_to(ROOT).as_posix()}"
            if has_pair and speech_audio is not None
            else None
        )
        # URL for silence map TSV (if available)
        r["silence_map_url"] = (
            f"/files/{silence_map.relative_to(ROOT).as_posix()}"
            if silence_map is not None
            else None
        )
    return JSONResponse(rows)


# Helper to fetch a session by ID or raise 404 error
# Used by multiple endpoints to ensure session exists before processing
def _get_session(conn: sqlite3.Connection, session_id: int) -> sqlite3.Row:
    cur = conn.execute("SELECT * FROM audio_sessions WHERE id = ?", (session_id,))
    row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return row


# Returns session manifest with audio URLs, timeline data, and transcript info
# Provides all metadata needed for the web player UI
@app.get("/sessions/{session_id}/manifest")
def manifest(session_id: int) -> JSONResponse:
    with _db() as conn:
        s = _get_session(conn, session_id)
        # Validate audio file exists
        wav = _norm_path(s["file_path"]) if s["file_path"] else None
        if wav is None or not wav.exists():
            raise HTTPException(status_code=404, detail="Audio file not found for session")
        # Check for post-processed assets
        speech_audio, silence_map = _existing_speech_assets(wav)
        # Get audio duration from WAV metadata
        duration_ms = _wav_duration_ms(wav)
        # Load timeline if silence map exists - enables time conversion in UI
        timeline = _load_speech_timeline(silence_map, total_ms=duration_ms) if silence_map else None

        # Check if transcript is available for this session
        canonical = canonicalize_path(s["file_path"]) if s["file_path"] else None
        transcript_present = False
        if canonical:
            cur = conn.execute(
                "SELECT transcription FROM audio_transcriptions WHERE name = ? ORDER BY created_at DESC LIMIT 1",
                (canonical,),
            )
            trow = cur.fetchone()
            transcript_present = bool(trow and (trow[0] or "").strip())

    # Build manifest JSON with all session information
    man = {
        "session_id": session_id,
        "title": s["title"],
        "duration": duration_ms,  # Total duration in milliseconds
        "audio": {
            "original_url": f"/files/{wav.relative_to(ROOT).as_posix()}",  # Full recording with silence
            "speech_url": (  # Speech-only version (if available)
                f"/files/{speech_audio.relative_to(ROOT).as_posix()}"
                if speech_audio is not None and silence_map is not None
                else None
            ),
            "timeline": timeline,  # Time mapping for speech-only playback
        },
        "silence_map_url": (  # TSV file with silence intervals
            f"/files/{silence_map.relative_to(ROOT).as_posix()}" if silence_map is not None else None
        ),
        "transcript": {
            "format": "bracketed_text",  # Format identifier for parser
            "url": f"/sessions/{session_id}/transcript",  # Structured JSON
            "raw_url": f"/sessions/{session_id}/transcript.txt" if transcript_present else None,  # Plain text
        },
    }
    return JSONResponse(man)


# Returns structured transcript as JSON array
# Each item contains id, start_ms, end_ms, and text
@app.get("/sessions/{session_id}/transcript")
def transcript_json(session_id: int) -> JSONResponse:
    with _db() as conn:
        s = _get_session(conn, session_id)
        if not s["file_path"]:
            raise HTTPException(status_code=404, detail="Transcript not found for session")
        canonical = canonicalize_path(s["file_path"])
        cur = conn.execute(
            "SELECT transcription FROM audio_transcriptions WHERE name = ? ORDER BY created_at DESC LIMIT 1",
            (canonical,),
        )
        row = cur.fetchone()
        if row is None or not row[0]:
            raise HTTPException(status_code=404, detail="Transcript not found for session")
        items = parse_bracketed_transcript(row[0])
    return JSONResponse(items)


# Returns raw transcript text without parsing
# Useful for downloading or viewing plain text
@app.get("/sessions/{session_id}/transcript.txt")
def transcript_raw(session_id: int) -> PlainTextResponse:
    with _db() as conn:
        s = _get_session(conn, session_id)
        if not s["file_path"]:
            raise HTTPException(status_code=404, detail="Transcript not found for session")
        canonical = canonicalize_path(s["file_path"])
        cur = conn.execute(
            "SELECT transcription FROM audio_transcriptions WHERE name = ? ORDER BY created_at DESC LIMIT 1",
            (canonical,),
        )
        row = cur.fetchone()
        if row is None or not row[0]:
            raise HTTPException(status_code=404, detail="Transcript not found for session")
        txt = row[0]
    return PlainTextResponse(txt)


# Health check endpoint for monitoring
@app.get("/healthz")
def healthz() -> Dict[str, str]:
    return {"status": "ok"}


# Run: uvicorn server:app --reload
