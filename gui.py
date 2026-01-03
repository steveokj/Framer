import tkinter as tk
from tkinter import ttk, messagebox

from realtime_transcriber import RealtimeTranscriber, TranscriberConfig


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Realtime Transcription")
        self.geometry("720x420")

        self.model_var = tk.StringVar(value="medium")
        self.compute_var = tk.StringVar(value="float16")
        self.device_var = tk.StringVar(value="cuda")

        self._transcriber = None
        self._session_active = False  # started but not yet stopped
        self._capturing = False       # play/pause state

        # Handle unhandled exceptions in Tk callbacks by exiting the app
        def report_callback_exception(exc, val, tb):
            try:
                messagebox.showerror("Fatal Error", f"{val}")
            finally:
                self.destroy()
        self.report_callback_exception = report_callback_exception  # type: ignore[attr-defined]

        self._build_ui()

    def _build_ui(self):
        frm = ttk.Frame(self, padding=10)
        frm.pack(fill=tk.BOTH, expand=True)

        row = 0
        ttk.Label(frm, text="Model:").grid(row=row, column=0, sticky="w")
        ttk.Entry(frm, textvariable=self.model_var, width=12).grid(row=row, column=1, sticky="w")
        ttk.Label(frm, text="Compute:").grid(row=row, column=2, sticky="w")
        ttk.Entry(frm, textvariable=self.compute_var, width=12).grid(row=row, column=3, sticky="w")
        ttk.Label(frm, text="Device:").grid(row=row, column=4, sticky="w")
        ttk.Entry(frm, textvariable=self.device_var, width=12).grid(row=row, column=5, sticky="w")

        row += 1
        self.btn_start_stop = ttk.Button(frm, text="Start", command=self.on_start_stop)
        self.btn_play_pause = ttk.Button(frm, text="Play", command=self.on_play_pause)
        self.btn_start_stop.grid(row=row, column=0, pady=(8, 8), sticky="w")
        self.btn_play_pause.grid(row=row, column=1, pady=(8, 8), sticky="w")
        self.btn_play_pause.state(["disabled"])  # disabled until a session starts
        frm.columnconfigure(5, weight=1)

    def on_start(self):
        try:
            cfg = TranscriberConfig(
                model_size=self.model_var.get().strip() or "medium",
                compute_type=self.compute_var.get().strip() or "float16",
                device=self.device_var.get().strip() or "cuda",
            )
            self._transcriber = RealtimeTranscriber(
                config=cfg,
                on_error=lambda e: self.after(0, self._fatal_error, e),
            )
            self._transcriber.start()
            self._session_active = True
            self._capturing = True
            self.btn_start_stop.config(text="Stop")
            self.btn_play_pause.state(["!disabled"])  # enable
            self.btn_play_pause.config(text="Pause")
        except Exception as e:
            messagebox.showerror("Error", str(e))
            self.destroy()

    def on_stop(self):
        if not self._session_active:
            return
        try:
            if self._transcriber:
                self._transcriber.stop()
        finally:
            self._session_active = False
            self._capturing = False
            self.btn_start_stop.config(text="Start")
            self.btn_play_pause.config(text="Play")
            self.btn_play_pause.state(["disabled"])  # disable until next start

    def _schedule_ui_updates(self):
        # No-op; retained for compatibility with previous wiring
        pass

    def on_start_stop(self):
        if not self._session_active:
            self.on_start()
        else:
            self.on_stop()

    def on_play_pause(self):
        if not self._session_active:
            return
        try:
            if self._capturing:
                self._transcriber.pause()
                self._capturing = False
                self.btn_play_pause.config(text="Play")
            else:
                self._transcriber.resume()
                self._capturing = True
                self.btn_play_pause.config(text="Pause")
        except Exception as e:
            self._fatal_error(e)

    def _fatal_error(self, e: Exception):
        try:
            messagebox.showerror("Fatal Error", str(e))
        finally:
            try:
                if self._transcriber:
                    self._transcriber.stop()
            except Exception:
                pass
            self.destroy()


if __name__ == "__main__":
    app = App()
    app.mainloop()
