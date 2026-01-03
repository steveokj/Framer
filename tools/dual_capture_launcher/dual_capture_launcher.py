"""
Simple launcher that starts/stops the video + audio recorders together and exposes both
a minimal Tk GUI and a Windows system-tray toggle.

Defaults are derived from the commands used in:
    - video_cli_text.txt
    - sound_cli_text.txt

You can edit VIDEO_CMD/AUDIO_CMD below or override them via env vars.
"""

from __future__ import annotations

import os
import queue
import signal
import subprocess
import sys
import threading
import time
import tkinter as tk
from dataclasses import dataclass
from pathlib import Path
from tkinter import ttk, messagebox
from typing import Callable, List, Optional

try:
    from PIL import Image, ImageDraw
    import pystray
except Exception:  # pragma: no cover - tray is optional
    pystray = None
    Image = None

ROOT = Path(__file__).resolve().parents[2]


def default_python() -> str:
    return sys.executable or "python"


VIDEO_CMD_DEFAULT = [
    "target\\release\\screenpipe.exe",
    "--disable-audio",
    "--show-cursor",
    "--follow-cursor",
    "--fps",
    "10.0",
]
VIDEO_CWD_DEFAULT = Path("C:/dev/vcpkg/screenpipe")

AUDIO_CMD_DEFAULT = [default_python(), "cli\\audio_recorder_cli.py", "start", "--non-interactive"]
AUDIO_CWD_DEFAULT = ROOT


def _env_command(name: str, default: List[str]) -> List[str]:
    raw = os.environ.get(name)
    if not raw:
        return default
    return [part.strip() for part in raw.split()]


@dataclass
class LaunchConfig:
    video_cmd: List[str]
    video_cwd: Path
    audio_cmd: List[str]
    audio_cwd: Path

    @classmethod
    def load(cls) -> "LaunchConfig":
        video_cmd = _env_command("DUAL_LAUNCH_VIDEO_CMD", VIDEO_CMD_DEFAULT)
        audio_cmd = _env_command("DUAL_LAUNCH_AUDIO_CMD", AUDIO_CMD_DEFAULT)
        video_cwd = Path(os.environ.get("DUAL_LAUNCH_VIDEO_CWD", str(VIDEO_CWD_DEFAULT)))
        audio_cwd = Path(os.environ.get("DUAL_LAUNCH_AUDIO_CWD", str(AUDIO_CWD_DEFAULT)))
        return cls(video_cmd=video_cmd, video_cwd=video_cwd, audio_cmd=audio_cmd, audio_cwd=audio_cwd)


