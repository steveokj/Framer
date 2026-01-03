from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional, Tuple

import wave
import numpy as np
import logging
import time
try:
    import webrtcvad  # type: ignore
except Exception:
    webrtcvad = None  # optional dependency


@dataclass
class Params:
    frame_ms: int = 20  # 10|20|30 for WebRTC VAD
    min_speech_ms: int = 150
    min_silence_ms: int = 220
    pad_ms: int = 60
    use_webrtc: bool = True
    aggr: int = 3  # 0-3 (3 = most conservative speech)
    energy_threshold: float = 0.0020  # RMS threshold for fallback VAD (float32 in [-1,1])
    zcr_low: float = 0.02  # zero-crossing rate lower bound
    zcr_high: float = 0.25  # zero-crossing rate upper bound
    flatness_max: float = 0.6  # spectral flatness upper bound
    band_low_hz: int = 200
    band_high_hz: int = 3800
    band_energy_ratio_min: float = 0.65
    centroid_low_hz: int = 200
    centroid_high_hz: int = 4500
    require_consecutive_on: int = 3
    hangover_off: int = 2


@dataclass
class Result:
    input_path: str
    output_audio_path: str
    silence_map_path: str
    sample_rate: int
    channels_in: int
    duration_ms: int
    speech_ms: int
    removed_ms: int
    segment_count: int


def _read_wav_mono(path: Path) -> Tuple[np.ndarray, int, int]:
    with wave.open(str(path), "rb") as wf:
        n_channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        framerate = wf.getframerate()
        n_frames = wf.getnframes()
        frames = wf.readframes(n_frames)

    if sampwidth != 2:
        raise ValueError(f"Only 16-bit PCM WAV supported (got sampwidth={sampwidth} bytes)")

    data = np.frombuffer(frames, dtype=np.int16)
    if n_channels > 1:
        data = data.reshape(-1, n_channels).astype(np.int32)
        mono = np.mean(data, axis=1)
        data = np.clip(mono, -32768, 32767).astype(np.int16)
    data_f32 = (data.astype(np.float32)) / 32768.0
    return data_f32, framerate, n_channels


def _dc_block(x: np.ndarray, r: float = 0.995) -> np.ndarray:
    # Simple DC blocker / high-pass filter
    if x.size == 0:
        return x
    y = np.empty_like(x)
    prev_x = 0.0
    prev_y = 0.0
    for i in range(x.size):
        cur = x[i]
        yi = cur - prev_x + r * prev_y
        y[i] = yi
        prev_y = yi
        prev_x = cur
    return y


def _frame_signal(x: np.ndarray, sr: int, frame_ms: int) -> Tuple[np.ndarray, int]:
    frame_len = int(sr * frame_ms / 1000)
    if frame_len <= 0:
        raise ValueError("frame_ms too small for given sample rate")
    n_frames = len(x) // frame_len
    if n_frames == 0:
        return np.empty((0, frame_len), dtype=np.float32), frame_len
    y = x[: n_frames * frame_len].reshape(n_frames, frame_len)
    return y, frame_len


def _vad_webrtc_mask(frames: np.ndarray, sr: int, frame_ms: int, aggr: int) -> np.ndarray:
    if webrtcvad is None:
        raise RuntimeError("webrtcvad not available")
    if sr not in (8000, 16000, 32000, 48000):
        raise RuntimeError("webrtcvad requires 8k/16k/32k/48k sample rate")
    if frame_ms not in (10, 20, 30):
        raise RuntimeError("webrtcvad requires frame_ms in {10,20,30}")

    vad = webrtcvad.Vad(int(aggr))
    mask = np.zeros(frames.shape[0], dtype=bool)
    for i, fr in enumerate(frames):
        pcm16 = np.clip(fr, -1.0, 1.0)
        pcm16 = (pcm16 * 32767.0).astype(np.int16)
        try:
            mask[i] = bool(vad.is_speech(pcm16.tobytes(), sr))
        except Exception:
            mask[i] = False
    return mask


