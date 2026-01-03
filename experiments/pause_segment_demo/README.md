# Pause Segment Demo

This folder contains a self‑contained experiment that keeps pause/resume fast (no Whisper reloads) while still giving you the metadata needed to line recorded audio up with an external video timeline.

## Files

| File | Description |
| --- | --- |
| `segment_tracking_transcriber.py` | Minimal recorder that mirrors `SimpleTranscriber`, logs every pause/resume with wall‑clock timestamps, and writes a JSON manifest alongside the WAV so you can reconstruct real time later. |

## Trying It Out

```bash
python experiments/pause_segment_demo/segment_tracking_transcriber.py
```

- The script records from the default microphone using `sounddevice` (same dependency as the main GUI).
- Press **Enter** to toggle pause/resume without tearing down the recording pipeline.
- Type `stop` (or hit Ctrl+C) to finish.
- You will get two files in the `sessions/` folder:
  - `segment-demo-<timestamp>.wav`
  - `segment-demo-<timestamp>.segments.json`

Example manifest snippet:

```jsonc
{
  "segments": [
    { "wall_start_ms": 0.0, "wall_end_ms": 5300.0, "audio_start_sec": 0.0, "audio_end_sec": 5.3, "gap_from_prev_ms": null },
    { "wall_start_ms": 11000.0, "wall_end_ms": 15000.0, "audio_start_sec": 5.3, "audio_end_sec": 9.3, "gap_from_prev_ms": 5700.0 }
  ],
  "total_paused_ms": 5700.0
}
```

You can feed those gaps directly into `video_playback_new` (or into `speech_silence.py`) to re‑insert silence virtually, derive the proper audio offset for each frame timestamp, or even cut the single WAV into per‑segment files without forcing the user to restart the model.
