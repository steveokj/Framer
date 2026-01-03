"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

type Clip = {
  id: number;
  window_name: string;
  start_seconds: number;
  end_seconds: number;
  start_timestamp: string;
  end_timestamp: string;
  start_offset_index: number;
  end_offset_index: number;
  frame_count: number;
};

type FrameEntry = {
  offset_index: number;
  timestamp: string;
  seconds_from_video_start: number;
};

type FrameRequest = {
  id: number;
  seconds: number;
  resolve: (dataUrl: string) => void;
  reject: (err: unknown) => void;
};

type Metadata = {
  video: {
    path: string;
    frame_count: number;
    first_timestamp: string;
    last_timestamp: string;
  };
  audio: {
    path: string;
    session_id: number | null;
    start_timestamp: string;
    end_timestamp: string;
    duration_seconds: number;
  };
  alignment: {
    origin_timestamp: string;
    timeline_end_timestamp: string;
    audio_offset_seconds: number;
    audio_lead_seconds: number;
    audio_delay_seconds: number;
  };
  frames: FrameEntry[];
};

type WindowClipsResponse = {
  first_timestamp: string | null;
  last_timestamp: string | null;
  clips: Array<{
    window_name: string;
    start_seconds: number;
    end_seconds: number;
    start_timestamp: string;
    end_timestamp: string;
    start_offset_index: number;
    end_offset_index: number;
    frame_count: number;
  }>;
};

const DEFAULT_VIDEO = "C:\\Users\\steve\\.screenpipe\\data\\monitor_52305895_2025-10-12_02-13-01.mp4";
const DEFAULT_AUDIO = "C:\\Users\\steve\\Desktop\\Whisper\\sessions\\session-20251011-221322.wav";
const API_BASE = (process.env.NEXT_PUBLIC_API_BASE || "").replace(/\/$/, "");

const ABSOLUTE_PATH_REGEX = /^[a-zA-Z]:[\\/]|^\//;

function normalisePath(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.?\//, "");
}

function buildFileUrl(pathInput: string): { url: string | null; warning: string | null } {
  const trimmed = pathInput.trim();
  if (!trimmed) {
    return { url: null, warning: null };
  }
  if (ABSOLUTE_PATH_REGEX.test(trimmed)) {
    const normalised = normalisePath(trimmed);
    const absoluteUrl = `${API_BASE}/files_abs?path=${encodeURIComponent(normalised)}`;
    return { url: absoluteUrl, warning: null };
  }
  const normalised = normalisePath(trimmed);
  const url = `${API_BASE}/files/${encodeURI(normalised)}`;
  return { url, warning: null };
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

function formatOffset(offset: number): string {
  const abs = Math.abs(offset).toFixed(2);
  if (offset > 0) {
    return `+${abs}s`;
  }
  if (offset < 0) {
    return `-${abs}s`;
  }
  return "0.00s";
}

function mapVideoTimeToTimeline(videoTime: number, videoDuration: number | null | undefined, meta: Metadata | null): number {
  if (!meta || !meta.frames.length) {
    return videoTime;
  }
  const frames = meta.frames;
  const lastIndex = frames.length - 1;
  if (lastIndex === 0) {
    return frames[0].seconds_from_video_start;
  }
  const duration = Number.isFinite(videoDuration || 0) && (videoDuration || 0) > 0 ? (videoDuration as number) : frames[lastIndex].seconds_from_video_start;
  if (!(duration > 0)) {
    return videoTime;
  }
  const fraction = Math.min(Math.max(videoTime / duration, 0), 1);
  const position = fraction * lastIndex;
  const lowerIdx = Math.floor(position);
  const upperIdx = Math.min(lastIndex, lowerIdx + 1);
  if (upperIdx === lowerIdx) {
    return frames[lowerIdx].seconds_from_video_start;
  }
  const frameFraction = position - lowerIdx;
  const lowerSeconds = frames[lowerIdx].seconds_from_video_start;
  const upperSeconds = frames[upperIdx].seconds_from_video_start;
  return lowerSeconds + (upperSeconds - lowerSeconds) * frameFraction;
}

function mapTimelineToVideo(
  timelineSeconds: number,
  videoDuration: number | null | undefined,
  meta: Metadata | null,
): number {
  if (!meta || !meta.frames.length) {
    return Math.max(0, timelineSeconds);
  }
  const frames = meta.frames;
  const lastIndex = frames.length - 1;
  if (lastIndex === 0) {
    if (videoDuration && videoDuration > 0) {
      return Math.min(Math.max(timelineSeconds, 0), videoDuration);
    }
    return Math.max(0, timelineSeconds);
  }
  if (!(videoDuration && videoDuration > 0)) {
    return Math.max(0, timelineSeconds);
  }
  const lastTimeline = frames[lastIndex].seconds_from_video_start;
  if (timelineSeconds <= frames[0].seconds_from_video_start) {
    return 0;
  }
  if (timelineSeconds >= lastTimeline) {
    return videoDuration;
  }
  let lo = 0;
  let hi = lastIndex;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const midVal = frames[mid].seconds_from_video_start;
    if (midVal < timelineSeconds) {
      lo = mid + 1;
    } else if (midVal > timelineSeconds) {
      hi = mid - 1;
    } else {
      const midFraction = mid / lastIndex;
      return midFraction * videoDuration;
    }
  }
  const upperIdx = Math.min(lastIndex, Math.max(1, lo));
  const lowerIdx = upperIdx - 1;
  const lowerSeconds = frames[lowerIdx].seconds_from_video_start;
  const upperSeconds = frames[upperIdx].seconds_from_video_start;
  const segmentSpan = upperSeconds - lowerSeconds || 1;
  const segmentFraction = (timelineSeconds - lowerSeconds) / segmentSpan;
  const lowerVideo = (lowerIdx / lastIndex) * videoDuration;
  const upperVideo = (upperIdx / lastIndex) * videoDuration;
  return lowerVideo + (upperVideo - lowerVideo) * segmentFraction;
}

type FrameThumbnailCardProps = {
  frame: FrameEntry;
  thumbnail?: string;
  videoSeconds: number;
  isActive: boolean;
  isSelected: boolean;
  requestThumbnail: (frameId: number, seconds: number) => Promise<string>;
  onSelect: (frame: FrameEntry) => void;
  layoutMode: "grid" | "list";
};