def _vad_energy_mask(frames: np.ndarray, energy_threshold: float) -> np.ndarray:
    # RMS per frame
    rms = np.sqrt(np.mean(frames.astype(np.float32) ** 2, axis=1) + 1e-12)
    # Robust baseline using median and MAD
    med = float(np.median(rms))
    mad = float(np.median(np.abs(rms - med)))
    robust = med + 1.5 * mad
    thr = max(energy_threshold, robust)
    return rms > thr


def _rms(frames: np.ndarray) -> np.ndarray:
    return np.sqrt(np.mean(frames.astype(np.float32) ** 2, axis=1) + 1e-12)


def _zcr(frames: np.ndarray) -> np.ndarray:
    if frames.size == 0:
        return np.zeros(0, dtype=np.float32)
    signs = np.sign(frames)
    # treat zeros as previous sign to avoid artificial crossings
    signs[signs == 0] = 1
    changes = (signs[:, 1:] * signs[:, :-1]) < 0
    return changes.mean(axis=1).astype(np.float32)


def _spectral_flatness(frames: np.ndarray) -> np.ndarray:
    # Compute spectral flatness on magnitude spectrum
    if frames.size == 0:
        return np.zeros(0, dtype=np.float32)
    # Apply small Hann window to reduce spectral leakage
    N = frames.shape[1]
    window = np.hanning(N).astype(np.float32)
    X = np.abs(np.fft.rfft(frames * window, axis=1)) + 1e-12
    geo = np.exp(np.mean(np.log(X), axis=1))
    arith = np.mean(X, axis=1)
    flatness = (geo / arith).astype(np.float32)
    return flatness


def _band_energy_ratio(frames: np.ndarray, sr: int, low_hz: int, high_hz: int) -> np.ndarray:
    if frames.size == 0:
        return np.zeros(0, dtype=np.float32)
    N = frames.shape[1]
    window = np.hanning(N).astype(np.float32)
    X = np.abs(np.fft.rfft(frames * window, axis=1))
    freqs = np.fft.rfftfreq(N, d=1.0 / sr)
    lo = max(0, int(np.searchsorted(freqs, low_hz)))
    hi = int(np.searchsorted(freqs, high_hz))
    total = (X ** 2).sum(axis=1) + 1e-12
    band = (X[:, lo:hi] ** 2).sum(axis=1)
    return (band / total).astype(np.float32)


def _spectral_centroid(frames: np.ndarray, sr: int) -> np.ndarray:
    if frames.size == 0:
        return np.zeros(0, dtype=np.float32)
    N = frames.shape[1]
    window = np.hanning(N).astype(np.float32)
    X = np.abs(np.fft.rfft(frames * window, axis=1)) + 1e-12
    freqs = np.fft.rfftfreq(N, d=1.0 / sr).astype(np.float32)
    num = (X * freqs).sum(axis=1)
    den = X.sum(axis=1)
    return (num / den).astype(np.float32)


def _segments_from_mask(mask: np.ndarray, frame_ms: int) -> List[Tuple[int, int]]:
    segs: List[Tuple[int, int]] = []
    if mask.size == 0:
        return segs
    n = mask.size
    i = 0
    while i < n:
        if not mask[i]:
            i += 1
            continue
        start = i
        while i < n and mask[i]:
            i += 1
        end = i  # exclusive
        segs.append((start * frame_ms, end * frame_ms))
    return segs


def _merge_close(segs: List[Tuple[int, int]], min_silence_ms: int) -> List[Tuple[int, int]]:
    if not segs:
        return []
    out: List[Tuple[int, int]] = []
    cur_s, cur_e = segs[0]
    for s, e in segs[1:]:
        gap = s - cur_e
        if gap <= min_silence_ms:
            cur_e = max(cur_e, e)
        else:
            out.append((cur_s, cur_e))
            cur_s, cur_e = s, e
    out.append((cur_s, cur_e))
    return out


def _drop_short(segs: List[Tuple[int, int]], min_speech_ms: int) -> List[Tuple[int, int]]:
    return [(s, e) for s, e in segs if (e - s) >= min_speech_ms]


