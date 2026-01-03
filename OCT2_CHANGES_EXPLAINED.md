# Oct2 Commit Changes - Detailed Explanation

## Overview
The "oct2" commit introduced significant enhancements to the Whisper transcription system, adding video frame integration, speech-only audio playback, and timeline synchronization features. This document explains all changes made.

---

## 1. Core Python Files

### db.py
**Purpose**: Database layer for audio transcription sessions

**Key Features**:
- Full-text search (FTS5) for fast transcript searching
- Automatic triggers to keep FTS index in sync
- WAL mode for better concurrency
- Schema migration support for backward compatibility

**Tables**:
- `audio_sessions`: Recording session metadata (device, model, timestamps, status)
- `audio_transcriptions`: Cached transcripts keyed by canonicalized name + model_size
- `audio_transcriptions_fts`: FTS5 virtual table for fast text search

---

### server.py (FastAPI Application)
**Purpose**: REST API server for managing and querying transcription sessions

**New Functions Added**:

1. **`_related_speech_paths(wav: Path)`**
   - Generates paths for speech-only audio and silence map files
   - Example: `session.wav` → `session-silenced.wav`, `session-silence_map.tsv`

2. **`_existing_speech_assets(wav: Path)`**
   - Checks which post-processing files exist
   - Returns actual paths or None if files don't exist

3. **`_read_silence_map(path: Path)`**
   - Parses TSV file containing silence spans
   - Format: `start_ms \t end_ms` per line
   - Returns sorted list of (start_ms, end_ms) tuples

4. **`_merge_intervals(spans)`**
   - Merges overlapping silence periods
   - Example: `[(0,10), (5,15), (20,30)]` → `[(0,15), (20,30)]`

5. **`_load_speech_timeline(path, total_ms)`**
   - **Most Important Function**: Creates bidirectional time mapping
   - Converts silence map into speech segments
   - Returns timeline data structure with:
     - `segments`: Maps original time ↔ speech-only time
     - `silence_spans`: All silence periods
     - `total_original_ms`: Full recording duration
     - `total_speech_ms`: Duration with silence removed

6. **`_wav_duration_ms(path)`**
   - Calculates WAV file duration from metadata
   - Efficient - doesn't load entire audio file

**Modified Endpoints**:

- **`GET /sessions`**
  - Now includes URLs for speech-only audio and silence maps
  - Checks for post-processed assets using `_existing_speech_assets()`

- **`GET /sessions/{id}/manifest`**
  - Enhanced with timeline data for speech-only playback
  - Includes duration and time mapping information
  - Frontend uses this to sync audio playback with original timestamps

---

### debug_timeline.py
**Purpose**: Debug script to test timeline loading

- Tests `_load_speech_timeline()` function
- Validates silence map parsing
- Useful for troubleshooting post-processing issues

---

### faster.py
**Purpose**: Simple test script for Whisper transcription

- Tests faster-whisper model on recorded sessions
- Configurable model size (medium, large-v2)
- GPU/CPU support with multiple precision options

---

## 2. Web Application (Next.js/TypeScript)

### web/app/api/video/frame/route.ts
**Purpose**: API endpoint to extract video frames using FFmpeg

**Key Features**:
- Supports timestamp-based or offset-based frame extraction
- Fallback logic: filesystem timestamp calculation → database offset query
- Fast seeking with accurate seeking fallback
- Thumbnail generation support
- Returns JPEG image

**Algorithm**:
1. Parse query parameters (file_path, offset_index, timestamp)
2. If timestamp provided, calculate offset from video chunk start
3. Try fast seek (`-ss` before `-i`)
4. If that fails, try accurate seek (`-ss` after `-i`)
5. Attempt multiple offsets if frame extraction fails

---

### web/app/api/video/neighbor/route.ts
**Purpose**: Navigate to next/previous video frame

