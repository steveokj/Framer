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

type EventView = TimestoneEvent & {
  payloadData: any;
  mouseData: any;
};

type EventSegment = {
  id: string;
  events: EventView[];
};

type EventRow =
  | { kind: "single"; event: EventView }
  | { kind: "group"; event_type: string; events: EventView[] };

const API_BASE = (
  process.env.NEXT_PUBLIC_API_BASE && process.env.NEXT_PUBLIC_API_BASE.trim().length > 0
    ? process.env.NEXT_PUBLIC_API_BASE
    : "http://localhost:8001"
).replace(/\/$/, "");

const ABSOLUTE_PATH_REGEX = /^[a-zA-Z]:[\\/]|^\//;
const MAX_EVENTS = 300;
const SSE_POLL_MS = 500;
const SSE_HEARTBEAT_MS = 15000;
const TEXT_MERGE_WINDOW_MS = 1500;
const EVENT_ICON_MAP: Record<string, string | undefined> = {
  mouse_click: process.env.NEXT_PUBLIC_EVENT_ICON_MOUSE_CLICK,
  key_down: process.env.NEXT_PUBLIC_EVENT_ICON_KEY_DOWN,
  key_shortcut: process.env.NEXT_PUBLIC_EVENT_ICON_KEY_SHORTCUT,
  text_input: process.env.NEXT_PUBLIC_EVENT_ICON_TEXT_INPUT,
  clipboard_text: process.env.NEXT_PUBLIC_EVENT_ICON_CLIPBOARD_TEXT,
  clipboard_image: process.env.NEXT_PUBLIC_EVENT_ICON_CLIPBOARD_IMAGE,
  clipboard_files: process.env.NEXT_PUBLIC_EVENT_ICON_CLIPBOARD_FILES,
};
const APP_ICON_MAP: Record<string, string> = (() => {
  const raw = process.env.NEXT_PUBLIC_APP_ICON_MAP;
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
})();

function resolveIconSrc(path: string | null | undefined): string | null {
  if (!path) {
    return null;
  }
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  return buildFileUrl(path);
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

function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms)) {
    return "--:--";
  }
  const totalSeconds = Math.max(0, ms) / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const millis = Math.floor((totalSeconds - Math.floor(totalSeconds)) * 1000);
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}.${millis
    .toString()
    .padStart(3, "0")}`;
}

function clipText(text: string, maxLen = 240): string {
  if (text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, maxLen)}...`;
}

function formatShortcut(payload: any): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const modifiers = Array.isArray(payload.modifiers) ? payload.modifiers : [];
  const key = payload.key || payload.vk;
  if (!key) {
    return null;
  }
  const combo = [...modifiers, String(key)];
  return combo.join("+");
}

function mergeTextInputEvents(events: EventView[]): EventView[] {
  const sorted = [...events].sort((a, b) => a.ts_wall_ms - b.ts_wall_ms);
  const merged: EventView[] = [];
  for (const event of sorted) {
    if (event.event_type !== "text_input") {
      merged.push(event);
      continue;
    }
    const last = merged[merged.length - 1];
    const payload = event.payloadData || {};
    const lastPayload = last?.payloadData || {};
    const currentFinal = payload?.final_text;
    const lastFinal = lastPayload?.final_text;
    const currentText = typeof payload?.text === "string" ? payload.text : "";
    const lastText = typeof lastPayload?.text === "string" ? lastPayload.text : "";
    const sameWindow =
      last &&
      last.event_type === "text_input" &&
      last.window_title === event.window_title &&
      last.window_class === event.window_class &&
      last.process_name === event.process_name;
    const withinWindow =
      last && event.ts_wall_ms - last.ts_wall_ms <= TEXT_MERGE_WINDOW_MS;
    const shouldMerge =
      sameWindow &&
      withinWindow &&
      !currentFinal &&
      !lastFinal &&
      currentText.length > 0;

    if (shouldMerge && last) {
      const nextText = `${lastText}${currentText}`;
      const updated: EventView = {
        ...last,
        ts_wall_ms: event.ts_wall_ms,
        ts_mono_ms: event.ts_mono_ms,
        payloadData: { ...lastPayload, text: nextText },
      };
      merged[merged.length - 1] = updated;
    } else {
      merged.push(event);
    }
  }
  return merged.sort((a, b) => b.ts_wall_ms - a.ts_wall_ms);
}

