"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type TimestoneSession = {
  session_id: string;
  start_wall_ms: number;
  start_wall_iso: string;
  obs_video_path: string | null;
};

type TimestoneEvent = {
  id: number;
  session_id: string;
  ts_wall_ms: number;
  ts_mono_ms: number;
  event_type: string;
  process_name: string | null;
  window_title: string | null;
  window_class: string | null;
  window_rect: string | null;
  mouse: string | null;
  payload: string | null;
};

type RecordSegment = {
  id: number;
  session_id: string | null;
  start_wall_ms: number;
  end_wall_ms: number | null;
  obs_path: string | null;
  processed: number;
  created_wall_ms: number | null;
};

type EventView = TimestoneEvent & {
  payloadData: any;
  mouseData: any;
};

type EventFrame = {
  frame_path: string;
  frame_wall_ms: number | null;
};

type VideoInfo = {
  path: string;
  offsetMs: number;
};

type SegmentMarker = {
  kind: "segment";
  id: string;
  ts_wall_ms: number;
  label: string;
};

type ListRow = { kind: "event"; event: EventView } | SegmentMarker;

const API_BASE = (
  process.env.NEXT_PUBLIC_API_BASE && process.env.NEXT_PUBLIC_API_BASE.trim().length > 0
    ? process.env.NEXT_PUBLIC_API_BASE
    : "http://localhost:8001"
).replace(/\/$/, "");

const ABSOLUTE_PATH_REGEX = /^[a-zA-Z]:[\\/]|^\//;
const LAST_SESSION_STORAGE_KEY = "timestone:lastSessionId:mkv_tapper";

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

function formatWallTime(ts: number): string {
  if (!Number.isFinite(ts)) {
    return "--:--:--";
  }
  return new Date(ts).toLocaleTimeString();
}

