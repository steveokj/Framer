"""
Experimental recorder that keeps a single WAV on disk but tracks wall-clock pause segments.

This lets us keep the fast pause/resume UX (no Whisper/model re-init) while still
reconstructing the original timeline later when muxing with video or speech timelines.
"""

from __future__ import annotations

import json
import logging
import queue
import threading
import time
import wave
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, List, Optional

import numpy as np

try:
    import sounddevice as sd
except Exception:  # pragma: no cover - optional dependency
    sd = None


logger = logging.getLogger("segment_tracking_transcriber")
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s: %(message)s", "%H:%M:%S"))
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _monotonic_ms() -> float:
    return time.monotonic_ns() / 1_000_000.0


@dataclass
class SegmentRecorderConfig:
    model_size: str = "medium"
    device: str = "cuda"
    compute_type: str = "float16"
    sample_rate: int = 16_000
    channels: int = 1
    beam_size: int = 5
    sessions_dir: str = "sessions"


@dataclass
class SegmentBoundary:
    wall_start_ms: float
    audio_start_samples: int
    wall_end_ms: Optional[float] = None
    audio_end_samples: Optional[int] = None

    def to_manifest_entry(self, *, sample_rate: int, origin_ms: float, previous_wall_end: Optional[float]) -> dict:
        if self.wall_end_ms is None or self.audio_end_samples is None:
            raise ValueError("segment not closed")
        wall_start_rel = self.wall_start_ms - origin_ms
        wall_end_rel = self.wall_end_ms - origin_ms
        return {
            "wall_start_ms": wall_start_rel,
            "wall_end_ms": wall_end_rel,
            "duration_ms": wall_end_rel - wall_start_rel,
            "audio_start_sec": self.audio_start_samples / sample_rate,
            "audio_end_sec": self.audio_end_samples / sample_rate,
            "gap_from_prev_ms": None if previous_wall_end is None else wall_start_rel - (previous_wall_end - origin_ms),
        }