function windowLabel(event: EventView): string | null {
  return event.window_title || event.process_name || event.window_class || null;
}

function segmentByActiveWindow(events: EventView[]): EventSegment[] {
  const sorted = [...events].sort((a, b) => a.ts_wall_ms - b.ts_wall_ms);
  const segments: EventSegment[] = [];
  let current: EventSegment | null = null;
  for (const event of sorted) {
    if (event.event_type === "active_window_changed" || !current) {
      current = {
        id: `${event.id}-${event.ts_wall_ms}`,
        events: [event],
      };
      segments.push(current);
    } else {
      current.events.push(event);
    }
  }
  return segments
    .reverse()
    .map((segment) => ({
      ...segment,
      events: [...segment.events].sort((a, b) => b.ts_wall_ms - a.ts_wall_ms),
    }));
}

function groupConsecutiveByType(events: EventView[]): EventRow[] {
  const rows: EventRow[] = [];
  for (const event of events) {
    const last = rows[rows.length - 1];
    if (last && last.kind === "group" && last.event_type === event.event_type) {
      last.events.push(event);
      continue;
    }
    if (last && last.kind === "single" && last.event.event_type === event.event_type) {
      rows[rows.length - 1] = { kind: "group", event_type: event.event_type, events: [last.event, event] };
      continue;
    }
    rows.push({ kind: "single", event });
  }
  return rows;
}

