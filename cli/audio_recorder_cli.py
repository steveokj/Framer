"""
Command-line controller for the SimpleTranscriber.

Usage:
    python cli/audio_recorder_cli.py start --model-size large-v2 ...

Once started, type commands (`pause`, `resume`, `stop`, `status`, `help`)
in the terminal to control recording without the GUI.
"""

from __future__ import annotations

import argparse
import sys
import threading
import time
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from transcriber import SimpleTranscriber, TranscriberConfig


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="CLI controller for the Whisper audio recorder.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    start = subparsers.add_parser("start", help="Start recording. Defaults to interactive command mode.")
    start.add_argument("--model-size", default="large-v2")
    start.add_argument("--device", default="cuda")
    start.add_argument("--compute-type", default="float32")
    start.add_argument("--sessions-dir", default="sessions")
    start.add_argument("--beam-size", type=int, default=5)
    start.add_argument(
        "--non-interactive",
        action="store_true",
        help="Run headless (no stdin commands). Stop with Ctrl+C or by terminating the process.",
    )

    return parser.parse_args()


class CLIRunner:
    def __init__(self, cfg: TranscriberConfig) -> None:
        self.cfg = cfg
        self.transcriber = SimpleTranscriber(
            config=cfg,
            on_error=lambda e: print(f"[error] {e}", file=sys.stderr),
            on_complete=lambda text, path: print(f"\nTranscription stored for {path}\n"),
        )
        self._session_id: Optional[int] = None
        self._lock = threading.Lock()

    def start(self) -> None:
        with self._lock:
            if self._session_id is not None:
                print("Recording already running.")
                return
            self._session_id = self.transcriber.start()
            print(f"Recording started (session {self._session_id}).")

    def stop(self) -> None:
        with self._lock:
            if self._session_id is None:
                print("Recording is not running.")
                return
            print("Stopping... this may take a few seconds while transcription completes.")
            self.transcriber.stop()
            self._session_id = None

    def pause(self) -> None:
        with self._lock:
            if self._session_id is None:
                print("Recording is not running.")
                return
        self.transcriber.pause()
        print("Paused.")

    def resume(self) -> None:
        with self._lock:
            if self._session_id is None:
                print("Recording is not running.")
                return
        self.transcriber.resume()
        print("Resumed.")

    def status(self) -> None:
        running = self._session_id is not None
        print(f"Status: {'recording' if running else 'idle'} (session={self._session_id})")


def start_command(args: argparse.Namespace) -> int:
    cfg = TranscriberConfig(
        model_size=args.model_size,
        device=args.device,
        compute_type=args.compute_type,
        sessions_dir=args.sessions_dir,
        beam_size=args.beam_size,
    )
    runner = CLIRunner(cfg)
    runner.start()
    if args.non_interactive:
        print("Headless mode: press Ctrl+C to stop.")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            print("\nCtrl+C received. Stopping...")
            runner.stop()
        return 0

    print("Commands: pause | resume | stop | status | help")
    try:
        while True:
            try:
                cmd = input("audio> ").strip().lower()
            except EOFError:
                cmd = "stop"
            if cmd in ("pause", "p"):
                runner.pause()
            elif cmd in ("resume", "r"):
                runner.resume()
            elif cmd in ("status", "s"):
                runner.status()
            elif cmd in ("stop", "exit", "quit"):
                runner.stop()
                break
            elif cmd in ("help", "h", "?"):
                print("Available commands: pause, resume, status, stop, help")
            elif not cmd:
                continue
            else:
                print(f"Unknown command: {cmd}")
    except KeyboardInterrupt:
        print("\nCtrl+C received. Stopping...")
        runner.stop()
    return 0


def main() -> int:
    args = parse_args()
    if args.command == "start":
        return start_command(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