class DualCaptureController:
    def __init__(self, cfg: LaunchConfig, log_callback: Optional[Callable[[str], None]] = None) -> None:
        self.cfg = cfg
        self.video_proc: Optional[subprocess.Popen] = None
        self.audio_proc: Optional[subprocess.Popen] = None
        self._lock = threading.Lock()
        self._log_callback = log_callback

    def start(self) -> None:
        with self._lock:
            if self.is_running:
                return
            try:
                self.video_proc = self._spawn(self.cfg.video_cmd, self.cfg.video_cwd)
                time.sleep(0.5)  # slight stagger to keep logs readable
                self.audio_proc = self._spawn(self.cfg.audio_cmd, self.cfg.audio_cwd)
            except Exception:
                self._terminate(self.video_proc)
                self.video_proc = None
                self._log("Failed to start processes; cleaning up.")
                raise

    def stop(self) -> None:
        with self._lock:
            self._terminate(self.video_proc)
            self._terminate(self.audio_proc)
            self.video_proc = None
            self.audio_proc = None

    @property
    def is_running(self) -> bool:
        return any(proc and proc.poll() is None for proc in (self.video_proc, self.audio_proc))

    @property
    def video_running(self) -> bool:
        return self.video_proc is not None and self.video_proc.poll() is None

    @property
    def audio_running(self) -> bool:
        return self.audio_proc is not None and self.audio_proc.poll() is None

    def _log(self, message: str) -> None:
        if self._log_callback:
            self._log_callback(message)

    def _spawn(self, cmd: List[str], cwd: Path) -> subprocess.Popen:
        if not cmd:
            raise ValueError("command cannot be empty")
        resolved_cmd = list(cmd)
        exe = Path(resolved_cmd[0])
        if not exe.is_absolute():
            exe = cwd / exe
        resolved_cmd[0] = str(exe)
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
        proc = subprocess.Popen(
            resolved_cmd,
            cwd=str(cwd),
            creationflags=creationflags,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        threading.Thread(target=self._pipe_output, args=(proc,), daemon=True).start()
        return proc

    def _pipe_output(self, proc: subprocess.Popen) -> None:
        if not proc.stdout:
            return
        for line in proc.stdout:
            formatted = f"[{proc.pid}] {line}"
            sys.stdout.write(formatted)
            self._log(formatted.rstrip())
        proc.stdout.close()

    def _terminate(self, proc: Optional[subprocess.Popen]) -> None:
        if not proc:
            return
        if proc.poll() is not None:
            return
        if os.name == "nt":
            try:
                proc.send_signal(signal.CTRL_BREAK_EVENT)
            except Exception:
                pass
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.terminate()
        else:
            proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        self._log(f"Process {proc.pid} terminated.")


class DualCaptureApp:
    def __init__(self, controller: DualCaptureController, log_queue: Optional["queue.Queue[str]"] = None) -> None:
        self.controller = controller
        self.root = tk.Tk()
        self.root.title("Dual Capture Launcher")
        self.root.geometry("440x360")
        self.status_var = tk.StringVar(value="idle")
        self.button_text = tk.StringVar(value="Start")
        self.video_status = tk.StringVar(value="video: idle")
        self.audio_status = tk.StringVar(value="audio: idle")
        self._tray_queue: "queue.Queue[str]" = queue.Queue()
        self._log_queue: "queue.Queue[str]" = log_queue or queue.Queue()
        self._tray_icon = None
        self._tray_images: dict[str, Optional["Image.Image"]] = {"idle": None, "active": None, "paused": None}
        self._build_ui()
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)
        self._init_tray()
        self._poll_state()

    # UI
    def _build_ui(self) -> None:
        frm = ttk.Frame(self.root, padding=16)
        frm.pack(fill=tk.BOTH, expand=True)

        ttk.Label(frm, text="Video command:").grid(row=0, column=0, sticky="w")
        ttk.Label(frm, text=" ".join(self.controller.cfg.video_cmd), wraplength=360).grid(row=1, column=0, sticky="w")
        ttk.Label(frm, text="Audio command:", padding=(0, 8, 0, 0)).grid(row=2, column=0, sticky="w")
        ttk.Label(frm, text=" ".join(self.controller.cfg.audio_cmd), wraplength=360).grid(row=3, column=0, sticky="w")

        btn = ttk.Button(frm, textvariable=self.button_text, command=self.toggle, width=12)
        btn.grid(row=4, column=0, pady=8, sticky="w")

        ttk.Label(frm, textvariable=self.status_var, foreground="blue").grid(row=5, column=0, sticky="w")
        ttk.Label(frm, textvariable=self.video_status).grid(row=6, column=0, sticky="w")
        ttk.Label(frm, textvariable=self.audio_status).grid(row=7, column=0, sticky="w")

        ttk.Label(frm, text="Logs:", padding=(0, 8, 0, 0)).grid(row=8, column=0, sticky="w")
        self.log_text = tk.Text(frm, height=8, state=tk.DISABLED, wrap=tk.WORD, font=("Consolas", 9))
        self.log_text.grid(row=9, column=0, sticky="nsew")

        frm.rowconfigure(9, weight=1)
        frm.columnconfigure(0, weight=1)

    def toggle(self) -> None:
        if self.controller.is_running:
            self.controller.stop()
        else:
            try:
                self.controller.start()
            except Exception as exc:
                messagebox.showerror("Failed to start", str(exc))
        self._update_status()

    def _poll_state(self) -> None:
        self._update_status()
        self._drain_tray_queue()
        self._drain_log_queue()
        self.root.after(500, self._poll_state)

    def _update_status(self) -> None:
        running = self.controller.is_running
        self.button_text.set("Stop" if running else "Start")
        self.status_var.set("running" if running else "idle")
        self.video_status.set(f"video: {'running' if self.controller.video_running else 'idle'}")
        self.audio_status.set(f"audio: {'running' if self.controller.audio_running else 'idle'}")
        if self._tray_icon:
            try:
                self._tray_icon.title = f"Dual Capture ({'running' if running else 'idle'})"
                image = self._current_tray_image()
                if image:
                    self._tray_icon.icon = image
            except Exception:
                pass

    # Tray
    def _init_tray(self) -> None:
        if not pystray or not Image:
            print("pystray/Pillow not available; tray icon disabled")
            return
        self._tray_images["idle"] = self._make_tray_image("idle")
        self._tray_images["active"] = self._make_tray_image("active")
        self._tray_images["paused"] = self._make_tray_image("paused")

        menu = pystray.Menu(
            pystray.MenuItem(
                "Toggle Capture",
                lambda icon, item: self._tray_queue.put("toggle"),
                default=True,
            ),
            pystray.MenuItem(
                "Quit",
                lambda icon, item: self._tray_queue.put("quit"),
            ),
        )
        icon = pystray.Icon(
            "dual_capture",
            self._current_tray_image(),
            "Dual Capture (idle)",
            menu,
        )

        def run_icon() -> None:
            icon.run()

        threading.Thread(target=run_icon, daemon=True).start()
        self._tray_icon = icon

    def _make_tray_image(self, state: str) -> Optional["Image.Image"]:
        if not Image:
            return None
        image = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
        draw = ImageDraw.Draw(image)
        draw.ellipse((4, 4, 60, 60), fill="#0f172a", outline="#1e293b", width=2)

        if state == "active":
            draw.polygon([(26, 18), (26, 46), (46, 32)], fill="#22c55e")
        elif state == "paused":
            draw.rectangle((22, 18, 30, 46), fill="#facc15")
            draw.rectangle((36, 18, 44, 46), fill="#facc15")
        else:  # idle
            draw.rectangle((24, 18, 44, 46), fill="#9ca3af")
        return image

    def _current_tray_image(self) -> Optional["Image.Image"]:
        if self.controller.video_running and self.controller.audio_running:
            return self._tray_images.get("active")
        if self.controller.video_running or self.controller.audio_running:
            return self._tray_images.get("paused")
        return self._tray_images.get("idle")

    def _drain_tray_queue(self) -> None:
        while True:
            try:
                item = self._tray_queue.get_nowait()
            except queue.Empty:
                break
            if item == "toggle":
                self.toggle()
            elif item == "quit":
                self._on_close()

    def _drain_log_queue(self) -> None:
        while True:
            try:
                line = self._log_queue.get_nowait()
            except queue.Empty:
                break
            self.log_text.configure(state=tk.NORMAL)
            self.log_text.insert(tk.END, line.rstrip() + "\n")
            self.log_text.see(tk.END)
            self.log_text.configure(state=tk.DISABLED)

    # Lifecycle
    def _on_close(self) -> None:
        self.controller.stop()
        if self._tray_icon:
            try:
                self._tray_icon.stop()
            except Exception:
                pass
        self.root.destroy()

    def run(self) -> None:
        self.root.mainloop()


def main() -> int:
    cfg = LaunchConfig.load()
    app_log_queue: "queue.Queue[str]" = queue.Queue()
    controller = DualCaptureController(cfg, log_callback=app_log_queue.put)
    app = DualCaptureApp(controller, log_queue=app_log_queue)
    app.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
