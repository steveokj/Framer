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

// const DEFAULT_VIDEO = "C:\\Users\\steve\\.screenpipe\\data\\monitor_52305895_2025-10-12_02-13-01.mp4";
// const DEFAULT_AUDIO = "C:\\Users\\steve\\Desktop\\Whisper\\sessions\\session-20251011-221322.wav";

const DEFAULT_VIDEO = "C:\\Users\\steve\\.screenpipe\\data\\monitor_52305895_2025-10-12_02-13-01.mp4";
const DEFAULT_AUDIO = "C:\\Users\\steve\\Desktop\\Whisper\\sessions\\session-20251011-221322.wav";


const API_BASE = (
  process.env.NEXT_PUBLIC_API_BASE && process.env.NEXT_PUBLIC_API_BASE.trim().length > 0
    ? process.env.NEXT_PUBLIC_API_BASE
    : "http://localhost:8000"
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

export default function VideoFrame2Page() {
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
  const [audioTime, setAudioTime] = useState(0);
  const [audioPending, setAudioPending] = useState(false);
  const [, forceFrameUpdate] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const lastTimelineRef = useRef(0);
  const lastSyncedRef = useRef(0);
  const hideControlsTimeoutRef = useRef<number | null>(null);
  const decoderRef = useRef<HTMLVideoElement>(null);
  const decoderReadyRef = useRef(false);
  const decoderReadyResolversRef = useRef<Array<{ resolve: () => void; reject: (reason?: unknown) => void }>>([]);
  const queueRef = useRef<FrameRequest[]>([]);
  const queueProcessingRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const framePromisesRef = useRef<Map<number, Promise<string>>>(new Map());
  const frameThumbsRef = useRef<Record<number, string>>({});
  const pendingAudioPlayRef = useRef(false);
  const shouldPlayAudioRef = useRef(false);

  const { url: videoUrl, warning: videoWarning } = useMemo(() => buildFileUrl(videoPath), [videoPath]);
  const { url: audioUrl, warning: audioWarning } = useMemo(() => buildFileUrl(audioPath), [audioPath]);

  const audioOffset = metadata?.alignment.audio_offset_seconds ?? 0;
  const combinedOffset = audioOffset + manualOffset;
  const serverHint = API_BASE || "http://localhost:8000";
  const timelineDuration = useMemo(() => getTimelineDuration(metadata), [metadata]);
  const displayScale = useMemo(() => {
    if (!timelineDuration || videoDuration == null || !(videoDuration > 0)) {
      return 1;
    }
    return timelineDuration / videoDuration;
  }, [timelineDuration, videoDuration]);


  // ========== NEW/MODIFIED UTILITY FUNCTIONS ==========

  // Deduplicates frames that have identical timestamps
  // This memoized function processes metadata frames to remove duplicates
  const frames = useMemo(() => {
    const all = metadata?.frames ?? []; // Get all frames from metadata
    if (all.length <= 1) {
      return all; // No deduplication needed for 0 or 1 frames
    }
    const deduped: FrameEntry[] = [];
    let lastTimestamp: string | null = null;

    // Iterate through frames, only keeping ones with unique timestamps
    for (const frame of all) {
      if (frame.timestamp === lastTimestamp) {
        continue; // Skip frames with duplicate timestamps
      }
      deduped.push(frame);
      lastTimestamp = frame.timestamp;
    }
    return deduped;
  }, [metadata]);

  // Define the sampling interval for frame carousel display
  const SAMPLE_FRAME_GAP_SECONDS = 1.0; // Show one frame per second when in "sampled" mode

  // Generate human-readable label for the sampling rate
  const SAMPLE_FRAME_GAP_LABEL =
    SAMPLE_FRAME_GAP_SECONDS >= 1
      ? `${Number.isInteger(SAMPLE_FRAME_GAP_SECONDS) ? SAMPLE_FRAME_GAP_SECONDS.toFixed(0) : SAMPLE_FRAME_GAP_SECONDS.toFixed(1)} second${SAMPLE_FRAME_GAP_SECONDS === 1 ? "" : "s"}`
      : `${Math.round(SAMPLE_FRAME_GAP_SECONDS * 1000)} ms`; // Show in milliseconds if < 1 second

  // ========== COMPUTE VIDEO TIME FROM FRAME ==========
  // Calculates the actual video playback time for a given frame
  // This accounts for the fact that frame indices don't directly map to video time
  const computeVideoSecondsFromFrame = useCallback(
    (frame: FrameEntry) => {
      // If we have valid video duration and frame count, use proportional mapping
      if (videoDuration && videoDuration > 0 && metadata?.video.frame_count && metadata.video.frame_count > 1) {
        const frameCount = metadata.video.frame_count;
        const denom = Math.max(frameCount - 1, 1); // Avoid division by zero

        // Calculate ratio: where is this frame in the sequence? (0.0 to 1.0)
        const ratio = frame.offset_index / denom;
        const clampedRatio = Math.min(Math.max(ratio, 0), 1); // Ensure 0-1 range

        // Map ratio to video duration
        return clampedRatio * videoDuration;
      }

      // Fallback: use frame's timeline position directly
      const seconds = frame.seconds_from_video_start;
      return Number.isFinite(seconds) ? Math.max(seconds, 0) : 0;
    },
    [metadata, videoDuration],
  );

  // ========== FILTER FRAMES FOR DISPLAY ==========
  // Creates a sampled subset of frames for performance in carousel view
  const displayFrames = useMemo(() => {
    if (!frames.length) {
      return []; // No frames to display
    }

    if (frameSamplingMode === "all") {
      return frames; // Show all frames without sampling
    }

    // Sample frames at regular intervals
    const sampled: FrameEntry[] = [];
    let lastTime = -Infinity; // Initialize to very negative number

    for (const frame of frames) {
      // Include frame if enough time has passed since last sampled frame
      if (frame.seconds_from_video_start - lastTime >= SAMPLE_FRAME_GAP_SECONDS) {
        sampled.push(frame);
        lastTime = frame.seconds_from_video_start;
      }
    }

    return sampled;
  }, [frames, frameSamplingMode]);

  // ========== GET SELECTED FRAME OBJECT ==========
  // Finds the full frame object matching the selected frame ID
  const selectedFrame = useMemo(() => {
    if (selectedFrameId == null) {
      return null; // No frame selected
    }
    // Find frame in display list by offset_index
    return displayFrames.find((frame) => frame.offset_index === selectedFrameId) ?? null;
  }, [displayFrames, selectedFrameId]);

  // ========== FIND CLOSEST FRAME TO CURRENT PLAYBACK ==========
  // Determines which frame is closest to the current timeline position
  const findClosestFrame = useCallback(() => {
    if (!frames.length) {
      return null; // No frames available
    }

    // Start with last known timeline position
    let targetTimeline = Number.isFinite(lastTimelineRef.current) ? lastTimelineRef.current : 0;

    const video = videoRef.current;
    const duration =
      video && Number.isFinite(video.duration) && video.duration > 0 ? video.duration : videoDuration;

    // Try to get more accurate timeline position from video element
    if (video && duration && metadata) {
      const mapped = mapVideoTimeToTimeline(video.currentTime, duration, metadata);
      if (Number.isFinite(mapped)) {
        targetTimeline = mapped; // Use mapped timeline position
      } else if (Number.isFinite(video.currentTime)) {
        targetTimeline = Math.max(0, video.currentTime); // Fallback to raw video time
      }
    } else if (!Number.isFinite(targetTimeline) || targetTimeline <= 0) {
      targetTimeline = Math.max(0, currentTime); // Last resort: use state
    }

    // Linear search for closest frame
    let closest = frames[0];
    let smallestDelta = Math.abs(closest.seconds_from_video_start - targetTimeline);

    for (let i = 1; i < frames.length; i += 1) {
      const candidate = frames[i];
      const delta = Math.abs(candidate.seconds_from_video_start - targetTimeline);

      if (delta < smallestDelta) {
        smallestDelta = delta;
        closest = candidate; // Found a closer frame
      }
    }

    return closest;
  }, [frames, combinedOffset, currentTime, metadata, videoDuration]);

  // ========== STORE FRAME THUMBNAIL ==========
  // Saves a decoded frame thumbnail and triggers UI update
  const storeFrameThumbnail = useCallback(
    (frameId: number, dataUrl: string) => {
      const existing = frameThumbsRef.current[frameId];
      if (existing === dataUrl) {
        return; // No change, skip update
      }

      // Create new object to trigger React's immutability detection
      frameThumbsRef.current = { ...frameThumbsRef.current, [frameId]: dataUrl };

      // Force component re-render to show new thumbnail
      // Using modulo to prevent infinite counter growth
      forceFrameUpdate((value) => (value + 1) % 1000000);
    },
    [forceFrameUpdate],
  );

  // ========== WAIT FOR DECODER READY ==========
  // Returns a promise that resolves when the decoder video element is ready
  const waitForDecoderReady = useCallback(() => {
    if (decoderReadyRef.current) {
      return Promise.resolve(); // Already ready
    }

    // Create promise that will be resolved by decoder's loadedmetadata event
    return new Promise<void>((resolve, reject) => {
      decoderReadyResolversRef.current.push({ resolve, reject });
    });
  }, []);

  // ========== GET CANVAS ELEMENT ==========
  // Lazily creates and returns a canvas for drawing video frames
  const getCanvas = useCallback(() => {
    if (!canvasRef.current) {
      canvasRef.current = document.createElement("canvas"); // Create once
    }
    return canvasRef.current;
  }, []);

  // ========== DECODE FRAME AT SPECIFIC TIME ==========
  // Core function: seeks decoder video to timestamp and captures frame as JPEG
  const decodeFrameAtTime = useCallback(
    async (seconds: number) => {
      const decoder = decoderRef.current;
      if (!decoder) {
        throw new Error("Decoder not initialised");
      }

      // Wait for decoder to be ready (metadata loaded)
      await waitForDecoderReady();
      if (!decoderReadyRef.current) {
        throw new Error("Decoder not ready");
      }

      // Calculate target seek time, clamped to valid range
      const duration = Number.isFinite(decoder.duration) && decoder.duration > 0 ? decoder.duration : null;
      const target = duration ? Math.min(Math.max(seconds, 0), Math.max(duration - 0.001, 0)) : Math.max(seconds, 0);

      if (!Number.isFinite(target)) {
        throw new Error("Invalid frame timestamp");
      }

      // Helper function to draw current frame to canvas and export
      const performDraw = async () => {
        // Wait for next animation frame to ensure video is painted
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });

        const canvas = getCanvas();
        const width = decoder.videoWidth || 0;
        const height = decoder.videoHeight || 0;

        if (!width || !height) {
          throw new Error("Video dimensions unavailable");
        }

        // Set canvas size to match video dimensions
        const renderWidth = width;
        const renderHeight = height;
        canvas.width = renderWidth;
        canvas.height = renderHeight;

        // Get 2D drawing context
        const context = canvas.getContext("2d");
        if (!context) {
          throw new Error("Unable to create canvas context");
        }

        // Draw current video frame onto canvas
        context.drawImage(decoder, 0, 0, renderWidth, renderHeight);

        // Export canvas to JPEG data URL
        try {
          return canvas.toDataURL("image/jpeg", 0.92); // 92% quality
        } catch (err) {
          // Check for CORS taint error
          throw new Error(
            err instanceof Error && err.message.toLowerCase().includes("tainted")
              ? "Browser blocked canvas export. Enable CORS on the video file endpoint."
              : err instanceof Error
                ? err.message
                : "Failed to serialise frame",
          );
        }
      };

      // If decoder is already at target time (within 10ms), just draw
      if (Math.abs(decoder.currentTime - target) <= 0.01) {
        return performDraw();
      }

      // Otherwise, seek to target time first
      await new Promise<void>((resolve, reject) => {
        const handleSeeked = () => {
          decoder.removeEventListener("seeked", handleSeeked);
          decoder.removeEventListener("error", handleError);
          resolve(); // Seek completed successfully
        };

        const handleError = () => {
          decoder.removeEventListener("seeked", handleSeeked);
          decoder.removeEventListener("error", handleError);
          reject(new Error("Decoder seek error"));
        };

        // Listen for seek completion or error
        decoder.addEventListener("seeked", handleSeeked);
        decoder.addEventListener("error", handleError);

        try {
          decoder.currentTime = target; // Initiate seek
        } catch (err) {
          // Seek threw synchronously
          decoder.removeEventListener("seeked", handleSeeked);
          decoder.removeEventListener("error", handleError);
          reject(err);
        }
      });

      // Seek complete, now draw the frame
      return performDraw();
    },
    [getCanvas, waitForDecoderReady],
  );

  // ========== PROCESS FRAME DECODE QUEUE ==========
  // Processes queued frame decode requests one at a time
  const processQueue = useCallback(() => {
    if (queueProcessingRef.current) {
      return; // Already processing
    }

    if (!decoderReadyRef.current) {
      return; // Decoder not ready yet
    }

    const decoder = decoderRef.current;
    if (!decoder) {
      return; // No decoder element
    }

    queueProcessingRef.current = true; // Mark as processing

    // Recursive function to process next item in queue
    const runNext = () => {
      const next = queueRef.current.shift(); // Get next request (FIFO)

      if (!next) {
        queueProcessingRef.current = false; // Queue empty
        return;
      }

      // Decode the frame
      decodeFrameAtTime(next.seconds)
        .then((dataUrl) => {
          next.resolve(dataUrl); // Fulfill promise with data URL
        })
        .catch((err) => {
          next.reject(err); // Propagate error to promise
        })
        .finally(() => {
          if (!decoderReadyRef.current) {
            queueProcessingRef.current = false; // Decoder became unavailable
            return;
          }

          // Continue processing if more items in queue
          if (queueRef.current.length > 0) {
            requestAnimationFrame(runNext); // Process next on next frame
          } else {
            queueProcessingRef.current = false; // Done
          }
        });
    };

    runNext(); // Start processing
  }, [decodeFrameAtTime]);

  // ========== REQUEST FRAME THUMBNAIL ==========
  // Public API to request a frame thumbnail (with caching and deduplication)
  const requestFrameThumbnail = useCallback(
    (frameId: number, seconds: number) => {
      // Check if already cached
      const cached = frameThumbsRef.current[frameId];
      if (cached) {
        return Promise.resolve(cached); // Return cached data URL immediately
      }

      // Check if request already in flight
      const existing = framePromisesRef.current.get(frameId);
      if (existing) {
        return existing; // Return existing promise (deduplication)
      }

      // Create new decode request
      const promise = new Promise<string>((resolve, reject) => {
        // Add to queue
        queueRef.current.push({
          id: frameId,
          seconds,
          resolve,
          reject,
        });
        processQueue(); // Kick off processing
      })
        .then((dataUrl) => {
          storeFrameThumbnail(frameId, dataUrl); // Cache result
          return dataUrl;
        })
        .finally(() => {
          framePromisesRef.current.delete(frameId); // Clean up promise cache
        });

      // Store promise so duplicate requests can share it
      framePromisesRef.current.set(frameId, promise);
      return promise;
    },
    [processQueue, storeFrameThumbnail],
  );

  // Get current thumbnail cache (causes re-render when updated)
  const frameThumbnails = frameThumbsRef.current;

  // ========== CALCULATE SELECTED FRAME INDEX ==========
  // Finds the array index of the currently selected frame
  const selectedFrameIndex = useMemo(() => {
    if (!selectedFrame) {
      return -1; // No selection
    }
    return displayFrames.findIndex((frame) => frame.offset_index === selectedFrame.offset_index);
  }, [displayFrames, selectedFrame]);

  // Check if there are adjacent frames for navigation
  const hasPrevFrame = selectedFrameIndex > 0;
  const hasNextFrame = selectedFrameIndex >= 0 && selectedFrameIndex < displayFrames.length - 1;

  // ========== CAN OPEN CAROUSEL CHECK ==========
  // Determines if frame carousel button should be enabled
  const canOpenCarousel = useMemo(() => {
    if (!videoUrl) {
      return false; // No video loaded
    }
    return displayFrames.length > 0; // Have frames to show
  }, [videoUrl, displayFrames]);

  // Get active timeline position for highlighting frames
  const activeTimeline = Number.isFinite(lastTimelineRef.current) ? lastTimelineRef.current : 0;

  // ========== OPEN FRAME OVERLAY ==========
  // Opens the frame carousel in full-screen mode
  const handleOpenFrameOverlay = useCallback(() => {
    setFrameSamplingMode(() => "all"); // Show all frames when opening

    // Auto-select frame closest to current position
    const nearest = findClosestFrame();
    if (nearest) {
      setSelectedFrameId(nearest.offset_index);
    }

    setFrameOverlayOpen(true);
  }, [findClosestFrame]);

  // ========== CLOSE FRAME OVERLAY ==========
  // Closes both the carousel and preview modal
  const handleCloseFrameOverlay = useCallback(() => {
    setFrameOverlayOpen(false);
    setPreviewOpen(false);
  }, []);

  // ========== CALCULATE EFFECTIVE DURATION ==========
  // Determines best duration source for timeline slider (priority order)
  const effectiveDuration = useMemo(() => {
    if (timelineDuration && timelineDuration > 0) {
      return timelineDuration; // Prefer timeline from metadata
    }
    if (videoDuration && videoDuration > 0) {
      return videoDuration; // Video duration
    }
    if (metadata?.audio.duration_seconds && metadata.audio.duration_seconds > 0) {
      return metadata.audio.duration_seconds; // Metadata audio duration
    }
    if (audioDuration && audioDuration > 0) {
      return audioDuration; // Loaded audio duration
    }
    return Math.max(currentTime, 0); // Current position as fallback
  }, [audioDuration, currentTime, metadata, timelineDuration, videoDuration]);

  // Calculate timeline values for slider
  const clampedCurrentTime = Math.min(Math.max(currentTime, 0), effectiveDuration || Math.max(currentTime, 0));
  const sliderMax = effectiveDuration > 0 ? effectiveDuration : Math.max(currentTime || 0, 1);
  const formattedCurrentTime = formatTime(clampedCurrentTime);
  const formattedTotalTime = formatTime(sliderMax > 0 ? sliderMax : Math.max(clampedCurrentTime, 0));

  // ========== PRE-AUDIO REGION DETECTION ==========
  // Calculate when audio actually starts on the timeline
  const audioStartTimeline = Math.max(0, -combinedOffset);

  // Check if current position is before audio starts
  const isPreAudioRegion = clampedCurrentTime + 0.005 < audioStartTimeline;

  // === HAD TO ADD - WAS MISSING FROM CLAUDE'S EXPLANATION ===

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

  // === HAD TO ADD - WAS MISSING FROM CLAUDE'S EXPLANATION ===

  // ========== SEEK TO TIMELINE POSITION (MODIFIED) ==========
  // Enhanced version that handles pre-audio region and separate audio/video control
  const seekToTimeline = useCallback(
    (targetTimelineSeconds: number, autoplay = false) => {
      const video = videoRef.current;
      if (!video) {
        return;
      }

      // Get video duration
      const duration =
        (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : videoDuration) ?? null;

      // Get timeline max value
      const timelineMax =
        timelineDuration && timelineDuration > 0 ? timelineDuration : duration && duration > 0 ? duration : null;

      // Clamp target to valid range
      const clampedTimeline =
        timelineMax && Number.isFinite(timelineMax)
          ? Math.min(Math.max(targetTimelineSeconds, 0), timelineMax)
          : Math.max(targetTimelineSeconds, 0);

      // Map timeline to video time and seek video
      const videoTime = mapTimelineToVideo(clampedTimeline, duration, metadata);
      if (Number.isFinite(videoTime)) {
        try {
          video.currentTime = Math.max(0, videoTime);
        } catch {
          /* ignore seek errors */
        }
      }

      // Update timeline state
      lastTimelineRef.current = clampedTimeline;
      setCurrentTime(clampedTimeline);

      // Determine if audio should be playing
      if (autoplay) {
        shouldPlayAudioRef.current = true;
        video
          .play()
          .then(() => {
            /* video playing */
          })
          .catch(() => {
            /* video play failed */
          });
      } else {
        shouldPlayAudioRef.current = !video.paused;
      }

      const audio = audioRef.current;
      if (!audio) {
        return;
      }

      // Get audio duration cap
      const audioCap =
        metadata?.audio.duration_seconds && metadata.audio.duration_seconds > 0
          ? metadata.audio.duration_seconds
          : audioDuration && audioDuration > 0
            ? audioDuration
            : null;

      // Calculate desired audio position
      const desiredAudio = clampedTimeline + combinedOffset;

      if (desiredAudio <= 0) {
        // In pre-audio region: pause audio at start
        pendingAudioPlayRef.current = shouldPlayAudioRef.current; // Remember we want to play
        setAudioPending(shouldPlayAudioRef.current);
        setAudioTime(0);

        try {
          audio.pause();
        } catch {
          /* ignore */
        }
        try {
          audio.currentTime = 0;
        } catch {
          /* ignore */
        }
      } else {
        // In audio region: seek and possibly play
        pendingAudioPlayRef.current = false;
        setAudioPending(false);

        const clampedAudio = Math.max(0, Math.min(desiredAudio, audioCap ?? desiredAudio));

        // Only seek if difference is significant (avoid stuttering)
        if (Math.abs(audio.currentTime - clampedAudio) > 0.12) {
          try {
            audio.currentTime = clampedAudio;
          } catch {
            /* ignore */
          }
        }

        // Start audio if needed
        if (shouldPlayAudioRef.current || autoplay) {
          audio
            .play()
            .then(() => {
              setAudioPending(false);
              setAudioTime(clampedAudio);
            })
            .catch(() => {
              setAudioPending(true); // Couldn't start audio
            });
        } else {
          setAudioTime(clampedAudio);
        }
      }
    },
    [audioDuration, combinedOffset, metadata, timelineDuration, videoDuration],
  );

  // === HAD TO ADD - WAS MISSING FROM CLAUDE'S EXPLANATION ===

  
  const handleTimelineSliderChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const rawValue = Number(event.target.value);
    if (!Number.isFinite(rawValue)) {
      return;
    }
    const video = videoRef.current;
    const shouldAutoplay = !!video && !video.paused;
    seekToTimeline(rawValue, shouldAutoplay);
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
      shouldPlayAudioRef.current = true;
      video
        .play()
        .then(() => {
          /* noop */
        })
        .catch(() => {
          /* ignore */
        });
    } else {
      shouldPlayAudioRef.current = false;
      video.pause();
    }
  };

  const handleRestart = () => {
    setControlsVisible(true);
    clearHideControlsTimeout();
    seekToTimeline(0, true);
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
    lastTimelineRef.current = 0;
    setCurrentTime(0);
    setAudioTime(0);
    setAudioPending(false);
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
    pendingAudioPlayRef.current = false;
    shouldPlayAudioRef.current = false;
  }, [audioUrl, videoUrl]);

  // === HAD TO ADD - WAS MISSING FROM CLAUDE'S EXPLANATION ===





  // ========== EFFECT: MANAGE DECODER VIDEO ELEMENT ==========
  // Complex effect that manages the hidden decoder video lifecycle
  useEffect(() => {
    const decoder = decoderRef.current;
    if (!decoder) {
      return;
    }

    // Helper to reset decoder state
    const resetDecoderState = (clearThumbnails: boolean) => {
      queueProcessingRef.current = false;

      // Reject all queued requests
      const pendingQueue = queueRef.current.splice(0);
      pendingQueue.forEach((request) => {
        try {
          request.reject(new Error("Frame decoding reset"));
        } catch {
          /* ignore */
        }
      });

      // Mark decoder as not ready
      decoderReadyRef.current = false;

      // Reject all waiting promises
      const resolvers = decoderReadyResolversRef.current.splice(0);
      resolvers.forEach(({ reject }) => {
        try {
          reject(new Error("Frame decoder reset"));
        } catch {
          /* ignore */
        }
      });

      // Clear promise cache
      const previousPromises = framePromisesRef.current;
      framePromisesRef.current = new Map();
      previousPromises.clear();

      setDecoderError(null);

      // Optionally clear thumbnail cache
      if (clearThumbnails) {
        frameThumbsRef.current = {};
        canvasRef.current = null;
        forceFrameUpdate((value) => (value + 1) % 1000000);
      }
    };

    // Configure decoder video element
    decoder.defaultMuted = true;
    decoder.muted = true;
    decoder.preload = "auto";
    decoder.playsInline = true;
    decoder.crossOrigin = "anonymous"; // Required for canvas export

    // Handler when metadata loads (decoder ready)
    const handleLoadedMetadata = () => {
      decoderReadyRef.current = true;

      // Resolve all waiting promises
      const resolvers = decoderReadyResolversRef.current.splice(0);
      resolvers.forEach(({ resolve }) => resolve());

      processQueue(); // Start processing queued requests
    };

    // Handler for decoder errors
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

      // Set user-friendly error message
      setDecoderError(
        `Frame decoder failed to load (mediaErr=${mediaErrorCode}, networkState=${networkState}). Ensure the FastAPI server at ${serverHint} is running and that it returns Access-Control-Allow-Origin headers.`,
      );

      // Mark as not ready and reject all promises
      decoderReadyRef.current = false;
      const resolvers = decoderReadyResolversRef.current.splice(0);
      resolvers.forEach(({ reject }) => {
        try {
          reject(new Error("Frame decoder unavailable"));
        } catch {
          /* ignore */
        }
      });

      // Clear queue
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

    // Track current source to detect changes
    const currentSrc = decoder.getAttribute("data-current-src");

    if (!videoUrl) {
      // No video: clear decoder
      resetDecoderState(true);
      decoder.removeAttribute("data-current-src");
      decoder.removeAttribute("src");
      decoder.load(); // Reset element

      return () => {
        decoder.removeEventListener("loadedmetadata", handleLoadedMetadata);
        decoder.removeEventListener("error", handleError);
      };
    }

    if (currentSrc === videoUrl && decoder.readyState >= 1) {
      // Same source already loaded
      decoderReadyRef.current = true;
      const resolvers = decoderReadyResolversRef.current.splice(0);
      resolvers.forEach(({ resolve }) => resolve());
      processQueue();

      return () => {
        decoder.removeEventListener("loadedmetadata", handleLoadedMetadata);
        decoder.removeEventListener("error", handleError);
      };
    }

    // New source: reload decoder
    const isNewSource = currentSrc !== videoUrl;
    resetDecoderState(isNewSource); // Clear thumbnails if source changed
    decoder.setAttribute("data-current-src", videoUrl);
    decoder.src = videoUrl;
    decoder.load(); // Start loading

    return () => {
      decoder.removeEventListener("loadedmetadata", handleLoadedMetadata);
      decoder.removeEventListener("error", handleError);
    };
  }, [videoUrl, processQueue, serverHint, forceFrameUpdate]);

  // ========== EFFECT: WARMUP THUMBNAIL DECODING ==========
  // Pre-decode first 24 frames when carousel opens for better UX
  useEffect(() => {
    if (!frameOverlayOpen || previewOpen) {
      return; // Don't warmup if overlay closed or preview open
    }

    const warmup = displayFrames.slice(0, 24); // First 24 frames
    warmup.forEach((frame) => {
      requestFrameThumbnail(frame.offset_index, computeVideoSecondsFromFrame(frame)).catch(() => {
        /* allow individual warmup failures */
      });
    });
  }, [frameOverlayOpen, previewOpen, displayFrames, requestFrameThumbnail, computeVideoSecondsFromFrame]);

  // ========== EFFECT: CLOSE PREVIEW WHEN OVERLAY CLOSES ==========
  useEffect(() => {
    if (!frameOverlayOpen) {
      setPreviewOpen(false); // Preview can't be open if carousel is closed
    }
  }, [frameOverlayOpen]);

  // ========== EFFECT: AUTO-SELECT CLOSEST FRAME ==========
  // Automatically select frame nearest to playback when carousel opens
  useEffect(() => {
    if (!frameOverlayOpen || previewOpen) {
      return; // Don't auto-select if preview is open
    }

    const closest = findClosestFrame();
    if (!closest) {
      setSelectedFrameId(null);
      return;
    }

    // Only update if different (avoid unnecessary re-renders)
    setSelectedFrameId((prev) => (prev === closest.offset_index ? prev : closest.offset_index));
  }, [frameOverlayOpen, previewOpen, findClosestFrame]);

  // ========== EFFECT: DECODE SELECTED FRAME THUMBNAIL ==========
  // Ensure selected frame's thumbnail is decoded
  useEffect(() => {
    if (!selectedFrame) {
      return; // No frame selected
    }
    if (!(frameOverlayOpen || previewOpen)) {
      return; // UI not visible, skip decode
    }

    const frameId = selectedFrame.offset_index;
    if (frameThumbsRef.current[frameId]) {
      return; // Already cached
    }

    // Request thumbnail decode
    requestFrameThumbnail(frameId, computeVideoSecondsFromFrame(selectedFrame)).catch(() => {
      /* thumbnail request errors surface on card */
    });
  }, [selectedFrame, frameOverlayOpen, previewOpen, requestFrameThumbnail, computeVideoSecondsFromFrame]);

  // ========== EFFECT: SCROLL SELECTED FRAME INTO VIEW ==========
  // Automatically scroll carousel to show selected frame
  useEffect(() => {
    if (!frameOverlayOpen) {
      return; // Carousel not open
    }
    if (selectedFrameId == null) {
      return; // No selection
    }

    // Use requestAnimationFrame to wait for DOM update
    const raf = window.requestAnimationFrame(() => {
      // Find the frame card element by data attribute
      const element = document.querySelector<HTMLElement>(`[data-frame-card="${selectedFrameId}"]`);
      if (element) {
        // Scroll so frame is centered in viewport
        element.scrollIntoView({ block: "center", inline: "center" });
      }
    });

    return () => {
      window.cancelAnimationFrame(raf); // Cleanup
    };
  }, [frameOverlayOpen, selectedFrameId, frameSamplingMode, layoutMode, displayFrames]);

  // === GOT FROM VIDEO_FRAME_N, WAS MISSING FROM CLAUDE'S VIDEO_FRAME_NEW, SO LIKELY THE FIX ===

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
  // === GOT FROM VIDEO_FRAME_N, WAS MISSING FROM VIDEO_FRAME_NEW ===

  // ========== EFFECT: SYNC FROM VIDEO (MODIFIED) ==========
  // Enhanced video sync that handles pre-audio region and separate audio control
  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    // Main sync function - called on video timeupdate
    const syncFromVideo = () => {
      console.log("syncing from video");
      const duration =
        (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : videoDuration) ?? null;

      // Map video time to timeline
      const timelineSeconds = mapVideoTimeToTimeline(video.currentTime, duration, metadata);
      if (!Number.isFinite(timelineSeconds)) {
        return; // Invalid timeline value
      }

      const audioNode = audioRef.current;
      if (!audioNode) {
        // No audio element, just update timeline
        lastTimelineRef.current = timelineSeconds;
        setCurrentTime(timelineSeconds);
        return;
      }

      // Get audio duration cap
      const audioCap =
        metadata?.audio.duration_seconds && metadata.audio.duration_seconds > 0
          ? metadata.audio.duration_seconds
          : audioDuration && audioDuration > 0
            ? audioDuration
            : null;

      // Calculate where audio should be
      const desiredAudio = timelineSeconds + combinedOffset;

      // Update timeline if audio shouldn't be playing
      if (!shouldPlayAudioRef.current || audioNode.paused) {
        lastTimelineRef.current = timelineSeconds;
        setCurrentTime(timelineSeconds);
      }

      if (desiredAudio <= 0) {
        // PRE-AUDIO REGION: Video is playing but audio hasn't started yet
        pendingAudioPlayRef.current = shouldPlayAudioRef.current; // Remember we want audio
        setAudioPending(shouldPlayAudioRef.current);
        setAudioTime(0);

        try {
          audioNode.pause(); // Keep audio paused
        } catch {
          /* ignore */
        }

        try {
          // Reset audio to start if it drifted
          if (Math.abs(audioNode.currentTime) > 0.01) {
            audioNode.currentTime = 0;
          }
        } catch {
          /* ignore */
        }
        return;
      }

      // AUDIO REGION: Audio should be playing
      const clampedAudio = Math.max(0, Math.min(desiredAudio, audioCap ?? desiredAudio));

      // If audio is paused but should be playing, start it
      if (audioNode.paused && shouldPlayAudioRef.current) {
        try {
          // Seek if needed
          if (Math.abs(audioNode.currentTime - clampedAudio) > 0.12) {
            audioNode.currentTime = clampedAudio;
          }
        } catch {
          /* ignore */
        }

        audioNode
          .play()
          .then(() => {
            pendingAudioPlayRef.current = false;
            setAudioPending(false);
          })
          .catch(() => {
            pendingAudioPlayRef.current = true;
            setAudioPending(true); // Audio play failed, stay pending
          });
      } else if (pendingAudioPlayRef.current && !audioNode.paused) {
        // Audio started playing, clear pending state
        pendingAudioPlayRef.current = false;
        setAudioPending(false);
      }

      // Update audio time display when paused
      if (audioNode.paused) {
        setAudioTime(clampedAudio);
      }
    };

    // Handler when video starts playing
    const handlePlay = () => {
      // Set video playback rate to stretch/compress to timeline duration
      if (timelineDuration && videoDuration && videoDuration > 0) {
        const rate = videoDuration / timelineDuration;
        video.playbackRate = rate > 0 ? rate : 1;
      } else {
        video.playbackRate = 1; // Normal speed
      }

      shouldPlayAudioRef.current = true;
      setIsPlaying(true);
      queueHideControls(); // Auto-hide controls after delay

      const audioNode = audioRef.current;
      if (audioNode) {
        audioNode.muted = false; // Unmute audio
        audioNode.playbackRate = 1; // Audio always plays at normal speed
      }

      syncFromVideo(); // Initial sync
    };

    // Handler when video pauses
    const handlePause = () => {
      shouldPlayAudioRef.current = false;
      setIsPlaying(false);
      clearHideControlsTimeout();
      setControlsVisible(true);
      setAudioPending(false);

      const audioNode = audioRef.current;
      if (audioNode) {
        try {
          audioNode.pause(); // Pause audio too
        } catch {
          /* ignore */
        }
      }
    };

    // Handler when user starts seeking
    const handleSeeking = () => {
      setControlsVisible(true);
      clearHideControlsTimeout();
      syncFromVideo(); // Sync during seek
    };

    // Handler when seek completes
    const handleSeeked = () => {
      syncFromVideo();
    };

    // Handler on time update
    const handleTimeUpdate = () => {
      console.log("time update");
      const audioNode = audioRef.current;
      // Only sync from video if audio isn't driving playback
      if (!audioNode || audioNode.paused || pendingAudioPlayRef.current) {
        syncFromVideo();
      }
    };

    // Handler when video data loads
    const handleLoadedData = () => {
      syncFromVideo();
    };

    // Register all event listeners
    video.addEventListener("play", handlePlay);
    video.addEventListener("pause", handlePause);
    video.addEventListener("seeking", handleSeeking);
    video.addEventListener("seeked", handleSeeked);
    video.addEventListener("timeupdate", handleTimeUpdate);
    video.addEventListener("loadeddata", handleLoadedData);

    return () => {
      // Cleanup listeners
      video.removeEventListener("play", handlePlay);
      video.removeEventListener("pause", handlePause);
      video.removeEventListener("seeking", handleSeeking);
      video.removeEventListener("seeked", handleSeeked);
      video.removeEventListener("timeupdate", handleTimeUpdate);
      video.removeEventListener("loadeddata", handleLoadedData);
    };
  }, [audioDuration, clearHideControlsTimeout, combinedOffset, metadata, queueHideControls, timelineDuration, videoDuration]);

  // ========== EFFECT: SYNC FROM AUDIO (NEW) ==========
  // Separate effect to handle audio-driven sync (when audio is playing)
  useEffect(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video || !audio) {
      return;
    }

    // Sync video position based on audio time
    const syncFromAudio = () => {
      const audioSeconds = Math.max(0, audio.currentTime);
      setAudioTime(audioSeconds); // Update audio time display

      if (audio.paused) {
        return; // Don't sync when audio is paused
      }

      // Don't update timeline if we're pending and audio hasn't started
      if (pendingAudioPlayRef.current && shouldPlayAudioRef.current && audioSeconds < 0.01) {
        return;
      }

      // Calculate timeline position from audio time
      const timelineSeconds = Math.max(0, audioSeconds - combinedOffset);
      lastTimelineRef.current = timelineSeconds;
      setCurrentTime(timelineSeconds);

      // Sync video to match audio-derived timeline position
      const duration =
        (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : videoDuration) ?? null;

      if (metadata && duration && duration > 0) {
        const desiredVideo = mapTimelineToVideo(timelineSeconds, duration, metadata);

        // Only seek video if drift is significant (>180ms)
        if (Number.isFinite(desiredVideo) && Math.abs(video.currentTime - desiredVideo) > 0.18) {
          try {
            console.log(video.playbackRate + " is this the rate?");
            console.log(desiredVideo + "has been changed");
            video.currentTime = desiredVideo;
          } catch {
            /* ignore */
          }
        }
      }
    };

    // Handler when audio starts playing
    const handleAudioPlay = () => {
      pendingAudioPlayRef.current = false;
      setAudioPending(false);
      syncFromAudio();
    };

    // Handler when audio pauses
    const handleAudioPause = () => {
      if (shouldPlayAudioRef.current) {
        // We want audio playing but it paused (maybe buffering)
        pendingAudioPlayRef.current = true;
        setAudioPending(true);
      }
    };

    syncFromAudio(); // Initial sync

    // Register audio event listeners
    audio.addEventListener("timeupdate", syncFromAudio);
    audio.addEventListener("seeking", syncFromAudio);
    audio.addEventListener("seeked", syncFromAudio);
    audio.addEventListener("play", handleAudioPlay);
    audio.addEventListener("pause", handleAudioPause);
    audio.addEventListener("loadedmetadata", syncFromAudio);

    return () => {
      // Cleanup listeners
      audio.removeEventListener("timeupdate", syncFromAudio);
      audio.removeEventListener("seeking", syncFromAudio);
      audio.removeEventListener("seeked", syncFromAudio);
      audio.removeEventListener("play", handleAudioPlay);
      audio.removeEventListener("pause", handleAudioPause);
      audio.removeEventListener("loadedmetadata", syncFromAudio);
    };
  }, [combinedOffset, metadata, videoDuration]);

  // ========== SEEK TO FRAME ==========
  // Seeks playback to a specific frame's timeline position
  const seekToFrame = useCallback(
    (frame: FrameEntry, options?: { autoplay?: boolean }) => {
      setSelectedFrameId(frame.offset_index); // Mark as selected

      const video = videoRef.current;
      const resolvedDuration =
        (video && Number.isFinite(video.duration) && video.duration > 0 ? video.duration : videoDuration) ?? null;

      // Calculate video seconds for this frame
      const videoSeconds = computeVideoSecondsFromFrame(frame);

      // Use frame's timeline position
      let timelineSeconds = frame.seconds_from_video_start;

      // Try to get more accurate timeline position if we have metadata
      if (resolvedDuration && metadata) {
        const mapped = mapVideoTimeToTimeline(videoSeconds, resolvedDuration, metadata);
        if (Number.isFinite(mapped)) {
          timelineSeconds = mapped;
        }
      }

      // Perform the seek
      seekToTimeline(timelineSeconds, Boolean(options?.autoplay));
    },
    [computeVideoSecondsFromFrame, metadata, seekToTimeline, videoDuration],
  );

  // ========== OPEN FRAME PREVIEW MODAL ==========
  // Opens detailed preview modal for a specific frame
  const openFramePreview = useCallback(
    (frame: FrameEntry) => {
      setSelectedFrameId(frame.offset_index);
      setPreviewOpen(true);

      // Ensure thumbnail is decoded
      const videoSeconds = computeVideoSecondsFromFrame(frame);
      requestFrameThumbnail(frame.offset_index, videoSeconds).catch(() => {
        /* individual decode errors surface on card */
      });
    },
    [computeVideoSecondsFromFrame, requestFrameThumbnail],
  );

  // ========== CLOSE FRAME PREVIEW ==========
  const closeFramePreview = useCallback(() => {
    setPreviewOpen(false);
  }, []);

  // ========== SEEK AND PLAY FROM PREVIEW ==========
  // Seeks to frame and starts playback, then closes modal
  const handleSeekAndPlayFrame = useCallback(
    (frame: FrameEntry) => {
      seekToFrame(frame, { autoplay: true }); // Seek and play
      setPreviewOpen(false); // Close preview
      setFrameOverlayOpen(false); // Close carousel
    },
    [seekToFrame],
  );

  // ========== NAVIGATE TO PREVIOUS FRAME ==========
  // Moves preview to previous frame in sequence
  const navigateToPrevFrame = useCallback(() => {
    if (!selectedFrame) {
      return; // No current selection
    }

    const currentIndex = displayFrames.findIndex((frame) => frame.offset_index === selectedFrame.offset_index);
    if (currentIndex > 0) {
      const prevFrame = displayFrames[currentIndex - 1];
      openFramePreview(prevFrame); // Open preview for previous frame
    }
  }, [selectedFrame, displayFrames, openFramePreview]);

  // ========== NAVIGATE TO NEXT FRAME ==========
  // Moves preview to next frame in sequence
  const navigateToNextFrame = useCallback(() => {
    if (!selectedFrame) {
      return; // No current selection
    }

    const currentIndex = displayFrames.findIndex((frame) => frame.offset_index === selectedFrame.offset_index);
    if (currentIndex < displayFrames.length - 1) {
      const nextFrame = displayFrames[currentIndex + 1];
      openFramePreview(nextFrame); // Open preview for next frame
    }
  }, [selectedFrame, displayFrames, openFramePreview]);

  // ========== FIND ACTIVE TRANSCRIPT SEGMENT (MODIFIED) ==========
  // Now uses audioTime instead of currentTime
  const activeSegment = useMemo(
    () => segments.find((seg) => audioTime >= seg.start && audioTime < seg.end) || null,
    [segments, audioTime],
  );

  // ========== SEEK TO TRANSCRIPT SEGMENT (MODIFIED) ==========
  // Accounts for audio offset when seeking to transcript
  const handleSeekToSegment = (segment: Segment) => {
    // Convert audio time to timeline time
    const targetTimeline = Math.max(0, segment.start - combinedOffset);
    seekToTimeline(targetTimeline, true); // Seek and play
    setControlsVisible(true);
  };

  // ========== FORM SUBMIT HANDLER ==========
  const handleFormSubmit = (evt: React.FormEvent<HTMLFormElement>) => {
    evt.preventDefault();
    setVideoPath(videoInput.trim()); // Apply new video path
    setAudioPath(audioInput.trim()); // Apply new audio path
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
                style={{
                  width: "100%",
                  accentColor: isPreAudioRegion ? "#f97316" : "#38bdf8",
                  filter: isPreAudioRegion ? "saturate(1.2)" : "none",
                }}
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