function formatSessionDate(value: string): string {
  const cleaned = value.replace(/\.\d+/, "");
  const parsed = Date.parse(cleaned);
  if (!Number.isFinite(parsed)) {
    return value;
  }
  return new Date(parsed).toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function safeJsonParse(input: string | null): any {
  if (!input) {
    return null;
  }
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function eventSearchBlob(event: EventView): string {
  const payload = event.payloadData || {};
  const mouse = event.mouseData || {};
  return [
    event.event_type,
    event.window_title || "",
    event.process_name || "",
    event.window_class || "",
    payload?.text || "",
    payload?.final_text || "",
    payload?.note || "",
    payload?.key || "",
    payload?.vk || "",
    mouse?.x != null && mouse?.y != null ? `click ${mouse.x},${mouse.y}` : "",
  ]
    .join(" ")
    .toLowerCase();
}

export default function MkvTapperPage() {
  const [sessions, setSessions] = useState<TimestoneSession[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [segments, setSegments] = useState<RecordSegment[]>([]);
  const [events, setEvents] = useState<EventView[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<EventView | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [eventVisibility, setEventVisibility] = useState<Record<string, boolean>>({
    active_window_changed: true,
    key_down: true,
    key_shortcut: true,
    text_input: true,
    mouse_click: true,
    clipboard_text: true,
    clipboard_image: true,
    clipboard_files: true,
    marker: true,
  });
  const [eventFrames, setEventFrames] = useState<EventFrame[]>([]);
  const [frameIndex, setFrameIndex] = useState(0);
  const [frameLoading, setFrameLoading] = useState(false);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [eventFrameIds, setEventFrameIds] = useState<Set<number>>(new Set());
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [pendingSeekMs, setPendingSeekMs] = useState<number | null>(null);
  const [status, setStatus] = useState("Idle");
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem(LAST_SESSION_STORAGE_KEY);
    if (saved) {
      setSessionId(saved);
    }
  }, []);

  useEffect(() => {
    if (!sessionId.trim()) {
      localStorage.removeItem(LAST_SESSION_STORAGE_KEY);
      return;
    }
    localStorage.setItem(LAST_SESSION_STORAGE_KEY, sessionId);
  }, [sessionId]);

  const activeSession = useMemo(
    () => sessions.find((session) => session.session_id === sessionId) || null,
    [sessions, sessionId]
  );

  const eventTypes = useMemo(() => {
    const types = new Set<string>();
    events.forEach((event) => types.add(event.event_type));
    return Array.from(types).sort();
  }, [events]);

  useEffect(() => {
    setEventVisibility((prev) => {
      const next = { ...prev };
      for (const type of eventTypes) {
        if (!(type in next)) {
          next[type] = true;
        }
      }
      return next;
    });
  }, [eventTypes]);

  const filteredEvents = useMemo(() => {
    let list = events;
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter((event) => eventSearchBlob(event).includes(q));
    }
    list = list.filter((event) => eventVisibility[event.event_type] !== false);
    return list;
  }, [events, eventVisibility, searchQuery]);

  const sessionSegments = useMemo(() => {
    if (!sessionId) {
      return [];
    }
    return segments
      .filter((segment) => segment.session_id === sessionId && segment.end_wall_ms != null)
      .sort((a, b) => a.start_wall_ms - b.start_wall_ms);
  }, [segments, sessionId]);

  const segmentMarkers = useMemo(() => {
    if (!sessionSegments.length) {
      return [];
    }
    const lastIndex = sessionSegments.length - 1;
    return sessionSegments.map((segment, index) => ({
      kind: "segment" as const,
      id: `segment-${segment.id}`,
      ts_wall_ms: segment.end_wall_ms || segment.start_wall_ms,
      label: index === lastIndex ? "Segment Stop" : "Segment Pause",
    }));
  }, [sessionSegments]);

  const listRows = useMemo(() => {
    const rows: ListRow[] = [
      ...filteredEvents.map((event) => ({ kind: "event" as const, event })),
      ...segmentMarkers,
    ];
    return rows.sort((a, b) => {
      const aTs = a.kind === "event" ? a.event.ts_wall_ms : a.ts_wall_ms;
      const bTs = b.kind === "event" ? b.event.ts_wall_ms : b.ts_wall_ms;
      return bTs - aTs;
    });
  }, [filteredEvents, segmentMarkers]);

  const segmentOffsets = useMemo(() => {
    const offsets = new Map<number, number>();
    const byPath = new Map<string, RecordSegment[]>();
    for (const segment of segments) {
      if (!segment.obs_path) {
        continue;
      }
      const list = byPath.get(segment.obs_path) || [];
      list.push(segment);
      byPath.set(segment.obs_path, list);
    }
    for (const [_, list] of byPath.entries()) {
      list.sort((a, b) => a.start_wall_ms - b.start_wall_ms);
      let cumulative = 0;
      for (const segment of list) {
        offsets.set(segment.id, cumulative);
        if (segment.end_wall_ms != null) {
          cumulative += Math.max(0, segment.end_wall_ms - segment.start_wall_ms);
        }
      }
    }
    return offsets;
  }, [segments]);

  const pickClosestFrameIndex = useCallback((frames: EventFrame[], wallMs: number) => {
    if (!frames.length) {
      return 0;
    }
    let bestIndex = 0;
    let bestDiff = Math.abs((frames[0].frame_wall_ms ?? wallMs) - wallMs);
    for (let i = 1; i < frames.length; i += 1) {
      const candidate = frames[i];
      const diff = Math.abs((candidate.frame_wall_ms ?? wallMs) - wallMs);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIndex = i;
      }
    }
    return bestIndex;
  }, []);

  const resolveVideoInfo = useCallback(
    (event: EventView): VideoInfo | null => {
      if (!segments.length) {
        return null;
      }
      const sorted = [...segments].sort((a, b) => a.start_wall_ms - b.start_wall_ms);
      let match =
        sorted.find(
          (segment) =>
            segment.start_wall_ms <= event.ts_wall_ms &&
            (segment.end_wall_ms == null || event.ts_wall_ms <= segment.end_wall_ms),
        ) || null;
      if (!match) {
        match = sorted
          .filter((segment) => segment.start_wall_ms <= event.ts_wall_ms)
          .sort((a, b) => b.start_wall_ms - a.start_wall_ms)[0];
      }
      if (!match || !match.obs_path) {
        return null;
      }
      const offsetBefore = segmentOffsets.get(match.id) || 0;
      const offsetMs = offsetBefore + Math.max(0, event.ts_wall_ms - match.start_wall_ms);
      return { path: match.obs_path, offsetMs };
    },
    [segmentOffsets, segments],
  );

  const loadEventFrames = useCallback(
    async (event: EventView | null) => {
      if (!event) {
        setEventFrames([]);
        setFrameIndex(0);
        return;
      }
      setFrameLoading(true);
      setFrameError(null);
      try {
        const res = await fetch("/api/timestone_event_frames", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eventId: event.id }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(payload.error || `Failed to load frames (${res.status})`);
        }
        const data = await res.json();
        const frames = Array.isArray(data.frames) ? data.frames : [];
        setEventFrames(frames);
        setFrameIndex(pickClosestFrameIndex(frames, event.ts_wall_ms));
      } catch (err) {
        setFrameError(err instanceof Error ? err.message : "Failed to load frames");
        setEventFrames([]);
        setFrameIndex(0);
      } finally {
        setFrameLoading(false);
      }
    },
    [pickClosestFrameIndex],
  );

  const selectEvent = useCallback(
    (event: EventView) => {
      setSelectedEvent(event);
      loadEventFrames(event);
      const info = resolveVideoInfo(event);
      if (info?.path) {
        const src = buildFileUrl(info.path);
        if (src) {
          setVideoSrc(src);
          setPendingSeekMs(info.offsetMs);
        }
      }
    },
    [loadEventFrames, resolveVideoInfo],
  );

  const refreshSessions = useCallback(async () => {
    setError(null);
    setStatus("Loading sessions...");
    try {
      const res = await fetch("/api/timestone_sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `Failed to load sessions (${res.status})`);
      }
      const data = await res.json();
      const list = Array.isArray(data.sessions) ? data.sessions : [];
      setSessions(list);
      if (!sessionId && list.length > 0) {
        setSessionId(list[0].session_id);
      }
      setStatus("Ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sessions");
      setStatus("Error");
    }
  }, [sessionId]);

  const fetchEvents = useCallback(async () => {
    if (!sessionId) {
      setEvents([]);
      return;
    }
    setStatus("Loading events...");
    try {
      const res = await fetch("/api/timestone_events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `Failed to load events (${res.status})`);
      }
      const data = await res.json();
      const list = Array.isArray(data?.events) ? (data.events as TimestoneEvent[]) : [];
      const normalized: EventView[] = list.map((event) => ({
        ...event,
        payloadData: safeJsonParse(event.payload),
        mouseData: safeJsonParse(event.mouse),
      }));
      normalized.sort((a, b) => b.ts_wall_ms - a.ts_wall_ms);
      setEvents(normalized);
      setStatus("Ready");
    } catch (err) {
      setEvents([]);
      setStatus("Error");
      setError(err instanceof Error ? err.message : "Failed to load events");
    }
  }, [sessionId]);

  const fetchSegments = useCallback(async () => {
    if (!sessionId) {
      setSegments([]);
      return;
    }
    try {
      const res = await fetch("/api/timestone_record_segments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `Failed to load segments (${res.status})`);
      }
      const data = await res.json();
      const list = Array.isArray(data?.segments) ? (data.segments as RecordSegment[]) : [];
      setSegments(list);
    } catch (err) {
      setSegments([]);
      setError(err instanceof Error ? err.message : "Failed to load segments");
    }
  }, [sessionId]);

  const fetchEventFrameIndex = useCallback(async () => {
    if (!sessionId) {
      setEventFrameIds(new Set());
      return;
    }
    try {
      const res = await fetch("/api/timestone_event_frames_index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `Failed to load frame index (${res.status})`);
      }
      const data = await res.json();
      const ids = Array.isArray(data?.event_ids) ? data.event_ids : [];
      setEventFrameIds(new Set(ids.map((id: any) => Number(id))));
    } catch (err) {
      setEventFrameIds(new Set());
      setError(err instanceof Error ? err.message : "Failed to load frame index");
    }
  }, [sessionId]);

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    fetchEvents();
    fetchSegments();
    fetchEventFrameIndex();
  }, [fetchEvents, fetchSegments, fetchEventFrameIndex]);

  useEffect(() => {
    if (pendingSeekMs == null) {
      return;
    }
    const el = videoRef.current;
    if (!el || Number.isNaN(el.duration)) {
      return;
    }
    el.currentTime = pendingSeekMs / 1000;
    setPendingSeekMs(null);
  }, [pendingSeekMs, videoSrc]);

  const handleLoadedMetadata = useCallback(() => {
    if (pendingSeekMs == null) {
      return;
    }
    const el = videoRef.current;
    if (!el) {
      return;
    }
    el.currentTime = pendingSeekMs / 1000;
    setPendingSeekMs(null);
  }, [pendingSeekMs]);

  const currentFrame = eventFrames[frameIndex] || null;
  const currentFrameUrl = currentFrame ? buildFileUrl(currentFrame.frame_path) : null;

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
      <div style={{ maxWidth: 1600, margin: "0 auto", display: "grid", gap: 20 }}>
        <header style={{ display: "grid", gap: 6 }}>
          <h1 style={{ fontSize: 30, margin: 0 }}>MKV Tapper</h1>
          <p style={{ margin: 0, color: "#94a3b8" }}>
            Pick a session and scrub the MKV with frame snapshots at event timestamps.
          </p>
        </header>

        <section
          style={{
            background: "rgba(15, 23, 42, 0.7)",
            borderRadius: 14,
            padding: 16,
            display: "flex",
            flexWrap: "wrap",
            gap: 16,
            alignItems: "center",
          }}
        >
          <label style={{ display: "grid", gap: 6, minWidth: 260 }}>
            <span style={{ color: "#cbd5f5" }}>Timestone session</span>
            <select
              value={sessionId}
              onChange={(event) => setSessionId(event.target.value)}
              style={{
                padding: "8px 10px",
                borderRadius: 8,
                border: "1px solid #1e293b",
                background: "#0b1120",
                color: "#e2e8f0",
              }}
            >
              <option value="">Select a session...</option>
              {sessions.map((session) => (
                <option key={session.session_id} value={session.session_id}>
                  {formatSessionDate(session.start_wall_iso)} ({session.session_id.slice(0, 8)})
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={refreshSessions}
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              border: "1px solid #1e293b",
              background: "#0f172a",
              color: "#e2e8f0",
              cursor: "pointer",
            }}
          >
            Refresh sessions
          </button>
          <div style={{ color: "#94a3b8" }}>{status}</div>
          {error ? <div style={{ color: "#fca5a5" }}>{error}</div> : null}
        </section>

        <section
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) minmax(320px, 420px)",
            gap: 24,
            alignItems: "start",
          }}
        >
          <div style={{ display: "grid", gap: 16 }}>
            <div
              style={{
                background: "#0b1120",
                borderRadius: 14,
                padding: 16,
                border: "1px solid #1e293b",
              }}
            >
              <div style={{ marginBottom: 8, color: "#94a3b8" }}>
                {activeSession?.obs_video_path ? `Video: ${activeSession.obs_video_path}` : "No OBS video path"}
              </div>
              <div style={{ position: "relative", width: "100%", height: "min(60vh, 520px)" }}>
                {videoSrc ? (
                  <video
                    ref={videoRef}
                    src={videoSrc}
                    onLoadedMetadata={handleLoadedMetadata}
                    controls
                    style={{ width: "100%", height: "100%", objectFit: "contain", background: "#0f172a" }}
                  />
                ) : (
                  <div
                    style={{
                      width: "100%",
                      height: "100%",
                      borderRadius: 12,
                      border: "1px dashed #1e293b",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "#64748b",
                    }}
                  >
                    Select an event to load the video.
                  </div>
                )}
              </div>
            </div>

            <div
              style={{
                background: "#0b1120",
                borderRadius: 14,
                padding: 16,
                border: "1px solid #1e293b",
                display: "grid",
                gap: 12,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <strong>Event frame</strong>
                {frameLoading ? <span style={{ color: "#94a3b8" }}>Loading...</span> : null}
                {frameError ? <span style={{ color: "#fca5a5" }}>{frameError}</span> : null}
              </div>
              <div style={{ position: "relative", width: "100%", minHeight: 260 }}>
                {currentFrameUrl ? (
                  <img
                    src={currentFrameUrl}
                    alt="Event frame"
                    style={{ width: "100%", height: "auto", borderRadius: 12, border: "1px solid #1e293b" }}
                  />
                ) : (
                  <div style={{ color: "#64748b" }}>No frame loaded.</div>
                )}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <button
                  type="button"
                  onClick={() => setFrameIndex((idx) => Math.max(0, idx - 1))}
                  disabled={frameIndex === 0}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 8,
                    border: "1px solid #1e293b",
                    background: "#0f172a",
                    color: "#e2e8f0",
                    cursor: "pointer",
                  }}
                >
                  Prev
                </button>
                <button
                  type="button"
                  onClick={() => setFrameIndex((idx) => Math.min(eventFrames.length - 1, idx + 1))}
                  disabled={frameIndex >= eventFrames.length - 1}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 8,
                    border: "1px solid #1e293b",
                    background: "#0f172a",
                    color: "#e2e8f0",
                    cursor: "pointer",
                  }}
                >
                  Next
                </button>
                <span style={{ color: "#94a3b8" }}>
                  {eventFrames.length ? `${frameIndex + 1} / ${eventFrames.length}` : "0 / 0"}
                </span>
              </div>
            </div>
          </div>

          <aside
            style={{
              background: "#0b1120",
              borderRadius: 14,
              padding: 16,
              border: "1px solid #1e293b",
              maxHeight: "calc(100vh - 160px)",
              overflowY: "auto",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <strong>Events</strong>
              <span style={{ color: "#94a3b8" }}>{filteredEvents.length}</span>
            </div>
            <div style={{ display: "grid", gap: 10, marginBottom: 12 }}>
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search events"
                style={{
                  padding: "8px 10px",
                  borderRadius: 10,
                  border: "1px solid #1e293b",
                  background: "#0f172a",
                  color: "#e2e8f0",
                }}
              />
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {eventTypes.map((type) => {
                  const active = eventVisibility[type] !== false;
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() =>
                        setEventVisibility((prev) => ({ ...prev, [type]: !(prev[type] !== false) }))
                      }
                      style={{
                        padding: "6px 10px",
                        borderRadius: 999,
                        border: "1px solid",
                        borderColor: active ? "#38bdf8" : "#1e293b",
                        background: active ? "rgba(56, 189, 248, 0.18)" : "transparent",
                        color: active ? "#e0f2fe" : "#94a3b8",
                        fontSize: 12,
                        cursor: "pointer",
                      }}
                    >
                      {type.replace(/_/g, " ")}
                    </button>
                  );
                })}
              </div>
            </div>
            <div style={{ display: "grid", gap: 10 }}>
              {listRows.map((row) => {
                if (row.kind === "segment") {
                  return (
                    <div
                      key={row.id}
                      style={{
                        padding: "10px 12px",
                        borderRadius: 10,
                        border: "1px dashed #334155",
                        background: "rgba(15, 23, 42, 0.5)",
                        color: "#e2e8f0",
                        display: "grid",
                        gap: 6,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                        <strong>{row.label}</strong>
                        <span style={{ color: "#94a3b8" }}>{formatWallTime(row.ts_wall_ms)}</span>
                      </div>
                      <div style={{ color: "#94a3b8" }}>Recording boundary</div>
                    </div>
                  );
                }
                const event = row.event;
                return (
                  <button
                    key={event.id}
                    type="button"
                    onClick={() => selectEvent(event)}
                    style={{
                      textAlign: "left",
                      padding: "10px 12px",
                      borderRadius: 10,
                      border:
                        selectedEvent?.id === event.id
                          ? "1px solid #38bdf8"
                          : eventFrameIds.has(event.id)
                            ? "1px solid rgba(34,197,94,0.6)"
                            : "1px solid #1e293b",
                      background: eventFrameIds.has(event.id)
                        ? "rgba(34, 197, 94, 0.08)"
                        : "rgba(15, 23, 42, 0.7)",
                      color: "#e2e8f0",
                      cursor: "pointer",
                      display: "grid",
                      gap: 6,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                      <strong style={{ textTransform: "capitalize" }}>{event.event_type.replace(/_/g, " ")}</strong>
                      <span style={{ color: "#94a3b8" }}>{formatWallTime(event.ts_wall_ms)}</span>
                    </div>
                    <div style={{ color: "#cbd5f5" }}>
                      {event.window_title || event.process_name || event.window_class || "Unknown window"}
                    </div>
                  </button>
                );
              })}
              {!listRows.length && <div style={{ color: "#64748b" }}>No events loaded.</div>}
            </div>
          </aside>
        </section>
      </div>
    </div>
  );
}
