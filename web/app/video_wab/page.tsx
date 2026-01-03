"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Segment = {
  id: number;
  start: number;
  end: number;
  text: string;
};

const DEFAULT_VIDEO = "merged_test_db_vfr.mp4";
const DEFAULT_AUDIO = "sessions/session-20251011-221322.wav";
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
    return { url: null, warning: "Provide a path relative to the project root so it can be served via /files." };
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

export default function VideoWABPage() {
  const [videoInput, setVideoInput] = useState(DEFAULT_VIDEO);
  const [audioInput, setAudioInput] = useState(DEFAULT_AUDIO);
  const [videoPath, setVideoPath] = useState(DEFAULT_VIDEO);
  const [audioPath, setAudioPath] = useState(DEFAULT_AUDIO);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const { url: videoUrl, warning: videoWarning } = useMemo(() => buildFileUrl(videoPath), [videoPath]);
  const { url: audioUrl, warning: audioWarning } = useMemo(() => buildFileUrl(audioPath), [audioPath]);

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
      setTranscriptError(err instanceof Error ? err.message : "Failed to load transcript");
    } finally {
      setLoadingTranscript(false);
    }
  }, [audioPath]);

  useEffect(() => {
    fetchTranscript();
  }, [fetchTranscript]);

  useEffect(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video || !audio) {
      return;
    }

    const syncAudio = () => {
      if (!video || !audio) return;
      const diff = Math.abs(video.currentTime - audio.currentTime);
      if (diff > 0.15) {
        audio.currentTime = video.currentTime;
      }
    };

    const handlePlay = () => {
      audio.play().catch(() => {
        /* swallow */
      });
    };
    const handlePause = () => {
      audio.pause();
    };

    video.addEventListener("play", handlePlay);
    video.addEventListener("pause", handlePause);
    video.addEventListener("seeked", syncAudio);
    video.addEventListener("timeupdate", syncAudio);

    return () => {
      video.removeEventListener("play", handlePlay);
      video.removeEventListener("pause", handlePause);
      video.removeEventListener("seeked", syncAudio);
      video.removeEventListener("timeupdate", syncAudio);
    };
  }, [videoUrl, audioUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const handle = () => setCurrentTime(video.currentTime);
    video.addEventListener("timeupdate", handle);
    return () => video.removeEventListener("timeupdate", handle);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (video) {
      video.load();
    }
    if (audio) {
      audio.load();
    }
  }, [videoUrl, audioUrl]);

  const activeSegment = useMemo(() => {
    return segments.find((seg) => currentTime >= seg.start && currentTime < seg.end) || null;
  }, [segments, currentTime]);

  const handleSeekToSegment = (segment: Segment) => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video || !audio) return;
    video.currentTime = segment.start;
    audio.currentTime = segment.start;
    video.play().catch(() => {
      /* ignore */
    });
  };

  const handleFormSubmit = (evt: React.FormEvent<HTMLFormElement>) => {
    evt.preventDefault();
    setVideoPath(videoInput.trim());
    setAudioPath(audioInput.trim());
  };

  return (
    <main style={{ display: "grid", gap: 24, padding: 24 }}>
      <header>
        <h1>Video + Audio + Transcript (Option B)</h1>
        <p style={{ color: "#607080" }}>
          Provide project-relative paths. The player keeps audio and video separate while maintaining sync, and the
          transcript stays aligned in real time.
        </p>
      </header>

      <section>
        <form onSubmit={handleFormSubmit} style={{ display: "grid", gap: 12, maxWidth: 640 }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span>Video path (relative to project root)</span>
            <input
              type="text"
              value={videoInput}
              onChange={(e) => setVideoInput(e.target.value)}
              style={{ padding: "8px 10px" }}
            />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span>Audio path (relative to project root)</span>
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
        <div style={{ position: "relative", background: "#111", minHeight: 320, borderRadius: 12, overflow: "hidden" }}>
          {videoUrl ? (
            <video ref={videoRef} src={videoUrl} controls style={{ width: "100%", height: "100%", objectFit: "contain" }} />
          ) : (
            <div style={{ padding: 40, color: "#eee" }}>Enter a project-relative video path to start playback.</div>
          )}
          <audio ref={audioRef} src={audioUrl || undefined} />
        </div>

        <div style={{ background: "#0f172a", color: "#f8fafc", padding: 16, borderRadius: 8 }}>
          <strong>Current transcript:</strong>
          <div style={{ marginTop: 8, minHeight: 40 }}>
            {activeSegment ? activeSegment.text : loadingTranscript ? "Transcribing..." : "--"}
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
    </main>
  );
}




