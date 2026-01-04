"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

type Segment = {
  id: number;
  start: number;
  end: number;
  text: string;
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

const DEFAULT_VIDEO = "C:\\Users\\steve\\.screenpipe\\data\\monitor_52305895_2025-10-12_02-13-01.mp4";
const DEFAULT_AUDIO = "C:\\Users\\steve\\Desktop\\Whisper\\sessions\\session-20251011-221322.wav";
const API_BASE = (
  process.env.NEXT_PUBLIC_API_BASE && process.env.NEXT_PUBLIC_API_BASE.trim().length > 0
    ? process.env.NEXT_PUBLIC_API_BASE
    : "http://localhost:8001"
).replace(/\/$/, "");

const ABSOLUTE_PATH_REGEX = /^[a-zA-Z]:[\\/]|^\//;

function normalisePath(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.?\//, "");
}

function getTimelineDuration(meta: Metadata | null): number | null {
  if (!meta || !meta.frames.length) {
    return null;
  }
  return meta.frames[meta.frames.length - 1].seconds_from_video_start;
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

type FrameThumbnailCardProps = {
  frame: FrameEntry;
  thumbnail: string | undefined;
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (thumbnail) {
      return;
    }
    setLoading(true);
    setError(null);
    requestThumbnail(frame.offset_index, videoSeconds)
      .catch((err) => {
        if (cancelled) {
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to decode frame");
      })
      .finally(() => {
        if (cancelled) {
          return;
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [frame.offset_index, videoSeconds, requestThumbnail, thumbnail]);

  const handleSelect = () => {
    if (loading) {
      return;
    }
    if (thumbnail) {
      onSelect(frame);
      return;
    }
    setLoading(true);
    setError(null);
    requestThumbnail(frame.offset_index, videoSeconds)
      .then(() => {
        onSelect(frame);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to decode frame");
      })
      .finally(() => {
        setLoading(false);
      });
  };

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
            gap: 16,
            color: metadataColour,
          }}
        >
          <span>Frame #: {frame ? frame.offset_index : "--"}</span>
          <span>Video time: {frame ? formatTime(videoSeconds ?? frame.seconds_from_video_start) : "--"}</span>
          <span>Timeline time: {frame ? formatTime(frame.seconds_from_video_start) : "--"}</span>
          <span>Timestamp: {frame ? frame.timestamp : "--"}</span>
        </div>
        <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={onSeekAndPlay}
            disabled={!frame}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: "none",
              background: frame ? "#2563eb" : "#1e293b",
              color: "#f8fafc",
              cursor: frame ? "pointer" : "not-allowed",
            }}
          >
            Seek &amp; play
          </button>
        </div>
      </div>
    </div>
  );
}

type IconProps = {
  size?: number;
  color?: string;
};

function PlayIcon({ size = 20, color = "#f8fafc" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 5v14l11-7z" fill={color} />
    </svg>
  );
}

function PauseIcon({ size = 20, color = "#f8fafc" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x={6} y={5} width={4} height={14} rx={1} fill={color} />
      <rect x={14} y={5} width={4} height={14} rx={1} fill={color} />
    </svg>
  );
}