**How It Works**:
- Calls Python script `video_query.py neighbor` command
- Finds adjacent frame within same video chunk
- Returns new offset_index and timestamp
- Used by video player for frame-by-frame navigation

---

### web/app/api/video/search/route.ts
**Purpose**: Search OCR and audio transcriptions

**Features**:
- Searches both OCR (screen text) and audio databases
- Supports filtering by app name, start time
- Optional audio-to-frame mapping
- Calls Python script `video_query.py search` command

---

### web/app/s/[id]/page.tsx (Session Player Page)
**Purpose**: Audio player with speech-only toggle and timeline sync

**New Features**:

1. **Timeline Converters**
   - `speechToOriginal(ms)`: Converts speech-only time → original time
   - `originalToSpeech(ms)`: Converts original time → speech-only time
   - Enables showing correct timestamps even when playing speech-only audio

2. **Speech-Only Toggle**
   - Switches between original and speech-only audio
   - Maintains playback position using timeline converters
   - Disabled if speech-only assets don't exist

3. **Smart Audio Selection**
   - Automatically chooses appropriate audio URL based on toggle state
   - Uses `manifest.audio.timeline` for time conversions

**User Experience**:
- User can toggle speech-only mode while playing
- Transcript timestamps always show original time
- Clicking transcript line seeks to correct position in current audio

---

### web/app/video/page.tsx
**Purpose**: Video frame search and playback UI

**Features**:
- Search OCR text and audio transcriptions
- Display thumbnail grid of matching frames
- Double-click to open frame in viewer
- Frame-by-frame navigation (prev/next buttons)
- Playback mode with adjustable speed
- Fit-to-viewer or actual-size display modes

**Search Filters**:
- Text query
- App name (for OCR)
- Start time (ISO timestamp)
- Source selection (OCR, Audio, or both)

---

### web/scripts/video_query.py
**Purpose**: Python bridge for querying screenpipe and audio databases

**Commands**:

1. **`search`**
   - Searches OCR frames and audio transcriptions
   - Uses FTS indexes when available for speed
   - Optional audio-to-frame mapping (finds nearest video frame for each audio result)
   - Returns JSON with OCR and audio arrays

2. **`neighbor`**
   - Finds adjacent frame in video chunk
   - Direction: "prev" or "next"
   - Returns frame info or end indicator

3. **`offset`**
   - Calculates ffmpeg seek offset for a frame timestamp
   - Finds earliest frame in chunk (video start)
   - Returns difference in seconds

**Database Schema Expected**:
- **Screenpipe DB**: frames, video_chunks, ocr_text, ocr_text_fts
- **Audio DB**: audio_transcriptions, audio_transcriptions_fts

---

### web/styles/globals.css
**Purpose**: Global styles

**Changes**:
- Container now full-width (removed max-width constraint)
- Added `.viewer` class for responsive image viewing
- `.fit` class for contained images
- `.actual` class for actual-size images

---

## 3. Configuration Changes

### .gitignore
**Additions**:
- Image files: `*.png`, `*.jpg`, `*.jpeg`, `*.gif`, `*.bmp`, `*.tiff`
- `sp_repo/` directory

**Reason**: Keep repository clean from generated screenshots and external repos

---

## 4. Documentation

### db.md
**New File**: Comprehensive guide on:
- Connection pooling in SQLite
- Efficient querying across multiple databases
- `ATTACH DATABASE` technique
- Performance recommendations
- Schema suggestions for mouse/screen events

---

## Key Architectural Patterns

### 1. Speech Timeline Mapping
The most innovative feature is the bidirectional time mapping:

```
Original Audio:  [SPEECH][SILENCE][SPEECH][SILENCE][SPEECH]
                 0ms    10s     15s    20s     25s    30s

Speech-Only:     [SPEECH][SPEECH][SPEECH]
                 0ms    10s     15s     20s

Timeline Segments:
- Original 0-10s → Speech 0-10s (10s duration)
- Original 15-20s → Speech 10-15s (5s duration)  
- Original 25-30s → Speech 15-20s (5s duration)

Silence Spans:
- 10s-15s (5s removed)
- 20s-25s (5s removed)
```

