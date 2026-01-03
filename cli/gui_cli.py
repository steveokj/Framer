"""
Lightweight CLI wrapper for gui_new.py so it can be launched headlessly or
configured via command-line flags (mirroring the way screenpipe.exe is run).
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Launch the Whisper GUI recorder with CLI options.")
    parser.add_argument("--model-size", default="large-v2", help="Whisper model size (default: large-v2)")
    parser.add_argument("--device", default="cuda", help="Device for inference (cuda/cpu)")
    parser.add_argument("--compute-type", default="float32", help="Compute type (float16/float32/int8_float16/...)")
    parser.add_argument("--sessions-dir", default="sessions", help="Output directory for WAV files")
    parser.add_argument("--beam-size", type=int, default=5, help="Beam size passed to the transcriber")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    # Expose configuration via env vars consumed by gui_new.py/TranscriberConfig
    env = os.environ.copy()
    env["GUI_CFG_MODEL_SIZE"] = args.model_size
    env["GUI_CFG_DEVICE"] = args.device
    env["GUI_CFG_COMPUTE_TYPE"] = args.compute_type
    env["GUI_CFG_SESSIONS_DIR"] = args.sessions_dir
    env["GUI_CFG_BEAM_SIZE"] = str(args.beam_size)

    gui_path = ROOT / "gui_new.py"
    cmd = [sys.executable, str(gui_path)]
    completed = subprocess.run(cmd, cwd=str(ROOT), env=env)
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
