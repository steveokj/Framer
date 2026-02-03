"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

type TranscriptStatus = {
  video_path: string;
  run_id: number | null;
  model: string | null;
  status: string;
  progress: number;
  started_ms?: number | null;
  ended_ms?: number | null;
  error?: string | null;
  last_update_ms?: number | null;
};

const DEFAULT_OBS_FOLDER = "C:\\Users\\steve\\Desktop\\Desktop II\\OBS";
const LAST_FOLDER_KEY = "timestone:obs_transcripts:folder";
const LAST_MODEL_KEY = "timestone:obs_transcripts:model";
const MODELS = ["tiny", "small", "medium", "large-v2"];

function formatDate(ms: number | null): string {
  if (!ms) {
    return "--";
  }
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDuration(seconds: number | null): string {
  if (!Number.isFinite(seconds)) {
    return "--:--";
  }
  const total = Math.max(0, seconds || 0);
  const mins = Math.floor(total / 60);
  const secs = Math.floor(total % 60);
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

export default function ObsTranscriptsPage() {
  const [obsFolder, setObsFolder] = useState("");
  const [videos, setVideos] = useState<ObsVideo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMap, setStatusMap] = useState<Map<string, TranscriptStatus>>(new Map());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastChecked, setLastChecked] = useState<number | null>(null);
  const [model, setModel] = useState("medium");
  const [runningCount, setRunningCount] = useState(0);
  const [missingDurations, setMissingDurations] = useState(0);
  const [logOpen, setLogOpen] = useState(false);
  const [logText, setLogText] = useState("");
  const [logLoading, setLogLoading] = useState(false);
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
    if (!obsFolder.trim()) {
      return;
    }
    localStorage.setItem(LAST_FOLDER_KEY, obsFolder);
  }, [obsFolder]);

  useEffect(() => {
    localStorage.setItem(LAST_MODEL_KEY, model);
  }, [model]);

  const loadVideos = useCallback(async () => {
    if (!obsFolder.trim()) {
      setVideos([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/obs_videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderPath: obsFolder, fastScan: true, hydrate: true }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `Failed to scan OBS folder (${res.status})`);
      }
      const data = await res.json();
      const list = Array.isArray(data?.videos) ? (data.videos as ObsVideo[]) : [];
      setMissingDurations(Number(data?.missing_durations) || 0);
      list.sort((a, b) => (b.start_ms || 0) - (a.start_ms || 0));
      setVideos(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load videos");
      setVideos([]);
    } finally {
      setLoading(false);
    }
  }, [obsFolder]);

  const loadStatus = useCallback(async () => {
    if (!videos.length) {
      setStatusMap(new Map());
      setRunningCount(0);
      return;
    }
    try {
      const res = await fetch("/api/obs_transcripts/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videos: videos.map((v) => v.path), model }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `Failed to load transcript status (${res.status})`);
      }
      const data = await res.json();
      const rows = Array.isArray(data?.status) ? (data.status as TranscriptStatus[]) : [];
      const map = new Map<string, TranscriptStatus>();
      let running = 0;
      rows.forEach((row) => {
        map.set(row.video_path, row);
        if (row.status === "running") {
          running += 1;
        }
      });
      setStatusMap(map);
      setRunningCount(running);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load transcript status");
    }
  }, [videos, model]);

  useEffect(() => {
    if (!obsFolder.trim()) {
      return;
    }
    loadVideos();
  }, [loadVideos, obsFolder]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    const source = new EventSource("/api/obs_transcripts/stream");
    const onDb = () => loadStatus();
    const onCache = () => loadVideos();
    source.addEventListener("db", onDb);
    source.addEventListener("cache", onCache);
    return () => {
      source.removeEventListener("db", onDb);
      source.removeEventListener("cache", onCache);
      source.close();
    };
  }, [loadStatus, loadVideos]);

  const selectedList = useMemo(() => Array.from(selected), [selected]);

  const toggleSelectAll = useCallback(() => {
    if (selected.size === videos.length) {
      setSelected(new Set());
      return;
    }
    setSelected(new Set(videos.map((v) => v.path)));
  }, [selected, videos]);

  const handleCheckbox = useCallback(
    (index: number, path: string, checked: boolean, shift: boolean) => {
      setSelected((prev) => {
        const next = new Set(prev);
        if (shift && lastChecked != null && lastChecked !== index) {
          const [start, end] = lastChecked < index ? [lastChecked, index] : [index, lastChecked];
          for (let i = start; i <= end; i += 1) {
            const target = videos[i];
            if (!target) continue;
            if (checked) {
              next.add(target.path);
            } else {
              next.delete(target.path);
            }
          }
        } else {
          if (checked) {
            next.add(path);
          } else {
            next.delete(path);
          }
        }
        return next;
      });
      setLastChecked(index);
    },
    [lastChecked, videos],
  );

  const startTranscribe = useCallback(async () => {
    if (!selectedList.length) {
      return;
    }
    setError(null);
    try {
      const res = await fetch("/api/obs_transcripts/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videos: selectedList, model }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `Failed to start transcription (${res.status})`);
      }
      setTimeout(() => loadStatus(), 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start transcription");
    }
  }, [selectedList, model, loadStatus]);

  const fetchLog = useCallback(async () => {
    setLogLoading(true);
    try {
      const res = await fetch("/api/obs_transcripts/log");
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `Failed to load log (${res.status})`);
      }
      const data = await res.json();
      setLogText(typeof data?.log === "string" ? data.log : "");
    } catch (err) {
      setLogText(err instanceof Error ? err.message : "Failed to load log");
    } finally {
      setLogLoading(false);
    }
  }, []);

  const untranscribedCount = useMemo(() => {
    let count = 0;
    videos.forEach((video) => {
      const status = statusMap.get(video.path);
      if (!status || status.status === "idle") {
        count += 1;
      }
    });
    return count;
  }, [videos, statusMap]);

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
        <div
          style={{
            position: "sticky",
            top: 0,
            zIndex: 20,
            paddingBottom: 12,
            background: "linear-gradient(180deg, rgba(7, 11, 22, 0.98) 0%, rgba(7, 11, 22, 0.9) 100%)",
            borderBottom: "1px solid rgba(30, 41, 59, 0.8)",
          }}
        >
          <header style={{ display: "grid", gap: 8, paddingTop: 12 }}>
            <h1 style={{ fontSize: 32, margin: 0 }}>OBS Transcript Manager</h1>
            <p style={{ margin: 0, color: "#94a3b8" }}>
              Select OBS recordings to transcribe, track progress, and jump into the transcript player.
            </p>
          </header>

          <section
            style={{
              marginTop: 16,
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
            <button
              type="button"
              onClick={startTranscribe}
              disabled={selectedList.length === 0}
              style={{
                padding: "8px 12px",
                borderRadius: 8,
                border: "1px solid #38bdf8",
                background: selectedList.length ? "rgba(56, 189, 248, 0.18)" : "rgba(15, 23, 42, 0.6)",
                color: selectedList.length ? "#e0f2fe" : "#64748b",
                cursor: selectedList.length ? "pointer" : "not-allowed",
              }}
            >
              Transcribe selected
            </button>
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
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", color: "#94a3b8" }}>
            <span>Videos: {videos.length}</span>
            <span>Selected: {selected.size}</span>
            <span>Untranscribed: {untranscribedCount}</span>
            {runningCount > 0 ? <span>Running: {runningCount}</span> : null}
            {missingDurations > 0 ? <span>Durations pending: {missingDurations}</span> : null}
            <button
              type="button"
              onClick={loadStatus}
              style={{
                padding: "4px 10px",
                borderRadius: 999,
                border: "1px solid #1e293b",
                background: "#0f172a",
                color: "#cbd5f5",
                cursor: "pointer",
              }}
            >
              Refresh status
            </button>
            <button
              type="button"
              onClick={() => {
                setLogOpen(true);
                fetchLog();
              }}
              style={{
                padding: "4px 10px",
                borderRadius: 999,
                border: "1px solid #1e293b",
                background: "#0f172a",
                color: "#cbd5f5",
                cursor: "pointer",
              }}
            >
              View log
            </button>
          </div>
          {error ? <div style={{ color: "#fca5a5" }}>{error}</div> : null}
        </section>
        </div>

        <section style={{ display: "grid", gap: 12 }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <button
              type="button"
              onClick={toggleSelectAll}
              style={{
                padding: "6px 10px",
                borderRadius: 8,
                border: "1px solid #1e293b",
                background: "#0f172a",
                color: "#e2e8f0",
                cursor: "pointer",
              }}
            >
              {selected.size === videos.length ? "Clear all" : "Select all"}
            </button>
            {loading ? <span style={{ color: "#94a3b8" }}>Loading...</span> : null}
          </div>

          <div style={{ display: "grid", gap: 12 }}>
            {videos.length === 0 ? (
              <div style={{ color: "#64748b" }}>No videos found.</div>
            ) : (
              videos.map((video, index) => {
                const status = statusMap.get(video.path);
                const isChecked = selected.has(video.path);
                const isRunning = status?.status === "running";
                const progress = Math.min(Math.max(status?.progress || 0, 0), 1);
                const lastUpdate = status?.last_update_ms || null;
                const isStuck = isRunning && lastUpdate ? Date.now() - lastUpdate > 5 * 60 * 1000 : false;
                return (
                  <div
                    key={video.path}
                    style={{
                      borderRadius: 14,
                      padding: "14px 16px",
                      border: "1px solid rgba(30, 41, 59, 0.7)",
                      background: "rgba(11, 17, 32, 0.9)",
                      display: "grid",
                      gap: 10,
                    }}
                  >
                    <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={(event) =>
                          handleCheckbox(index, video.path, event.target.checked, event.shiftKey)
                        }
                      />
                      <div style={{ flex: 1, minWidth: 220 }}>
                        <div style={{ fontWeight: 600 }}>{video.name}</div>
                        <div style={{ color: "#94a3b8", fontSize: 12, overflowWrap: "anywhere" }}>{video.path}</div>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          (window.location.href = `/obs_transcripts_player?video=${encodeURIComponent(
                            video.path,
                          )}`)
                        }
                        style={{
                          padding: "6px 10px",
                          borderRadius: 8,
                          border: "1px solid #38bdf8",
                          background: "rgba(56, 189, 248, 0.18)",
                          color: "#e0f2fe",
                          cursor: "pointer",
                        }}
                      >
                        Open player
                      </button>
                    </div>
                    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", color: "#94a3b8", fontSize: 13 }}>
                      <span>Start: {formatDate(video.start_ms)}</span>
                      <span>Duration: {formatDuration(video.duration_s)}</span>
                      <span>Status: {status?.status || "idle"}</span>
                      {status?.model ? <span>Model: {status.model}</span> : null}
                      {lastUpdate ? <span>Last update: {formatDate(lastUpdate)}</span> : null}
                      {isStuck ? <span style={{ color: "#fca5a5" }}>Stuck?</span> : null}
                    </div>
                    {isRunning ? (
                      <div style={{ display: "grid", gap: 6 }}>
                        <div
                          style={{
                            height: 8,
                            borderRadius: 999,
                            background: "rgba(148, 163, 184, 0.2)",
                            overflow: "hidden",
                          }}
                        >
                          <div
                            style={{
                              height: "100%",
                              width: `${Math.round(progress * 100)}%`,
                              background: "rgba(56, 189, 248, 0.9)",
                              transition: "width 0.3s ease",
                            }}
                          />
                        </div>
                        <div style={{ color: "#cbd5f5", fontSize: 12 }}>{Math.round(progress * 100)}%</div>
                      </div>
                    ) : null}
                    {status?.error ? <div style={{ color: "#fca5a5" }}>{status.error}</div> : null}
                  </div>
                );
              })
            )}
          </div>
        </section>

        {logOpen ? (
          <div
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(2, 6, 23, 0.75)",
              display: "grid",
              placeItems: "center",
              zIndex: 50,
            }}
            onClick={() => setLogOpen(false)}
          >
            <div
              style={{
                width: "min(1000px, 92vw)",
                maxHeight: "80vh",
                background: "#0b1120",
                borderRadius: 16,
                border: "1px solid rgba(30, 41, 59, 0.9)",
                padding: 16,
                display: "grid",
                gap: 12,
              }}
              onClick={(event) => event.stopPropagation()}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <strong>Transcription log</strong>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    onClick={fetchLog}
                    style={{
                      padding: "6px 10px",
                      borderRadius: 8,
                      border: "1px solid #1e293b",
                      background: "#0f172a",
                      color: "#e2e8f0",
                      cursor: "pointer",
                    }}
                  >
                    Refresh
                  </button>
                  <button
                    type="button"
                    onClick={() => setLogOpen(false)}
                    style={{
                      padding: "6px 10px",
                      borderRadius: 8,
                      border: "1px solid #1e293b",
                      background: "#0f172a",
                      color: "#e2e8f0",
                      cursor: "pointer",
                    }}
                  >
                    Close
                  </button>
                </div>
              </div>
              <div
                style={{
                  background: "#020617",
                  borderRadius: 12,
                  border: "1px solid rgba(30, 41, 59, 0.8)",
                  padding: 12,
                  fontFamily: "Consolas, 'SFMono-Regular', Menlo, monospace",
                  fontSize: 12,
                  color: "#e2e8f0",
                  whiteSpace: "pre-wrap",
                  overflow: "auto",
                  maxHeight: "60vh",
                }}
              >
                {logLoading ? "Loading..." : logText || "No log output."}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
