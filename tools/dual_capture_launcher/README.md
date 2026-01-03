# Dual Capture Launcher

Quick helper GUI that mirrors the CLI commands from `video_cli_text.txt` and `sound_cli_text.txt` so you can start/stop both recorders together and control them from the Windows tray.

## Files

- `dual_capture_launcher.py` – Tk GUI + system-tray toggle that starts/stops:
  - `target\release\screenpipe.exe --disable-audio --show-cursor --follow-cursor --fps 30.0`
    (working directory defaults to `C:\dev\vcpkg\screenpipe`)
  - `python cli\audio_recorder_cli.py start` (working directory defaults to the repo root), i.e., the new CLI-only controller for the audio recorder.

You can override the commands/working directories by setting:

```powershell
$env:DUAL_LAUNCH_VIDEO_CMD = "target\release\screenpipe.exe --disable-audio"
$env:DUAL_LAUNCH_VIDEO_CWD = "C:\path\to\screenpipe"
$env:DUAL_LAUNCH_AUDIO_CMD = "py gui_new.py"
$env:DUAL_LAUNCH_AUDIO_CWD = "C:\Users\steve\Desktop\Whisper"
```

## Usage

```powershell
(.venv) PS C:\Users\steve\Desktop\Whisper> python tools\dual_capture_launcher\dual_capture_launcher.py
```

- Click **Start** to spawn both processes; **Stop** terminates them.
- The tray icon shows the current state and includes a “Toggle” menu item plus “Quit”.
- Output from both child processes is streamed into the launcher console so you can watch logs exactly as if you had started them manually.

## Requirements

- `sounddevice` (already needed by `gui_new.py`)
- `pystray` and `Pillow` for the tray icon (`pip install pystray pillow`). If those modules are missing, the app still works but the tray integration is disabled.