function FrameThumbnailCard({
  frame,
  thumbnail,
  videoSeconds,
  isActive,
  isSelected,
  requestThumbnail,
  onSelect,
  layoutMode,
}: FrameThumbnailCardProps) {
  const [loading, setLoading] = useState(!thumbnail);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (thumbnail) {
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    requestThumbnail(frame.offset_index, videoSeconds)
      .then(() => {
        if (!cancelled) {
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to decode frame");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [frame.offset_index, requestThumbnail, thumbnail, videoSeconds]);

  const handleSelect = useCallback(() => {
    onSelect(frame);
  }, [frame, onSelect]);

  return (
    <button
      type="button"
      onClick={handleSelect}
      data-frame-card={frame.offset_index}
      style={{
        display: layoutMode === "grid" ? "grid" : "flex",
        gap: layoutMode === "grid" ? 8 : 12,
        padding: layoutMode === "grid" ? 8 : 10,
        borderRadius: 10,
        border: `1px solid ${isSelected ? "#38bdf8" : isActive ? "rgba(56, 189, 248, 0.6)" : "#1e293b"}`,
        background: isSelected
          ? "rgba(56, 189, 248, 0.18)"
          : isActive
            ? "rgba(56, 189, 248, 0.1)"
            : "rgba(15, 23, 42, 0.65)",
        color: "#e2e8f0",
        textAlign: "left",
        cursor: "pointer",
        width: "100%",
        maxWidth: "100%",
        alignItems: layoutMode === "grid" ? undefined : "center",
      }}
    >
      <div
        style={{
          position: "relative",
          aspectRatio: "16 / 9",
          width: layoutMode === "grid" ? "100%" : 220,
          overflow: "hidden",
          borderRadius: 8,
          background: "#0f172a",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        {thumbnail ? (
          <img
            src={thumbnail}
            alt={`Frame ${frame.offset_index} at ${formatTime(frame.seconds_from_video_start)}`}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
            loading="lazy"
          />
        ) : loading ? (
          <span style={{ color: "#94a3b8" }}>Decoding...</span>
        ) : error ? (
          <span style={{ color: "#fca5a5" }}>{error}</span>
        ) : (
          <span style={{ color: "#94a3b8" }}>Queued...</span>
        )}
      </div>
      <div
        style={{
          display: "grid",
          gap: 4,
          fontSize: layoutMode === "grid" ? 12 : 13,
          color: "#cbd5f5",
          width: "100%",
        }}
      >
        <span style={{ fontWeight: isSelected ? 600 : 500 }}>#{frame.offset_index}</span>
        <span>{formatTime(frame.seconds_from_video_start)}</span>
        {layoutMode === "list" && <span style={{ color: "#94a3b8" }}>{frame.timestamp}</span>}
      </div>
    </button>
  );
}

type FramePreviewModalProps = {
  frame: FrameEntry | null;
  thumbnail?: string;
  videoSeconds?: number | null;
  onClose: () => void;
  onSeekAndPlay: () => void;
  onNavigatePrev: () => void;
  onNavigateNext: () => void;
  hasPrev: boolean;
  hasNext: boolean;
};

function FramePreviewModal({
  frame,
  thumbnail,
  videoSeconds,
  onClose,
  onSeekAndPlay,
  onNavigatePrev,
  onNavigateNext,
  hasPrev,
  hasNext,
}: FramePreviewModalProps) {
  const handleContainerClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      } else if (event.key === "ArrowLeft" && hasPrev) {
        onNavigatePrev();
      } else if (event.key === "ArrowRight" && hasNext) {
        onNavigateNext();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, onNavigatePrev, onNavigateNext, hasPrev, hasNext]);

  const metadataColour = frame ? "#cbd5f5" : "#64748b";

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 90,
        background: "rgba(8, 15, 35, 0.92)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
      onClick={onClose}
    >
      <div
        onClick={handleContainerClick}
        style={{
          width: "min(94vw, 1500px)",
          maxHeight: "90vh",
          background: "#0b1120",
          borderRadius: 18,
          boxShadow: "0 24px 60px rgba(15, 23, 42, 0.55)",
          padding: 24,
          display: "grid",
          gap: 16,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <strong style={{ fontSize: 18 }}>Frame preview</strong>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "6px 12px",
              borderRadius: 6,
              border: "1px solid #334155",
              background: "rgba(15, 23, 42, 0.65)",
              color: "#f8fafc",
              cursor: "pointer",
            }}
          >
            Close
          </button>
        </div>
        <div
          style={{
            position: "relative",
            width: "100%",
            aspectRatio: "16 / 9",
            borderRadius: 12,
            overflow: "hidden",
            background: "#111827",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            maxHeight: "65vh",
          }}
        >
          {frame ? (
            thumbnail ? (
              <img
                src={thumbnail}
                alt={`Frame ${frame.offset_index}`}
                style={{ width: "100%", height: "100%", objectFit: "contain" }}
              />
            ) : (
              <span style={{ color: "#94a3b8" }}>Decoding preview...</span>
            )
          ) : (
            <span style={{ color: "#94a3b8" }}>Select a frame to preview.</span>
          )}
          <button
            type="button"
            onClick={onNavigatePrev}
            disabled={!hasPrev}
            style={{
              position: "absolute",
              left: 16,
              top: "50%",
              transform: "translateY(-50%)",
              width: 48,
              height: 48,
              borderRadius: "50%",
              border: "1px solid #334155",
              background: hasPrev ? "rgba(15, 23, 42, 0.85)" : "rgba(15, 23, 42, 0.5)",
              color: hasPrev ? "#f8fafc" : "#64748b",
              cursor: hasPrev ? "pointer" : "not-allowed",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 20,
              fontWeight: 600,
            }}
          >
            {"<"}
          </button>
          <button
            type="button"
            onClick={onNavigateNext}
            disabled={!hasNext}
            style={{
              position: "absolute",
              right: 16,
              top: "50%",
              transform: "translateY(-50%)",
              width: 48,
              height: 48,
              borderRadius: "50%",
              border: "1px solid #334155",
              background: hasNext ? "rgba(15, 23, 42, 0.85)" : "rgba(15, 23, 42, 0.5)",
              color: hasNext ? "#f8fafc" : "#64748b",
              cursor: hasNext ? "pointer" : "not-allowed",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 20,
              fontWeight: 600,
            }}
          >
            {">"}
          </button>
        </div>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 12,
            alignItems: "center",
            justifyContent: "space-between",
            color: metadataColour,
          }}
        >
          <div style={{ display: "grid", gap: 4 }}>
            <span>
              Frame #: <strong>{frame ? frame.offset_index : "--"}</strong>
            </span>
            <span>
              Timeline: <strong>{frame ? formatTime(frame.seconds_from_video_start) : "--:--"}</strong>
            </span>
            <span>
              Video time: <strong>{videoSeconds != null ? formatTime(videoSeconds) : "--:--"}</strong>
            </span>
          </div>
          <button
            type="button"
            onClick={onSeekAndPlay}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: "none",
              background: "#2563eb",
              color: "#f8fafc",
              cursor: "pointer",
            }}
          >
            Seek &amp; play
          </button>
        </div>
      </div>
    </div>
  );
}

function FrameCarouselIcon({ size = 20, color = "#f8fafc" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" stroke={color} strokeWidth={1.8} />
      <line x1="9" y1="5.5" x2="9" y2="18.5" stroke={color} strokeWidth={1.4} />
      <line x1="15" y1="5.5" x2="15" y2="18.5" stroke={color} strokeWidth={1.4} />
      <circle cx="6.2" cy="8.5" r="0.7" fill={color} />
      <circle cx="6.2" cy="15.5" r="0.7" fill={color} />
      <circle cx="18.8" cy="8.5" r="0.7" fill={color} />
      <circle cx="18.8" cy="15.5" r="0.7" fill={color} />
    </svg>
  );
}