class SegmentTrackingTranscriber:
    """
    Minimal recorder that mirrors SimpleTranscriber but logs pause/resume metadata.

    The WAV on disk contains only the captured speech (no silence padding). The
    accompanying JSON manifest documents how to align the audio samples with the
    wall-clock timeline (and, by extension, any video frame timestamps).
    """

    def __init__(
        self,
        *,
        config: Optional[SegmentRecorderConfig] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
        on_complete: Optional[Callable[[str, str], None]] = None,
    ) -> None:
        if config is None:
            config = SegmentRecorderConfig()
        self.cfg = config
        self.on_error = on_error
        self.on_complete = on_complete

        if sd is None:
            raise RuntimeError("sounddevice is required for this demo. pip install sounddevice")

        self._audio_q: "queue.Queue[np.ndarray]" = queue.Queue(maxsize=256)
        self._stop_event = threading.Event()
        self._paused_event = threading.Event()
        self._record_thread: Optional[threading.Thread] = None
        self._stream: Optional[sd.InputStream] = None
        self._wav: Optional[wave.Wave_write] = None
        self._wav_path: Optional[Path] = None
        self._session_id = None  # placeholder to mirror SimpleTranscriber API
        self._total_frames = 0

        self._segments: List[SegmentBoundary] = []
        self._open_segment: Optional[SegmentBoundary] = None
        self._wall_clock_origin_ms: Optional[float] = None

    # --------------------------------------------------------------------- #
    # Public API

    def start(self, title: Optional[str] = None) -> int:
        if self._record_thread and self._record_thread.is_alive():
            raise RuntimeError("Recording already in progress")

        sessions_dir = Path(self.cfg.sessions_dir)
        sessions_dir.mkdir(parents=True, exist_ok=True)

        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        self._wav_path = sessions_dir / f"segment-demo-{stamp}.wav"
        self._wall_clock_origin_ms = _monotonic_ms()

        self._wav = wave.open(str(self._wav_path), "wb")
        self._wav.setnchannels(self.cfg.channels)
        self._wav.setsampwidth(2)
        self._wav.setframerate(self.cfg.sample_rate)

        self._stop_event.clear()
        self._paused_event.clear()
        self._stream = sd.InputStream(
            samplerate=self.cfg.sample_rate,
            channels=self.cfg.channels,
            dtype="float32",
            callback=self._audio_callback,
            blocksize=512,
        )
        self._stream.start()

        self._record_thread = threading.Thread(target=self._run_recording, daemon=True)
        self._record_thread.start()

        self._open_new_segment()
        logger.info("Segment demo recording started -> %s", self._wav_path)
        return int(time.time())  # dummy session id

    def stop(self) -> None:
        self._stop_event.set()
        try:
            if self._stream:
                self._stream.stop()
                self._stream.close()
        except Exception:
            logger.exception("Failed to stop input stream cleanly")
        finally:
            self._stream = None

        try:
            self._audio_q.put_nowait(None)
        except Exception:
            pass

        if self._record_thread:
            self._record_thread.join(timeout=10)
            self._record_thread = None

        if self._wav:
            try:
                self._wav.close()
            except Exception:
                pass
            self._wav = None

        self._finalize_open_segment()
        self._write_manifest()

        if self.on_complete and self._wav_path:
            try:
                self.on_complete(str(self._wav_path), str(self._manifest_path()))
            except Exception:
                logger.exception("on_complete callback failed")

        logger.info(
            "Segment demo stopped. segments=%d manifest=%s",
            len(self._segments),
            self._manifest_path() if self._wav_path else None,
        )

    def pause(self) -> None:
        if self._paused_event.is_set():
            return
        self._paused_event.set()
        self._finalize_open_segment()
        logger.info("Paused at wall %.2f ms", _monotonic_ms())

    def resume(self) -> None:
        if not self._paused_event.is_set():
            return
        self._paused_event.clear()
        self._open_new_segment()
        logger.info("Resumed at wall %.2f ms", _monotonic_ms())

    # ------------------------------------------------------------------ #
    # Internal helpers

    def _audio_callback(self, indata, frames, time_info, status):
        if status:
            logger.debug("Input stream status: %s", status)
        if self._stop_event.is_set() or self._paused_event.is_set():
            return
        if self._wav is None:
            return
        pcm16 = np.clip(indata, -1.0, 1.0)
        pcm16 = (pcm16 * 32767.0).astype(np.int16)
        self._wav.writeframes(pcm16.tobytes())
        self._total_frames += frames

    def _run_recording(self) -> None:
        try:
            while not self._stop_event.is_set():
                self._stop_event.wait(timeout=0.5)
        except Exception as exc:
            logger.exception("Recording loop failed: %s", exc)
            if self.on_error:
                try:
                    self.on_error(exc)
                except Exception:
                    pass

    def _open_new_segment(self) -> None:
        if self._open_segment is not None:
            return
        start = _monotonic_ms()
        self._open_segment = SegmentBoundary(
            wall_start_ms=start,
            audio_start_samples=self._total_frames,
        )

    def _finalize_open_segment(self) -> None:
        if self._open_segment is None:
            return
        self._open_segment.wall_end_ms = _monotonic_ms()
        self._open_segment.audio_end_samples = self._total_frames
        self._segments.append(self._open_segment)
        self._open_segment = None

    def _manifest_path(self) -> Path:
        if not self._wav_path:
            raise RuntimeError("Recording not started")
        return self._wav_path.with_suffix(".segments.json")

    def _write_manifest(self) -> None:
        if not self._segments or self._wall_clock_origin_ms is None or not self._wav_path:
            return
        manifest_segments = []
        prev_end = None
        for seg in self._segments:
            manifest_segments.append(
                seg.to_manifest_entry(
                    sample_rate=self.cfg.sample_rate,
                    origin_ms=self._wall_clock_origin_ms,
                    previous_wall_end=prev_end,
                )
            )
            prev_end = seg.wall_end_ms

        manifest = {
            "wav_path": str(self._wav_path),
            "sample_rate": self.cfg.sample_rate,
            "created_at": _utc_now_iso(),
            "segments": manifest_segments,
            "total_captured_sec": self._total_frames / self.cfg.sample_rate,
            "total_paused_ms": sum(
                max(0.0, seg.get("gap_from_prev_ms") or 0.0) for seg in manifest_segments[1:]
            ),
        }
        path = self._manifest_path()
        path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        logger.info("Segment manifest written -> %s", path)


if __name__ == "__main__":  # pragma: no cover - manual demo
    recorder = SegmentTrackingTranscriber()
    recorder.start()
    logger.info("Recording... type 'stop' to finish, ENTER toggles pause.")
    try:
        while True:
            cmd = input("[ENTER=toggle pause, stop=finish]> ").strip().lower()
            if cmd == "stop":
                break
            if recorder._paused_event.is_set():
                recorder.resume()
            else:
                recorder.pause()
    except KeyboardInterrupt:
        pass
    finally:
        recorder.stop()
## ... to here, but we need entire file? apply_patch? file truncated. Need complete file.