function RestartIcon({ size = 20, color = "#f8fafc" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M12 5a7 7 0 1 1-6.32 10.01"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M7 5H3v4" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
        <path d="m3 5 3.5 3.5" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

function FrameCarouselIcon({ size = 20, color = "#f8fafc" }: IconProps) {
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

export default function VideoFramePage() {
  const [videoInput, setVideoInput] = useState(DEFAULT_VIDEO);
  const [audioInput, setAudioInput] = useState(DEFAULT_AUDIO);
  const [videoPath, setVideoPath] = useState(DEFAULT_VIDEO);
  const [audioPath, setAudioPath] = useState(DEFAULT_AUDIO);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [loadingMetadata, setLoadingMetadata] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoLoadError, setVideoLoadError] = useState<string | null>(null);
  const [audioLoadError, setAudioLoadError] = useState<string | null>(null);
  const [manualOffset, setManualOffset] = useState(0);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [audioDuration, setAudioDuration] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [frameOverlayOpen, setFrameOverlayOpen] = useState(false);
  const [decoderError, setDecoderError] = useState<string | null>(null);
  const [selectedFrameId, setSelectedFrameId] = useState<number | null>(null);
  const [frameSamplingMode, setFrameSamplingMode] = useState<"sampled" | "all">("sampled");
  const [layoutMode, setLayoutMode] = useState<"grid" | "list">("grid");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [, forceFrameUpdate] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const lastSyncedRef = useRef(0);
  const lastTimelineRef = useRef(0);
  const lastRequestedAudioRef = useRef(0);
  const hideControlsTimeoutRef = useRef<number | null>(null);
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
  const serverHint = API_BASE || "http://localhost:8001";
  const timelineDuration = useMemo(() => getTimelineDuration(metadata), [metadata]);
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
  const SAMPLE_FRAME_GAP_SECONDS = 1.0;
  const SAMPLE_FRAME_GAP_LABEL =
    SAMPLE_FRAME_GAP_SECONDS >= 1
      ? `${Number.isInteger(SAMPLE_FRAME_GAP_SECONDS) ? SAMPLE_FRAME_GAP_SECONDS.toFixed(0) : SAMPLE_FRAME_GAP_SECONDS.toFixed(1)} second${SAMPLE_FRAME_GAP_SECONDS === 1 ? "" : "s"}`
      : `${Math.round(SAMPLE_FRAME_GAP_SECONDS * 1000)} ms`;
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
  const displayFrames = useMemo(() => {
    if (!frames.length) {
      return [];
    }
    if (frameSamplingMode === "all") {
      return frames;
    }
    const sampled: FrameEntry[] = [];
    let lastTime = -Infinity;
    for (const frame of frames) {
      if (frame.seconds_from_video_start - lastTime >= SAMPLE_FRAME_GAP_SECONDS) {
        sampled.push(frame);
        lastTime = frame.seconds_from_video_start;
      }
    }
    return sampled;
  }, [frames, frameSamplingMode]);
  const selectedFrame = useMemo(() => {
    if (selectedFrameId == null) {
      return null;
    }
    return displayFrames.find((frame) => frame.offset_index === selectedFrameId) ?? null;
  }, [displayFrames, selectedFrameId]);
  const findClosestFrame = useCallback(() => {
    if (!frames.length) {
      return null;
    }
    let targetTimeline = Number.isFinite(lastTimelineRef.current) ? lastTimelineRef.current : 0;
    const video = videoRef.current;
    const duration =
      video && Number.isFinite(video.duration) && video.duration > 0 ? video.duration : videoDuration;
    if (video && duration && metadata) {
      const mapped = mapVideoTimeToTimeline(video.currentTime, duration, metadata);
      if (Number.isFinite(mapped)) {
        targetTimeline = mapped;
      } else if (Number.isFinite(video.currentTime)) {
        targetTimeline = Math.max(0, video.currentTime);
      }
    } else if (!Number.isFinite(targetTimeline) || targetTimeline <= 0) {
      targetTimeline = Math.max(0, currentTime - combinedOffset);
    }
    let closest = frames[0];
    let smallestDelta = Math.abs(closest.seconds_from_video_start - targetTimeline);
    for (let i = 1; i < frames.length; i += 1) {
      const candidate = frames[i];
      const delta = Math.abs(candidate.seconds_from_video_start - targetTimeline);
      if (delta < smallestDelta) {
        smallestDelta = delta;
        closest = candidate;
      }
    }
    return closest;
  }, [frames, combinedOffset, currentTime, metadata, videoDuration]);
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
        throw new Error("Decoder not initialised");
      }

      await waitForDecoderReady();
      if (!decoderReadyRef.current) {
        throw new Error("Decoder not ready");
      }

      const duration = Number.isFinite(decoder.duration) && decoder.duration > 0 ? decoder.duration : null;
      const target = duration ? Math.min(Math.max(seconds, 0), Math.max(duration - 0.001, 0)) : Math.max(seconds, 0);

      if (!Number.isFinite(target)) {
        throw new Error("Invalid frame timestamp");
      }

      const performDraw = async () => {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
        const canvas = getCanvas();
        const width = decoder.videoWidth || 0;
        const height = decoder.videoHeight || 0;
        if (!width || !height) {
          throw new Error("Video dimensions unavailable");
        }

        const renderWidth = width;
        const renderHeight = height;
        canvas.width = renderWidth;
        canvas.height = renderHeight;

        const context = canvas.getContext("2d");
        if (!context) {
          throw new Error("Unable to create canvas context");
        }
        context.drawImage(decoder, 0, 0, renderWidth, renderHeight);
        try {
          return canvas.toDataURL("image/jpeg", 0.92);
        } catch (err) {
          throw new Error(
            err instanceof Error && err.message.toLowerCase().includes("tainted")
              ? "Browser blocked canvas export. Enable CORS on the video file endpoint."
              : err instanceof Error
                ? err.message
                : "Failed to serialise frame",
          );
        }
      };

      if (Math.abs(decoder.currentTime - target) <= 0.01) {
        return performDraw();
      }

      await new Promise<void>((resolve, reject) => {
        const handleSeeked = () => {
          decoder.removeEventListener("seeked", handleSeeked);
          decoder.removeEventListener("error", handleError);
          resolve();
        };
        const handleError = () => {
          decoder.removeEventListener("seeked", handleSeeked);
          decoder.removeEventListener("error", handleError);
          reject(new Error("Decoder seek error"));
        };
        decoder.addEventListener("seeked", handleSeeked);
        decoder.addEventListener("error", handleError);
        try {
          decoder.currentTime = target;
        } catch (err) {
          decoder.removeEventListener("seeked", handleSeeked);
          decoder.removeEventListener("error", handleError);
          reject(err);
        }
      });

      return performDraw();
    },
    [getCanvas, waitForDecoderReady],
  );
  const processQueue = useCallback(() => {
    if (queueProcessingRef.current) {
      return;
    }
    if (!decoderReadyRef.current) {
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
        queueRef.current.push({
          id: frameId,
          seconds,
          resolve,
          reject,
        });
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
  const frameThumbnails = frameThumbsRef.current;
  const selectedFrameIndex = useMemo(() => {
    if (!selectedFrame) {
      return -1;
    }
    return displayFrames.findIndex((frame) => frame.offset_index === selectedFrame.offset_index);
  }, [displayFrames, selectedFrame]);
  const hasPrevFrame = selectedFrameIndex > 0;
  const hasNextFrame = selectedFrameIndex >= 0 && selectedFrameIndex < displayFrames.length - 1;
  const canOpenCarousel = useMemo(() => {
    if (!videoUrl) {
      return false;
    }
    return displayFrames.length > 0;
  }, [videoUrl, displayFrames]);
  const activeTimeline = Number.isFinite(lastTimelineRef.current) ? lastTimelineRef.current : 0;
  const handleOpenFrameOverlay = useCallback(() => {
    setFrameSamplingMode(() => "all");
    const nearest = findClosestFrame();
    if (nearest) {
      setSelectedFrameId(nearest.offset_index);
    }
    setFrameOverlayOpen(true);
  }, [findClosestFrame]);
  const handleCloseFrameOverlay = useCallback(() => {
    setFrameOverlayOpen(false);
    setPreviewOpen(false);
  }, []);
  const effectiveDuration = useMemo(() => {
    if (metadata?.audio.duration_seconds && metadata.audio.duration_seconds > 0) {
      return metadata.audio.duration_seconds;
    }
    if (audioDuration && audioDuration > 0) {
      return audioDuration;
    }
    if (timelineDuration && timelineDuration > 0) {
      return timelineDuration;
    }
    if (videoDuration && videoDuration > 0) {
      return videoDuration;
    }
    return Math.max(currentTime, 0);
  }, [metadata, audioDuration, timelineDuration, videoDuration, currentTime]);
  const clampedCurrentTime = Math.min(Math.max(currentTime, 0), effectiveDuration || Math.max(currentTime, 0));
  const sliderMax = effectiveDuration > 0 ? effectiveDuration : Math.max(currentTime || 0, 1);
  const formattedCurrentTime = formatTime(clampedCurrentTime);
  const formattedTotalTime = formatTime(sliderMax > 0 ? sliderMax : Math.max(clampedCurrentTime, 0));

  const clearHideControlsTimeout = useCallback(() => {
    if (hideControlsTimeoutRef.current != null) {
      window.clearTimeout(hideControlsTimeoutRef.current);
      hideControlsTimeoutRef.current = null;
    }
  }, []);

  const queueHideControls = useCallback(() => {
    if (!isPlaying) {
      return;
    }
    clearHideControlsTimeout();
    hideControlsTimeoutRef.current = window.setTimeout(() => {
      setControlsVisible(false);
      hideControlsTimeoutRef.current = null;
    }, 2000);
  }, [clearHideControlsTimeout, isPlaying]);

  useEffect(() => {
    if (!isPlaying) {
      clearHideControlsTimeout();
      setControlsVisible(true);
      return;
    }
    setControlsVisible(true);
    queueHideControls();
    return () => {
      clearHideControlsTimeout();
    };
  }, [isPlaying, queueHideControls, clearHideControlsTimeout]);

  useEffect(
    () => () => {
      clearHideControlsTimeout();
    },
    [clearHideControlsTimeout],
  );

  const seekToMediaTime = useCallback(
    (targetAudioSeconds: number, autoplay = false) => {
      const video = videoRef.current;
      const audio = audioRef.current;
      if (!video || !audio) {
        return;
      }
      const desiredAudio = targetAudioSeconds;
      const timelineSeconds = Math.max(0, desiredAudio - combinedOffset);
      lastTimelineRef.current = timelineSeconds;
      lastRequestedAudioRef.current = desiredAudio;
      const audioCap =
        metadata?.audio.duration_seconds && metadata.audio.duration_seconds > 0
          ? metadata.audio.duration_seconds
          : audioDuration && audioDuration > 0
            ? audioDuration
            : null;
      const clampedAudio = Math.max(0, Math.min(desiredAudio, audioCap ?? desiredAudio));
      const duration =
        (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : videoDuration) ?? null;
      const videoTime = mapTimelineToVideo(timelineSeconds, duration, metadata);
      if (Number.isFinite(videoTime)) {
        try {
          video.currentTime = videoTime;
        } catch {
          /* ignore */
        }
      }
      try {
        audio.currentTime = clampedAudio;
      } catch {
        /* ignore */
      }
      setCurrentTime(Math.max(0, desiredAudio));
      if (autoplay) {
        video
          .play()
          .then(() => {
            /* noop */
          })
          .catch(() => {
            /* ignore */
          });
      }
    },
    [audioDuration, combinedOffset, metadata, videoDuration],
  );

  const handleTimelineSliderChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const rawValue = Number(event.target.value);
    if (!Number.isFinite(rawValue)) {
      return;
    }
    const video = videoRef.current;
    const shouldAutoplay = !!video && !video.paused;
    seekToMediaTime(rawValue, shouldAutoplay);
    setControlsVisible(true);
    if (shouldAutoplay) {
      queueHideControls();
    } else {
      clearHideControlsTimeout();
    }
  };

  const handleTogglePlayback = () => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    setControlsVisible(true);
    if (video.paused) {
      video
        .play()
        .then(() => {
          /* noop */
        })
        .catch(() => {
          /* ignore */
        });
    } else {
      video.pause();
    }
  };

  const handleRestart = () => {
    setControlsVisible(true);
    clearHideControlsTimeout();
    seekToMediaTime(0, true);
  };

  const handlePlayerPointerMove = () => {
    setControlsVisible(true);
    queueHideControls();
  };

  const handlePlayerPointerLeave = () => {
    if (!isPlaying) {
      return;
    }
    clearHideControlsTimeout();
    setControlsVisible(false);
  };

  const handleVideoError = useCallback(() => {
    setVideoLoadError(
      `Video stream failed to load. Ensure the FastAPI server at ${serverHint} is running and the path is accessible.`,
    );
  }, [serverHint]);

  const handleAudioError = useCallback(() => {
    setAudioLoadError(
      `Audio stream failed to load. Ensure the FastAPI server at ${serverHint} is running and the path is accessible.`,
    );
  }, [serverHint]);

  const fetchTranscript = useCallback(async () => {
    if (!audioPath.trim()) {
      setSegments([]);
      setTranscriptError(null);
      return;
    }
    setLoadingTranscript(true);
    setTranscriptError(null);
    try {
      const res = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audioPath }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `Transcription failed (status ${res.status})`);
      }
      const data = await res.json();
      setSegments(Array.isArray(data?.segments) ? data.segments : []);
    } catch (err) {
      setSegments([]);
      if (err instanceof TypeError && err.message && err.message.toLowerCase().includes("fetch")) {
        setTranscriptError("Failed to reach transcription API. Restart the Next.js dev server and try again.");
      } else {
        setTranscriptError(err instanceof Error ? err.message : "Failed to load transcript");
      }
    } finally {
      setLoadingTranscript(false);
    }
  }, [audioPath]);

  const fetchMetadata = useCallback(
    async (video: string, audio: string) => {
      const trimmedVideo = video.trim();
      const trimmedAudio = audio.trim();
      if (!trimmedVideo || !trimmedAudio) {
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
          body: JSON.stringify({ videoPath: trimmedVideo, audioPath: trimmedAudio }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(payload.error || `Metadata request failed (status ${res.status})`);
        }
        const data: Metadata = await res.json();
        setMetadata(data);
      } catch (err) {
        setMetadata(null);
        setMetadataError(err instanceof Error ? err.message : "Failed to load playback metadata");
      } finally {
        setLoadingMetadata(false);
      }
    },
    []
  );

  useEffect(() => {
    fetchTranscript();
  }, [fetchTranscript]);

  useEffect(() => {
    fetchMetadata(videoPath, audioPath);
  }, [videoPath, audioPath, fetchMetadata]);

  useEffect(() => {
    lastSyncedRef.current = 0;
    setCurrentTime(0);
  }, [videoPath, audioPath]);

  useEffect(() => {
    setVideoDuration(null);
  }, [videoPath]);

  useEffect(() => {
    setAudioDuration(null);
  }, [audioPath]);

  useEffect(() => {
    setVideoLoadError(null);
  }, [videoUrl]);

  useEffect(() => {
    setFrameOverlayOpen(false);
    setPreviewOpen(false);
    setSelectedFrameId(null);
  }, [videoUrl]);

  useEffect(() => {
    setAudioLoadError(null);
  }, [audioUrl]);

  useEffect(() => {
    const decoder = decoderRef.current;
    if (!decoder) {
      return;
    }

    const resetDecoderState = (clearThumbnails: boolean) => {
      queueProcessingRef.current = false;
      const pendingQueue = queueRef.current.splice(0);
      pendingQueue.forEach((request) => {
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
      const previousPromises = framePromisesRef.current;
      framePromisesRef.current = new Map();
      previousPromises.clear();
      setDecoderError(null);
      if (clearThumbnails) {
        frameThumbsRef.current = {};
        canvasRef.current = null;
        forceFrameUpdate((value) => (value + 1) % 1000000);
      }
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
      while (queueRef.current.length) {
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
      return () => {
        decoder.removeEventListener("loadedmetadata", handleLoadedMetadata);
        decoder.removeEventListener("error", handleError);
      };
    }

    const isNewSource = currentSrc !== videoUrl;
    resetDecoderState(isNewSource);
    decoder.setAttribute("data-current-src", videoUrl);
    decoder.src = videoUrl;
    decoder.load();

    return () => {
      decoder.removeEventListener("loadedmetadata", handleLoadedMetadata);
      decoder.removeEventListener("error", handleError);
    };
  }, [videoUrl, processQueue, serverHint, forceFrameUpdate]);

  useEffect(() => {
    if (!frameOverlayOpen || previewOpen) {
      return;
    }
    const warmup = displayFrames.slice(0, 24);
    warmup.forEach((frame) => {
      requestFrameThumbnail(frame.offset_index, computeVideoSecondsFromFrame(frame)).catch(() => {
        /* allow individual warmup failures */
      });
    });
  }, [frameOverlayOpen, previewOpen, displayFrames, requestFrameThumbnail, computeVideoSecondsFromFrame]);

  useEffect(() => {
    if (!frameOverlayOpen) {
      setPreviewOpen(false);
    }
  }, [frameOverlayOpen]);

  useEffect(() => {
    if (!frameOverlayOpen || previewOpen) {
      return;
    }
    const closest = findClosestFrame();
    if (!closest) {
      setSelectedFrameId(null);
      return;
    }
    setSelectedFrameId((prev) => (prev === closest.offset_index ? prev : closest.offset_index));
  }, [frameOverlayOpen, previewOpen, findClosestFrame]);

  useEffect(() => {
    if (!selectedFrame) {
      return;
    }
    if (!(frameOverlayOpen || previewOpen)) {
      return;
    }
    const frameId = selectedFrame.offset_index;
    if (frameThumbsRef.current[frameId]) {
      return;
    }
    requestFrameThumbnail(frameId, computeVideoSecondsFromFrame(selectedFrame)).catch(() => {
      /* thumbnail request errors surface on card */
    });
  }, [selectedFrame, frameOverlayOpen, previewOpen, requestFrameThumbnail, computeVideoSecondsFromFrame]);

  useEffect(() => {
    if (!frameOverlayOpen) {
      return;
    }
    if (selectedFrameId == null) {
      return;
    }
    const raf = window.requestAnimationFrame(() => {
      const element = document.querySelector<HTMLElement>(`[data-frame-card="${selectedFrameId}"]`);
      if (element) {
        element.scrollIntoView({ block: "center", inline: "center" });
      }
    });
    return () => {
      window.cancelAnimationFrame(raf);
    };
  }, [frameOverlayOpen, selectedFrameId, frameSamplingMode, layoutMode, displayFrames]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const updateDuration = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        setVideoDuration(video.duration);
      }
    };
    video.addEventListener("loadedmetadata", updateDuration);
    video.addEventListener("durationchange", updateDuration);
    updateDuration();
    return () => {
      video.removeEventListener("loadedmetadata", updateDuration);
      video.removeEventListener("durationchange", updateDuration);
    };
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const updateDuration = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setAudioDuration(audio.duration);
      }
    };
    audio.addEventListener("loadedmetadata", updateDuration);
    audio.addEventListener("durationchange", updateDuration);
    updateDuration();
    return () => {
      audio.removeEventListener("loadedmetadata", updateDuration);
      audio.removeEventListener("durationchange", updateDuration);
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    if (timelineDuration && videoDuration && videoDuration > 0) {
      const rate = videoDuration / timelineDuration;
      video.playbackRate = rate > 0 ? rate : 1;
    } else {
      video.playbackRate = 1;
    }
  }, [timelineDuration, videoDuration]);

  useEffect(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video || !audio) {
      return;
    }

    const computeTargetAudioTime = () => {
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : videoDuration;
      const timelineTime = mapVideoTimeToTimeline(video.currentTime, duration, metadata);
      const target = Math.max(0, timelineTime + combinedOffset);
      return Number.isFinite(target) ? target : 0;
    };

    const handlePlay = () => {
      if (timelineDuration && videoDuration && videoDuration > 0) {
        const rate = videoDuration / timelineDuration;
        video.playbackRate = rate > 0 ? rate : 1;
      }
      setIsPlaying(true);
      audio.muted = false;
      audio.playbackRate = 1;
      const nextTime = computeTargetAudioTime();
      try {
        audio.currentTime = nextTime;
      } catch {
        /* ignore */
      }
      audio.play().catch(() => {
        /* ignore */
      });
    };

    const handlePause = () => {
      audio.pause();
      setIsPlaying(false);
      clearHideControlsTimeout();
      setControlsVisible(true);
    };

    const handleSeeking = () => {
      const nextTime = computeTargetAudioTime();
      try {
        audio.currentTime = nextTime;
      } catch {
        /* ignore */
      }
    };

    const handleSeeked = () => {
      const nextTime = computeTargetAudioTime();
      try {
        audio.currentTime = nextTime;
      } catch {
        /* ignore */
      }
    };

    video.addEventListener("play", handlePlay);
    video.addEventListener("pause", handlePause);
    video.addEventListener("seeking", handleSeeking);
    video.addEventListener("seeked", handleSeeked);
    handleSeeked();

    return () => {
      video.removeEventListener("play", handlePlay);
      video.removeEventListener("pause", handlePause);
      video.removeEventListener("seeking", handleSeeking);
      video.removeEventListener("seeked", handleSeeked);
    };
  }, [metadata, combinedOffset, videoDuration, timelineDuration, clearHideControlsTimeout]);

  useEffect(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video || !audio) {
      return;
    }

    const syncFromAudio = () => {
      const audioTime = Math.max(0, audio.currentTime);
      const audioCap =
        metadata?.audio.duration_seconds && metadata.audio.duration_seconds > 0
          ? metadata.audio.duration_seconds
          : audioDuration && audioDuration > 0
            ? audioDuration
            : null;
      const requestedAudio = lastRequestedAudioRef.current;
      const clampedLow = requestedAudio < 0 && audioTime <= 0.01;
      const clampedHigh =
        audioCap != null && requestedAudio > audioCap && Math.abs(audioTime - audioCap) <= 0.01;
      let timelineSeconds = Math.max(0, audio.currentTime - combinedOffset);
      if (clampedLow || clampedHigh) {
        timelineSeconds = lastTimelineRef.current;
      } else {
        lastTimelineRef.current = timelineSeconds;
      }
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : videoDuration;
      if (metadata && duration && duration > 0) {
        const desiredVideo = mapTimelineToVideo(timelineSeconds, duration, metadata);
        if (Number.isFinite(desiredVideo) && Math.abs(video.currentTime - desiredVideo) > 0.15) {
          try {
            video.currentTime = desiredVideo;
          } catch {
            /* ignore */
          }
        }
      }
      if (Math.abs(audioTime - lastSyncedRef.current) > 0.03) {
        lastSyncedRef.current = audioTime;
        setCurrentTime(audioTime);
      }
    };

    syncFromAudio();

    audio.addEventListener("timeupdate", syncFromAudio);
    audio.addEventListener("seeking", syncFromAudio);
    audio.addEventListener("seeked", syncFromAudio);
    audio.addEventListener("play", syncFromAudio);
    audio.addEventListener("loadedmetadata", syncFromAudio);

    return () => {
      audio.removeEventListener("timeupdate", syncFromAudio);
      audio.removeEventListener("seeking", syncFromAudio);
      audio.removeEventListener("seeked", syncFromAudio);
      audio.removeEventListener("play", syncFromAudio);
      audio.removeEventListener("loadedmetadata", syncFromAudio);
    };
  }, [metadata, combinedOffset, videoDuration, audioDuration]);

  const seekToFrame = useCallback(
    (frame: FrameEntry, options?: { autoplay?: boolean }) => {
      setSelectedFrameId(frame.offset_index);
      const video = videoRef.current;
      const resolvedDuration =
        (video && Number.isFinite(video.duration) && video.duration > 0 ? video.duration : videoDuration) ?? null;
      const videoSeconds = computeVideoSecondsFromFrame(frame);
      let timelineSeconds = frame.seconds_from_video_start;
      if (resolvedDuration && metadata) {
        const mapped = mapVideoTimeToTimeline(videoSeconds, resolvedDuration, metadata);
        if (Number.isFinite(mapped)) {
          timelineSeconds = mapped;
        }
      }
      const audioSeconds = timelineSeconds + combinedOffset;
      seekToMediaTime(audioSeconds, Boolean(options?.autoplay));
    },
    [combinedOffset, computeVideoSecondsFromFrame, metadata, seekToMediaTime, videoDuration],
  );

  const openFramePreview = useCallback(
    (frame: FrameEntry) => {
      setSelectedFrameId(frame.offset_index);
      setPreviewOpen(true);
      const videoSeconds = computeVideoSecondsFromFrame(frame);
      requestFrameThumbnail(frame.offset_index, videoSeconds).catch(() => {
        /* individual decode errors surface on card */
      });
    },
    [computeVideoSecondsFromFrame, requestFrameThumbnail],
  );

  const closeFramePreview = useCallback(() => {
    setPreviewOpen(false);
  }, []);

  const handleSeekAndPlayFrame = useCallback(
    (frame: FrameEntry) => {
      seekToFrame(frame, { autoplay: true });
      setPreviewOpen(false);
      setFrameOverlayOpen(false);
    },
    [seekToFrame],
  );

  const navigateToPrevFrame = useCallback(() => {
    if (!selectedFrame) {
      return;
    }
    const currentIndex = displayFrames.findIndex((frame) => frame.offset_index === selectedFrame.offset_index);
    if (currentIndex > 0) {
      const prevFrame = displayFrames[currentIndex - 1];
      openFramePreview(prevFrame);
    }
  }, [selectedFrame, displayFrames, openFramePreview]);

  const navigateToNextFrame = useCallback(() => {
    if (!selectedFrame) {
      return;
    }
    const currentIndex = displayFrames.findIndex((frame) => frame.offset_index === selectedFrame.offset_index);
    if (currentIndex < displayFrames.length - 1) {
      const nextFrame = displayFrames[currentIndex + 1];
      openFramePreview(nextFrame);
    }
  }, [selectedFrame, displayFrames, openFramePreview]);

  const activeSegment = useMemo(() => {
    return segments.find((seg) => currentTime >= seg.start && currentTime < seg.end) || null;
  }, [segments, currentTime]);

  const handleSeekToSegment = (segment: Segment) => {
    seekToMediaTime(Math.max(0, segment.start), true);
    setControlsVisible(true);
  };

  const handleFormSubmit = (evt: React.FormEvent<HTMLFormElement>) => {
    evt.preventDefault();
    setVideoPath(videoInput.trim());
    setAudioPath(audioInput.trim());
  };

  return (
    <main style={{ display: "grid", gap: 24, padding: 24 }}>
      <header>
        <h1>Video + Audio + Transcript (Web Playback)</h1>
        <p style={{ color: "#607080" }}>
          Loads original Screenpipe chunks directly in the browser and aligns audio using frame timestamps from the database
          (no ffmpeg merge). Useful for testing quick playback and sync accuracy.
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

      <section style={{ display: "grid", gap: 16 }}>
        <div
          style={{ position: "relative", background: "#111", minHeight: 320, borderRadius: 12, overflow: "hidden" }}
          onMouseMove={handlePlayerPointerMove}
          onMouseLeave={handlePlayerPointerLeave}
          onTouchStart={handlePlayerPointerMove}
          onFocusCapture={handlePlayerPointerMove}
        >
          {videoUrl ? (
            <>
              <video
                ref={videoRef}
                src={videoUrl}
                style={{ width: "100%", height: "100%", objectFit: "contain", background: "#0f172a" }}
                preload="metadata"
                onClick={handleTogglePlayback}
                onError={handleVideoError}
                onLoadedData={() => setVideoLoadError(null)}
                playsInline
              />
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: 0,
                  padding: "16px 20px",
                  background: "linear-gradient(180deg, rgba(15,23,42,0) 0%, rgba(15,23,42,0.85) 100%)",
                  display: controlsVisible ? "grid" : "none",
                  gap: 12,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <button
                    type="button"
                    onClick={handleTogglePlayback}
                    aria-label={isPlaying ? "Pause" : "Play"}
                    title={isPlaying ? "Pause" : "Play"}
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: "50%",
                      border: "none",
                      background: "rgba(15, 23, 42, 0.75)",
                      color: "#f8fafc",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      cursor: "pointer",
                    }}
                  >
                    {isPlaying ? <PauseIcon /> : <PlayIcon />}
                  </button>
                  <button
                    type="button"
                    onClick={handleRestart}
                    aria-label="Restart"
                    title="Restart"
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: "50%",
                      border: "none",
                      background: "rgba(15, 23, 42, 0.55)",
                      color: "#f8fafc",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      cursor: "pointer",
                    }}
                  >
                    <RestartIcon />
                </button>
                <span style={{ color: "#e2e8f0", fontVariantNumeric: "tabular-nums" }}>
                  {formattedCurrentTime} / {formattedTotalTime}
                </span>
                <button
                  type="button"
                  onClick={handleOpenFrameOverlay}
                  aria-label="Open frame carousel"
                  title={canOpenCarousel ? "Open frame carousel" : "Frame metadata not yet available"}
                  disabled={!canOpenCarousel}
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: "50%",
                    border: "none",
                    background: canOpenCarousel ? "rgba(30, 64, 175, 0.75)" : "rgba(15, 23, 42, 0.35)",
                    color: canOpenCarousel ? "#f8fafc" : "#475569",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: canOpenCarousel ? "pointer" : "not-allowed",
                    marginLeft: "auto",
                    transition: "background 0.2s ease",
                  }}
                >
                  <FrameCarouselIcon color={canOpenCarousel ? "#f8fafc" : "#475569"} />
                </button>
              </div>
              <input
                type="range"
                min={0}
                max={sliderMax}
                  step={0.05}
                  value={clampedCurrentTime}
                  onChange={handleTimelineSliderChange}
                  style={{ width: "100%" }}
                  disabled={sliderMax <= 0.05}
                />
              </div>
            </>
          ) : (
            <div style={{ padding: 40, color: "#eee" }}>
              Enter an absolute or project-relative video path to start playback.
            </div>
          )}
          <audio
            ref={audioRef}
            src={audioUrl || undefined}
            preload="metadata"
            onError={handleAudioError}
            onLoadedData={() => setAudioLoadError(null)}
          />
        </div>
        {(videoLoadError || audioLoadError) && (
          <div style={{ color: "#fca5a5", marginTop: 8 }}>
            {videoLoadError}
            {videoLoadError && audioLoadError ? " " : ""}
            {audioLoadError}
          </div>
        )}

        <div style={{ display: "grid", gap: 8, background: "#0f172a", color: "#f8fafc", padding: 16, borderRadius: 8 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
            <strong>Alignment:</strong>
            {loadingMetadata && <span style={{ color: "#94a3b8" }}>Loading metadata...</span>}
            {metadataError && <span style={{ color: "#fca5a5" }}>{metadataError}</span>}
            {metadata && (
              <>
                <span>audioOffset = {formatOffset(metadata.alignment.audio_offset_seconds)}</span>
                <span>lead = {metadata.alignment.audio_lead_seconds.toFixed(2)}s</span>
                <span>delay = {metadata.alignment.audio_delay_seconds.toFixed(2)}s</span>
                <span>timelineScale = {displayScale.toFixed(3)}×</span>
                <span>frames = {metadata.video.frame_count}</span>
                <span>manual = {manualOffset.toFixed(2)}s</span>
              </>
            )}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span>Manual audio offset (s)</span>
              <input
                type="number"
                value={manualOffset}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  setManualOffset(Number.isFinite(next) ? next : 0);
                }}
                step={0.05}
                min={-5}
                max={5}
                style={{ width: 90, padding: "4px 6px" }}
              />
            </label>
            <button type="button" onClick={() => setManualOffset(0)} style={{ padding: "4px 10px" }}>
              Reset Offset
            </button>
          </div>
          <div>
            <strong>Current transcript:</strong>
            <div style={{ marginTop: 8, minHeight: 40 }}>
              {activeSegment ? activeSegment.text : loadingTranscript ? "Transcribing..." : "--"}
            </div>
          </div>
        </div>
      </section>

      <section style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h2 style={{ margin: 0 }}>Transcript segments</h2>
          {loadingTranscript && <span style={{ color: "#64748b" }}>Loading transcript...</span>}
          {transcriptError && <span style={{ color: "#b54747" }}>{transcriptError}</span>}
        </div>
        <div style={{ maxHeight: 320, overflowY: "auto", border: "1px solid #1e293b", borderRadius: 8 }}>
          {segments.length === 0 && !loadingTranscript ? (
            <div style={{ padding: 16, color: "#94a3b8" }}>No transcript segments available.</div>
          ) : (
            segments.map((segment) => {
              const isActive = activeSegment?.id === segment.id;
              return (
                <button
                  key={segment.id}
                  onClick={() => handleSeekToSegment(segment)}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "80px 1fr",
                    gap: 12,
                    width: "100%",
                    textAlign: "left",
                    padding: "10px 14px",
                    background: isActive ? "#1d4ed8" : "transparent",
                    color: isActive ? "#ffffff" : "#e2e8f0",
                    border: "none",
                    borderBottom: "1px solid #1e293b",
                    cursor: "pointer",
                  }}
                >
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>
                    {formatTime(segment.start)} - {formatTime(segment.end)}
                  </span>
                  <span>{segment.text}</span>
                </button>
              );
            })
          )}
        </div>
      </section>

      {frameOverlayOpen && (
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
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <div>
              <h2 style={{ margin: 0 }}>Frame carousel</h2>
              <p style={{ margin: 0, color: "#94a3b8" }}>
                Browse timeline thumbnails and pop open a detailed view without losing playback context.
              </p>
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
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 12,
              alignItems: "center",
            }}
          >
            <span style={{ color: "#94a3b8" }}>
              Showing {displayFrames.length.toLocaleString()} of {frames.length.toLocaleString()} frames
            </span>
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
                  background:
                    frameSamplingMode === "sampled" ? "rgba(56, 189, 248, 0.15)" : "rgba(15, 23, 42, 0.6)",
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
                  background: frameSamplingMode === "all" ? "rgba(56, 189, 248, 0.15)" : "rgba(15, 23, 42, 0.6)",
                  color: "#f8fafc",
                  cursor: "pointer",
                }}
              >
                All frames
              </button>
              <span style={{ color: "#64748b", fontSize: 12 }}>(~{SAMPLE_FRAME_GAP_LABEL})</span>
            </div>
            <span style={{ color: "#334155" }}>||</span>
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
                  background: layoutMode === "grid" ? "rgba(56, 189, 248, 0.2)" : "rgba(15, 23, 42, 0.6)",
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
                  background: layoutMode === "list" ? "rgba(56, 189, 248, 0.2)" : "rgba(15, 23, 42, 0.6)",
                  color: "#f8fafc",
                  cursor: "pointer",
                }}
              >
                List
              </button>
            </div>
            <span style={{ color: "#334155" }}>||</span>
            {decoderError && <span style={{ color: "#fca5a5" }}>{decoderError}</span>}
          </div>
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              paddingRight: 12,
            }}
          >
            {displayFrames.length === 0 ? (
              <div style={{ color: "#94a3b8" }}>No frames available for decoding.</div>
            ) : layoutMode === "grid" ? (
              <div
                style={{
                  display: "grid",
                  gap: 12,
                  gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
                }}
              >
                {displayFrames.map((frame) => {
                  const videoSeconds = computeVideoSecondsFromFrame(frame);
                  return (
                    <FrameThumbnailCard
                      key={frame.offset_index}
                      frame={frame}
                      thumbnail={frameThumbnails[frame.offset_index]}
                      videoSeconds={videoSeconds}
                      isActive={Math.abs(activeTimeline - frame.seconds_from_video_start) < 0.2}
                      isSelected={selectedFrameId === frame.offset_index}
                      requestThumbnail={requestFrameThumbnail}
                      onSelect={openFramePreview}
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
                  return (
                    <FrameThumbnailCard
                      key={frame.offset_index}
                      frame={frame}
                      thumbnail={frameThumbnails[frame.offset_index]}
                      videoSeconds={videoSeconds}
                      isActive={Math.abs(activeTimeline - frame.seconds_from_video_start) < 0.2}
                      isSelected={selectedFrameId === frame.offset_index}
                      requestThumbnail={requestFrameThumbnail}
                      onSelect={openFramePreview}
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
          onSeekAndPlay={() => {
            if (selectedFrame) {
              handleSeekAndPlayFrame(selectedFrame);
            }
          }}
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