def _pad_and_clip(
    segs: List[Tuple[int, int]], pad_ms: int, total_ms: int
) -> List[Tuple[int, int]]:
    if not segs:
        return []
    padded: List[Tuple[int, int]] = []
    for s, e in segs:
        s2 = max(0, s - pad_ms)
        e2 = min(total_ms, e + pad_ms)
        padded.append((s2, e2))
    # merge overlaps after padding
    padded.sort()
    out: List[Tuple[int, int]] = []
    cs, ce = padded[0]
    for s, e in padded[1:]:
        if s <= ce:
            ce = max(ce, e)
        else:
            out.append((cs, ce))
            cs, ce = s, e
    out.append((cs, ce))
    return out


def _complement_silence(segs: List[Tuple[int, int]], total_ms: int) -> List[Tuple[int, int]]:
    out: List[Tuple[int, int]] = []
    cur = 0
    for s, e in segs:
        if s > cur:
            out.append((cur, s))
        cur = e
    if cur < total_ms:
        out.append((cur, total_ms))
    return out


def _write_wav_mono_int16(path: Path, sr: int, chunks: Iterable[np.ndarray]) -> int:
    total_samples = 0
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        for arr in chunks:
            if arr.size == 0:
                continue
            pcm = np.clip(arr, -1.0, 1.0)
            pcm16 = (pcm * 32767.0).astype(np.int16)
            wf.writeframes(pcm16.tobytes())
            total_samples += pcm16.size
    return total_samples


def derive_outputs(input_wav: str) -> Tuple[str, str]:
    p = Path(input_wav)
    base = p.with_suffix("")
    # Convention: input.wav -> input-silenced.wav and input-silence_map.tsv
    out_audio = str(base.with_name(base.name + "-silenced").with_suffix(".wav"))
    out_map = str(base.with_name(base.name + "-silence_map").with_suffix(".tsv"))
    return out_audio, out_map