This enables:
- Playing speech-only audio (20s total)
- Displaying original timestamps (30s timeline)
- Seeking correctly between modes

### 2. Multi-Database Integration
The system bridges three databases:
1. **transcriptions.sqlite3**: Audio transcriptions
2. **screenpipe OCR DB**: Video frames and OCR text
3. **Video files**: MP4 chunks accessed via FFmpeg

Python scripts provide the glue layer, with Next.js API routes calling them.

### 3. Lazy Asset Generation
- Original recordings are always saved
- Speech-only audio and silence maps are generated post-processing
- System checks for existence and gracefully degrades if unavailable
- Frontend enables features only when assets exist

---

## Workflow Example

### Recording → Playback Flow:
1. **Record**: `realtime_transcriber.py` captures audio and transcribes
2. **Post-Process**: `speech_silence.py` generates silenced audio + map (optional)
3. **API**: `server.py` serves session manifest with timeline data
4. **Frontend**: `page.tsx` loads manifest and enables speech-only toggle
5. **Playback**: Timeline converters sync timestamps during playback

### Video Search Flow:
1. **User**: Enters search query in `web/app/video/page.tsx`
2. **API**: `/api/video/search` calls `video_query.py search`
3. **Python**: Queries OCR and audio databases using FTS
4. **Mapping**: Optionally finds nearest video frame for audio results
5. **Display**: Grid of thumbnails with metadata
6. **Navigation**: Double-click opens frame viewer with prev/next buttons

---

## Benefits of These Changes

1. **Better UX**: Skip silence during playback while showing original timestamps
2. **Searchability**: Fast full-text search across OCR and audio
3. **Integration**: Video frames linked to audio transcriptions
4. **Flexibility**: Graceful degradation if optional assets unavailable
5. **Performance**: FTS indexes, WAL mode, connection pooling
6. **Maintainability**: Detailed comments and modular architecture

---

## Files Modified Summary

**Python Backend**:
- `db.py` - Enhanced with FTS and better comments
- `server.py` - Added timeline functions and enhanced endpoints
- `debug_timeline.py` - New debug script
- `faster.py` - Added comments

**Web Frontend**:
- `web/app/api/video/frame/route.ts` - New frame extraction endpoint
- `web/app/api/video/neighbor/route.ts` - New neighbor navigation endpoint
- `web/app/api/video/search/route.ts` - New search endpoint
- `web/app/s/[id]/page.tsx` - Enhanced with timeline conversion
- `web/app/video/page.tsx` - New video search page
- `web/scripts/video_query.py` - New Python query bridge
- `web/styles/globals.css` - Updated styles

**Config**:
- `.gitignore` - Ignore images and sp_repo

**Docs**:
- `db.md` - New database guide

---

## Testing the Changes

### Test Timeline Loading:
```bash
python debug_timeline.py
```

### Test Whisper Transcription:
```bash
python faster.py
```

### Start API Server:
```bash
uvicorn server:app --reload
```

### Access Endpoints:
- Sessions list: `http://localhost:8000/sessions`
- Session manifest: `http://localhost:8000/sessions/1/manifest`
- Transcript: `http://localhost:8000/sessions/1/transcript`

### Test Video Search (requires env vars):
```bash
export SCREENPIPE_DB_PATH=/path/to/screenpipe.db
export TRANSCRIPTIONS_DB_PATH=/path/to/transcriptions.sqlite3
# Then start Next.js dev server
```

---

## Conclusion

The "oct2" commit transforms the Whisper transcription system into a comprehensive multimodal search and playback platform. It seamlessly integrates audio transcriptions with video frame capture, enabling powerful search capabilities while maintaining excellent user experience through features like speech-only playback with accurate timestamp preservation.


