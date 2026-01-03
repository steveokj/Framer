# Simple script to test faster-whisper transcription on recorded audio files
# Used for offline batch transcription of session recordings
from faster_whisper import WhisperModel

# Model size selection - medium offers good balance of speed and accuracy
# model_size = "medium"
# Alternative: large-v2 for higher accuracy at the cost of speed
model_size = "large-v2"

# Initialize Whisper model on GPU with float32 precision
# This provides better accuracy than int8 but uses more VRAM
# Run on GPU with FP16
# model = WhisperModel(model_size, device="cuda", compute_type="float32")
model = WhisperModel(model_size, device="cuda", compute_type="float32")

# Alternative configurations for different hardware setups:
# or run on GPU with INT8
# model = WhisperModel(model_size, device="cuda", compute_type="int8_float16")
# or run on CPU with INT8
# model = WhisperModel(model_size, device="cpu", compute_type="int8")

# Transcribe a specific session recording
# beam_size=5 balances accuracy and speed in beam search decoding
segments, info = model.transcribe("sessions\session-20251107-173902.wav", beam_size=5)

# Display detected language and confidence level
print("Detected language '%s' with probability %f" % (info.language, info.language_probability))

# Print each transcribed segment with timestamps
# Format: [start_time -> end_time] transcribed text
for segment in segments:
    print("[%.2fs -> %.2fs] %s" % (segment.start, segment.end, segment.text))