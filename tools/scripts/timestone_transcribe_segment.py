import argparse
import json
import os
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model", default="medium")
    parser.add_argument("--language", default="en")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--compute-type", default="float16")
    args = parser.parse_args()

    audio_path = args.audio
    if not os.path.exists(audio_path):
        print(json.dumps({"engine": "whisper", "segments": []}))
        return 0

    try:
        from faster_whisper import WhisperModel
    except Exception:
        print(json.dumps({"engine": "whisper", "segments": []}))
        return 0

    device = args.device
    compute_type = args.compute_type
    try:
        model = WhisperModel(args.model, device=device, compute_type=compute_type)
    except Exception:
        model = WhisperModel(args.model, device="cpu", compute_type="int8")
        device = "cpu"
        compute_type = "int8"

    segments, _ = model.transcribe(audio_path, language=args.language, beam_size=5, word_timestamps=False)
    rows = []
    for seg in segments:
        text = (seg.text or "").strip()
        if not text:
            continue
        start_ms = int(seg.start * 1000)
        end_ms = int(seg.end * 1000)
        rows.append({"start_ms": start_ms, "end_ms": end_ms, "text": text})

    engine = f"faster-whisper:{args.model}/{compute_type}"
    print(json.dumps({"engine": engine, "segments": rows}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
