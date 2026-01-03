"use client";

// Video frame search and playback page
// Allows searching OCR text and audio transcriptions with thumbnail grid
// Includes frame viewer with prev/next navigation and playback mode

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Type definition for OCR search results
// Each result represents a video frame with extracted text
type OcrItem = {
  source: "ocr";
  frame_id: number;
  ocr_text: string; // Extracted text from frame
  timestamp: string; // ISO timestamp of frame
  frame_name?: string | null;
  file_path: string; // Path to video file
  offset_index: number; // Seek position in seconds
  app_name?: string | null; // Application window (e.g., "chrome")
  window_name?: string | null; // Window title
};

// Type definition for audio transcription search results
// May include nearest video frame if audio-to-frame mapping is enabled
type AudioItem = {
  source: "audio";
  id: number;
  session_id: number;
  transcription: string; // Transcribed text
  timestamp: string; // ISO timestamp of transcription
  nearest_frame?: {
    file_path: string;
    offset_index: number;
    frame_timestamp?: string;
  };
};

// API response structure from /api/video/search
type SearchResponse = {
  data: {
    ocr: OcrItem[];
    audio: AudioItem[];
  };
};

// Main video search page component
export default function VideoPage() {
  // Search form state
  const [q, setQ] = useState(""); // Search query text
  const [appName, setAppName] = useState(""); // Filter by application name
  const [startTime, setStartTime] = useState(""); // ISO timestamp filter
  const [includeOcr, setIncludeOcr] = useState(true); // Search OCR frames
  const [includeAudio, setIncludeAudio] = useState(false); // Search audio transcriptions
  
  // Search results state
  const [ocr, setOcr] = useState<OcrItem[]>([]);
  const [audio, setAudio] = useState<AudioItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false); // Has user performed a search yet
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Frame viewer state
  const [current, setCurrent] = useState<{
    file_path: string;
    offset_index: number;
    timestamp?: string;
  } | null>(null); // Currently displayed frame
  const [playing, setPlaying] = useState(false); // Auto-advance mode
  const [fitMode, setFitMode] = useState(true); // fit-to-viewer vs actual size
  const playTimer = useRef<NodeJS.Timeout | null>(null); // Timer for auto-advance
  const playingRef = useRef(false); // Ref for cleanup in effect
  const [stepIntervalMs, setStepIntervalMs] = useState(700); // Delay between frames in play mode
  const [loadingFrame, setLoadingFrame] = useState(false);
  
  // Unique key for img element to force reload on frame change
  const imgKey = useMemo(() => (current ? `${current.file_path}:${current.offset_index}` : ""), [current]);

  // Executes search query and updates results
  // Builds API URL with all search parameters
  const doSearch = useCallback(async () => {
    setLoading(true);
    try {
      setErrorMsg(null);
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      
      // Build sources parameter from checkboxes
      const sources: string[] = [];
      if (includeOcr) sources.push("ocr");
      if (includeAudio) sources.push("audio");
      params.set("sources", sources.join(",") || "ocr");
      
      if (appName) params.set("app_name", appName);
      if (startTime) params.set("start_time", startTime);
      params.set("limit", "48");
      
      const res = await fetch(`/api/video/search?${params.toString()}`);
      const json: SearchResponse = await res.json();
      setOcr(json.data.ocr || []);
      setAudio(json.data.audio || []);
      setSearched(true);
    } catch (e) {
      console.error(e);
      setErrorMsg((e as Error)?.message || "Search failed");
      setSearched(true);
    } finally {
      setLoading(false);
    }
  }, [q, includeOcr, includeAudio, appName, startTime]);

  useEffect(() => {
    // First load shows nothing until user searches
  }, []);

  // Opens a frame in the viewer
  // Called when user double-clicks a thumbnail
  const openItem = useCallback((file_path: string, offset_index: number, timestamp?: string) => {
    setCurrent({ file_path, offset_index, timestamp });
  }, []);

  // Navigates to adjacent frame (prev or next)
  // Returns true if successful, false if reached end
  const step = useCallback(async (dir: "prev" | "next") => {
    if (!current) return false;
    const params = new URLSearchParams({
      file_path: current.file_path,
      offset_index: String(current.offset_index),
      dir,
    });
    const res = await fetch(`/api/video/neighbor?${params.toString()}`);
    const data = await res.json();
    if (data && data.offset_index != null) {
      setLoadingFrame(true);
      setCurrent({ file_path: data.file_path, offset_index: data.offset_index, timestamp: data.timestamp });
      return true;
    } else {
      // Reached end of video chunk
      setPlaying(false);
      return false;
    }
  }, [current]);

  // Effect for auto-advance playback mode
  // Continuously calls step("next") at configured interval
  useEffect(() => {
    playingRef.current = playing;
    if (!playing) return;
    
    let cancelled = false;
    const tick = async () => {
      if (!playingRef.current || cancelled) return;
      await step("next");
      if (!playingRef.current || cancelled) return;
      playTimer.current = setTimeout(tick, stepIntervalMs) as unknown as NodeJS.Timeout;
    };
    tick();
    
    // Cleanup on unmount or when playing stops
    return () => {
      cancelled = true;
      if (playTimer.current) clearTimeout(playTimer.current);
      playTimer.current = null;
    };
  }, [playing, step, stepIntervalMs]);

  const hasViewer = Boolean(current);

  return (
    <main style={{ display: "grid", gap: 12 }}>
      <h1>Video Frames</h1>
      
      {/* Search form with filters */}
      <form onSubmit={(e) => { e.preventDefault(); doSearch(); }} style={{ display: "grid", gap: 8, gridTemplateColumns: "1fr auto auto auto auto", alignItems: "end" }}>
        <div>
          <label>Query</label>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search text" />
        </div>
        <div>
          <label>App Name (OCR)</label>
          <input value={appName} onChange={(e) => setAppName(e.target.value)} placeholder="e.g. chrome" />
        </div>
        <div>
          <label>Start Time</label>
          <input value={startTime} onChange={(e) => setStartTime(e.target.value)} placeholder="YYYY-MM-DDTHH:MM:SSZ" />
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={includeOcr} onChange={(e) => setIncludeOcr(e.target.checked)} /> OCR
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={includeAudio} onChange={(e) => setIncludeAudio(e.target.checked)} /> Audio
          </label>
        </div>
        <button type="submit" disabled={loading}>
          {loading ? "Searching..." : "Search"}
        </button>
      </form>

      {/* Frame viewer with playback controls */}
      {hasViewer && (
        <section className="card" style={{ padding: 8, flexDirection: "column", alignItems: "stretch", gap: 8 }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" onClick={() => step("prev")}>Prev</button>
            <button type="button" onClick={() => setPlaying((p) => !p)}>{playing ? "Pause" : "Play"}</button>
            <button type="button" onClick={() => step("next")}>Next</button>
            <button type="button" onClick={() => setFitMode((f) => !f)}>{fitMode ? "Actual" : "Fit"}</button>
            <div style={{ color: "#777" }}>{current?.timestamp ?? ""}</div>
            <div className="muted">Speed:
              <select value={stepIntervalMs} onChange={(e) => setStepIntervalMs(Number(e.target.value))} style={{ marginLeft: 6 }}>
                <option value={1200}>~0.8 fps</option>
                <option value={900}>~1.1 fps</option>
                <option value={700}>~1.4 fps</option>
                <option value={500}>~2.0 fps</option>
              </select>
            </div>
          </div>
          
          {/* Frame metadata */}
          <div style={{ display: "grid", gap: 4, fontSize: 12, color: "#9aa7b0" }}>
            <div><strong>File:</strong> {current?.file_path}</div>
            <div><strong>Offset:</strong> {current?.offset_index}s</div>
            <div><strong>Time:</strong> {current?.timestamp}</div>
          </div>
          
          {/* Frame image viewer */}
          <div className="viewer">
            <img
              key={imgKey}
              src={`/api/video/frame?file_path=${encodeURIComponent(current!.file_path)}&offset_index=${current!.offset_index}&timestamp=${encodeURIComponent(current!.timestamp || "")}&v=${current!.offset_index}`}
              className={fitMode ? "fit" : "actual"}
              alt="frame"
              onLoad={() => setLoadingFrame(false)}
              onError={() => setLoadingFrame(false)}
            />
            {loadingFrame && <div className="muted" style={{ position: "absolute", padding: 6, background: "rgba(0,0,0,0.5)", borderRadius: 6 }}>Loading…</div>}
          </div>
        </section>
      )}

      {/* Error message display */}
      {errorMsg && (
        <div className="card" style={{ borderColor: "#7f1d1d", color: "#fca5a5" }}>Error: {errorMsg}</div>
      )}

      {/* OCR results grid */}
      {includeOcr && (
        <section>
          <h2>OCR Frames</h2>
          <div className="list">
            {searched && !loading && ocr.length === 0 && (
              <div className="muted">No OCR matches found</div>
            )}
            {ocr.map((r) => (
              <div
                key={r.frame_id}
                className="card"
                style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: 12, alignItems: "flex-start", cursor: "pointer" }}
                onDoubleClick={() => openItem(r.file_path, r.offset_index, r.timestamp)}
              >
                {/* Thumbnail image */}
                <img
                  src={`/api/video/frame?file_path=${encodeURIComponent(r.file_path)}&offset_index=${r.offset_index}&timestamp=${encodeURIComponent(r.timestamp)}&thumb=1`}
                  alt="thumb"
                  style={{ width: 160, height: 90, objectFit: "cover", borderRadius: 6 }}
                />
                <div>
                  {/* OCR text with ellipsis overflow */}
                  <div className="title" title={r.ocr_text} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {r.ocr_text}
                  </div>
                  <div className="muted">{r.timestamp} {r.app_name ? `• ${r.app_name}` : ""}</div>
                  {r.window_name ? <div className="muted">{r.window_name}</div> : null}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Audio transcription results */}
      {includeAudio && (
        <section>
          <h2>Audio Transcriptions</h2>
          <div className="list">
            {searched && !loading && audio.length === 0 && (
              <div className="muted">No Audio matches found</div>
            )}
            {audio.map((a) => (
              <div key={a.id} className="card" style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: 12 }}>
                <div>
                  {/* Show nearest video frame if available */}
                  {a.nearest_frame ? (
                    <img
                      src={`/api/video/frame?file_path=${encodeURIComponent(a.nearest_frame.file_path)}&offset_index=${a.nearest_frame.offset_index}&timestamp=${encodeURIComponent(a.nearest_frame.frame_timestamp || a.timestamp)}&thumb=1`}
                      alt="thumb"
                      style={{ width: 160, height: 90, objectFit: "cover", borderRadius: 6, cursor: "pointer" }}
                      onDoubleClick={() => openItem(a.nearest_frame!.file_path, a.nearest_frame!.offset_index, a.timestamp)}
                    />
                  ) : (
                    <div style={{ width: 160, height: 90, background: "#eee", borderRadius: 6 }} />
                  )}
                </div>
                <div>
                  <div className="muted">{a.timestamp}</div>
                  {/* Show first 400 chars of transcription */}
                  <div style={{ whiteSpace: "pre-wrap" }}>{a.transcription.slice(0, 400)}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Empty state message */}
      {searched && !loading && ((includeOcr && ocr.length === 0) && (!includeAudio || audio.length === 0)) && (
        <div className="muted">No results found</div>
      )}
    </main>
  );
}
