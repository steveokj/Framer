import threading
import queue
import wave
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional, Callable

import numpy as np
import logging

try:
    import sounddevice as sd
except Exception as e:  # pragma: no cover
    sd = None

from faster_whisper import WhisperModel

from db import TranscriptionDB

try:
    import webrtcvad  # type: ignore
except Exception:
    webrtcvad = None  # Optional dependency

# Simple console logger
logger = logging.getLogger("realtime_transcriber")
if not logger.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s: %(message)s", datefmt="%H:%M:%S"))
    logger.addHandler(_h)
    logger.setLevel(logging.INFO)


@dataclass
class TranscriberConfig:
    model_size: str = "large-v2" # "medium"
    device: str = "cuda"
    language: str = "en"
    compute_type: str = "float32"  # e.g., "float16", "float32", "int8_float16"
    sample_rate: int = 16000
    channels: int = 1
    beam_size: int = 5
    vad_filter: bool = True
    overlap_seconds: float = 0.3  # small tail to avoid boundary cuts
    # Silence-driven flushing (no arbitrary time slicing)
    vad_silence_seconds: float = 0.2  # flush once this much trailing silence is detected
    vad_energy_threshold: float = 0.0015  # RMS < threshold is treated as silence (adaptive baseline)
    # Optional WebRTC VAD (preferred when available)
    vad_use_webrtc: bool = True
    vad_aggressiveness: int = 1  # 0-3 (3 = most aggressive) #  Change back to 2 for more aggressive VAD
    vad_frame_ms: int = 30  # must be 10, 20 or 30 for WebRTC
    max_buffer_seconds: float = 10.0  # safety cap to avoid long-latency backlogs
    condition_on_previous_text: bool = False,
    sessions_dir: str = "sessions"


