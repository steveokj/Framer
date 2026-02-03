"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

type ObsVideo = {
  path: string;
  name: string;
  start_ms: number | null;
  duration_s: number | null;
  end_ms: number | null;
  created_ms: number | null;
  modified_ms: number | null;
  start_source: "filename" | "filetime" | "unknown";
};

type TranscriptSegment = {
  start_ms: number;
  end_ms: number;
  text: string;
  model: string;
  run_id: number;
};

type SearchMatch = {
  video_path: string;
  start_ms: number;
  end_ms: number;
  text: string;
  model: string;
  run_id: number;
};

const DEFAULT_OBS_FOLDER = "C:\\Users\\steve\\Desktop\\Desktop II\\OBS";
const LAST_FOLDER_KEY = "timestone:obs_transcripts_player:folder";
const LAST_MODEL_KEY = "timestone:obs_transcripts_player:model";
const MODELS = ["tiny", "small", "medium", "large-v2"];

const API_BASE = (
  process.env.NEXT_PUBLIC_API_BASE && process.env.NEXT_PUBLIC_API_BASE.trim().length > 0
    ? process.env.NEXT_PUBLIC_API_BASE
    : "http://localhost:8001"
).replace(/\/$/, "");

const ABSOLUTE_PATH_REGEX = /^[a-zA-Z]:[\\/]|^\//;

function normalisePath(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.?\//, "");
}

function buildFileUrl(pathInput: string): string | null {
  const trimmed = pathInput.trim();
  if (!trimmed) {
    return null;
  }
  if (ABSOLUTE_PATH_REGEX.test(trimmed)) {
    const normalised = normalisePath(trimmed);
    return `${API_BASE}/files_abs?path=${encodeURIComponent(normalised)}`;
  }
  const normalised = normalisePath(trimmed);
  return `${API_BASE}/files/${encodeURI(normalised)}`;
}

function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms)) {
    return "--:--";
  }
  const totalSeconds = Math.max(0, ms) / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

