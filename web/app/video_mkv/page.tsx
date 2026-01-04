"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

type FrameEntry = {
  offset_index: number;
  timestamp: string | null;
  seconds_from_video_start: number;
  frame_path?: string | null;
};

type FrameRequest = {
  id: number;
  seconds: number;
  resolve: (dataUrl: string) => void;
  reject: (err: unknown) => void;
};

type VideoMeta = {
  path: string;
  fps: number | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  frame_count: number | null;
  kept_frames: number | null;
  creation_time: string | null;
};

type Metadata = {
  video: VideoMeta;
  frames: FrameEntry[];
};

type IngestedVideo = {
  id: number;
  file_path: string;
  fps: number | null;
  duration: number | null;
  frame_count: number | null;
  kept_frames: number | null;
  creation_time: string | null;
};

const API_BASE = (
  process.env.NEXT_PUBLIC_API_BASE && process.env.NEXT_PUBLIC_API_BASE.trim().length > 0
    ? process.env.NEXT_PUBLIC_API_BASE
    : "http://localhost:8001"
).replace(/\/$/, "");

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

type FrameThumbnailCardProps = {
  frame: FrameEntry;
  imageUrl?: string;
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
  imageUrl,
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
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (thumbnail || (imageUrl && !imageFailed)) {
      return;
    }
    setLoading(true);
    setError(null);
    requestThumbnail(frame.offset_index, videoSeconds)
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to decode frame");
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [frame.offset_index, videoSeconds, requestThumbnail, thumbnail, imageUrl, imageFailed]);

  useEffect(() => {
    setImageFailed(false);
  }, [imageUrl]);

  const handleSelect = () => {
    if (thumbnail || (imageUrl && !imageFailed)) {
      onSelect(frame);
      return;
    }
    if (loading) {
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
        maxWidth: layoutMode === "grid" ? "100%" : "100%",
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
        {thumbnail || (imageUrl && !imageFailed) ? (
          <img
            src={thumbnail ?? imageUrl}
            alt={`Frame ${frame.offset_index} at ${formatTime(frame.seconds_from_video_start)}`}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
            loading="lazy"
            onError={() => {
              if (!thumbnail) {
                setImageFailed(true);
              }
            }}
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
        {layoutMode === "list" && <span style={{ color: "#94a3b8" }}>{frame.timestamp ?? "--"}</span>}
      </div>
    </button>
  );
}

type FramePreviewModalProps = {
  frame: FrameEntry | null;
  imageUrl?: string;
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
  imageUrl,
  thumbnail,
  videoSeconds,
  onClose,
  onSeekAndPlay,
  onNavigatePrev,
  onNavigateNext,
  hasPrev,
  hasNext,
}: FramePreviewModalProps) {
  const handleContainerClick = (event: React.MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
  };

  // Keyboard navigation handler
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
        zIndex: 70,
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
          width: "min(94vw, 1600px)",
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
            thumbnail || imageUrl ? (
              <img
                src={thumbnail ?? imageUrl}
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
              fontSize: 24,
              fontWeight: "bold",
              backdropFilter: "blur(4px)",
              transition: "all 0.2s",
            }}
            onMouseEnter={(e) => {
              if (hasPrev) {
                e.currentTarget.style.background = "rgba(15, 23, 42, 0.95)";
                e.currentTarget.style.borderColor = "#38bdf8";
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = hasPrev ? "rgba(15, 23, 42, 0.85)" : "rgba(15, 23, 42, 0.5)";
              e.currentTarget.style.borderColor = "#334155";
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
              fontSize: 24,
              fontWeight: "bold",
              backdropFilter: "blur(4px)",
              transition: "all 0.2s",
            }}
            onMouseEnter={(e) => {
              if (hasNext) {
                e.currentTarget.style.background = "rgba(15, 23, 42, 0.95)";
                e.currentTarget.style.borderColor = "#38bdf8";
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = hasNext ? "rgba(15, 23, 42, 0.85)" : "rgba(15, 23, 42, 0.5)";
              e.currentTarget.style.borderColor = "#334155";
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
          <span>
            Frame #: {frame ? frame.offset_index : "--"}
          </span>
          <span>Video time: {frame ? formatTime(videoSeconds ?? frame.seconds_from_video_start) : "--"}</span>
          <span>Frame time: {frame ? formatTime(frame.seconds_from_video_start) : "--"}</span>
          <span>Timestamp: {frame?.timestamp ?? "--"}</span>
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

export default function VideoMkvPage() {
  const [ingestedVideos, setIngestedVideos] = useState<IngestedVideo[]>([]);
  const [ingestedLoading, setIngestedLoading] = useState(false);
  const [ingestedError, setIngestedError] = useState<string | null>(null);
  const [selectedIngestedPath, setSelectedIngestedPath] = useState("");
  const [videoInput, setVideoInput] = useState("");
  const [videoPath, setVideoPath] = useState("");
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [loadingMetadata, setLoadingMetadata] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [decoderError, setDecoderError] = useState<string | null>(null);
  const [selectedFrameId, setSelectedFrameId] = useState<number | null>(null);
  const [frameSamplingMode, setFrameSamplingMode] = useState<"sampled" | "all">("sampled");
  const [layoutMode, setLayoutMode] = useState<"grid" | "list">("grid");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);

  const { url: videoUrl, warning: videoWarning } = useMemo(() => buildFileUrl(videoPath), [videoPath]);

  const serverHint = API_BASE || "http://localhost:8001";
  const refreshIngestedVideos = useCallback(async () => {
    setIngestedLoading(true);
    setIngestedError(null);
    try {
      const res = await fetch("/api/mkv_playback", { method: "GET" });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `Failed to list videos (status ${res.status})`);
      }
      const data: IngestedVideo[] = await res.json();
      setIngestedVideos(Array.isArray(data) ? data : []);
    } catch (err) {
      setIngestedVideos([]);
      setIngestedError(err instanceof Error ? err.message : "Failed to load ingested videos");
    } finally {
      setIngestedLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshIngestedVideos().catch(() => {
      /* handled inside */
    });
  }, [refreshIngestedVideos]);

  useEffect(() => {
    if (!videoInput && ingestedVideos.length > 0) {
      const latest = ingestedVideos[0]?.file_path;
      if (latest) {
        setVideoInput(latest);
        setVideoPath(latest);
        setSelectedIngestedPath(latest);
      }
      return;
    }
    if (videoInput) {
      const match = ingestedVideos.find((video) => video.file_path === videoInput);
      if (match && selectedIngestedPath !== match.file_path) {
        setSelectedIngestedPath(match.file_path);
      }
    }
  }, [ingestedVideos, videoInput, selectedIngestedPath]);
  const frames = useMemo(() => {
    const all = metadata?.frames ?? [];
    if (all.length <= 1) {
      return all;
    }
    const deduped: FrameEntry[] = [];
    let lastTimestamp: string | null = null;
    for (const frame of all) {
      if (frame.timestamp && frame.timestamp === lastTimestamp) {
        continue;
      }
      deduped.push(frame);
      if (frame.timestamp) {
        lastTimestamp = frame.timestamp;
      }
    }
    return deduped;
  }, [metadata]);
  const frameImageUrls = useMemo(() => {
    const mapping: Record<number, string | undefined> = {};
    for (const frame of frames) {
      if (!frame.frame_path) {
        continue;
      }
      const { url } = buildFileUrl(frame.frame_path);
      if (url) {
        mapping[frame.offset_index] = url;
      }
    }
    return mapping;
  }, [frames]);
  const SAMPLE_FRAME_GAP_SECONDS = 1.0;
  const SAMPLE_FRAME_GAP_LABEL =
    SAMPLE_FRAME_GAP_SECONDS >= 1
      ? `${Number.isInteger(SAMPLE_FRAME_GAP_SECONDS) ? SAMPLE_FRAME_GAP_SECONDS.toFixed(0) : SAMPLE_FRAME_GAP_SECONDS.toFixed(1)} second${SAMPLE_FRAME_GAP_SECONDS === 1 ? "" : "s"}`
      : `${Math.round(SAMPLE_FRAME_GAP_SECONDS * 1000)} ms`;
  const computeVideoSeconds = useCallback(
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

  const videoRef = useRef<HTMLVideoElement>(null);
  const decoderRef = useRef<HTMLVideoElement>(null);
  const decoderReadyRef = useRef(false);
  const decoderReadyResolversRef = useRef<Array<{ resolve: () => void; reject: (reason?: unknown) => void }>>([]);
  const queueRef = useRef<FrameRequest[]>([]);
  const queueProcessingRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const framePromisesRef = useRef<Map<number, Promise<string>>>(new Map());
  const frameThumbsRef = useRef<Record<number, string>>({});
  const [, forceFrameUpdate] = useState(0);

  const storeFrameThumbnail = useCallback((frameId: number, dataUrl: string) => {
    const existing = frameThumbsRef.current[frameId];
    if (existing === dataUrl) {
      return;
    }
    frameThumbsRef.current = { ...frameThumbsRef.current, [frameId]: dataUrl };
    forceFrameUpdate((value) => (value + 1) % 1000000);
  }, []);

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

  const fetchMetadata = useCallback(async (video: string) => {
    const trimmedVideo = video.trim();
    if (!trimmedVideo) {
      setMetadata(null);
      setMetadataError(null);
      return;
    }
    setLoadingMetadata(true);
    setMetadataError(null);
    try {
      const res = await fetch("/api/mkv_playback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoPath: trimmedVideo }),
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
  }, []);

  useEffect(() => {
    fetchMetadata(videoPath);
  }, [videoPath, fetchMetadata]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    const handleTimeUpdate = () => {
      setCurrentTime(Math.max(0, video.currentTime));
    };
    video.addEventListener("timeupdate", handleTimeUpdate);
    video.addEventListener("seeked", handleTimeUpdate);
    video.addEventListener("play", handleTimeUpdate);
    return () => {
      video.removeEventListener("timeupdate", handleTimeUpdate);
      video.removeEventListener("seeked", handleTimeUpdate);
      video.removeEventListener("play", handleTimeUpdate);
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    const handleLoadedMetadata = () => {
      setVideoDuration(video.duration);
    };
    video.addEventListener("loadedmetadata", handleLoadedMetadata);
    return () => {
      video.removeEventListener("loadedmetadata", handleLoadedMetadata);
    };
  }, []);

  useEffect(() => {
    setCurrentTime(0);
    setOverlayOpen(false);
  }, [videoUrl]);

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
        // Surface detailed diagnostics in devtools without leaking into UI string
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

    console.debug("Frame decoder updating source", { currentSrc, nextSrc: videoUrl });

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
  }, [videoUrl, processQueue, serverHint]);

  useEffect(() => {
    if (!overlayOpen || previewOpen) {
      return;
    }
    const warmup = displayFrames.slice(0, 24);
    warmup.forEach((frame) => {
      if (frameImageUrls[frame.offset_index]) {
        return;
      }
      requestFrameThumbnail(frame.offset_index, computeVideoSeconds(frame)).catch(() => {
        /* ignore warmup errors - card will display error state */
      });
    });
  }, [overlayOpen, previewOpen, displayFrames, frameImageUrls, computeVideoSeconds, requestFrameThumbnail]);


  useEffect(() => {
    if (!overlayOpen) {
      setPreviewOpen(false);
    }
  }, [overlayOpen]);
  useEffect(() => {
    if (!overlayOpen || previewOpen) {
      return;
    }
    if (!displayFrames.length) {
      setSelectedFrameId(null);
      return;
    }
    setSelectedFrameId((prev) => {
      if (prev != null && displayFrames.some((frame) => frame.offset_index === prev)) {
        return prev;
      }
      let closest = displayFrames[0];
      let smallestDelta = Math.abs(computeVideoSeconds(displayFrames[0]) - currentTime);
      for (let i = 1; i < displayFrames.length; i += 1) {
        const candidate = displayFrames[i];
        const delta = Math.abs(computeVideoSeconds(candidate) - currentTime);
        if (delta < smallestDelta) {
          smallestDelta = delta;
          closest = candidate;
        }
      }
      return closest.offset_index;
    });
  }, [overlayOpen, previewOpen, displayFrames, currentTime, computeVideoSeconds]);

  useEffect(() => {
    if (!selectedFrame) {
      return;
    }
    if (!(overlayOpen || previewOpen)) {
      return;
    }
    const frameId = selectedFrame.offset_index;
    if (frameThumbsRef.current[frameId]) {
      return;
    }
    if (frameImageUrls[frameId]) {
      return;
    }
    requestFrameThumbnail(frameId, computeVideoSeconds(selectedFrame)).catch(() => {
      /* ignore individual frame errors */
    });
  }, [overlayOpen, previewOpen, selectedFrame, frameImageUrls, computeVideoSeconds, requestFrameThumbnail]);

  const seekToFrame = useCallback(
    (frame: FrameEntry, options?: { autoplay?: boolean }) => {
      setSelectedFrameId(frame.offset_index);
      const video = videoRef.current;
      if (!video) {
        return;
      }
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
      const targetSeconds = computeVideoSeconds(frame);
      const clamped = duration
        ? Math.min(Math.max(targetSeconds, 0), Math.max(duration - 0.001, 0))
        : Math.max(targetSeconds, 0);
      try {
        video.currentTime = clamped;
        setCurrentTime(clamped);
      } catch {
        /* ignore */
      }
      if (options?.autoplay) {
        video
          .play()
          .catch(() => {
            /* ignore autoplay restrictions */
          });
      }
    },
    [computeVideoSeconds],
  );

  const openFramePreview = useCallback(
    (frame: FrameEntry) => {
      setSelectedFrameId(frame.offset_index);
      setPreviewOpen(true);
      if (!frameImageUrls[frame.offset_index]) {
        const videoSeconds = computeVideoSeconds(frame);
        requestFrameThumbnail(frame.offset_index, videoSeconds).catch(() => {
          /* decode errors surfaced on card */
        });
      }
    },
    [computeVideoSeconds, requestFrameThumbnail, frameImageUrls],
  );

  const closeFramePreview = useCallback(() => {
    setPreviewOpen(false);
  }, []);

  const handleSeekAndPlay = useCallback(
    (frame: FrameEntry) => {
      seekToFrame(frame, { autoplay: true });
      setPreviewOpen(false);
      setOverlayOpen(false);
    },
    [seekToFrame],
  );

  const navigateToPrevFrame = useCallback(() => {
    if (!selectedFrame) return;
    const currentIndex = displayFrames.findIndex((f) => f.offset_index === selectedFrame.offset_index);
    if (currentIndex > 0) {
      const prevFrame = displayFrames[currentIndex - 1];
      openFramePreview(prevFrame);
    }
  }, [selectedFrame, displayFrames, openFramePreview]);

  const navigateToNextFrame = useCallback(() => {
    if (!selectedFrame) return;
    const currentIndex = displayFrames.findIndex((f) => f.offset_index === selectedFrame.offset_index);
    if (currentIndex < displayFrames.length - 1) {
      const nextFrame = displayFrames[currentIndex + 1];
      openFramePreview(nextFrame);
    }
  }, [selectedFrame, displayFrames, openFramePreview]);

  const selectedFrameIndex = useMemo(() => {
    if (!selectedFrame) return -1;
    return displayFrames.findIndex((f) => f.offset_index === selectedFrame.offset_index);
  }, [selectedFrame, displayFrames]);

  const hasPrevFrame = selectedFrameIndex > 0;
  const hasNextFrame = selectedFrameIndex >= 0 && selectedFrameIndex < displayFrames.length - 1;

  const handleOpenOverlay = useCallback(() => {
    setOverlayOpen(true);
  }, []);

  const handleCloseOverlay = useCallback(() => {
    setOverlayOpen(false);
    setPreviewOpen(false);
  }, []);

  const frameThumbnails = frameThumbsRef.current;
  const canOpenCarousel = Boolean(videoUrl) && displayFrames.length > 0;

  const handleSelectIngested = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const nextPath = event.target.value;
    setSelectedIngestedPath(nextPath);
    if (nextPath) {
      setVideoInput(nextPath);
      setVideoPath(nextPath);
    } else {
      setVideoInput("");
      setVideoPath("");
    }
  };

  const handleVideoInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value;
    setVideoInput(next);
    const match = ingestedVideos.find((video) => video.file_path === next);
    setSelectedIngestedPath(match ? match.file_path : "");
  };

  const handleFormSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = videoInput.trim();
    setVideoPath(trimmed);
    const match = ingestedVideos.find((video) => video.file_path === trimmed);
    setSelectedIngestedPath(match ? match.file_path : "");
  };

  return (
    <main style={{ display: "grid", gap: 24, padding: 24 }}>
      <header>
        <h1>MKV/MP4 Frame Player</h1>
        <p style={{ color: "#607080" }}>
          Load an ingested video, play it with audio, and browse the extracted frames with thumbnails or on-demand
          decoding.
        </p>
      </header>

      <section style={{ display: "grid", gap: 16, maxWidth: 720 }}>
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
            <strong>Ingested videos</strong>
            <button
              type="button"
              onClick={refreshIngestedVideos}
              style={{
                padding: "6px 12px",
                borderRadius: 6,
                border: "1px solid #334155",
                background: "rgba(15, 23, 42, 0.6)",
                color: "#f8fafc",
                cursor: "pointer",
              }}
            >
              Refresh list
            </button>
            {ingestedLoading && <span style={{ color: "#94a3b8" }}>Loading...</span>}
          </div>
          <select
            value={selectedIngestedPath}
            onChange={handleSelectIngested}
            style={{ padding: "8px 10px", borderRadius: 6 }}
          >
            <option value="">Select an ingested video...</option>
            {ingestedVideos.map((video) => (
              <option key={video.id} value={video.file_path}>
                {video.file_path}
              </option>
            ))}
          </select>
          {!ingestedLoading && ingestedVideos.length === 0 && (
            <p style={{ color: "#94a3b8" }}>No ingested videos found in the MKV ingest database.</p>
          )}
          {ingestedError && <p style={{ color: "#fca5a5" }}>{ingestedError}</p>}
        </div>

        <form onSubmit={handleFormSubmit} style={{ display: "grid", gap: 12 }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span>Video path (absolute or project-relative)</span>
            <input
              type="text"
              value={videoInput}
              onChange={handleVideoInputChange}
              style={{ padding: "8px 10px" }}
            />
          </label>
          <button type="submit" style={{ width: 180, padding: "8px 12px" }}>
            Load video metadata
          </button>
        </form>
        {videoWarning && <p style={{ color: "#b54747", marginTop: 8 }}>{videoWarning}</p>}
        {metadataError && <p style={{ color: "#fca5a5" }}>{metadataError}</p>}
        {loadingMetadata && <p style={{ color: "#94a3b8" }}>Loading metadata...</p>}
      </section>

      <section>
        {videoUrl ? (
          <video
            ref={videoRef}
            src={videoUrl}
            controls
            style={{ width: "100%", maxHeight: 360, borderRadius: 12, background: "#111" }}
            preload="metadata"
            crossOrigin="anonymous"
          />
        ) : (
          <div style={{ padding: 40, color: "#eee" }}>Provide a video path to enable playback.</div>
        )}
      </section>

      <section style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
        <button
          type="button"
          onClick={handleOpenOverlay}
          disabled={!canOpenCarousel}
          style={{
            padding: "8px 14px",
            borderRadius: 8,
            border: "none",
            background: canOpenCarousel ? "#2563eb" : "#1e293b",
            color: "#f8fafc",
            cursor: canOpenCarousel ? "pointer" : "not-allowed",
          }}
        >
          Open frame carousel
        </button>
        <span style={{ color: "#94a3b8" }}>
          Frames available: {frames.length ? frames.length.toLocaleString() : "0"}
        </span>
        <span style={{ color: "#94a3b8" }}>Current time: {formatTime(currentTime)}</span>
        {decoderError && <span style={{ color: "#fca5a5" }}>{decoderError}</span>}
      </section>

      <section style={{ display: "grid", gap: 8 }}>
        <h2 style={{ marginBottom: 4 }}>Frame metadata preview</h2>
        {metadata?.video && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 16, color: "#94a3b8", fontSize: 13 }}>
            <span>FPS: {metadata.video.fps ?? "--"}</span>
            <span>Duration: {metadata.video.duration ? `${metadata.video.duration.toFixed(2)}s` : "--"}</span>
            <span>Frames: {metadata.video.frame_count ?? frames.length}</span>
            <span>Kept: {metadata.video.kept_frames ?? frames.length}</span>
            <span>
              Size: {metadata.video.width && metadata.video.height ? `${metadata.video.width}x${metadata.video.height}` : "--"}
            </span>
          </div>
        )}
        {frames.length ? (
          <div style={{ display: "grid", gap: 4, maxHeight: 200, overflowY: "auto", color: "#cbd5f5" }}>
            {frames.slice(0, 12).map((frame) => (
              <div key={frame.offset_index} style={{ display: "flex", gap: 12 }}>
                <span style={{ width: 60 }}>#{frame.offset_index}</span>
                <span style={{ flex: 1 }}>{frame.timestamp ?? "--"}</span>
                <span style={{ width: 80 }}>{formatTime(frame.seconds_from_video_start)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p style={{ color: "#94a3b8" }}>Frame metadata will populate once a video is loaded.</p>
        )}
      </section>

      {overlayOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 50,
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
                Browse the timeline thumbnails and pop open a detailed view without losing your place.
              </p>
            </div>
            <button
              type="button"
              onClick={handleCloseOverlay}
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
                  const videoSeconds = computeVideoSeconds(frame);
                  return (
                    <FrameThumbnailCard
                      key={frame.offset_index}
                      frame={frame}
                      imageUrl={frameImageUrls[frame.offset_index]}
                      thumbnail={frameThumbnails[frame.offset_index]}
                      videoSeconds={videoSeconds}
                      isActive={Math.abs(currentTime - videoSeconds) < 0.2}
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
                  const videoSeconds = computeVideoSeconds(frame);
                  return (
                    <FrameThumbnailCard
                      key={frame.offset_index}
                      frame={frame}
                      imageUrl={frameImageUrls[frame.offset_index]}
                      thumbnail={frameThumbnails[frame.offset_index]}
                      videoSeconds={videoSeconds}
                      isActive={Math.abs(currentTime - videoSeconds) < 0.2}
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
          imageUrl={selectedFrame ? frameImageUrls[selectedFrame.offset_index] : undefined}
          thumbnail={selectedFrame ? frameThumbnails[selectedFrame.offset_index] : undefined}
          videoSeconds={selectedFrame ? computeVideoSeconds(selectedFrame) : null}
          onClose={closeFramePreview}
          onSeekAndPlay={() => {
            if (selectedFrame) {
              handleSeekAndPlay(selectedFrame);
            }
          }}
          onNavigatePrev={navigateToPrevFrame}
          onNavigateNext={navigateToNextFrame}
          hasPrev={hasPrevFrame}
          hasNext={hasNextFrame}
        />
      )}
      <video
        ref={decoderRef}
        style={{ display: "none" }}
        preload="metadata"
        playsInline
        muted
        aria-hidden="true"
      />
    </main>
  );
}