def build_speech_only_with_silence_map(
    input_wav: str,
    output_wav: Optional[str] = None,
    map_tsv: Optional[str] = None,
    params: Optional[Params] = None,
) -> Result:
    if params is None:
        params = Params()

    in_path = Path(input_wav)
    if output_wav is None or map_tsv is None:
        auto_audio, auto_map = derive_outputs(str(in_path))
        output_wav = output_wav or auto_audio
        map_tsv = map_tsv or auto_map

    logger = logging.getLogger("speech_silence")
    if not logger.handlers:
        # Basic console logger if not configured by host
        h = logging.StreamHandler()
        h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s: %(message)s", datefmt="%H:%M:%S"))
        logger.addHandler(h)
        logger.setLevel(logging.INFO)

    x, sr, ch_in = _read_wav_mono(in_path)
    # DC blocking / light high-pass to reduce low-frequency rumble
    x = _dc_block(x)
    total_ms = int(round(len(x) * 1000.0 / sr))

    frames, frame_len = _frame_signal(x, sr, params.frame_ms)

    use_webrtc = (
        params.use_webrtc
        and webrtcvad is not None
        and sr in (8000, 16000, 32000, 48000)
        and params.frame_ms in (10, 20, 30)
    )

    n_frames = frames.shape[0]
    # Frame-wise features for gating
    rms = _rms(frames) if n_frames > 0 else np.zeros(0, dtype=np.float32)
    zcr = _zcr(frames) if n_frames > 0 else np.zeros(0, dtype=np.float32)
    flat = _spectral_flatness(frames) if n_frames > 0 else np.zeros(0, dtype=np.float32)
    # Robust energy threshold
    med = float(np.median(rms)) if rms.size else 0.0
    mad = float(np.median(np.abs(rms - med))) if rms.size else 0.0
    robust_thr = max(params.energy_threshold, med + 1.5 * mad)

    if use_webrtc and n_frames > 0:
        vad_mask = _vad_webrtc_mask(frames, sr, params.frame_ms, params.aggr)
    else:
        vad_mask = np.zeros(n_frames, dtype=bool)

    energy_mask = rms > (robust_thr * 1.2)
    zcr_mask = (zcr >= params.zcr_low) & (zcr <= params.zcr_high)
    flat_mask = flat < params.flatness_max
    ber = _band_energy_ratio(frames, sr, params.band_low_hz, params.band_high_hz)
    ber_mask = ber >= params.band_energy_ratio_min
    centroid = _spectral_centroid(frames, sr)
    centroid_mask = (centroid >= params.centroid_low_hz) & (centroid <= params.centroid_high_hz)

    if use_webrtc:
        base = vad_mask
    else:
        base = energy_mask & zcr_mask & flat_mask & ber_mask & centroid_mask

    pre_mask = base & energy_mask & zcr_mask & flat_mask & ber_mask & centroid_mask

    # Apply hysteresis: require N consecutive ON to start, H hangover OFF to end
    mask = np.zeros_like(pre_mask)
    on_count = 0
    off_count = 0
    in_speech = False
    for i, val in enumerate(pre_mask):
        if val:
            on_count += 1
            off_count = 0
        else:
            off_count += 1
            on_count = 0
        if not in_speech and on_count >= params.require_consecutive_on:
            in_speech = True
        if in_speech:
            mask[i] = True
            if off_count > params.hangover_off:
                in_speech = False
                on_count = 0
                off_count = 0

    # Diagnostics
    if n_frames > 0:
        logger.info(
            "Frames=%d webrtc=%s keep_webrtc=%d keep_energy=%d keep_zcr=%d keep_flat=%d keep_ber=%d keep_centroid=%d keep_all=%d",
            n_frames,
            use_webrtc,
            int(vad_mask.sum()) if use_webrtc else 0,
            int(energy_mask.sum()),
            int(zcr_mask.sum()),
            int(flat_mask.sum()),
            int(ber_mask.sum()),
            int(centroid_mask.sum()),
            int(mask.sum()),
        )

    segs = _segments_from_mask(mask, params.frame_ms)
    segs = _merge_close(segs, params.min_silence_ms)
    segs = _drop_short(segs, params.min_speech_ms)
    segs = _pad_and_clip(segs, params.pad_ms, total_ms)

    silences = _complement_silence(segs, total_ms)

    chunks: List[np.ndarray] = []
    for s_ms, e_ms in segs:
        s = int(s_ms * sr / 1000)
        e = int(e_ms * sr / 1000)
        chunks.append(x[s:e])

    out_audio_path = Path(output_wav)
    out_map_path = Path(map_tsv)
    out_audio_path.parent.mkdir(parents=True, exist_ok=True)
    out_map_path.parent.mkdir(parents=True, exist_ok=True)

    logger.info(
        "Converting to speech-only: frames=%d sr=%dHz frame_ms=%d webrtc=%s aggr=%d",
        frames.shape[0], sr, params.frame_ms, use_webrtc, params.aggr,
    )
    _write_wav_mono_int16(out_audio_path, sr, chunks)

    with open(out_map_path, "w", encoding="utf-8") as f:
        f.write("start_ms\tend_ms\tdur_ms\n")
        for s, e in silences:
            f.write(f"{int(s)}\t{int(e)}\t{int(e - s)}\n")

    speech_ms = sum(max(0, e - s) for s, e in segs)
    removed_ms = sum(max(0, e - s) for s, e in silences)

    res = Result(
        input_path=str(in_path),
        output_audio_path=str(out_audio_path),
        silence_map_path=str(out_map_path),
        sample_rate=sr,
        channels_in=ch_in,
        duration_ms=total_ms,
        speech_ms=int(speech_ms),
        removed_ms=int(removed_ms),
        segment_count=len(segs),
    )
    logger.info(
        "Speech-only created: %s | Map: %s | total=%.2fs speech=%.2fs removed=%.2fs segments=%d",
        res.output_audio_path,
        res.silence_map_path,
        res.duration_ms / 1000.0,
        res.speech_ms / 1000.0,
        res.removed_ms / 1000.0,
        res.segment_count,
    )
    return res


"""
Usage (programmatic only; no CLI):

from speech_silence import build_speech_only_with_silence_map, Params

res = build_speech_only_with_silence_map("input.wav")
print(res)

Outputs:
- <input>.speech.wav  (mono, 16-bit PCM, original sample rate)
- <input>.silence_map.tsv (start_ms, end_ms, dur_ms)

The map is computed after smoothing and padding, enabling lossless re-expansion.
"""