export default function WindowsNewPage() {
  const [videoInput, setVideoInput] = useState(DEFAULT_VIDEO);
  const [audioInput, setAudioInput] = useState(DEFAULT_AUDIO);
  const [videoPath, setVideoPath] = useState(DEFAULT_VIDEO);
  const [audioPath, setAudioPath] = useState(DEFAULT_AUDIO);
  const [clips, setClips] = useState<Clip[]>([]);
  const [loadingClips, setLoadingClips] = useState(false);
  const [clipError, setClipError] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [loadingMetadata, setLoadingMetadata] = useState(false);
  const [manualOffset, setManualOffset] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [activeClipId, setActiveClipId] = useState<number | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [videoLoadError, setVideoLoadError] = useState<string | null>(null);
  const [audioLoadError, setAudioLoadError] = useState<string | null>(null);
  const [frameOverlayClipId, setFrameOverlayClipId] = useState<number | null>(null);
  const [frameSamplingMode, setFrameSamplingMode] = useState<"sampled" | "all">("sampled");
  const [layoutMode, setLayoutMode] = useState<"grid" | "list">("grid");
  const [selectedFrameId, setSelectedFrameId] = useState<number | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [decoderError, setDecoderError] = useState<string | null>(null);
  const [, forceFrameUpdate] = useState(0);

  const audioRef = useRef<HTMLAudioElement>(null);
  const clipVideoRefs = useRef<Map<number, HTMLVideoElement>>(new Map());
  const decoderRef = useRef<HTMLVideoElement>(null);
  const decoderReadyRef = useRef(false);
  const decoderReadyResolversRef = useRef<Array<{ resolve: () => void; reject: (reason?: unknown) => void }>>([]);
  const queueRef = useRef<FrameRequest[]>([]);
  const queueProcessingRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const framePromisesRef = useRef<Map<number, Promise<string>>>(new Map());
  const frameThumbsRef = useRef<Record<number, string>>({});

  const { url: videoUrl, warning: videoWarning } = useMemo(() => buildFileUrl(videoPath), [videoPath]);
  const { url: audioUrl, warning: audioWarning } = useMemo(() => buildFileUrl(audioPath), [audioPath]);

  const audioOffset = metadata?.alignment.audio_offset_seconds ?? 0;
  const combinedOffset = audioOffset + manualOffset;
  const serverHint = API_BASE || "http://localhost:8000";
  const timelineDuration = useMemo(() => {
    if (!metadata || !metadata.frames.length) return null;
    return metadata.frames[metadata.frames.length - 1].seconds_from_video_start;
  }, [metadata]);
  const displayScale = useMemo(() => {
    if (!timelineDuration || videoDuration == null || !(videoDuration > 0)) {
      return 1;
    }
    return timelineDuration / videoDuration;
  }, [timelineDuration, videoDuration]);
  const frames = useMemo(() => {
    const all = metadata?.frames ?? [];
    if (all.length <= 1) {
      return all;
    }
    const deduped: FrameEntry[] = [];
    let lastTimestamp: string | null = null;
    for (const frame of all) {
      if (frame.timestamp === lastTimestamp) {
        continue;
      }
      deduped.push(frame);
      lastTimestamp = frame.timestamp;
    }
    return deduped;
  }, [metadata]);
  const framesByClip = useMemo(() => {
    if (!frames.length || !clips.length) {
      return new Map<number, FrameEntry[]>();
    }
    const map = new Map<number, FrameEntry[]>();
    for (const clip of clips) {
      const subset = frames.filter(
        (frame) =>
          frame.offset_index >= clip.start_offset_index &&
          frame.offset_index <= clip.end_offset_index &&
          frame.seconds_from_video_start >= clip.start_seconds - 0.001 &&
          frame.seconds_from_video_start <= clip.end_seconds + 0.001,
      );
      map.set(clip.id, subset);
    }
    return map;
  }, [clips, frames]);
  const SAMPLE_FRAME_GAP_SECONDS = 1.0;
  const SAMPLE_FRAME_GAP_LABEL =
    SAMPLE_FRAME_GAP_SECONDS >= 1
      ? `${
          Number.isInteger(SAMPLE_FRAME_GAP_SECONDS)
            ? SAMPLE_FRAME_GAP_SECONDS.toFixed(0)
            : SAMPLE_FRAME_GAP_SECONDS.toFixed(1)
        } second${SAMPLE_FRAME_GAP_SECONDS === 1 ? "" : "s"}`
      : `${Math.round(SAMPLE_FRAME_GAP_SECONDS * 1000)} ms`;
  const frameOverlayClip = useMemo(
    () => (frameOverlayClipId != null ? clips.find((clip) => clip.id === frameOverlayClipId) ?? null : null),
    [clips, frameOverlayClipId],
  );
  const frameOverlayFrames = useMemo(() => {
    if (!frameOverlayClip) {
      return [];
    }
    return framesByClip.get(frameOverlayClip.id) ?? [];
  }, [frameOverlayClip, framesByClip]);
  const computeVideoSecondsFromFrame = useCallback(
    (frame: FrameEntry) => {
      if (videoDuration && videoDuration > 0 && metadata?.video.frame_count && metadata.video.frame_count > 1) {
        const frameCount = metadata.video.frame_count;
        const denom = Math.max(frameCount - 1, 1);
        const ratio = frame.offset_index / denom;
        const clampedRatio = Math.min(Math.max(ratio, 0), 1);
        return clampedRatio * videoDuration;
      }
      const seconds = frame.seconds_from_video_start;
      return Number.isFinite(seconds) ? Math.max(seconds, 0) : 0;
    },
    [metadata, videoDuration],
  );
  const frameThumbnails = frameThumbsRef.current;
  const displayFrames = useMemo(() => {
    if (!frameOverlayFrames.length) {
      return [];
    }
    if (frameSamplingMode === "all") {
      return frameOverlayFrames;
    }
    const sampled: FrameEntry[] = [];
    let lastTime = -Infinity;
    for (const frame of frameOverlayFrames) {
      if (frame.seconds_from_video_start - lastTime >= SAMPLE_FRAME_GAP_SECONDS) {
        sampled.push(frame);
        lastTime = frame.seconds_from_video_start;
      }
    }
    return sampled;
  }, [frameOverlayFrames, frameSamplingMode]);
  const selectedFrame = useMemo(() => {
    if (selectedFrameId == null) {
      return null;
    }
    return frameOverlayFrames.find((frame) => frame.offset_index === selectedFrameId) ?? null;
  }, [frameOverlayFrames, selectedFrameId]);
  const selectedFrameIndex = useMemo(() => {
    if (!selectedFrame) {
      return -1;
    }
    return displayFrames.findIndex((frame) => frame.offset_index === selectedFrame.offset_index);
  }, [displayFrames, selectedFrame]);
  const hasPrevFrame = selectedFrameIndex > 0;
  const hasNextFrame = selectedFrameIndex >= 0 && selectedFrameIndex < displayFrames.length - 1;
  const storeFrameThumbnail = useCallback(
    (frameId: number, dataUrl: string) => {
      const existing = frameThumbsRef.current[frameId];
      if (existing === dataUrl) {
        return;
      }
      frameThumbsRef.current = { ...frameThumbsRef.current, [frameId]: dataUrl };
      forceFrameUpdate((value) => (value + 1) % 1000000);
    },
    [forceFrameUpdate],
  );
  const waitForDecoderReady = useCallback(() => {
    if (decoderReadyRef.current) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      decoderReadyResolversRef.current.push({ resolve, reject });
    });
  }, []);
  const getCanvas = useCallback(() => {
    if (!canvasRef.current) {
      canvasRef.current = document.createElement("canvas");
    }
    return canvasRef.current;
  }, []);
  const decodeFrameAtTime = useCallback(
    async (seconds: number) => {
      const decoder = decoderRef.current;
      if (!decoder) {
        throw new Error("Frame decoder not initialised");
      }
      await waitForDecoderReady();
      decoder.pause();
      decoder.currentTime = Math.max(0, seconds);
      await new Promise<void>((resolve, reject) => {
        const handleSeeked = () => {
          decoder.removeEventListener("seeked", handleSeeked);
          decoder.removeEventListener("error", handleError);
          resolve();
        };
        const handleError = () => {
          decoder.removeEventListener("seeked", handleSeeked);
          decoder.removeEventListener("error", handleError);
          reject(new Error("Frame decoder failed to seek"));
        };
        decoder.addEventListener("seeked", handleSeeked, { once: true });
        decoder.addEventListener("error", handleError, { once: true });
      });
      const canvas = getCanvas();
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error("Unable to get canvas context");
      }
      canvas.width = decoder.videoWidth || 1920;
      canvas.height = decoder.videoHeight || 1080;
      ctx.drawImage(decoder, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.7);
    },
    [getCanvas, waitForDecoderReady],
  );
  const processQueue = useCallback(() => {
    if (queueProcessingRef.current || !decoderReadyRef.current) {
      return;
    }
    const decoder = decoderRef.current;
    if (!decoder) {
      return;
    }
    queueProcessingRef.current = true;

    const runNext = () => {
      const next = queueRef.current.shift();
      if (!next) {
        queueProcessingRef.current = false;
        return;
      }
      decodeFrameAtTime(next.seconds)
        .then((dataUrl) => {
          next.resolve(dataUrl);
        })
        .catch((err) => {
          next.reject(err);
        })
        .finally(() => {
          if (!decoderReadyRef.current) {
            queueProcessingRef.current = false;
            return;
          }
          if (queueRef.current.length > 0) {
            requestAnimationFrame(runNext);
          } else {
            queueProcessingRef.current = false;
          }
        });
    };

    runNext();
  }, [decodeFrameAtTime]);
  const requestFrameThumbnail = useCallback(
    (frameId: number, seconds: number) => {
      const cached = frameThumbsRef.current[frameId];
      if (cached) {
        return Promise.resolve(cached);
      }
      const existing = framePromisesRef.current.get(frameId);
      if (existing) {
        return existing;
      }
      const promise = new Promise<string>((resolve, reject) => {
        queueRef.current.push({ id: frameId, seconds, resolve, reject });
        processQueue();
      })
        .then((dataUrl) => {
          storeFrameThumbnail(frameId, dataUrl);
          return dataUrl;
        })
        .finally(() => {
          framePromisesRef.current.delete(frameId);
        });
      framePromisesRef.current.set(frameId, promise);
      return promise;
    },
    [processQueue, storeFrameThumbnail],
  );

  useEffect(() => {
    const fetchMetadata = async () => {
      if (!videoPath.trim() || !audioPath.trim()) {
        setMetadata(null);
        setMetadataError(null);
        return;
      }
      setLoadingMetadata(true);
      setMetadataError(null);
      try {
        const res = await fetch("/api/video_web_playback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videoPath, audioPath }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(payload.error || `Metadata request failed (status ${res.status})`);
        }
        const data: Metadata = await res.json();
        setMetadata(data);
      } catch (err) {
        setMetadata(null);
        setMetadataError(err instanceof Error ? err.message : "Failed to load metadata");
      } finally {
        setLoadingMetadata(false);
      }
    };
    fetchMetadata();
  }, [videoPath, audioPath]);

  useEffect(() => {
    const fetchClips = async () => {
      if (!videoPath.trim()) {
        setClips([]);
        setClipError(null);
        return;
      }
      setLoadingClips(true);
      setClipError(null);
      try {
        const res = await fetch("/api/windows_clips", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videoPath }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(payload.error || `Failed to load window clips (status ${res.status})`);
        }
        const data: WindowClipsResponse = await res.json();
        const mapped: Clip[] = data.clips.map((clip, idx) => ({
          id: idx,
          window_name: clip.window_name || "Unknown window",
          start_seconds: clip.start_seconds,
          end_seconds: clip.end_seconds,
          start_timestamp: clip.start_timestamp,
          end_timestamp: clip.end_timestamp,
          start_offset_index: clip.start_offset_index,
          end_offset_index: clip.end_offset_index,
          frame_count: clip.frame_count,
        }));
        setClips(mapped);
      } catch (err) {
        setClips([]);
        setClipError(err instanceof Error ? err.message : "Failed to load window clips");
      } finally {
        setLoadingClips(false);
      }
    };
    fetchClips();
  }, [videoPath]);

  useEffect(() => {
    if (!videoUrl) {
      setVideoLoadError(null);
    }
  }, [videoUrl]);

  useEffect(() => {
    const video = audioRef.current;
    if (!video) return;
    setAudioLoadError(null);
  }, [audioUrl]);

  const pauseAll = useCallback((excludeId?: number, pauseAudio = true) => {
    clipVideoRefs.current.forEach((node, id) => {
      try {
        if (!node) return;
        if (excludeId != null && id === excludeId) return;
        node.pause();
      } catch {
        /* ignore */
      }
    });
    if (pauseAudio) {
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
      }
    }
  }, []);

  const syncClipMedia = useCallback(
    (clip: Clip, video: HTMLVideoElement, options?: { fromVideo?: boolean }) => {
      const audio = audioRef.current;
      if (!audio) return;
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : videoDuration;
      if (!duration || duration <= 0) {
        return;
      }
      if (timelineDuration && timelineDuration > 0) {
        const rate = duration / timelineDuration;
        video.playbackRate = rate > 0 ? rate : 1;
      } else {
        video.playbackRate = 1;
      }

      if (options?.fromVideo) {
        const timelineSeconds = mapVideoTimeToTimeline(video.currentTime, duration, metadata);
        const targetAudioTime = Math.max(0, timelineSeconds + combinedOffset);
        if (Math.abs(audio.currentTime - targetAudioTime) > 0.02) {
          audio.currentTime = targetAudioTime;
        }
        setCurrentTime(Math.max(0, audio.currentTime));
        return;
      }

      const timelineSeconds = Math.max(0, audio.currentTime - combinedOffset);
      const desiredVideo = mapTimelineToVideo(timelineSeconds, duration, metadata);
      if (Number.isFinite(desiredVideo) && Math.abs(video.currentTime - desiredVideo) > 0.03) {
        video.currentTime = desiredVideo;
      }
      setCurrentTime(Math.max(0, audio.currentTime));
      if (timelineSeconds >= clip.end_seconds - 0.05) {
        video.pause();
        audio.pause();
        setActiveClipId(null);
      }
    },
    [combinedOffset, metadata, timelineDuration, videoDuration],
  );

  const handleRestartClip = useCallback(
    (clip: Clip) => {
      const video = clipVideoRefs.current.get(clip.id);
      const audio = audioRef.current;
      if (!video || !audio) return;

      pauseAll();

      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : videoDuration;
      if (duration && duration > 0) {
        const videoTime = mapTimelineToVideo(clip.start_seconds, duration, metadata);
        video.currentTime = videoTime;
      }

      const targetAudioTime = Math.max(0, clip.start_seconds + combinedOffset);
      audio.currentTime = targetAudioTime;
      setCurrentTime(targetAudioTime);
      setActiveClipId(clip.id);

      video.defaultMuted = true;
      video.muted = true;
      syncClipMedia(clip, video);

      video
        .play()
        .catch(() => {
          /* ignore */
        });

      audio.muted = false;
      audio.playbackRate = 1;
      audio
        .play()
        .catch(() => {
          /* ignore */
        });
    },
    [combinedOffset, metadata, pauseAll, syncClipMedia, videoDuration],
  );

  const playClip = useCallback(
    (clip: Clip) => {
      const video = clipVideoRefs.current.get(clip.id);
      const audio = audioRef.current;
      if (!video || !audio) return;

      pauseAll();

      const currentTimeline = Math.max(0, audio.currentTime - combinedOffset);
      const inClipRange =
        activeClipId === clip.id &&
        currentTimeline >= clip.start_seconds &&
        currentTimeline <= clip.end_seconds;

      if (!inClipRange) {
        const targetAudioTime = Math.max(0, clip.start_seconds + combinedOffset);
        audio.currentTime = targetAudioTime;
        setCurrentTime(targetAudioTime);
        syncClipMedia(clip, video);
      } else {
        syncClipMedia(clip, video);
      }

      setActiveClipId(clip.id);
      video.defaultMuted = true;
      video.muted = true;
      video
        .play()
        .catch(() => {
          /* ignore */
        });

      audio.muted = false;
      audio.playbackRate = 1;
      audio
        .play()
        .catch(() => {
          /* ignore */
        });
    },
    [activeClipId, combinedOffset, pauseAll, syncClipMedia],
  );

  const pauseClip = useCallback((clip: Clip) => {
    pauseAll();
  }, [pauseAll]);

  const handleClipSeek = useCallback(
    (clip: Clip, timelineSeconds: number) => {
      const video = clipVideoRefs.current.get(clip.id);
      const audio = audioRef.current;
      if (!video || !audio) return;

      const clampedTimeline = Math.min(
        Math.max(timelineSeconds, clip.start_seconds),
        clip.end_seconds,
      );
      const targetAudioTime = Math.max(0, clampedTimeline + combinedOffset);
      const wasPlaying = !audio.paused;

      audio.currentTime = targetAudioTime;
      setCurrentTime(targetAudioTime);
      setActiveClipId(clip.id);
      syncClipMedia(clip, video);

      if (wasPlaying) {
        video
          .play()
          .catch(() => {
            /* ignore */
          });
        audio
          .play()
          .catch(() => {
            /* ignore */
          });
      }
    },
    [combinedOffset, syncClipMedia],
  );
  const findClosestFrameInClip = useCallback(
    (clip: Clip) => {
      const clipFrames = framesByClip.get(clip.id) ?? [];
      if (!clipFrames.length) {
        return null;
      }
      const clampedTimeline = Math.min(Math.max(currentTime, clip.start_seconds), clip.end_seconds);
      let closest = clipFrames[0];
      let smallestDelta = Math.abs(closest.seconds_from_video_start - clampedTimeline);
      for (let i = 1; i < clipFrames.length; i += 1) {
        const candidate = clipFrames[i];
        const delta = Math.abs(candidate.seconds_from_video_start - clampedTimeline);
        if (delta < smallestDelta) {
          smallestDelta = delta;
          closest = candidate;
        }
      }
      return closest;
    },
    [currentTime, framesByClip],
  );
  const handleOpenFrameOverlay = useCallback(
    (clip: Clip) => {
      const clipFrames = framesByClip.get(clip.id) ?? [];
      if (!clipFrames.length) {
        return;
      }
      setFrameOverlayClipId(clip.id);
      setFrameSamplingMode("sampled");
      setPreviewOpen(false);
      const nearest = findClosestFrameInClip(clip) ?? clipFrames[0];
      setSelectedFrameId(nearest.offset_index);
    },
    [findClosestFrameInClip, framesByClip],
  );
  const handleCloseFrameOverlay = useCallback(() => {
    setFrameOverlayClipId(null);
    setSelectedFrameId(null);
    setPreviewOpen(false);
    setDecoderError(null);
  }, []);
  useEffect(() => {
    if (!frameOverlayClip) {
      setSelectedFrameId(null);
      setPreviewOpen(false);
      return;
    }
    const clipFrames = framesByClip.get(frameOverlayClip.id) ?? [];
    if (!clipFrames.length) {
      setFrameOverlayClipId(null);
      setSelectedFrameId(null);
      setPreviewOpen(false);
      return;
    }
    if (selectedFrameId != null && clipFrames.some((frame) => frame.offset_index === selectedFrameId)) {
      return;
    }
    setSelectedFrameId(clipFrames[0]?.offset_index ?? null);
  }, [frameOverlayClip, framesByClip, selectedFrameId]);
  const seekClipToFrame = useCallback(
    (clip: Clip, frame: FrameEntry, options?: { autoplay?: boolean }) => {
      handleClipSeek(clip, frame.seconds_from_video_start);
      if (options?.autoplay) {
        const video = clipVideoRefs.current.get(clip.id);
        const audio = audioRef.current;
        if (video) {
          video
            .play()
            .catch(() => {
              /* ignore */
            });
        }
        if (audio) {
          audio
            .play()
            .catch(() => {
              /* ignore */
            });
        }
      }
    },
    [handleClipSeek],
  );
  const openFramePreview = useCallback(
    (clip: Clip, frame: FrameEntry) => {
      setSelectedFrameId(frame.offset_index);
      setPreviewOpen(true);
      const videoSeconds = computeVideoSecondsFromFrame(frame);
      requestFrameThumbnail(frame.offset_index, videoSeconds).catch(() => {
        /* card handles individual decode errors */
      });
      seekClipToFrame(clip, frame);
    },
    [computeVideoSecondsFromFrame, requestFrameThumbnail, seekClipToFrame],
  );
  const closeFramePreview = useCallback(() => {
    setPreviewOpen(false);
  }, []);
  const handleSeekAndPlayFrame = useCallback(() => {
    if (!frameOverlayClip || !selectedFrame) {
      return;
    }
    seekClipToFrame(frameOverlayClip, selectedFrame, { autoplay: true });
    setPreviewOpen(false);
    setFrameOverlayClipId(null);
  }, [frameOverlayClip, seekClipToFrame, selectedFrame]);
  const navigateToPrevFrame = useCallback(() => {
    if (!frameOverlayClip || !selectedFrame || selectedFrameIndex <= 0) {
      return;
    }
    const prevFrame = displayFrames[selectedFrameIndex - 1];
    if (prevFrame) {
      openFramePreview(frameOverlayClip, prevFrame);
    }
  }, [displayFrames, frameOverlayClip, selectedFrame, selectedFrameIndex, openFramePreview]);
  const navigateToNextFrame = useCallback(() => {
    if (!frameOverlayClip || !selectedFrame || selectedFrameIndex < 0 || selectedFrameIndex >= displayFrames.length - 1) {
      return;
    }
    const nextFrame = displayFrames[selectedFrameIndex + 1];
    if (nextFrame) {
      openFramePreview(frameOverlayClip, nextFrame);
    }
  }, [displayFrames, frameOverlayClip, selectedFrame, selectedFrameIndex, openFramePreview]);
  const handleFrameCardSelect = useCallback(
    (clip: Clip, frame: FrameEntry) => {
      openFramePreview(clip, frame);
    },
    [openFramePreview],
  );
  useEffect(() => {
    if (!frameOverlayClip || !frameOverlayFrames.length) {
      return;
    }
    const warmup = displayFrames.slice(0, 24);
    warmup.forEach((frame) => {
      const videoSeconds = computeVideoSecondsFromFrame(frame);
      requestFrameThumbnail(frame.offset_index, videoSeconds).catch(() => {
        /* ignore individual decode errors */
      });
    });
  }, [computeVideoSecondsFromFrame, displayFrames, frameOverlayClip, frameOverlayFrames, requestFrameThumbnail]);
  useEffect(() => {
    if (!frameOverlayClip || selectedFrameId == null) {
      return;
    }
    const raf = window.requestAnimationFrame(() => {
      const element = document.querySelector<HTMLElement>(`[data-frame-card="${selectedFrameId}"]`);
      if (element) {
        element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
      }
    });
    return () => {
      window.cancelAnimationFrame(raf);
    };
  }, [frameOverlayClip, selectedFrameId, frameSamplingMode, layoutMode, displayFrames]);
  useEffect(() => {
    if (!frameOverlayClip || !selectedFrame) {
      return;
    }
    const videoSeconds = computeVideoSecondsFromFrame(selectedFrame);
    requestFrameThumbnail(selectedFrame.offset_index, videoSeconds).catch(() => {
      /* ignore individual decode errors */
    });
  }, [computeVideoSecondsFromFrame, frameOverlayClip, requestFrameThumbnail, selectedFrame]);

  useEffect(() => {
    setCurrentTime(0);
    setActiveClipId(null);
    pauseAll();
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
    }
  }, [audioPath, videoPath, pauseAll]);

  useEffect(() => {
    setVideoDuration(null);
  }, [videoPath]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const updateCurrent = () => {
      setCurrentTime(Math.max(0, audio.currentTime));
      if (activeClipId != null) {
        const clip = clips.find((c) => c.id === activeClipId);
        if (clip) {
          const video = clipVideoRefs.current.get(clip.id);
          if (video) {
            syncClipMedia(clip, video);
          }
        }
      }
    };
    audio.addEventListener("timeupdate", updateCurrent);
    return () => {
      audio.removeEventListener("timeupdate", updateCurrent);
    };
  }, [activeClipId, clips, syncClipMedia]);

  useEffect(() => {
    clipVideoRefs.current.forEach((node) => {
      if (!node) return;
      if (!videoUrl) {
        node.removeAttribute("data-current-src");
        node.removeAttribute("src");
        node.load();
        return;
      }
      const current = node.getAttribute("data-current-src");
      if (current !== videoUrl) {
        node.setAttribute("data-current-src", videoUrl);
        node.src = videoUrl;
        node.load();
      }
    });
  }, [videoUrl]);

  useEffect(() => {
    setFrameOverlayClipId(null);
    setSelectedFrameId(null);
    setPreviewOpen(false);
    setDecoderError(null);
  }, [videoUrl]);

  useEffect(() => {
    const decoder = decoderRef.current;
    if (!decoder) {
      return;
    }

    const resetDecoderState = (clearThumbnails: boolean) => {
      queueProcessingRef.current = false;
      const pending = queueRef.current.splice(0);
      pending.forEach((request) => {
        try {
          request.reject(new Error("Frame decoding reset"));
        } catch {
          /* ignore */
        }
      });
      decoderReadyRef.current = false;
      const resolvers = decoderReadyResolversRef.current.splice(0);
      resolvers.forEach(({ reject }) => {
        try {
          reject(new Error("Frame decoder reset"));
        } catch {
          /* ignore */
        }
      });
      framePromisesRef.current.forEach((promise, frameId) => {
        void promise.catch(() => {
          /* noop */
        });
        framePromisesRef.current.delete(frameId);
      });
      if (clearThumbnails) {
        frameThumbsRef.current = {};
        canvasRef.current = null;
        forceFrameUpdate((value) => (value + 1) % 1000000);
      }
      setDecoderError(null);
    };

    decoder.defaultMuted = true;
    decoder.muted = true;
    decoder.preload = "auto";
    decoder.playsInline = true;
    decoder.crossOrigin = "anonymous";

    const handleLoadedMetadata = () => {
      decoderReadyRef.current = true;
      const resolvers = decoderReadyResolversRef.current.splice(0);
      resolvers.forEach(({ resolve }) => resolve());
      processQueue();
      setDecoderError(null);
    };

    const handleError = () => {
      const mediaError = decoder.error;
      if (mediaError) {
        console.error("Frame decoder media error", {
          code: mediaError.code,
          message: mediaError.message,
          videoUrl,
        });
      } else {
        console.error("Frame decoder fired generic error event", { videoUrl });
      }
      const mediaErrorCode = mediaError?.code ?? 0;
      const networkState = decoder.networkState;
      setDecoderError(
        `Frame decoder failed to load (mediaErr=${mediaErrorCode}, networkState=${networkState}). Ensure the FastAPI server at ${serverHint} is running and that it returns Access-Control-Allow-Origin headers.`,
      );
      decoderReadyRef.current = false;
      const resolvers = decoderReadyResolversRef.current.splice(0);
      resolvers.forEach(({ reject }) => {
        try {
          reject(new Error("Frame decoder unavailable"));
        } catch {
          /* ignore */
        }
      });
      queueProcessingRef.current = false;
      while (queueRef.current.length > 0) {
        const pending = queueRef.current.shift();
        if (pending) {
          pending.reject(new Error("Frame decoder unavailable"));
        }
      }
    };

    decoder.addEventListener("loadedmetadata", handleLoadedMetadata);
    decoder.addEventListener("error", handleError);

    const currentSrc = decoder.getAttribute("data-current-src");
    if (!videoUrl) {
      resetDecoderState(true);
      decoder.removeAttribute("data-current-src");
      decoder.removeAttribute("src");
      decoder.load();
      return () => {
        decoder.removeEventListener("loadedmetadata", handleLoadedMetadata);
        decoder.removeEventListener("error", handleError);
      };
    }

    if (currentSrc === videoUrl && decoder.readyState >= 1) {
      decoderReadyRef.current = true;
      const resolvers = decoderReadyResolversRef.current.splice(0);
      resolvers.forEach(({ resolve }) => resolve());
      processQueue();
    } else {
      resetDecoderState(true);
      decoder.setAttribute("data-current-src", videoUrl);
      decoder.src = videoUrl;
      decoder.load();
    }

    return () => {
      decoder.removeEventListener("loadedmetadata", handleLoadedMetadata);
      decoder.removeEventListener("error", handleError);
    };
  }, [processQueue, serverHint, videoUrl, forceFrameUpdate]);

  const handleFormSubmit = (evt: React.FormEvent<HTMLFormElement>) => {
    evt.preventDefault();
    setVideoPath(videoInput.trim());
    setAudioPath(audioInput.trim());
  };

  const serverErrorMessage = useMemo(() => {
    if (!videoUrl && !audioUrl) {
      return "Provide both video and audio paths to begin.";
    }
    if (!videoUrl) {
      return "Provide a valid video path.";
    }
    if (!audioUrl) {
      return "Provide a valid audio path.";
    }
    return null;
  }, [videoUrl, audioUrl]);

  return (
    <main style={{ display: "grid", gap: 24, padding: 24 }}>
      <header>
        <h1>Window Clips</h1>
        <p style={{ color: "#607080" }}>
          Groups contiguous frames by recorded window title so you can jump between context clips, review thumbnails, and keep audio playback in sync.
        </p>
      </header>

      <section>
        <form onSubmit={handleFormSubmit} style={{ display: "grid", gap: 12, maxWidth: 640 }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span>Video path (absolute or project-relative)</span>
            <input
              type="text"
              value={videoInput}
              onChange={(e) => setVideoInput(e.target.value)}
              style={{ padding: "8px 10px" }}
            />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span>Audio path (absolute or project-relative)</span>
            <input
              type="text"
              value={audioInput}
              onChange={(e) => setAudioInput(e.target.value)}
              style={{ padding: "8px 10px" }}
            />
          </label>
          <button type="submit" style={{ width: 160, padding: "8px 12px" }}>
            Load Sources
          </button>
        </form>
        {videoWarning && <p style={{ color: "#b54747", marginTop: 8 }}>{videoWarning}</p>}
        {audioWarning && <p style={{ color: "#b54747" }}>{audioWarning}</p>}
      </section>

      <section style={{ background: "#0f172a", color: "#f8fafc", padding: 16, borderRadius: 8, display: "grid", gap: 12 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
          <strong>Alignment:</strong>
          {loadingMetadata && <span style={{ color: "#94a3b8" }}>Loading metadata...</span>}
          {metadataError && <span style={{ color: "#fca5a5" }}>{metadataError}</span>}
          {metadata && (
            <>
              <span>audioOffset = {formatOffset(metadata.alignment.audio_offset_seconds)}</span>
              <span>timelineScale = {displayScale.toFixed(3)}x</span>
              <span>manual = {manualOffset.toFixed(2)}s</span>
              <span>frames = {metadata.video.frame_count}</span>
            </>
          )}
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span>Manual audio offset (s)</span>
            <input
              type="number"
              value={manualOffset}
              onChange={(e) => {
                const val = Number(e.target.value);
                setManualOffset(Number.isFinite(val) ? val : 0);
              }}
              step={0.05}
              min={-5}
              max={5}
              style={{ width: 80, padding: "4px 6px" }}
            />
          </label>
          <button type="button" onClick={() => setManualOffset(0)} style={{ padding: "4px 10px" }}>
            Reset Offset
          </button>
        </div>
      </section>

      {serverErrorMessage && <div style={{ color: "#b54747" }}>{serverErrorMessage}</div>}

      <audio
        ref={audioRef}
        src={audioUrl || undefined}
        preload="metadata"
        onError={() =>
          setAudioLoadError(`Audio failed to load. Ensure the FastAPI server at ${serverHint} is running.`)
        }
        onLoadedData={() => setAudioLoadError(null)}
      />
      {audioLoadError && <div style={{ color: "#fca5a5" }}>{audioLoadError}</div>}
      {videoLoadError && <div style={{ color: "#fca5a5" }}>{videoLoadError}</div>}

      <section style={{ display: "grid", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h2 style={{ margin: 0 }}>Window clips</h2>
          {loadingClips && <span style={{ color: "#64748b" }}>Loading clips...</span>}
          {clipError && <span style={{ color: "#b54747" }}>{clipError}</span>}
        </div>
        <div style={{ display: "grid", gap: 16 }}>
          {clips.length === 0 && !loadingClips ? (
            <div style={{ color: "#94a3b8" }}>No window clips detected for this recording.</div>
          ) : (
            clips.map((clip) => {
              const clipFramesForCard = framesByClip.get(clip.id) ?? [];
              const isActive = activeClipId === clip.id;
              const audioEl = audioRef.current;
              const isPlaying = isActive && audioEl ? !audioEl.paused : false;
              const clipDuration = Math.max(clip.end_seconds - clip.start_seconds, 0.001);
              const timelineSeconds = Math.max(0, currentTime - combinedOffset);
              const effectiveTimeline = Math.min(Math.max(timelineSeconds, clip.start_seconds), clip.end_seconds);
              const sliderValue = isActive ? effectiveTimeline - clip.start_seconds : 0;
              const clipCurrentDisplay = clip.start_seconds + sliderValue;
              const canOpenCarousel = Boolean(videoUrl && clipFramesForCard.length);
              return (
                <div
                  key={clip.id}
                  style={{
                    border: `1px solid ${isActive ? "#1d4ed8" : "#1e293b"}`,
                    borderRadius: 8,
                    padding: 16,
                    display: "grid",
                    gap: 12,
                    background: "#0b1120",
                    color: "#e2e8f0",
                  }}
                >
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
                    <strong style={{ fontSize: 18 }}>{clip.window_name || "Unknown window"}</strong>
                    <span style={{ color: "#94a3b8" }}>
                      {formatTime(clip.start_seconds)} - {formatTime(clip.end_seconds)}
                    </span>
                    <span style={{ color: "#64748b" }}>{clip.frame_count} frames</span>
                    <div style={{ flexGrow: 1 }} />
                    <button
                      type="button"
                      onClick={() => handleOpenFrameOverlay(clip)}
                      disabled={!canOpenCarousel}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "6px 12px",
                        borderRadius: 6,
                        border: "1px solid",
                        borderColor: canOpenCarousel ? "#3b82f6" : "#334155",
                        background: canOpenCarousel ? "rgba(59, 130, 246, 0.2)" : "rgba(15, 23, 42, 0.6)",
                        color: canOpenCarousel ? "#e0f2fe" : "#64748b",
                        cursor: canOpenCarousel ? "pointer" : "not-allowed",
                      }}
                    >
                      <FrameCarouselIcon color={canOpenCarousel ? "#e0f2fe" : "#64748b"} size={18} />
                      Frames
                    </button>
                  </div>

                  <div style={{ display: "grid", gap: 8 }}>
                    <div
                      style={{
                        position: "relative",
                        background: "#111",
                        minHeight: 200,
                        borderRadius: 8,
                        overflow: "hidden",
                      }}
                    >
                      {videoUrl ? (
                        <video
                          ref={(node) => {
                            if (node) {
                              node.defaultMuted = true;
                              node.muted = true;
                              node.volume = 0;
                              if (!(node as any).__enforceMute) {
                                const enforceMute = () => {
                                  if (!node.muted) {
                                    node.muted = true;
                                  }
                                  if (node.volume !== 0) {
                                    node.volume = 0;
                                  }
                                };
                                (node as any).__enforceMute = enforceMute;
                                node.addEventListener("volumechange", enforceMute);
                              }
                              node.preload = "metadata";
                              if (videoUrl) {
                                const current = node.getAttribute("data-current-src");
                                if (current !== videoUrl) {
                                  node.setAttribute("data-current-src", videoUrl);
                                  node.src = videoUrl;
                                  node.load();
                                }
                              }
                              node.onloadedmetadata = () => {
                                setVideoDuration((prev) => prev ?? (Number.isFinite(node.duration) ? node.duration : prev));
                                const duration = Number.isFinite(node.duration) && node.duration > 0 ? node.duration : videoDuration;
                                node.currentTime = mapTimelineToVideo(clip.start_seconds, duration, metadata);
                              };
                              clipVideoRefs.current.set(clip.id, node);
                            } else {
                              const prevNode = clipVideoRefs.current.get(clip.id);
                              if (prevNode && (prevNode as any).__enforceMute) {
                                prevNode.removeEventListener("volumechange", (prevNode as any).__enforceMute);
                                delete (prevNode as any).__enforceMute;
                              }
                              clipVideoRefs.current.delete(clip.id);
                            }
                          }}
                          onError={() =>
                            setVideoLoadError(
                              `Video failed to load. Ensure the FastAPI server at ${serverHint} is running and the file path is correct.`,
                            )
                          }
                          onLoadedData={() => setVideoLoadError(null)}
                          style={{ width: "100%", height: "100%", objectFit: "contain" }}
                        />
                      ) : (
                        <div style={{ padding: 40, color: "#eee" }}>Enter a video path to view clips.</div>
                      )}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        alignItems: "center",
                        gap: 12,
                        marginTop: 12,
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => (isPlaying ? pauseClip(clip) : playClip(clip))}
                        style={{ padding: "4px 10px" }}
                      >
                        {isPlaying ? "Pause" : "Play"}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRestartClip(clip)}
                        style={{ padding: "4px 10px" }}
                      >
                        Restart
                      </button>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 160 }}>
                        <input
                          type="range"
                          min={0}
                          max={clipDuration}
                          step={0.05}
                          value={sliderValue}
                          onChange={(event) =>
                            handleClipSeek(clip, clip.start_seconds + Number(event.target.value || "0"))
                          }
                          onMouseDown={() => setActiveClipId(clip.id)}
                          disabled={clipDuration <= 0.01}
                          style={{ flex: 1 }}
                        />
                        <span style={{ color: "#94a3b8", fontVariantNumeric: "tabular-nums" }}>
                          {formatTime(clipCurrentDisplay)} / {formatTime(clip.end_seconds)}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      {frameOverlayClip && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 80,
            background: "rgba(8, 15, 35, 0.95)",
            color: "#f8fafc",
            display: "flex",
            flexDirection: "column",
            padding: "24px 32px",
            gap: 16,
          }}
        >
          <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center" }}>
            <div style={{ display: "grid", gap: 4 }}>
              <h2 style={{ margin: 0 }}>Frame carousel</h2>
              <span style={{ color: "#cbd5f5" }}>
                Clip: {frameOverlayClip.window_name || "Unknown window"} ·{" "}
                {formatTime(frameOverlayClip.start_seconds)} – {formatTime(frameOverlayClip.end_seconds)}
              </span>
              <span style={{ color: "#94a3b8" }}>
                Showing {displayFrames.length.toLocaleString()} of {frameOverlayFrames.length.toLocaleString()} frames (
                {frameSamplingMode === "sampled" ? `sampled every ${SAMPLE_FRAME_GAP_LABEL}` : "all frames"})
              </span>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginLeft: "auto" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ color: "#cbd5f5" }}>Density:</span>
                <button
                  type="button"
                  onClick={() => setFrameSamplingMode("sampled")}
                  style={{
                    padding: "6px 12px",
                    borderRadius: 6,
                    border: "1px solid",
                    borderColor: frameSamplingMode === "sampled" ? "#38bdf8" : "#334155",
                    background: frameSamplingMode === "sampled" ? "rgba(56, 189, 248, 0.18)" : "rgba(15, 23, 42, 0.6)",
                    color: "#f8fafc",
                    cursor: "pointer",
                  }}
                >
                  Sampled
                </button>
                <span style={{ color: "#334155" }}>|</span>
                <button
                  type="button"
                  onClick={() => setFrameSamplingMode("all")}
                  style={{
                    padding: "6px 12px",
                    borderRadius: 6,
                    border: "1px solid",
                    borderColor: frameSamplingMode === "all" ? "#38bdf8" : "#334155",
                    background: frameSamplingMode === "all" ? "rgba(56, 189, 248, 0.18)" : "rgba(15, 23, 42, 0.6)",
                    color: "#f8fafc",
                    cursor: "pointer",
                  }}
                >
                  All
                </button>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ color: "#cbd5f5" }}>Layout:</span>
                <button
                  type="button"
                  onClick={() => setLayoutMode("grid")}
                  style={{
                    padding: "6px 12px",
                    borderRadius: 6,
                    border: "1px solid",
                    borderColor: layoutMode === "grid" ? "#38bdf8" : "#334155",
                    background: layoutMode === "grid" ? "rgba(56, 189, 248, 0.18)" : "rgba(15, 23, 42, 0.6)",
                    color: "#f8fafc",
                    cursor: "pointer",
                  }}
                >
                  Grid
                </button>
                <span style={{ color: "#334155" }}>|</span>
                <button
                  type="button"
                  onClick={() => setLayoutMode("list")}
                  style={{
                    padding: "6px 12px",
                    borderRadius: 6,
                    border: "1px solid",
                    borderColor: layoutMode === "list" ? "#38bdf8" : "#334155",
                    background: layoutMode === "list" ? "rgba(56, 189, 248, 0.18)" : "rgba(15, 23, 42, 0.6)",
                    color: "#f8fafc",
                    cursor: "pointer",
                  }}
                >
                  List
                </button>
              </div>
              <button
                type="button"
                onClick={handleCloseFrameOverlay}
                style={{
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: "1px solid #334155",
                  background: "rgba(15, 23, 42, 0.6)",
                  color: "#f8fafc",
                  cursor: "pointer",
                }}
              >
                Close
              </button>
            </div>
          </div>
          {decoderError && <div style={{ color: "#fca5a5" }}>{decoderError}</div>}
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              paddingRight: 12,
              display: "grid",
              gap: 12,
            }}
          >
            {displayFrames.length === 0 ? (
              <div style={{ color: "#94a3b8" }}>No frames available for this clip.</div>
            ) : layoutMode === "grid" ? (
              <div
                style={{
                  display: "grid",
                  gap: 12,
                  gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                }}
              >
                {displayFrames.map((frame) => {
                  const videoSeconds = computeVideoSecondsFromFrame(frame);
                  const isActive =
                    Math.abs(currentTime - frame.seconds_from_video_start) < 0.2 ||
                    Math.abs((selectedFrame?.seconds_from_video_start ?? 0) - frame.seconds_from_video_start) < 0.2;
                  return (
                    <FrameThumbnailCard
                      key={frame.offset_index}
                      frame={frame}
                      thumbnail={frameThumbnails[frame.offset_index]}
                      videoSeconds={videoSeconds}
                      isActive={isActive}
                      isSelected={selectedFrameId === frame.offset_index}
                      requestThumbnail={requestFrameThumbnail}
                      onSelect={(clickedFrame) => handleFrameCardSelect(frameOverlayClip, clickedFrame)}
                      layoutMode="grid"
                    />
                  );
                })}
              </div>
            ) : (
              <div
                style={{
                  display: "grid",
                  gap: 12,
                }}
              >
                {displayFrames.map((frame) => {
                  const videoSeconds = computeVideoSecondsFromFrame(frame);
                  const isActive =
                    Math.abs(currentTime - frame.seconds_from_video_start) < 0.2 ||
                    Math.abs((selectedFrame?.seconds_from_video_start ?? 0) - frame.seconds_from_video_start) < 0.2;
                  return (
                    <FrameThumbnailCard
                      key={frame.offset_index}
                      frame={frame}
                      thumbnail={frameThumbnails[frame.offset_index]}
                      videoSeconds={videoSeconds}
                      isActive={isActive}
                      isSelected={selectedFrameId === frame.offset_index}
                      requestThumbnail={requestFrameThumbnail}
                      onSelect={(clickedFrame) => handleFrameCardSelect(frameOverlayClip, clickedFrame)}
                      layoutMode="list"
                    />
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {previewOpen && (
        <FramePreviewModal
          frame={selectedFrame}
          thumbnail={selectedFrame ? frameThumbnails[selectedFrame.offset_index] : undefined}
          videoSeconds={selectedFrame ? computeVideoSecondsFromFrame(selectedFrame) : null}
          onClose={closeFramePreview}
          onSeekAndPlay={handleSeekAndPlayFrame}
          onNavigatePrev={navigateToPrevFrame}
          onNavigateNext={navigateToNextFrame}
          hasPrev={hasPrevFrame}
          hasNext={hasNextFrame}
        />
      )}

      <video ref={decoderRef} style={{ display: "none" }} preload="metadata" playsInline muted aria-hidden="true" />
    </main>
  );
}