export default function LiveEventsPage() {
  const [sessions, setSessions] = useState<TimestoneSession[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [events, setEvents] = useState<EventView[]>([]);
  const [status, setStatus] = useState("Idle");
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const [liveEnabled, setLiveEnabled] = useState(true);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());

  const lastWallMsRef = useRef<number | null>(null);
  const seenIdsRef = useRef<Set<number>>(new Set());

  const activeSession = useMemo(
    () => sessions.find((session) => session.session_id === sessionId) || null,
    [sessions, sessionId]
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
      setStatus("Live");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sessions");
      setStatus("Error");
    }
  }, [sessionId]);

  const ingestEvents = useCallback((incoming: TimestoneEvent[]) => {
    if (!incoming.length) {
      return;
    }
    const next = incoming.filter((event) => {
      if (seenIdsRef.current.has(event.id)) {
        return false;
      }
      seenIdsRef.current.add(event.id);
      return true;
    });
    if (!next.length) {
      return;
    }
    const newestWall = next.reduce((max, event) => Math.max(max, event.ts_wall_ms), 0);
    lastWallMsRef.current = Math.max(lastWallMsRef.current || 0, newestWall);
    const normalized: EventView[] = next.map((event) => ({
      ...event,
      payloadData: safeJsonParse(event.payload),
      mouseData: safeJsonParse(event.mouse),
    }));
    normalized.sort((a, b) => b.ts_wall_ms - a.ts_wall_ms);
    setEvents((prev) => {
      const merged = [...normalized, ...prev];
      return merged.slice(0, MAX_EVENTS);
    });
  }, []);

  const buildStreamUrl = useCallback(() => {
    if (!sessionId) {
      return null;
    }
    const startMs =
      lastWallMsRef.current !== null
        ? Math.max(0, lastWallMsRef.current - 1)
        : activeSession?.start_wall_ms;
    const params = new URLSearchParams({ sessionId });
    if (startMs != null && Number.isFinite(startMs)) {
      params.set("startMs", String(startMs));
    }
    params.set("pollMs", String(SSE_POLL_MS));
    params.set("heartbeatMs", String(SSE_HEARTBEAT_MS));
    return `/api/timestone_events?${params.toString()}`;
  }, [activeSession?.start_wall_ms, sessionId]);

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    lastWallMsRef.current = null;
    seenIdsRef.current = new Set();
    setEvents([]);
    setError(null);
    if (!sessionId) {
      return;
    }
    let cancelled = false;
    let source: EventSource | null = null;
    const connect = () => {
      const url = buildStreamUrl();
      if (!url || cancelled) {
        return;
      }
      setStatus("Live");
      source = new EventSource(url);
      source.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          ingestEvents(Array.isArray(payload.events) ? payload.events : []);
          setLastUpdate(new Date().toLocaleTimeString());
        } catch {
          setError("Failed to parse live event stream.");
        }
      };
      source.onerror = () => {
        source?.close();
        source = null;
        if (!cancelled) {
          setStatus("Reconnecting...");
          setTimeout(connect, 1500);
        }
      };
    };
    if (liveEnabled) {
      connect();
    } else {
      setStatus("Paused");
    }
    return () => {
      cancelled = true;
      source?.close();
    };
  }, [buildStreamUrl, ingestEvents, liveEnabled, sessionId]);

  const eventCount = events.length;
  const displayEvents = useMemo(() => mergeTextInputEvents(events), [events]);
  const segments = useMemo(() => segmentByActiveWindow(displayEvents), [displayEvents]);
  const toggleGroup = useCallback((id: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const renderEventDetails = (event: EventView) => {
    const payload = event.payloadData || {};
    const mouse = event.mouseData || {};
    const clipboardPath = payload?.path ? String(payload.path) : null;
    const clipboardUrl = clipboardPath ? buildFileUrl(clipboardPath) : null;
    const clipTextValue = payload?.final_text
      ? String(payload.final_text)
      : payload?.text
        ? String(payload.text)
        : null;
    const clipFiles = Array.isArray(payload?.files) ? payload.files : [];
    const shortcut = event.event_type === "key_shortcut" ? formatShortcut(payload) : null;

    return (
      <>

        {event.event_type === "clipboard_text" && clipTextValue ? (
          <div style={{ display: "grid", gap: 8 }}>
            <strong>Clipboard text</strong>
            <div
              style={{
                padding: "10px 12px",
                borderRadius: 10,
                background: "rgba(15, 23, 42, 0.8)",
                border: "1px solid rgba(30, 41, 59, 0.6)",
                whiteSpace: "pre-wrap",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 13,
              }}
            >
              {clipText(clipTextValue, 1200)}
            </div>
          </div>
        ) : null}

        {event.event_type === "clipboard_image" && clipboardPath ? (
          <div style={{ display: "grid", gap: 8 }}>
            <strong>Clipboard image</strong>
            <span style={{ color: "#94a3b8" }}>
              {payload?.width || "?"} x {payload?.height || "?"}
            </span>
            {clipboardUrl ? (
              <img
                src={clipboardUrl}
                alt="Clipboard"
                style={{ maxWidth: 360, borderRadius: 10, border: "1px solid #1e293b" }}
              />
            ) : null}
            <div style={{ color: "#64748b" }}>{clipboardPath}</div>
          </div>
        ) : null}

        {event.event_type === "clipboard_files" && clipFiles.length > 0 ? (
          <div style={{ display: "grid", gap: 8 }}>
            <strong>Clipboard files</strong>
            <div style={{ display: "grid", gap: 6 }}>
              {clipFiles.slice(0, 12).map((path: string, idx: number) => (
                <div key={`${path}-${idx}`} style={{ color: "#cbd5f5" }}>
                  {path}
                </div>
              ))}
              {clipFiles.length > 12 ? (
                <div style={{ color: "#94a3b8" }}>+{clipFiles.length - 12} more</div>
              ) : null}
            </div>
          </div>
        ) : null}

        {event.event_type === "key_shortcut" && shortcut ? (
          <div style={{ color: "#cbd5f5" }}>Shortcut: {shortcut}</div>
        ) : null}

        {event.event_type === "key_down" && payload?.key ? <div style={{ color: "#cbd5f5" }}>Key: {payload.key}</div> : null}

        {event.event_type === "text_input" && clipTextValue ? (
          <div style={{ color: "#cbd5f5" }}>Typed: {clipText(clipTextValue, 200)}</div>
        ) : null}

        {event.event_type === "mouse_click" && mouse?.x != null && mouse?.y != null ? (
          <div style={{ color: "#cbd5f5" }}>
            Click @ {mouse.x},{mouse.y}
          </div>
        ) : null}
      </>
    );
  };

  return (
    <div className="container">
      <main
        style={{
          minHeight: "100vh",
          background: "linear-gradient(180deg, #070b16 0%, #0a1224 40%, #0b1120 100%)",
          color: "#e2e8f0",
          padding: "32px 24px 80px",
          fontFamily: '"Space Grotesk", "Segoe UI", system-ui',
        }}
      >
        <div style={{ maxWidth: 1200, margin: "0 auto", display: "grid", gap: 24 }}>
          <div
            style={{
              position: "sticky",
              top: 0,
              zIndex: 20,
              display: "grid",
              gap: 16,
              paddingTop: 8,
              paddingBottom: 16,
              background: "linear-gradient(180deg, rgba(7, 11, 22, 0.95) 0%, rgba(7, 11, 22, 0.85) 100%)",
              backdropFilter: "blur(10px)",
            }}
          >
            <header style={{ display: "grid", gap: 8 }}>
              <h1 style={{ fontSize: 32, margin: 0 }}>Live Events</h1>
              <p style={{ margin: 0, color: "#94a3b8" }}>
                Stream timestone events in real time. Clipboard captures show text, images, and file lists as soon as
                they land.
              </p>
            </header>

            <section
              style={{
                background: "rgba(15, 23, 42, 0.7)",
                borderRadius: 14,
                padding: 20,
                display: "grid",
                gap: 16,
                border: "1px solid rgba(30, 41, 59, 0.6)",
              }}
            >
              <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
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
                        {session.start_wall_iso} ({session.session_id.slice(0, 8)})
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
                <button
                  type="button"
                  onClick={() => setLiveEnabled((prev) => !prev)}
                  style={{
                    padding: "8px 12px",
                    borderRadius: 8,
                    border: "1px solid #1e293b",
                    background: liveEnabled ? "rgba(56, 189, 248, 0.2)" : "#0f172a",
                    color: liveEnabled ? "#e0f2fe" : "#e2e8f0",
                    cursor: "pointer",
                  }}
                >
                  {liveEnabled ? "Stop live" : "Start live"}
                </button>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", color: "#94a3b8" }}>
                <span>Status: {status}</span>
                {activeSession ? <span>Started {activeSession.start_wall_iso}</span> : null}
                <span>Events loaded: {eventCount}</span>
                {lastUpdate ? <span>Last update: {lastUpdate}</span> : null}
              </div>
              {error ? <div style={{ color: "#fca5a5" }}>{error}</div> : null}
            </section>
          </div>

          <section style={{ display: "grid", gap: 16 }}>
            {eventCount === 0 ? (
              <div style={{ color: "#94a3b8" }}>No events yet.</div>
            ) : (
              segments.map((segment) => {
                const rows = groupConsecutiveByType(segment.events);

                return (
                  <div
                    key={segment.id}
                    style={{
                      borderRadius: 16,
                      padding: 16,
                      border: "1px solid rgba(30, 41, 59, 0.7)",
                      background: "rgba(11, 17, 32, 0.9)",
                      display: "grid",
                      gap: 12,
                    }}
                  >
                    <div style={{ display: "grid", gap: 10 }}>
                      {rows.map((row, rowIndex) => {
                        const rowId = `${segment.id}-${rowIndex}`;
                        if (row.kind === "group") {
                          const expanded = expandedGroups.has(rowId);
                          const groupMonoTime = activeSession
                            ? formatDurationMs(row.events[0].ts_wall_ms - activeSession.start_wall_ms)
                            : formatDurationMs(row.events[0].ts_mono_ms);
                          const groupIcon = resolveIconSrc(EVENT_ICON_MAP[row.event_type]);
                          return (
                            <div
                              key={rowId}
                              style={{
                                borderRadius: 12,
                                padding: "10px 12px",
                                border: "1px solid rgba(30, 41, 59, 0.6)",
                                background: "rgba(9, 14, 26, 0.9)",
                                display: "grid",
                                gap: 6,
                              }}
                            >
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
                                {row.events.length > 1 ? (
                                  <button
                                    type="button"
                                    onClick={() => toggleGroup(rowId)}
                                    style={{
                                      width: 24,
                                      height: 24,
                                      borderRadius: 6,
                                      border: "1px solid rgba(30, 41, 59, 0.8)",
                                      background: "rgba(15, 23, 42, 0.7)",
                                      color: "#e2e8f0",
                                      cursor: "pointer",
                                    }}
                                    aria-label={expanded ? "Collapse group" : "Expand group"}
                                  >
                                    {expanded ? "-" : "+"}
                                  </button>
                                ) : null}
                                {groupIcon ? (
                                  <img
                                    src={groupIcon}
                                    alt=""
                                    style={{ width: 20, height: 20, borderRadius: 6, objectFit: "cover" }}
                                  />
                                ) : null}
                                <strong style={{ textTransform: "capitalize" }}>
                                  {row.event_type.replace(/_/g, " ")}
                                </strong>
                                <span style={{ color: "#cbd5f5" }}>
                                  {formatWallTime(row.events[0].ts_wall_ms)}
                                </span>
                                <span style={{ color: "#64748b" }}>
                                  +{groupMonoTime}
                                </span>
                                {row.events.length > 1 ? (
                                  <span
                                    style={{
                                      color: "#0f172a",
                                      background: "rgba(56, 189, 248, 0.9)",
                                      borderRadius: 999,
                                      padding: "2px 8px",
                                      fontSize: 12,
                                      fontWeight: 600,
                                    }}
                                  >
                                    {row.events.length}x
                                  </span>
                                ) : null}
                              </div>
                              {renderEventDetails(row.events[0])}
                                {expanded ? (
                                  <div style={{ display: "grid", gap: 6, paddingLeft: 10 }}>
                                    {row.events.map((event) => {
                                      const eventPayload = event.payloadData || {};
                                      const eventMouse = event.mouseData || {};
                                      const eventText = eventPayload?.final_text
                                        ? String(eventPayload.final_text)
                                        : eventPayload?.text
                                          ? String(eventPayload.text)
                                          : null;
                                      return (
                                        <div
                                          key={event.id}
                                        style={{
                                          borderRadius: 10,
                                          padding: "8px 10px",
                                          border: "1px solid rgba(30, 41, 59, 0.6)",
                                          background: "rgba(7, 12, 22, 0.85)",
                                          display: "grid",
                                          gap: 4,
                                        }}
                                        >
                                          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                                            <span style={{ color: "#cbd5f5", fontSize: 12 }}>
                                              {formatWallTime(event.ts_wall_ms)}
                                            </span>
                                            <span style={{ color: "#94a3b8", fontSize: 12 }}>
                                              {event.event_type.replace(/_/g, " ")}
                                            </span>
                                          </div>
                                          {event.event_type === "key_down" && eventPayload?.key ? (
                                            <div style={{ color: "#cbd5f5" }}>Key: {eventPayload.key}</div>
                                          ) : null}
                                          {event.event_type === "key_shortcut" ? (
                                            <div style={{ color: "#cbd5f5" }}>
                                              Shortcut: {formatShortcut(eventPayload) || "Unknown"}
                                            </div>
                                          ) : null}
                                          {event.event_type === "text_input" && eventText ? (
                                            <div style={{ color: "#cbd5f5" }}>{clipText(eventText, 160)}</div>
                                          ) : null}
                                          {event.event_type === "mouse_click" &&
                                          eventMouse?.x != null &&
                                          eventMouse?.y != null ? (
                                            <div style={{ color: "#94a3b8" }}>
                                              Click @ {eventMouse.x},{eventMouse.y}
                                            </div>
                                          ) : null}
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : null}
                            </div>
                          );
                        }

                        const event = row.event;
                        const wallTime = formatWallTime(event.ts_wall_ms);
                        const monoTime = activeSession
                          ? formatDurationMs(event.ts_wall_ms - activeSession.start_wall_ms)
                          : formatDurationMs(event.ts_mono_ms);
                        const windowName = windowLabel(event);
                        const windowInitial = windowName ? windowName.slice(0, 1).toUpperCase() : "?";
                        const eventIcon = resolveIconSrc(EVENT_ICON_MAP[event.event_type]);
                        const appIcon = resolveIconSrc(
                          event.event_type === "active_window_changed"
                            ? (event.payloadData?.app_icon_path as string | undefined) ||
                                APP_ICON_MAP[event.process_name || ""] ||
                                null
                            : null
                        );
                        const isActiveWindow = event.event_type === "active_window_changed";
                        return (
                          <div
                            key={event.id}
                            style={{
                              borderRadius: 14,
                              padding: 16,
                              border: "1px solid rgba(30, 41, 59, 0.7)",
                              background: "rgba(11, 17, 32, 0.9)",
                              display: "grid",
                              gap: 12,
                            }}
                          >
                            {isActiveWindow ? (
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
                                {appIcon ? (
                                  <img
                                    src={appIcon}
                                    alt=""
                                    style={{ width: 32, height: 32, borderRadius: 10, objectFit: "cover" }}
                                  />
                                ) : (
                                  <div
                                    style={{
                                      width: 32,
                                      height: 32,
                                      borderRadius: 10,
                                      background: "rgba(56, 189, 248, 0.2)",
                                      color: "#e2e8f0",
                                      display: "grid",
                                      placeItems: "center",
                                      fontSize: 12,
                                    }}
                                  >
                                    {windowInitial}
                                  </div>
                                )}
                                <div style={{ display: "grid", gap: 4 }}>
                                    <div style={{ display: "flex", flexDirection: "row", gap: 16 }}>
                                      <strong style={{ textTransform: "capitalize" }}>
                                        {event.event_type.replace(/_/g, " ")}
                                      </strong>
                                      
                                      <div style={{ alignSelf: "start", display: "flex", gap: 12, alignItems: "center" }} >
                                        <span style={{ color: "#cbd5f5" }}>{wallTime}</span>
                                        <span style={{ color: "#64748b" }}>+{monoTime}</span>
                                      </div>
                                  </div>
                                  {windowName ? <div style={{ color: "#cbd5f5" }}>{windowName}</div> : null}
                                </div>
                              </div>
                            ) : (
                              <>
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
                                  {eventIcon ? (
                                    <img
                                      src={eventIcon}
                                      alt=""
                                      style={{ width: 20, height: 20, borderRadius: 6, objectFit: "cover" }}
                                    />
                                  ) : null}
                                  <strong style={{ textTransform: "capitalize" }}>
                                    {event.event_type.replace(/_/g, " ")}
                                  </strong>
                                  <span style={{ color: "#cbd5f5" }}>{wallTime}</span>
                                  <span style={{ color: "#64748b" }}>+{monoTime}</span>
                                </div>
                                {windowName ? <div style={{ color: "#94a3b8" }}>{windowName}</div> : null}
                              </>
                            )}
                            {renderEventDetails(event)}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
