import tkinter as tk
from tkinter import ttk, messagebox, scrolledtext

from transcriber import SimpleTranscriber, TranscriberConfig


class TranscriberApp(tk.Tk):
    """
    GUI application for the simple transcriber.
    
    Provides controls to:
    - Configure model, compute type, and device
    - Start/Stop recording
    - Pause/Resume recording
    - Display transcription results after recording completes
    """
    
    def __init__(self):
        super().__init__()
        self.title("Simple Transcriber")
        self.geometry("400x300")

        # Configuration variables
        self.model_var = tk.StringVar(value="large-v2")
        self.compute_var = tk.StringVar(value="float32")
        self.device_var = tk.StringVar(value="cuda")

        # Transcriber instance and state
        self._transcriber = None
        self._session_active = False  # started but not yet stopped
        self._capturing = False       # play/pause state

        # Handle unhandled exceptions in Tk callbacks by showing error and exiting
        def report_callback_exception(exc, val, tb):
            try:
                messagebox.showerror("Fatal Error", f"{val}")
            finally:
                self.destroy()
        self.report_callback_exception = report_callback_exception  # type: ignore[attr-defined]

        self._build_ui()

    def _build_ui(self):
        """Build the user interface with controls and transcript display."""
        frm = ttk.Frame(self, padding=10)
        frm.pack(fill=tk.BOTH, expand=True)

        # Configuration row - Model, Compute Type, Device
        row = 0
        ttk.Label(frm, text="Model:").grid(row=row, column=0, sticky="w")
        ttk.Entry(frm, textvariable=self.model_var, width=12).grid(row=row, column=1, sticky="w")
        ttk.Label(frm, text="Compute:").grid(row=row, column=2, sticky="w")
        ttk.Entry(frm, textvariable=self.compute_var, width=12).grid(row=row, column=3, sticky="w")
        ttk.Label(frm, text="Device:").grid(row=row, column=4, sticky="w")
        ttk.Entry(frm, textvariable=self.device_var, width=12).grid(row=row, column=5, sticky="w")

        # Control buttons row - Start/Stop and Play/Pause
        row += 1
        self.btn_start_stop = ttk.Button(frm, text="Start", command=self.on_start_stop)
        self.btn_play_pause = ttk.Button(frm, text="Play", command=self.on_play_pause)
        self.btn_start_stop.grid(row=row, column=0, pady=(8, 8), sticky="w")
        self.btn_play_pause.grid(row=row, column=1, pady=(8, 8), sticky="w")
        self.btn_play_pause.state(["disabled"])  # disabled until a session starts
        
        # Status label
        row += 1
        self.status_label = ttk.Label(frm, text="Ready to record", foreground="blue")
        self.status_label.grid(row=row, column=0, columnspan=6, sticky="w", pady=(0, 8))

        # Transcript display area
        row += 1
        ttk.Label(frm, text="Transcription:").grid(row=row, column=0, columnspan=6, sticky="w")
        row += 1
        self.transcript_text = scrolledtext.ScrolledText(
            frm,
            wrap=tk.WORD,
            width=80,
            height=25,
            font=("Consolas", 10),
        )
        self.transcript_text.grid(row=row, column=0, columnspan=6, sticky="nsew", pady=(4, 0))
        
        # Configure grid weights for proper resizing
        frm.columnconfigure(5, weight=1)
        frm.rowconfigure(row, weight=1)

    def on_start(self):
        """Start a new recording session."""
        try:
            # Create configuration from UI values
            cfg = TranscriberConfig(
                model_size=self.model_var.get().strip() or "medium",
                compute_type=self.compute_var.get().strip() or "float16",
                device=self.device_var.get().strip() or "cuda",
            )
            
            # Create transcriber with callbacks
            self._transcriber = SimpleTranscriber(
                config=cfg,
                on_error=lambda e: self.after(0, self._fatal_error, e),
                on_complete=lambda text, path: self.after(0, self._on_transcription_complete, text, path),
            )
            
            # Clear previous transcript
            self.transcript_text.delete(1.0, tk.END)
            
            # Start recording
            self._transcriber.start()
            self._session_active = True
            self._capturing = True
            
            # Update UI
            self.btn_start_stop.config(text="Stop")
            self.btn_play_pause.state(["!disabled"])  # enable
            self.btn_play_pause.config(text="Pause")
            self.status_label.config(text="Recording...", foreground="red")
            
        except Exception as e:
            messagebox.showerror("Error", str(e))
            self.destroy()

    def on_stop(self):
        """Stop recording and trigger transcription."""
        if not self._session_active:
            return
        try:
            self.status_label.config(text="Stopping and transcribing...", foreground="orange")
            self.update()  # Force UI update
            
            if self._transcriber:
                # This will transcribe and call our on_complete callback
                self._transcriber.stop()
        finally:
            self._session_active = False
            self._capturing = False
            self.btn_start_stop.config(text="Start")
            self.btn_play_pause.config(text="Play")
            self.btn_play_pause.state(["disabled"])  # disable until next start
            self.status_label.config(text="Transcription complete", foreground="green")

    def on_start_stop(self):
        """Toggle between start and stop."""
        if not self._session_active:
            self.on_start()
        else:
            self.on_stop()

    def on_play_pause(self):
        """Toggle between pause and resume during recording."""
        if not self._session_active:
            return
        try:
            if self._capturing:
                self._transcriber.pause()
                self._capturing = False
                self.btn_play_pause.config(text="Play")
                self.status_label.config(text="Paused", foreground="orange")
            else:
                self._transcriber.resume()
                self._capturing = True
                self.btn_play_pause.config(text="Pause")
                self.status_label.config(text="Recording...", foreground="red")
        except Exception as e:
            self._fatal_error(e)

    def _on_transcription_complete(self, transcription: str, wav_path: str):
        """
        Callback invoked when transcription completes.
        
        Displays the transcription result in the text area.
        """
        self.transcript_text.delete(1.0, tk.END)
        self.transcript_text.insert(1.0, f"Audio file: {wav_path}\n\n")
        # self.transcript_text.insert(tk.END, transcription)
        self.status_label.config(text="Transcription complete - Ready for next recording", foreground="green")

    def _fatal_error(self, e: Exception):
        """Handle fatal errors by showing message and closing application."""
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
    app = TranscriberApp()
    app.mainloop()