import sys
from pathlib import Path
import glob
import time

from speech_silence import build_speech_only_with_silence_map


def find_latest_session_wav() -> Path | None:
    candidates = []
    # Prefer sessions/ prefixed files
    for pattern in ("sessions/session-*.wav", "*.wav"):
        for p in glob.glob(pattern):
            try:
                mtime = Path(p).stat().st_mtime
            except Exception:
                continue
            candidates.append((mtime, Path(p)))
    if not candidates:
        return None
    candidates.sort(reverse=True)
    return candidates[0][1]


def main() -> int:
    if len(sys.argv) > 1:
        wav = Path(sys.argv[1])
        if not wav.exists():
            print(f"File not found: {wav}")
            return 2
    else:
        wav = find_latest_session_wav()
        if wav is None:
            print("No WAV found. Pass a path or record a session in ./sessions.")
            return 2

    print(f"Testing conversion for: {wav}")
    t0 = time.time()
    res = build_speech_only_with_silence_map(str(wav))
    dt = time.time() - t0
    pct_removed = (res.removed_ms / max(1, res.duration_ms)) * 100.0
    pct_speech = (res.speech_ms / max(1, res.duration_ms)) * 100.0

    print("-- Result --")
    print(f"Input:     {res.input_path}")
    print(f"Output:    {res.output_audio_path}")
    print(f"Map:       {res.silence_map_path}")
    print(f"SR/Ch:     {res.sample_rate} / {res.channels_in}")
    print(f"Dur total: {res.duration_ms/1000:.2f}s")
    print(f"Dur speech:{res.speech_ms/1000:.2f}s ({pct_speech:.1f}%)")
    print(f"Dur removed:{res.removed_ms/1000:.2f}s ({pct_removed:.1f}%)")
    print(f"Segments:  {res.segment_count}")
    print(f"Time:      {dt:.2f}s")

    # Quick sanity warnings
    if res.segment_count == 0 or res.speech_ms < 500:
        print("WARNING: Very little speech detected. Adjust thresholds or ensure mic input.")
    if pct_removed < 5.0:
        print("WARNING: Removal < 5%. This might indicate poor VAD; consider raising aggressiveness or thresholds.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

