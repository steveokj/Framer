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

type ServerBrowseEntry = {
  name: string;
  path: string;
  type: "dir" | "file";
  size: number | null;
};

type ServerBrowseResponse = {
  currentPath: string | null;
  parentPath: string | null;
  roots: string[];
  entries: ServerBrowseEntry[];
};

type UploadPhase = "idle" | "uploading" | "ingesting" | "done" | "error";

type IngestPhase =
  | "idle"
  | "starting"
  | "ingesting"
  | "processing"
  | "transcribing"
  | "transcribed"
  | "done"
  | "error";

type IngestProgress = {
  done: number;
  total: number;
  kept?: number | null;
  phase: "extract" | "process";
};

const API_BASE = (
  process.env.NEXT_PUBLIC_API_BASE && process.env.NEXT_PUBLIC_API_BASE.trim().length > 0
    ? process.env.NEXT_PUBLIC_API_BASE
    : "http://localhost:8001"
).replace(/\/$/, "");

const ABSOLUTE_PATH_REGEX = /^[a-zA-Z]:[\\/]|^\//;
const SERVER_BROWSER_STORAGE_KEY = "mkvServerBrowserPath";

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

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  const precision = value >= 10 || idx === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[idx]}`;
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
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>("idle");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadDetail, setUploadDetail] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [uploadFileName, setUploadFileName] = useState<string | null>(null);
  const [ingestAfterUpload, setIngestAfterUpload] = useState(true);
  const [fastIngest, setFastIngest] = useState(true);
  const [fastIngestFps, setFastIngestFps] = useState(2);
  const [ingestPhase, setIngestPhase] = useState<IngestPhase>("idle");
  const [ingestLogs, setIngestLogs] = useState<string[]>([]);
  const [ingestProgress, setIngestProgress] = useState<IngestProgress | null>(null);
  const [ingestTargetPath, setIngestTargetPath] = useState<string | null>(null);
  const [transcriptionStatus, setTranscriptionStatus] = useState<"idle" | "running" | "done" | "skipped" | "error">(
    "idle",
  );
  const [serverBrowsePath, setServerBrowsePath] = useState("");
  const [serverBrowseInput, setServerBrowseInput] = useState("");
  const [serverBrowseParent, setServerBrowseParent] = useState<string | null>(null);
  const [serverBrowseRoots, setServerBrowseRoots] = useState<string[]>([]);
  const [serverBrowseEntries, setServerBrowseEntries] = useState<ServerBrowseEntry[]>([]);
  const [serverBrowseLoading, setServerBrowseLoading] = useState(false);
  const [serverBrowseError, setServerBrowseError] = useState<string | null>(null);
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
  const uploadPercent = useMemo(() => {
    if (!uploadProgress || !uploadProgress.total) {
      return null;
    }
    return Math.min(100, Math.round((uploadProgress.loaded / uploadProgress.total) * 100));
  }, [uploadProgress]);
  const uploadRemaining = useMemo(() => {
    if (!uploadProgress) {
      return null;
    }
    return Math.max(uploadProgress.total - uploadProgress.loaded, 0);
  }, [uploadProgress]);
  const uploadBusy = uploadPhase === "uploading" || uploadPhase === "ingesting";
  const ingestPercent = useMemo(() => {
    if (!ingestProgress || !ingestProgress.total) {
      return null;
    }
    return Math.min(100, Math.round((ingestProgress.done / ingestProgress.total) * 100));
  }, [ingestProgress]);
  const ingestInProgressForVideo =
    Boolean(ingestTargetPath) &&
    Boolean(videoPath) &&
    ingestTargetPath === videoPath &&
    ingestPhase !== "done" &&
    ingestPhase !== "error";
  const uploadPhaseLabel = useMemo(() => {
    switch (uploadPhase) {
      case "uploading":
        return "Uploading";
      case "ingesting":
        return "Ingesting";
      case "done":
        return "Complete";
      case "error":
        return "Error";
      default:
        return "Idle";
    }
  }, [uploadPhase]);
  const ingestStatusLabel = useMemo(() => {
    if (!ingestAfterUpload) {
      return "Skipped";
    }
    switch (ingestPhase) {
      case "starting":
        return "Starting";
      case "ingesting":
        return "Preparing";
      case "processing":
        return "Processing frames";
      case "transcribing":
        return "Transcribing audio";
      case "transcribed":
        return "Transcription ready";
      case "done":
        return "Complete";
      case "error":
        return "Error";
      default:
        return "Waiting";
    }
  }, [ingestAfterUpload, ingestPhase]);
  const transcriptionLabel = useMemo(() => {
    if (!ingestAfterUpload) {
      return "Skipped";
    }
    switch (transcriptionStatus) {
      case "running":
        return "Running";
      case "done":
        return "Done";
      case "skipped":
        return "Skipped";
      case "error":
        return "Error";
      default:
        return "Pending";
    }
  }, [ingestAfterUpload, transcriptionStatus]);
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

  const loadServerBrowser = useCallback(async (pathInput?: string) => {
    setServerBrowseLoading(true);
    setServerBrowseError(null);
    try {
      const params = new URLSearchParams();
      if (pathInput && pathInput.trim()) {
        params.set("path", pathInput.trim());
      }
      const query = params.toString();
      const url = query ? `/api/server_browse?${query}` : "/api/server_browse";
      const res = await fetch(url);
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `Failed to load server files (status ${res.status})`);
      }
      const data: ServerBrowseResponse = await res.json();
      setServerBrowseRoots(Array.isArray(data.roots) ? data.roots : []);
      setServerBrowseEntries(Array.isArray(data.entries) ? data.entries : []);
      setServerBrowseParent(data.parentPath ?? null);
      const current = data.currentPath ?? "";
      setServerBrowsePath(current);
      setServerBrowseInput(current);
      if (current) {
        localStorage.setItem(SERVER_BROWSER_STORAGE_KEY, current);
      } else {
        localStorage.removeItem(SERVER_BROWSER_STORAGE_KEY);
      }
    } catch (err) {
      setServerBrowseEntries([]);
      setServerBrowseError(err instanceof Error ? err.message : "Failed to load server files");
    } finally {
      setServerBrowseLoading(false);
    }
  }, []);

  const startIngest = useCallback(
    async (video: string, options?: { fast?: boolean; maxFps?: number }) => {
      setIngestPhase("starting");
      setIngestLogs([]);
      setIngestProgress(null);
      setUploadDetail("Starting ingest...");
      setUploadError(null);
      setTranscriptionStatus("idle");
      let sawTranscribe = false;
      let sawTranscriptionSaved = false;
      let sawTranscriptionSkipped = false;
      try {
        const res = await fetch("/api/mkv_ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            videoPath: video,
            fast: Boolean(options?.fast),
            maxFps: options?.maxFps,
          }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(payload.error || `Ingest request failed (status ${res.status})`);
        }
        const reader = res.body?.getReader();
        if (!reader) {
          throw new Error("Ingest stream unavailable");
        }
        const decoder = new TextDecoder();
        let buffer = "";
        let doneCode: number | null = null;
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          let separatorIndex = buffer.indexOf("\n\n");
          while (separatorIndex !== -1) {
            const chunk = buffer.slice(0, separatorIndex);
            buffer = buffer.slice(separatorIndex + 2);
            const lines = chunk.split("\n");
            let eventType = "message";
            let data = "";
            for (const line of lines) {
              if (line.startsWith("event:")) {
                eventType = line.slice(6).trim();
              } else if (line.startsWith("data:")) {
                data += line.slice(5).trim();
              }
            }
            if (!data) {
              separatorIndex = buffer.indexOf("\n\n");
              continue;
            }
            let payload: any = null;
            try {
              payload = JSON.parse(data);
            } catch {
              payload = { line: data };
            }
            if (eventType === "log") {
              const line = payload?.line;
              if (typeof line === "string") {
                setIngestLogs((prev) => [...prev, line].slice(-200));
                const lower = line.toLowerCase();
                const extractMatch = line.match(/extract:\s*(\d+)\s*\/\s*(\d+)/i);
                if (extractMatch) {
                  const rawDone = Number(extractMatch[1]);
                  const total = Number(extractMatch[2]);
                  const done = Number.isFinite(rawDone) && Number.isFinite(total) ? Math.min(rawDone, total) : rawDone;
                  if (Number.isFinite(done) && Number.isFinite(total) && total > 0) {
                    setIngestProgress({ done, total, kept: null, phase: "extract" });
                  }
                }
                const progressMatch = line.match(/frames:\s*(\d+)\s*\/\s*(\d+)(?:\s+kept=(\d+))?/i);
                if (progressMatch) {
                  const done = Number(progressMatch[1]);
                  const total = Number(progressMatch[2]);
                  const kept = progressMatch[3] ? Number(progressMatch[3]) : null;
                  if (Number.isFinite(done) && Number.isFinite(total) && total > 0) {
                    setIngestProgress({ done, total, kept: kept ?? null, phase: "process" });
                  }
                }
                if (lower.includes("transcribing audio")) {
                  sawTranscribe = true;
                  setTranscriptionStatus("running");
                }
                if (lower.includes("transcription saved")) {
                  sawTranscriptionSaved = true;
                  setTranscriptionStatus("done");
                }
                if (lower.includes("transcription already exists")) {
                  sawTranscriptionSkipped = true;
                  setTranscriptionStatus("skipped");
                }
              }
            } else if (eventType === "stage") {
              const stage = payload?.stage as IngestPhase | undefined;
              if (stage) {
                setIngestPhase(stage);
                if (stage === "transcribing") {
                  setUploadDetail("Transcribing audio...");
                } else if (stage === "processing" || stage === "ingesting") {
                  setUploadDetail("Processing frames...");
                }
              }
            } else if (eventType === "done") {
              doneCode = Number(payload?.code ?? 0);
            } else if (eventType === "error") {
              throw new Error(payload?.message || "Ingest failed");
            }
            separatorIndex = buffer.indexOf("\n\n");
          }
        }
        if (doneCode && doneCode !== 0) {
          throw new Error(`Ingest failed (exit ${doneCode})`);
        }
        if (!sawTranscribe && !sawTranscriptionSaved && !sawTranscriptionSkipped) {
          setTranscriptionStatus("skipped");
        }
        setIngestPhase("done");
        setUploadDetail("Ingest complete.");
      } catch (err) {
        setIngestPhase("error");
        setUploadPhase("error");
        setUploadError(err instanceof Error ? err.message : "Ingest failed");
        setTranscriptionStatus("error");
        throw err;
      }
    },
    []
  );

  const uploadFileWithProgress = useCallback((file: File): Promise<{ path?: string; ingested?: boolean }> => {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/mkv_upload?ingest=0");
      xhr.responseType = "json";
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          setUploadProgress({ loaded: event.loaded, total: event.total });
        }
      };
      xhr.onload = () => {
        const payload = xhr.response ?? {};
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(payload);
        } else {
          reject(new Error(payload.error || `Upload failed (status ${xhr.status})`));
        }
      };
      xhr.onerror = () => {
        reject(new Error("Upload failed"));
      };
      const formData = new FormData();
      formData.append("file", file);
      xhr.send(formData);
    });
  }, []);

  useEffect(() => {
    refreshIngestedVideos().catch(() => {
      /* handled inside */
    });
  }, [refreshIngestedVideos]);

  useEffect(() => {
    const saved = localStorage.getItem(SERVER_BROWSER_STORAGE_KEY);
    loadServerBrowser(saved || undefined).catch(() => {
      /* handled inside */
    });
  }, [loadServerBrowser]);

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
  const uploadInputRef = useRef<HTMLInputElement>(null);
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
    if (ingestInProgressForVideo) {
      setMetadata(null);
      setMetadataError(null);
      return;
    }
    fetchMetadata(videoPath);
  }, [videoPath, fetchMetadata, ingestInProgressForVideo]);

  useEffect(() => {
    setMetadata(null);
    setMetadataError(null);
  }, [videoPath]);

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

  const handleUploadClick = () => {
    uploadInputRef.current?.click();
  };

  const handleUploadChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    setUploadPhase("uploading");
    setUploadError(null);
    setUploadDetail(null);
    setUploadProgress({ loaded: 0, total: file.size });
    setUploadFileName(file.name);
    setIngestPhase("idle");
    setIngestLogs([]);
    setTranscriptionStatus("idle");
    try {
      const payload = await uploadFileWithProgress(file);
      const storedPath = typeof payload.path === "string" ? payload.path : "";
      if (storedPath) {
        setVideoInput(storedPath);
        setVideoPath(storedPath);
        setSelectedIngestedPath("");
      }
      setUploadDetail("Upload complete.");
      if (ingestAfterUpload && storedPath) {
        setUploadPhase("ingesting");
        setIngestTargetPath(storedPath);
        try {
          await startIngest(storedPath, { fast: fastIngest, maxFps: fastIngest ? fastIngestFps : undefined });
          setUploadPhase("done");
          refreshIngestedVideos().catch(() => {
            /* handled inside */
          });
        } finally {
          setIngestTargetPath(null);
        }
      } else {
        setUploadPhase("done");
      }
    } catch (err) {
      setUploadPhase("error");
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    }
  };

  const handleServerBrowseSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    loadServerBrowser(serverBrowseInput).catch(() => {
      /* handled inside */
    });
  };

  const handleServerBrowseInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setServerBrowseInput(event.target.value);
  };

  const handleServerBrowseEntryClick = (entry: ServerBrowseEntry) => {
    if (entry.type === "dir") {
      loadServerBrowser(entry.path).catch(() => {
        /* handled inside */
      });
      return;
    }
    setVideoInput(entry.path);
    setVideoPath(entry.path);
    setSelectedIngestedPath("");
  };

  const handleServerBrowseRootClick = (root: string) => {
    loadServerBrowser(root).catch(() => {
      /* handled inside */
    });
  };

  const handleServerBrowseUp = () => {
    if (!serverBrowseParent) {
      return;
    }
    loadServerBrowser(serverBrowseParent).catch(() => {
      /* handled inside */
    });
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

        <div style={{ display: "grid", gap: 8 }}>
          <strong>Upload video</strong>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
            <button
              type="button"
              onClick={handleUploadClick}
              disabled={uploadBusy}
              style={{
                padding: "8px 12px",
                borderRadius: 6,
                border: "1px solid #334155",
                background: uploadBusy ? "rgba(30, 41, 59, 0.6)" : "rgba(15, 23, 42, 0.6)",
                color: uploadBusy ? "#94a3b8" : "#f8fafc",
                cursor: uploadBusy ? "not-allowed" : "pointer",
              }}
            >
              {uploadBusy ? "Upload in progress" : "Select video to upload"}
            </button>
            <label style={{ display: "flex", alignItems: "center", gap: 6, color: "#cbd5f5", fontSize: 13 }}>
              <input
                type="checkbox"
                checked={ingestAfterUpload}
                disabled={uploadBusy}
                onChange={(event) => setIngestAfterUpload(event.target.checked)}
              />
              Ingest after upload
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6, color: "#cbd5f5", fontSize: 13 }}>
              <input
                type="checkbox"
                checked={fastIngest}
                disabled={!ingestAfterUpload || uploadBusy}
                onChange={(event) => setFastIngest(event.target.checked)}
              />
              Fast ingest
            </label>
            {fastIngest && (
              <label style={{ display: "flex", alignItems: "center", gap: 6, color: "#cbd5f5", fontSize: 13 }}>
                <span>Max fps</span>
                <input
                  type="number"
                  min={0.5}
                  step={0.5}
                  value={fastIngestFps}
                  disabled={!ingestAfterUpload || uploadBusy}
                  onChange={(event) => setFastIngestFps(Math.max(0.5, Number(event.target.value) || 0.5))}
                  style={{ width: 70, padding: "2px 6px" }}
                />
              </label>
            )}
            {uploadPhase !== "idle" && <span style={{ color: "#94a3b8" }}>{uploadPhaseLabel}</span>}
          </div>
          <input
            ref={uploadInputRef}
            type="file"
            accept="video/*,.mkv,.mp4,.mov,.webm,.avi,.m4v"
            onChange={handleUploadChange}
            style={{ display: "none" }}
          />
          {uploadFileName && <div style={{ color: "#e2e8f0", fontSize: 13 }}>File: {uploadFileName}</div>}
          {uploadProgress && (
            <div
              style={{
                height: 8,
                borderRadius: 999,
                border: "1px solid #1e293b",
                background: "rgba(15, 23, 42, 0.8)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${uploadPercent ?? 0}%`,
                  height: "100%",
                  background: uploadPhase === "error" ? "#f87171" : "#38bdf8",
                  transition: "width 0.2s ease",
                }}
              />
            </div>
          )}
          {uploadProgress && uploadPhase === "uploading" && (
            <div style={{ color: "#94a3b8", fontSize: 12 }}>
              Uploading {uploadPercent ?? 0}% ({formatBytes(uploadRemaining ?? 0)} left of {formatBytes(uploadProgress.total)})
            </div>
          )}
          {ingestProgress && uploadPhase === "ingesting" && (
            <div style={{ color: "#94a3b8", fontSize: 12 }}>
              {ingestProgress.phase === "extract" ? "Extracting frames" : "Processing frames"} {ingestProgress.done}/
              {ingestProgress.total} ({ingestPercent ?? 0}%)
              {ingestProgress.phase === "process" && ingestProgress.kept != null ? `, kept ${ingestProgress.kept}` : ""}
            </div>
          )}
          {ingestProgress && uploadPhase === "ingesting" && (
            <div
              style={{
                height: 6,
                borderRadius: 999,
                border: "1px solid #1e293b",
                background: "rgba(15, 23, 42, 0.8)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${ingestPercent ?? 0}%`,
                  height: "100%",
                  background: ingestProgress.phase === "extract" ? "#38bdf8" : "#34d399",
                  transition: "width 0.2s ease",
                }}
              />
            </div>
          )}
          {uploadPhase === "ingesting" && !ingestProgress && (
            <div style={{ color: "#94a3b8", fontSize: 12 }}>Starting ingest, waiting for frame progress...</div>
          )}
          {uploadDetail && <p style={{ color: "#a7f3d0" }}>{uploadDetail}</p>}
          {uploadError && <p style={{ color: "#fca5a5" }}>{uploadError}</p>}
          <div style={{ display: "grid", gap: 4, color: "#94a3b8", fontSize: 12 }}>
            <div>Ingest status: {ingestStatusLabel}</div>
            <div>Transcription: {transcriptionLabel}</div>
            <div>Ingest mode: {fastIngest ? `Fast (${fastIngestFps} fps)` : "Full"}</div>
          </div>
          {ingestLogs.length > 0 && (
            <details style={{ border: "1px solid #1e293b", borderRadius: 8, padding: 8 }}>
              <summary style={{ cursor: "pointer", color: "#e2e8f0" }}>Ingest log</summary>
              <div
                style={{
                  marginTop: 8,
                  maxHeight: 180,
                  overflowY: "auto",
                  fontSize: 12,
                  color: "#cbd5f5",
                  whiteSpace: "pre-wrap",
                }}
              >
                {ingestLogs.join("\n")}
              </div>
            </details>
          )}
          <p style={{ color: "#94a3b8", fontSize: 12 }}>Uploads save to data/uploads on the server.</p>
        </div>

        <details style={{ border: "1px solid #1e293b", borderRadius: 8, padding: 10 }}>
          <summary style={{ cursor: "pointer", color: "#e2e8f0" }}>Browse server files</summary>
          <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              {serverBrowseParent && (
                <button
                  type="button"
                  onClick={handleServerBrowseUp}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 6,
                    border: "1px solid #334155",
                    background: "rgba(15, 23, 42, 0.6)",
                    color: "#f8fafc",
                    cursor: "pointer",
                  }}
                >
                  Up
                </button>
              )}
              {serverBrowseRoots.map((root) => (
                <button
                  key={root}
                  type="button"
                  onClick={() => handleServerBrowseRootClick(root)}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 6,
                    border: "1px solid #334155",
                    background: "rgba(15, 23, 42, 0.6)",
                    color: "#f8fafc",
                    cursor: "pointer",
                  }}
                >
                  {root}
                </button>
              ))}
            </div>
            <form onSubmit={handleServerBrowseSubmit} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="text"
                value={serverBrowseInput}
                onChange={handleServerBrowseInputChange}
                placeholder="C:\\"
                style={{ flex: 1, padding: "8px 10px" }}
              />
              <button type="submit" style={{ padding: "8px 12px" }}>
                Go
              </button>
            </form>
            {serverBrowsePath && (
              <div style={{ color: "#94a3b8", fontSize: 12 }}>Current folder: {serverBrowsePath}</div>
            )}
            {serverBrowseLoading && <span style={{ color: "#94a3b8" }}>Loading...</span>}
            {serverBrowseError && <p style={{ color: "#fca5a5" }}>{serverBrowseError}</p>}
            <div style={{ display: "grid", gap: 6, maxHeight: 220, overflowY: "auto" }}>
              {serverBrowseEntries.map((entry) => (
                <button
                  key={`${entry.type}-${entry.path}`}
                  type="button"
                  onClick={() => handleServerBrowseEntryClick(entry)}
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    padding: "6px 8px",
                    borderRadius: 6,
                    border: "1px solid #1e293b",
                    background: "rgba(15, 23, 42, 0.55)",
                    color: entry.type === "dir" ? "#38bdf8" : "#e2e8f0",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <span style={{ minWidth: 52 }}>{entry.type === "dir" ? "[DIR]" : "[FILE]"}</span>
                  <span style={{ flex: 1 }}>{entry.name}</span>
                </button>
              ))}
              {!serverBrowseLoading && serverBrowsePath && serverBrowseEntries.length === 0 && (
                <span style={{ color: "#94a3b8" }}>No video files found in this folder.</span>
              )}
            </div>
          </div>
        </details>
        {videoWarning && <p style={{ color: "#b54747", marginTop: 8 }}>{videoWarning}</p>}
        {ingestInProgressForVideo && (
          <p style={{ color: "#94a3b8" }}>Waiting for ingest to finish before loading metadata.</p>
        )}
        {!ingestInProgressForVideo && metadataError && <p style={{ color: "#fca5a5" }}>{metadataError}</p>}
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






