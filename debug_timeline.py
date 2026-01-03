# Debug script to test speech timeline loading from silence map files
# Used for testing the timeline generation functionality
from pathlib import Path
from server import _load_speech_timeline

# Path to a test silence map file generated from a recorded session
sm = Path('sessions/session-20250909-171330-silence_map.tsv')

# Check if the silence map file exists
print(sm.exists())

# Load and parse the speech timeline from the silence map
# Returns segments mapping original time to speech-only time
res = _load_speech_timeline(sm, total_ms=None)
print(res)
