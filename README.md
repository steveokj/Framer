Realtime transcription with faster-whisper

Overview

- Start/stop GUI records microphone audio and streams it to faster-whisper.
- Stores a single, full-session transcription row in SQLite with per-segment timestamps in text form (like an SRT-style listing).
- Also writes a WAV file for each session under `sessions/`.

Files

- `gui.py`: minimal Tkinter UI with Start/Stop.
- `realtime_transcriber.py`: audio capture + streaming transcription + DB writes.
- `db.py`: SQLite schema and helper methods.
- `faster.py`: original sample file transcription (unchanged).

Database schema

- `audio_sessions(id, title, file_path, device, sample_rate, channels, model, start_time, end_time, status)`
- `audio_transcriptions(id, name, model_size, transcription, created_at)`
- `audio_transcriptions_fts`: FTS5 mirror for fast text search with triggers to keep it in sync.

Install

1) Create/activate your venv (optional) and install deps:

   pip install faster-whisper sounddevice numpy

   For CPU-only: set device to `cpu` in the GUI. For CUDA, ensure compatible NVIDIA drivers and ctranslate2 CUDA wheels are installed by faster-whisper.

Run

   python gui.py

Usage

- Click Start to begin a new session; use Play/Pause to pause/resume capture.
- Click Stop to finalize the session (single row with the whole transcript) and close the WAV file.

Notes

- Default sample rate is 16 kHz mono which matches Whisper’s expectations. If your device cannot open at 16 kHz, adjust `TranscriberConfig.sample_rate` in `gui.py` or `realtime_transcriber.py`.
- If CUDA initialization fails, the transcriber falls back to CPU with `int8` compute type.