class RealtimeTranscriber:
    def __init__(
        self,
        db_path: str = "transcriptions.sqlite3",
        config: Optional[TranscriberConfig] = None,
        on_segment: Optional[Callable[[str, float, float], None]] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
        on_complete: Optional[Callable[[str], None]] = None,
    ) -> None:
        if config is None:
            config = TranscriberConfig()
        self.cfg = config
        self.on_segment = on_segment
        self.on_error = on_error
        # Called after stop() completes and the WAV is closed.
        # Signature: on_complete(wav_path: str) -> None
        # If no completion callback is provided, use a default that builds
        # a speech-only audio and silence map next to the recorded WAV.
        self.on_complete = on_complete or self._default_on_complete

        # Model (with simple CPU fallback if CUDA not available)
        try:
            self.model = WhisperModel(
                self.cfg.model_size,
                device=self.cfg.device,
                compute_type=self.cfg.compute_type,
            )
        except Exception:
            if self.cfg.device != "cpu":
                # Fallback to CPU to remain usable out-of-the-box
                self.model = WhisperModel(
                    self.cfg.model_size,
                    device="cpu",
                    compute_type="int8",  # lighter CPU default
                )
            else:
                raise

        # DB
        self.db = TranscriptionDB(db_path)
        self.session_id: Optional[int] = None

        # Runtime state
        self._audio_q: "queue.Queue[np.ndarray]" = queue.Queue(maxsize=256)
        self._stop_event = threading.Event()
        self._paused_event = threading.Event()
        self._transcribe_thread: Optional[threading.Thread] = None
        self._stream: Optional[sd.InputStream] = None if sd else None
        self._wav: Optional[wave.Wave_write] = None
        self._wav_path: Optional[Path] = None
        # Optional WebRTC VAD
        self._webrtc_vad = None
        self._vad_remainder = np.empty((0,), dtype=np.float32)
        if webrtcvad and self.cfg.vad_use_webrtc and self.cfg.sample_rate in (8000, 16000, 32000, 48000):
            try:
                self._webrtc_vad = webrtcvad.Vad(int(self.cfg.vad_aggressiveness))
            except Exception:
                self._webrtc_vad = None

    # --- Public API ---
    def start(self, title: Optional[str] = None) -> int:
        if sd is None:
            raise RuntimeError(
                "sounddevice is not available. Install with: pip install sounddevice"
            )

        if self._transcribe_thread and self._transcribe_thread.is_alive():
            raise RuntimeError("Transcription already running")

        # Ensure sessions dir exists
        sessions_dir = Path(self.cfg.sessions_dir)
        sessions_dir.mkdir(parents=True, exist_ok=True)

        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        self._wav_path = sessions_dir / f"session-{stamp}.wav"

        # Create DB session
        self.session_id = self.db.create_session(
            title=title or f"Session {stamp}",
            file_path=str(self._wav_path),
            device=str(sd.default.device),
            sample_rate=self.cfg.sample_rate,
            channels=self.cfg.channels,
            model=f"faster-whisper:{self.cfg.model_size}/{self.cfg.compute_type}",
        )

        # Open WAV writer
        self._wav = wave.open(str(self._wav_path), "wb")
        self._wav.setnchannels(self.cfg.channels)
        self._wav.setsampwidth(2)  # 16-bit PCM
        self._wav.setframerate(self.cfg.sample_rate)

        # Start microphone stream
        self._stop_event.clear()
        self._paused_event.clear()
        self._stream = sd.InputStream(
            samplerate=self.cfg.sample_rate,
            channels=self.cfg.channels,
            dtype="float32",
            callback=self._audio_callback,
            blocksize=512,  # smaller block for faster pause detection (~32ms @16kHz)
        )
        self._stream.start()

        # Start transcription thread
        self._transcribe_thread = threading.Thread(target=self._run_transcription, daemon=True)
        self._transcribe_thread.start()
        logger.info(
            "Started recording (session %s). WAV=%s device=%s sr=%d ch=%d",
            self.session_id,
            self._wav_path,
            str(sd.default.device),
            self.cfg.sample_rate,
            self.cfg.channels,
        )
        if self._webrtc_vad is not None:
            logger.info("WebRTC VAD: enabled (aggr=%d, frame=%dms)", self.cfg.vad_aggressiveness, self.cfg.vad_frame_ms)
        else:
            logger.info("WebRTC VAD: not available; using energy-based pause detection")
        return self.session_id

    def stop(self) -> None:
        self._stop_event.set()
        try:
            if self._stream:
                self._stream.stop()
                self._stream.close()
        except Exception:
            pass
        finally:
            self._stream = None

        # Push a sentinel to unblock generator
        try:
            self._audio_q.put_nowait(None)  # type: ignore[arg-type]
        except Exception:
            pass

        if self._transcribe_thread:
            self._transcribe_thread.join(timeout=30)
            self._transcribe_thread = None

        if self._wav:
            try:
                self._wav.close()
            except Exception:
                pass
            self._wav = None

        if self.session_id is not None:
            self.db.end_session(self.session_id, status="completed")
            logger.info("Stopped recording (session %s).", self.session_id)
            self.session_id = None

        # Invoke completion callback (non-blocking) with final WAV path
        wav_path_str = str(self._wav_path) if self._wav_path is not None else None
        if self.on_complete and wav_path_str:
            try:
                threading.Thread(target=self._run_on_complete, args=(wav_path_str,), daemon=True).start()
            except Exception:
                # Avoid raising from stop()
                pass

    def pause(self) -> None:
        """Pause audio capture/transcription without ending the session."""
        self._paused_event.set()
        logger.info("Paused recording (session %s).", self.session_id)

    def resume(self) -> None:
        """Resume audio capture/transcription for the current session."""
        self._paused_event.clear()
        logger.info("Resumed recording (session %s).", self.session_id)

    # --- Internals ---
    def _audio_callback(self, indata, frames, time, status):  # noqa: A002 - shadow builtins from PortAudio
        if status:
            # Dropouts or overflows; we proceed anyway
            pass
        # indata: shape (frames, channels), float32 in [-1, 1]
        if self._stop_event.is_set() or self._paused_event.is_set():
            return

        # Queue a copy for transcription
        try:
            self._audio_q.put_nowait(indata.copy())
        except queue.Full:
            # If the queue is full, drop the chunk to avoid blocking the audio thread
            pass

        # Write to WAV as 16-bit PCM
        if self._wav is not None and not self._paused_event.is_set():
            pcm16 = np.clip(indata, -1.0, 1.0)
            pcm16 = (pcm16 * 32767.0).astype(np.int16)
            self._wav.writeframes(pcm16.tobytes())

    def _run_transcription(self) -> None:
        # Chunked processing from an in-memory buffer (no generator into ffmpeg)
        sr = self.cfg.sample_rate
        overlap_samples = int(self.cfg.overlap_seconds * sr)
        max_buf_samples = int(self.cfg.max_buffer_seconds * sr)
        audio_buf = np.empty((0,), dtype=np.float32)
        offset_sec = 0.0
        last_emitted_end = -1e9
        initial_prompt = ""
        trailing_silence_sec = 0.0
        noise_floor = max(1e-6, self.cfg.vad_energy_threshold * 0.5)  # adaptive ambient estimate
        had_speech_since_flush = False
        use_webrtc = self._webrtc_vad is not None
        frame_ms = int(self.cfg.vad_frame_ms if self.cfg.vad_frame_ms in (10, 20, 30) else 30)
        frame_samples = int(sr * frame_ms / 1000)

        transcript_lines = []

        try:
            while True:
                # Drain any available chunks
                drained = False
                force_flush = False
                while True:
                    try:
                        chunk = self._audio_q.get(timeout=0.2)
                    except queue.Empty:
                        break
                    if chunk is None:
                        # Sentinel when stopping
                        self._stop_event.set()
                        break
                    drained = True
                    if chunk.ndim == 2 and chunk.shape[1] > 1:
                        chunk = np.mean(chunk, axis=1, keepdims=True)
                    chunk = chunk.reshape(-1)
                    audio_buf = np.concatenate([audio_buf, chunk])
                    # Update VAD state using WebRTC when available, otherwise energy-based fallback
                    if chunk.size:
                        if use_webrtc:
                            proc = np.concatenate([self._vad_remainder, chunk])
                            total = proc.size
                            n_frames = total // frame_samples
                            if n_frames > 0:
                                for i in range(n_frames):
                                    frame = proc[i * frame_samples : (i + 1) * frame_samples]
                                    pcm16 = np.clip(frame, -1.0, 1.0)
                                    pcm16 = (pcm16 * 32767.0).astype(np.int16)
                                    is_speech = False
                                    try:
                                        is_speech = bool(self._webrtc_vad.is_speech(pcm16.tobytes(), sr))  # type: ignore[attr-defined]
                                    except Exception:
                                        # If WebRTC throws, fallback softly
                                        is_speech = np.any(pcm16)
                                    if is_speech:
                                        trailing_silence_sec = 0.0
                                        had_speech_since_flush = True
                                    else:
                                        trailing_silence_sec += frame_ms / 1000.0
                                # remainder
                                start = n_frames * frame_samples
                                self._vad_remainder = proc[start:]
                            else:
                                # Not enough to form a frame yet, keep in remainder
                                self._vad_remainder = proc
                        else:
                            # Energy fallback
                            abs_chunk = np.abs(chunk)
                            thr = max(self.cfg.vad_energy_threshold, noise_floor * 1.8)
                            speech_mask = abs_chunk >= thr
                            dur = chunk.size / sr
                            if speech_mask.any():
                                last_idx = int(np.flatnonzero(speech_mask)[-1])
                                trailing_samples = chunk.size - last_idx - 1
                                trailing_silence_sec = trailing_samples / sr
                                had_speech_since_flush = True
                                # Update noise floor from the trailing silent tail if present
                                if trailing_samples > 0:
                                    tail = chunk[last_idx + 1 :]
                                    if tail.size:
                                        tail_rms = float(np.sqrt(np.mean(np.square(tail), dtype=np.float64)))
                                        noise_floor = 0.98 * noise_floor + 0.02 * max(tail_rms, 1e-7)
                            else:
                                # Entire chunk is silence
                                trailing_silence_sec += dur
                                rms = float(np.sqrt(np.mean(np.square(chunk), dtype=np.float64)))
                                noise_floor = 0.98 * noise_floor + 0.02 * max(rms, 1e-7)

                    # If we have enough trailing silence or user paused, flush immediately
                    if (had_speech_since_flush and trailing_silence_sec >= self.cfg.vad_silence_seconds and audio_buf.size > 0) or (
                        self._paused_event.is_set() and had_speech_since_flush and audio_buf.size > 0
                    ):
                        force_flush = True
                        break

                # Decide whether to decode now
                should_process = False
                if self._stop_event.is_set() and audio_buf.size > 0:
                    should_process = True
                elif force_flush:
                    should_process = True
                elif audio_buf.size >= max_buf_samples and audio_buf.size > 0:
                    should_process = True

                if not should_process:
                    if not drained and self._stop_event.is_set():
                        break
                    continue

                # Process current buffer
                # Trim the trailing silence from the buffer to avoid lag and keep boundaries clean
                trim_tail = int(trailing_silence_sec * sr) if had_speech_since_flush else 0
                trim_tail = max(0, min(trim_tail, audio_buf.size))
                trimmed_samples = audio_buf.size - trim_tail
                to_process = audio_buf[:trimmed_samples].copy()
                if to_process.size == 0:
                    # Nothing meaningful to decode
                    trailing_silence_sec = 0.0
                    had_speech_since_flush = False
                    continue
                segments, info = self.model.transcribe(
                    audio=to_process,
                    beam_size=self.cfg.beam_size,
                    vad_filter=self.cfg.vad_filter,
                    vad_parameters={"min_silence_duration_ms": int(self.cfg.vad_silence_seconds * 1000), "speech_pad_ms": 80},
                    condition_on_previous_text=True,
                    word_timestamps=False,
                    initial_prompt=initial_prompt or None,
                )

                appended_text_parts = []
                for seg in segments:
                    text = (seg.text or "").strip()
                    if not text:
                        continue
                    g_start = float((seg.start or 0.0) + offset_sec)
                    g_end = float((seg.end or 0.0) + offset_sec)
                    if g_end <= last_emitted_end + 0.05:
                        continue
                    last_emitted_end = g_end

                    # Accumulate formatted line for final session transcript
                    line = f"[{g_start:.2f}s -> {g_end:.2f}s]  {text}"
                    transcript_lines.append(line)
                    logger.info(line)

                    if self.on_segment:
                        try:
                            self.on_segment(text, g_start, g_end)
                        except Exception:
                            pass
                    appended_text_parts.append(text)

                # Update prompt context; cap length to avoid runaway
                if appended_text_parts:
                    initial_prompt = (initial_prompt + " " + " ".join(appended_text_parts)).strip()[-1200:]

                # Keep small overlap tail from the end of speech (drop the trailing silence)
                if not self._stop_event.is_set() and overlap_samples > 0 and trimmed_samples > overlap_samples:
                    processed = trimmed_samples - overlap_samples
                    offset_sec += processed / sr
                    audio_buf = audio_buf[trimmed_samples - overlap_samples : trimmed_samples]
                else:
                    offset_sec += trimmed_samples / sr
                    audio_buf = np.empty((0,), dtype=np.float32)
                trailing_silence_sec = 0.0
                had_speech_since_flush = False

                if self._stop_event.is_set() and self._audio_q.empty() and audio_buf.size == 0:
                    break
        except Exception as e:
            logger.exception("Transcription error: %s", e)
            if self.on_error:
                try:
                    self.on_error(e)
                except Exception:
                    pass
            else:
                # Re-raise if no handler provided
                raise
        finally:
            # Save the full transcript as a single DB row for the session
            try:
                if transcript_lines and self._wav_path is not None:
                    full_text = "\n".join(transcript_lines)
                    self.db.insert_transcription(
                        name=str(self._wav_path),
                        model_size=self.cfg.model_size,
                        transcription=full_text,
                    )
                    logger.info(
                        "Session %s transcript saved (%d lines).",
                        self.session_id,
                        len(transcript_lines),
                    )
            except Exception:
                # Avoid masking the original error/cleanup
                pass
            # Ensure WAV closed if stop happened during decoding
            if self._wav is not None:
                try:
                    self._wav.close()
                except Exception:
                    pass
            self._wav = None

    def _run_on_complete(self, wav_path: str) -> None:
        try:
            if self.on_complete:
                logger.info("Starting speech-only conversion for %s", wav_path)
                self.on_complete(wav_path)
        except Exception:
            # Swallow exceptions from user callback to keep shutdown robust
            pass

    def _default_on_complete(self, wav_path: str) -> None:
        try:
            # Lazy import to avoid coupling unless used
            from speech_silence import build_speech_only_with_silence_map, derive_outputs

            out_audio, out_map = derive_outputs(wav_path)
            res = build_speech_only_with_silence_map(wav_path, out_audio, out_map)
            logger.info(
                "Conversion complete. Audio=%s Map=%s Speech=%.2fs Removed=%.2fs Segments=%d",
                res.output_audio_path,
                res.silence_map_path,
                res.speech_ms / 1000.0,
                res.removed_ms / 1000.0,
                res.segment_count,
            )
        except Exception as e:
            logger.exception("Post-processing failed for %s: %s", wav_path, e)