function clipText(text: string, maxLen = 180): string {
  if (text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, maxLen)}...`;
}

export default function ObsTranscriptsPlayer() {
  const searchParams = useSearchParams();
  const [obsFolder, setObsFolder] = useState("");
  const [videos, setVideos] = useState<ObsVideo[]>([]);
  const [videoPath, setVideoPath] = useState("");
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [model, setModel] = useState("medium");
  const [status, setStatus] = useState("Idle");
  const [pendingSeekMs, setPendingSeekMs] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pickerRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem(LAST_FOLDER_KEY);
    setObsFolder(saved || DEFAULT_OBS_FOLDER);
    const savedModel = localStorage.getItem(LAST_MODEL_KEY);
    if (savedModel) {
      setModel(savedModel);
    }
  }, []);

  useEffect(() => {
    if (obsFolder.trim()) {
      localStorage.setItem(LAST_FOLDER_KEY, obsFolder);
    }
  }, [obsFolder]);

  useEffect(() => {
    localStorage.setItem(LAST_MODEL_KEY, model);
  }, [model]);

  useEffect(() => {
    const queryVideo = searchParams.get("video");
    if (queryVideo) {
      setVideoPath(queryVideo);
    }
  }, [searchParams]);

  const loadVideos = useCallback(async () => {
    if (!obsFolder.trim()) {
      setVideos([]);
      return;
    }
    setStatus("Loading videos...");
    try {
      const res = await fetch("/api/obs_videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderPath: obsFolder }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `Failed to scan OBS folder (${res.status})`);
      }
      const data = await res.json();
      const list = Array.isArray(data?.videos) ? (data.videos as ObsVideo[]) : [];
      list.sort((a, b) => (b.start_ms || 0) - (a.start_ms || 0));
      setVideos(list);
      if (!videoPath && list.length) {
        setVideoPath(list[0].path);
      }
      setStatus("Ready");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Failed to load videos");
    }
  }, [obsFolder, videoPath]);

  useEffect(() => {
    if (obsFolder.trim()) {
      loadVideos();
    }
  }, [loadVideos, obsFolder]);

  useEffect(() => {
    const src = videoPath ? buildFileUrl(videoPath) : null;
    setVideoSrc(src);
  }, [videoPath]);

  const loadSegments = useCallback(async () => {
    if (!videoPath) {
      setSegments([]);
      return;
    }
    try {
      const res = await fetch("/api/obs_transcripts/segments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoPath, model }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `Failed to load transcript segments (${res.status})`);
      }
      const data = await res.json();
      setSegments(Array.isArray(data?.segments) ? (data.segments as TranscriptSegment[]) : []);
    } catch {
      setSegments([]);
    }
  }, [videoPath, model]);

  useEffect(() => {
    loadSegments();
  }, [loadSegments]);

  useEffect(() => {
    if (!searchQuery.trim()) {
      setMatches([]);
      return;
    }
    const id = window.setTimeout(async () => {
      try {
        const res = await fetch("/api/obs_transcripts/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: searchQuery.trim(), model }),
        });
        if (!res.ok) {
          setMatches([]);
          return;
        }
        const data = await res.json();
        setMatches(Array.isArray(data?.matches) ? (data.matches as SearchMatch[]) : []);
      } catch {
        setMatches([]);
      }
    }, 200);
    return () => window.clearTimeout(id);
  }, [searchQuery, model]);

  useEffect(() => {
    if (!pendingSeekMs || !videoRef.current) {
      return;
    }
    const video = videoRef.current;
    const target = Math.max(0, pendingSeekMs / 1000);
    if (Number.isFinite(video.duration) && video.duration > 0) {
      video.currentTime = Math.min(target, video.duration);
      setPendingSeekMs(null);
      return;
    }
    const handler = () => {
      video.currentTime = Math.min(target, video.duration || target);
      setPendingSeekMs(null);
      video.removeEventListener("loadedmetadata", handler);
    };
    video.addEventListener("loadedmetadata", handler);
    return () => video.removeEventListener("loadedmetadata", handler);
  }, [pendingSeekMs]);

  const handlePlayPause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch(() => undefined);
    } else {
      video.pause();
    }
  }, []);

  const handleRestart = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = 0;
    video.play().catch(() => undefined);
  }, []);

  const handleSeek = useCallback((value: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = value;
  }, []);

  const handleSelectSegment = useCallback(
    (segment: TranscriptSegment) => {
      setPendingSeekMs(segment.start_ms);
    },
    [],
  );

  const handleSelectMatch = useCallback(
    (match: SearchMatch) => {
      if (match.video_path !== videoPath) {
        setVideoPath(match.video_path);
      }
      setPendingSeekMs(match.start_ms);
      setSearchQuery("");
      setMatches([]);
    },
    [videoPath],
  );

  const videoOptions = useMemo(() => {
    return videos.map((video) => ({
      path: video.path,
      label: video.name,
    }));
  }, [videos]);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "linear-gradient(180deg, #070b16 0%, #0a1224 40%, #0b1120 100%)",
        color: "#e2e8f0",
        padding: "32px 24px 80px",
        fontFamily: '"Space Grotesk", "Segoe UI", system-ui',
      }}
    >
      <div style={{ maxWidth: 1400, margin: "0 auto", display: "grid", gap: 24 }}>
        <header style={{ display: "grid", gap: 8 }}>
          <h1 style={{ fontSize: 32, margin: 0 }}>OBS Transcript Player</h1>
          <p style={{ margin: 0, color: "#94a3b8" }}>
            Search across transcripts, then jump the OBS video to the matching moment.
          </p>
        </header>

        <section
          style={{
            background: "rgba(15, 23, 42, 0.7)",
            borderRadius: 14,
            padding: 20,
            display: "grid",
            gap: 16,
            border: "1px solid rgba(30, 41, 59, 0.8)",
          }}
        >
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
            <label style={{ flex: "1 1 320px", display: "grid", gap: 6 }}>
              <span style={{ color: "#cbd5f5" }}>OBS folder</span>
              <input
                value={obsFolder}
                onChange={(event) => setObsFolder(event.target.value)}
                placeholder="C:\\Path\\To\\OBS"
                style={{
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "1px solid #1e293b",
                  background: "#0b1120",
                  color: "#e2e8f0",
                }}
              />
            </label>
            <button
              type="button"
              onClick={() => pickerRef.current?.click()}
              style={{
                width: 40,
                height: 40,
                borderRadius: 10,
                border: "1px solid #1e293b",
                background: "#0f172a",
                color: "#e2e8f0",
                cursor: "pointer",
              }}
              aria-label="Pick OBS folder"
              title="Pick OBS folder"
            >
              📂
            </button>
            <button
              type="button"
              onClick={loadVideos}
              style={{
                padding: "8px 12px",
                borderRadius: 8,
                border: "1px solid #1e293b",
                background: "#0f172a",
                color: "#e2e8f0",
                cursor: "pointer",
              }}
            >
              Refresh videos
            </button>
            <label style={{ display: "grid", gap: 6 }}>
              <span style={{ color: "#cbd5f5" }}>Model</span>
              <select
                value={model}
                onChange={(event) => setModel(event.target.value)}
                style={{
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "1px solid #1e293b",
                  background: "#0b1120",
                  color: "#e2e8f0",
                }}
              >
                {MODELS.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ flex: "1 1 320px", display: "grid", gap: 6 }}>
              <span style={{ color: "#cbd5f5" }}>Video</span>
              <select
                value={videoPath}
                onChange={(event) => setVideoPath(event.target.value)}
                style={{
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "1px solid #1e293b",
                  background: "#0b1120",
                  color: "#e2e8f0",
                }}
              >
                {videoOptions.map((opt) => (
                  <option key={opt.path} value={opt.path}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <input
            ref={pickerRef}
            type="file"
            style={{ display: "none" }}
            webkitdirectory=""
            onChange={(event) => {
              const folderName = event.target.files?.[0]?.path
                ? event.target.files[0].path.split("\\").slice(0, -1).join("\\")
                : "";
              if (folderName) {
                setObsFolder(folderName);
              }
            }}
          />
          <div style={{ color: "#94a3b8" }}>{status}</div>
        </section>

        <section style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)", gap: 20 }}>
          <div style={{ display: "grid", gap: 16 }}>
            <div
              style={{
                position: "relative",
                background: "#111",
                minHeight: 240,
                height: "min(60vh, 520px)",
                borderRadius: 12,
                overflow: "hidden",
              }}
            >
              {videoSrc ? (
                <video
                  ref={videoRef}
                  src={videoSrc}
                  preload="metadata"
                  playsInline
                  style={{ width: "100%", height: "100%", objectFit: "contain", background: "#0f172a" }}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  onTimeUpdate={() => setCurrentTime(videoRef.current?.currentTime || 0)}
                  onLoadedMetadata={() => setDuration(videoRef.current?.duration || 0)}
                />
              ) : (
                <div style={{ display: "grid", placeItems: "center", color: "#64748b", height: "100%" }}>
                  No video selected.
                </div>
              )}
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: 0,
                  padding: "16px 20px",
                  background: "linear-gradient(rgba(15, 23, 42, 0) 0%, rgba(15, 23, 42, 0.85) 100%)",
                  display: "grid",
                  gap: 12,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <button
                    type="button"
                    aria-label={isPlaying ? "Pause" : "Play"}
                    title={isPlaying ? "Pause" : "Play"}
                    onClick={handlePlayPause}
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
                    {isPlaying ? "❚❚" : "▶"}
                  </button>
                  <button
                    type="button"
                    aria-label="Restart"
                    title="Restart"
                    onClick={handleRestart}
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
                    ↺
                  </button>
                  <span style={{ color: "#e2e8f0", fontVariantNumeric: "tabular-nums" }}>
                    {formatTimestamp(currentTime * 1000)} / {formatTimestamp(duration * 1000)}
                  </span>
                </div>
                <input
                  min={0}
                  max={duration || 0}
                  step={0.05}
                  type="range"
                  value={currentTime}
                  onChange={(event) => handleSeek(Number(event.target.value))}
                  style={{ width: "100%", accentColor: "#38bdf8" }}
                />
              </div>
            </div>
          </div>

          <aside
            style={{
              background: "rgba(11, 17, 32, 0.9)",
              borderRadius: 16,
              padding: 16,
              border: "1px solid rgba(30, 41, 59, 0.7)",
              display: "grid",
              gap: 12,
              minWidth: 0,
              maxHeight: "calc(60vh + 120px)",
              overflow: "auto",
            }}
          >
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search transcripts"
              style={{
                padding: "8px 10px",
                borderRadius: 10,
                border: "1px solid #1e293b",
                background: "#0f172a",
                color: "#e2e8f0",
                width: "100%",
                boxSizing: "border-box",
              }}
            />

            {searchQuery.trim() ? (
              <div style={{ display: "grid", gap: 8 }}>
                {matches.length === 0 ? (
                  <div style={{ color: "#64748b" }}>No matches.</div>
                ) : (
                  matches.map((match, index) => (
                    <button
                      key={`${match.video_path}-${match.start_ms}-${index}`}
                      type="button"
                      onClick={() => handleSelectMatch(match)}
                      style={{
                        textAlign: "left",
                        borderRadius: 10,
                        padding: "10px 12px",
                        border: "1px solid rgba(30, 41, 59, 0.7)",
                        background: "rgba(9, 14, 26, 0.9)",
                        color: "#e2e8f0",
                        cursor: "pointer",
                        display: "grid",
                        gap: 6,
                      }}
                    >
                      <div style={{ fontSize: 12, color: "#94a3b8" }}>
                        {match.video_path.split("\\").pop()} • {formatTimestamp(match.start_ms)}
                      </div>
                      <div>{clipText(match.text)}</div>
                    </button>
                  ))
                )}
              </div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {segments.length === 0 ? (
                  <div style={{ color: "#64748b" }}>No transcript segments loaded.</div>
                ) : (
                  segments.map((segment, index) => (
                    <button
                      key={`${segment.run_id}-${segment.start_ms}-${index}`}
                      type="button"
                      onClick={() => handleSelectSegment(segment)}
                      style={{
                        textAlign: "left",
                        borderRadius: 10,
                        padding: "10px 12px",
                        border: "1px solid rgba(30, 41, 59, 0.7)",
                        background: "rgba(9, 14, 26, 0.9)",
                        color: "#e2e8f0",
                        cursor: "pointer",
                        display: "grid",
                        gap: 6,
                      }}
                    >
                      <div style={{ fontSize: 12, color: "#94a3b8" }}>{formatTimestamp(segment.start_ms)}</div>
                      <div>{clipText(segment.text)}</div>
                    </button>
                  ))
                )}
              </div>
            )}
          </aside>
        </section>
      </div>
    </div>
  );
}
