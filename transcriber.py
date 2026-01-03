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
except Exception as e:
    sd = None

from faster_whisper import WhisperModel
from db import TranscriptionDB

# Simple console logger
logger = logging.getLogger("transcriber")
if not logger.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s: %(message)s", datefmt="%H:%M:%S"))
    logger.addHandler(_h)
    logger.setLevel(logging.INFO)


@dataclass
class TranscriberConfig:
    """Configuration for the simple transcriber"""
    model_size: str = "medium"
    device: str = "cuda"
    language: str = "en"
    compute_type: str = "float16"
    sample_rate: int = 16000
    channels: int = 1
    beam_size: int = 5
    sessions_dir: str = "sessions"


class SimpleTranscriber:
    """
    A simple transcriber that records audio and transcribes only after recording stops.
    
    Unlike the realtime transcriber, this:
    - Records all audio to a WAV file
    - Does NOT transcribe during recording
    - Transcribes the complete audio file after stop() is called
    - Stores the final transcription in the database
    """
    
    def __init__(
        self,
        db_path: str = "transcriptions.sqlite3",
        config: Optional[TranscriberConfig] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
        on_complete: Optional[Callable[[str, str], None]] = None,
    ) -> None:
        """
        Initialize the simple transcriber.
        
        Args:
            db_path: Path to SQLite database
            config: Transcriber configuration
            on_error: Callback for errors - signature: on_error(exception)
            on_complete: Callback after transcription completes - signature: on_complete(transcription_text, wav_path)
        """
        if config is None:
            config = TranscriberConfig()
        self.cfg = config
        self.on_error = on_error
        self.on_complete = on_complete

        # Initialize Whisper model with CPU fallback
        try:
            self.model = WhisperModel(
                self.cfg.model_size,
                device=self.cfg.device,
                compute_type=self.cfg.compute_type,
            )

            logger.info(
                f"cfg: {self.cfg}")
        except Exception:
            if self.cfg.device != "cpu":
                # Fallback to CPU if GPU not available
                logger.warning("GPU not available, falling back to CPU")
                self.model = WhisperModel(
                    self.cfg.model_size,
                    device="cpu",
                    compute_type="int8",
                )
            else:
                raise

        # Initialize database connection
        self.db = TranscriptionDB(db_path)
        self.session_id: Optional[int] = None

        # Runtime state for audio recording
        self._audio_q: "queue.Queue[np.ndarray]" = queue.Queue(maxsize=256)
        self._stop_event = threading.Event()
        self._paused_event = threading.Event()
        self._record_thread: Optional[threading.Thread] = None
        self._stream: Optional[sd.InputStream] = None if sd else None
        self._wav: Optional[wave.Wave_write] = None
        self._wav_path: Optional[Path] = None
        self._total_frames = 0

    def start(self, title: Optional[str] = None) -> int:
        """
        Start recording audio from the microphone.
        
        Args:
            title: Optional title for this recording session
            
        Returns:
            session_id: Database ID for this session
        """
        if sd is None:
            raise RuntimeError(
                "sounddevice is not available. Install with: pip install sounddevice"
            )

        if self._record_thread and self._record_thread.is_alive():
            raise RuntimeError("Recording already in progress")

        # Ensure sessions directory exists
        sessions_dir = Path(self.cfg.sessions_dir)
        sessions_dir.mkdir(parents=True, exist_ok=True)

        # Create session WAV file with timestamp
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        self._wav_path = sessions_dir / f"session-{stamp}.wav"

        # Create database session entry
        self.session_id = self.db.create_session(
            title=title or f"Session {stamp}",
            file_path=str(self._wav_path),
            device=str(sd.default.device),
            sample_rate=self.cfg.sample_rate,
            channels=self.cfg.channels,
            model=f"faster-whisper:{self.cfg.model_size}/{self.cfg.compute_type}",
        )

        # Open WAV file for writing
        self._wav = wave.open(str(self._wav_path), "wb")
        self._wav.setnchannels(self.cfg.channels)
        self._wav.setsampwidth(2)  # 16-bit PCM
        self._wav.setframerate(self.cfg.sample_rate)
        self._total_frames = 0

        # Start microphone audio stream
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

        # Start recording thread (just writes to WAV, no transcription yet)
        self._record_thread = threading.Thread(target=self._run_recording, daemon=True)
        self._record_thread.start()
        
        logger.info(
            "Started recording (session %s). WAV=%s device=%s sr=%d ch=%d",
            self.session_id,
            self._wav_path,
            str(sd.default.device),
            self.cfg.sample_rate,
            self.cfg.channels,
        )
        return self.session_id

    def stop(self) -> None:
        """
        Stop recording and transcribe the complete audio file.
        
        This will:
        1. Stop the audio stream
        2. Close the WAV file
        3. Transcribe the entire recording
        4. Save transcription to database
        5. Call on_complete callback if provided
        """
        self._stop_event.set()
        
        # Stop and close audio stream
        try:
            if self._stream:
                self._stream.stop()
                self._stream.close()
        except Exception:
            pass
        finally:
            self._stream = None

        # Signal recording thread to stop
        try:
            self._audio_q.put_nowait(None)  # type: ignore[arg-type]
        except Exception:
            pass

        # Wait for recording thread to finish
        if self._record_thread:
            self._record_thread.join(timeout=10)
            self._record_thread = None

        # Close WAV file
        if self._wav:
            try:
                self._wav.close()
            except Exception:
                pass
            self._wav = None

        logger.info("Stopped recording (session %s). Total frames: %d", self.session_id, self._total_frames)

        # Now transcribe the complete audio file
        if self._wav_path and self._wav_path.exists() and self.session_id is not None:
            self._transcribe_and_save()
        
        # Update session status
        if self.session_id is not None:
            self.db.end_session(self.session_id, status="completed")
            self.session_id = None

    def pause(self) -> None:
        """Pause audio recording without ending the session."""
        self._paused_event.set()
        logger.info("Paused recording (session %s).", self.session_id)

    def resume(self) -> None:
        """Resume audio recording for the current session."""
        self._paused_event.clear()
        logger.info("Resumed recording (session %s).", self.session_id)

    def _audio_callback(self, indata, frames, time, status):
        """
        Callback invoked by sounddevice when audio data is available.
        
        This runs on a separate audio thread and just writes audio to the WAV file.
        No transcription happens here.
        """
        if status:
            # Audio dropouts or overflows - log but continue
            pass
        
        # Skip if stopped or paused
        if self._stop_event.is_set() or self._paused_event.is_set():
            return

        # Write audio to WAV file as 16-bit PCM
        if self._wav is not None and not self._paused_event.is_set():
            # Clip to valid range and convert to 16-bit integers
            pcm16 = np.clip(indata, -1.0, 1.0)
            pcm16 = (pcm16 * 32767.0).astype(np.int16)
            self._wav.writeframes(pcm16.tobytes())
            self._total_frames += frames

    def _run_recording(self) -> None:
        """
        Recording thread main loop.
        
        This just keeps the thread alive while recording.
        The actual audio writing happens in the callback.
        """
        try:
            while not self._stop_event.is_set():
                self._stop_event.wait(timeout=0.5)
        except Exception as e:
            logger.exception("Recording error: %s", e)
            if self.on_error:
                try:
                    self.on_error(e)
                except Exception:
                    pass

    def _transcribe_and_save(self) -> None:
        """
        Transcribe the complete recorded audio file and save to database.
        
        This is called after stop() closes the WAV file.
        """
        try:
            wav_path_str = str(self._wav_path)
            logger.info("Starting transcription of %s", wav_path_str)
            
            # Transcribe the entire audio file at once
            segments, info = self.model.transcribe(
                audio=wav_path_str,
                beam_size=self.cfg.beam_size,
                language=self.cfg.language,
                word_timestamps=False,
            )
            
            # logger.info(
            #     "Detected language '%s' with probability %.2f",
            #     info.language,
            #     info.language_probability
            # )
            
            # Collect all segments into formatted transcript
            transcript_lines = []
            for seg in segments:
                text = (seg.text or "").strip()
                if not text:
                    continue
                
                # Format: [start -> end] text
                line = f"[{seg.start:.2f}s -> {seg.end:.2f}s]  {text}"
                transcript_lines.append(line)
                # logger.info(line)
            
            # Save complete transcript to database
            if transcript_lines and self._wav_path is not None:
                full_text = "\n".join(transcript_lines)
                self.db.insert_transcription(
                    name=str(self._wav_path),
                    model_size=self.cfg.model_size,
                    transcription=full_text,
                )
                logger.info(
                    "Session %s transcript saved (%d segments).",
                    self.session_id,
                    len(transcript_lines),
                )
                
                # Call completion callback if provided
                if self.on_complete:
                    try:
                        self.on_complete(full_text, wav_path_str)
                    except Exception:
                        pass
            else:
                logger.warning("No transcription generated for session %s", self.session_id)
                
        except Exception as e:
            logger.exception("Transcription failed: %s", e)
            if self.on_error:
                try:
                    self.on_error(e)
                except Exception:
                    pass
