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

type ObsVideoSegment = {
  id: string;
  path: string;
  name: string;
  start_ms: number | null;
  end_ms: number | null;
  duration_s: number | null;
  created_ms: number | null;
  modified_ms: number | null;
  start_source: "filename" | "filetime" | "unknown";
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

function SubtitleIcon({ size = 20, color = "#f8fafc" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x={3} y={5} width={18} height={14} rx={2} stroke={color} strokeWidth={1.6} />
      <path d="M7 10h4" stroke={color} strokeWidth={1.6} strokeLinecap="round" />
      <path d="M7 14h6" stroke={color} strokeWidth={1.6} strokeLinecap="round" />
      <path d="M14 10h3" stroke={color} strokeWidth={1.6} strokeLinecap="round" />
      <path d="M14 14h3" stroke={color} strokeWidth={1.6} strokeLinecap="round" />
    </svg>
  );
}

function SyncIcon({ size = 14, color = "#93c5fd" }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={{ display: "block" }}
    >
      <g>
        <path
          d="M4 12a8 8 0 0 1 13.66-5.66L20 8"
          stroke={color}
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M20 4v4h-4" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
        <path
          d="M20 12a8 8 0 0 1-13.66 5.66L4 16"
          stroke={color}
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M4 20v-4h4" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 12 12"
          to="360 12 12"
          dur="1.2s"
          repeatCount="indefinite"
        />
      </g>
    </svg>
  );
}

const API_BASE = (
  process.env.NEXT_PUBLIC_API_BASE && process.env.NEXT_PUBLIC_API_BASE.trim().length > 0
    ? process.env.NEXT_PUBLIC_API_BASE
    : "http://localhost:8001"
).replace(/\/$/, "");

const ABSOLUTE_PATH_REGEX = /^[a-zA-Z]:[\\/]|^\//;
const MAX_EVENTS = 400;
const SSE_POLL_MS = 500;
const SSE_HEARTBEAT_MS = 15000;
const TEXT_MERGE_WINDOW_MS = 1500;
const DEFAULT_OBS_FOLDER = "C:\\Users\\steve\\Desktop\\Desktop II\\OBS";
const LAST_FOLDER_STORAGE_KEY = "timestone:lastObsFolder:live_events_one";
const LAST_SESSION_STORAGE_KEY = "timestone:lastSessionId:live_events_one";
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

export default function LiveEventsOnePage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hideControlsTimeoutRef = useRef<number | null>(null);
  const switchInFlightRef = useRef(false);
  const pendingPlayRef = useRef(false);

  const [sessions, setSessions] = useState<TimestoneSession[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [events, setEvents] = useState<EventView[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [status, setStatus] = useState("Idle");
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const [liveEnabled, setLiveEnabled] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const [obsFolder, setObsFolder] = useState("");
  const [obsSegments, setObsSegments] = useState<ObsVideoSegment[]>([]);
  const [obsLoading, setObsLoading] = useState(false);
  const [obsError, setObsError] = useState<string | null>(null);
  const [obsPickerWarning, setObsPickerWarning] = useState<string | null>(null);
  const [obsTotalCount, setObsTotalCount] = useState(0);
  const [obsFilteredCount, setObsFilteredCount] = useState(0);
  const [filterMode, setFilterMode] = useState<"all" | "session" | "day" | "range" | "week" | "month">("day");
  const [filterDay, setFilterDay] = useState(() => new Date().toISOString().slice(0, 10));
  const [filterRangeStart, setFilterRangeStart] = useState(() => new Date().toISOString().slice(0, 10));
  const [filterRangeEnd, setFilterRangeEnd] = useState(() => new Date().toISOString().slice(0, 10));
  const [filterWeekStart, setFilterWeekStart] = useState(() => new Date().toISOString().slice(0, 10));
  const [filterMonth, setFilterMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [detailsMaxWidth] = useState(640);

  const [videoPath, setVideoPath] = useState("");
  const [videoError, setVideoError] = useState<string | null>(null);
  const [videoWarning, setVideoWarning] = useState<string | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [pendingSeekSeconds, setPendingSeekSeconds] = useState<number | null>(null);

  const lastWallMsRef = useRef<number | null>(null);
  const seenIdsRef = useRef<Set<number>>(new Set());
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const obsPickerRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem(LAST_FOLDER_STORAGE_KEY);
    if (saved) {
      setObsFolder(saved);
      return;
    }
    setObsFolder(DEFAULT_OBS_FOLDER);
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem(LAST_SESSION_STORAGE_KEY);
    if (saved) {
      setSessionId(saved);
    }
  }, []);

  useEffect(() => {
    if (!obsFolder.trim()) {
      localStorage.removeItem(LAST_FOLDER_STORAGE_KEY);
      return;
    }
    localStorage.setItem(LAST_FOLDER_STORAGE_KEY, obsFolder);
  }, [obsFolder]);

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
      if (!sessionId && list.length > 0 && filterMode === "session") {
        setSessionId(list[0].session_id);
      }
      setStatus("Live");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sessions");
      setStatus("Error");
    }
  }, [filterMode, sessionId]);

  const refreshObsVideos = useCallback(async () => {
    if (!obsFolder.trim()) {
      setObsSegments([]);
      setObsError(null);
      setObsPickerWarning(null);
      setObsTotalCount(0);
      setObsFilteredCount(0);
      return;
    }
    let startMs: number | null = null;
    let endMs: number | null = null;
    if (filterMode === "session" && sessionId) {
      const sessionEvents = events.filter((event) => event.session_id === sessionId);
      if (sessionEvents.length === 0) {
        setObsSegments([]);
        setObsTotalCount(0);
        setObsFilteredCount(0);
        return;
      }
      startMs = sessionEvents.reduce((min, event) => Math.min(min, event.ts_wall_ms), sessionEvents[0].ts_wall_ms);
      endMs = sessionEvents.reduce((max, event) => Math.max(max, event.ts_wall_ms), sessionEvents[0].ts_wall_ms);
    } else if (filterMode === "day") {
      const start = Date.parse(`${filterDay}T00:00:00`);
      if (Number.isFinite(start)) {
        startMs = start;
        endMs = start + 24 * 60 * 60 * 1000;
      }
    } else if (filterMode === "range") {
      const start = Date.parse(`${filterRangeStart}T00:00:00`);
      const end = Date.parse(`${filterRangeEnd}T00:00:00`);
      if (Number.isFinite(start) && Number.isFinite(end)) {
        startMs = start;
        endMs = end + 24 * 60 * 60 * 1000;
      }
    } else if (filterMode === "week") {
      const start = Date.parse(`${filterWeekStart}T00:00:00`);
      if (Number.isFinite(start)) {
        startMs = start;
        endMs = start + 7 * 24 * 60 * 60 * 1000;
      }
    } else if (filterMode === "month") {
      const [yearStr, monthStr] = filterMonth.split("-");
      const year = Number(yearStr);
      const month = Number(monthStr);
      if (Number.isFinite(year) && Number.isFinite(month)) {
        startMs = new Date(year, Math.max(0, month - 1), 1).getTime();
        endMs = new Date(year, Math.max(0, month), 1).getTime();
      }
    }
    setObsLoading(true);
    setObsError(null);
    try {
      const res = await fetch("/api/obs_videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderPath: obsFolder, startMs, endMs }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `Failed to scan OBS folder (${res.status})`);
      }
      const data = await res.json();
      const list = Array.isArray(data?.videos) ? (data.videos as ObsVideoSegment[]) : [];
      const normalized = list.map((entry) => ({
        ...entry,
        id: entry.path || entry.name,
      }));
      setObsSegments(normalized);
      setObsTotalCount(Number.isFinite(data?.total_count) ? Number(data.total_count) : list.length);
      setObsFilteredCount(Number.isFinite(data?.filtered_count) ? Number(data.filtered_count) : list.length);
      setObsPickerWarning(null);
    } catch (err) {
      setObsError(err instanceof Error ? err.message : "Failed to scan OBS folder");
      setObsSegments([]);
      setObsTotalCount(0);
      setObsFilteredCount(0);
    } finally {
      setObsLoading(false);
    }
  }, [
    obsFolder,
    filterMode,
    filterDay,
    filterRangeStart,
    filterRangeEnd,
    filterWeekStart,
    filterMonth,
    sessionId,
    events,
  ]);

  const fetchEventsSnapshot = useCallback(async () => {
    setEventsLoading(true);
    setEventsError(null);
    if (sessions.length === 0) {
      setEvents([]);
      setEventsLoading(false);
      return;
    }
    let targetSessions = sessions;
    let startMs: number | null = null;
    let endMs: number | null = null;

    if (filterMode === "session") {
      if (!sessionId) {
        setEvents([]);
        setEventsLoading(false);
        return;
      }
      targetSessions = sessions.filter((session) => session.session_id === sessionId);
    } else if (filterMode === "day") {
      const start = Date.parse(`${filterDay}T00:00:00`);
      if (Number.isFinite(start)) {
        startMs = start;
        endMs = start + 24 * 60 * 60 * 1000;
      }
    } else if (filterMode === "range") {
      const start = Date.parse(`${filterRangeStart}T00:00:00`);
      const end = Date.parse(`${filterRangeEnd}T00:00:00`);
      if (Number.isFinite(start) && Number.isFinite(end)) {
        startMs = start;
        endMs = end + 24 * 60 * 60 * 1000;
      }
    } else if (filterMode === "week") {
      const start = Date.parse(`${filterWeekStart}T00:00:00`);
      if (Number.isFinite(start)) {
        startMs = start;
        endMs = start + 7 * 24 * 60 * 60 * 1000;
      }
    } else if (filterMode === "month") {
      const [yearStr, monthStr] = filterMonth.split("-");
      const year = Number(yearStr);
      const month = Number(monthStr);
      if (Number.isFinite(year) && Number.isFinite(month)) {
        startMs = new Date(year, Math.max(0, month - 1), 1).getTime();
        endMs = new Date(year, Math.max(0, month), 1).getTime();
      }
    }

    if (startMs != null && endMs != null) {
      targetSessions = targetSessions.filter(
        (session) => session.start_wall_ms >= startMs! && session.start_wall_ms < endMs!,
      );
    }

    if (!targetSessions.length) {
      setEvents([]);
      setEventsLoading(false);
      return;
    }

    try {
      const responses = await Promise.all(
        targetSessions.map(async (session) => {
          const res = await fetch("/api/timestone_events", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionId: session.session_id,
              startMs,
              endMs,
            }),
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || `Failed to load events (${res.status})`);
          }
          const data = await res.json();
          return Array.isArray(data?.events) ? (data.events as TimestoneEvent[]) : [];
        }),
      );
      const combined = responses.flat();
      combined.sort((a, b) => b.ts_wall_ms - a.ts_wall_ms);
      const normalized: EventView[] = combined.map((event) => ({
        ...event,
        payloadData: safeJsonParse(event.payload),
        mouseData: safeJsonParse(event.mouse),
      }));
      setEvents(normalized);
      lastWallMsRef.current = normalized.length ? normalized[0].ts_wall_ms : null;
      seenIdsRef.current = new Set(normalized.map((event) => event.id));
    } catch (err) {
      setEvents([]);
      setEventsError(err instanceof Error ? err.message : "Failed to load events");
    } finally {
      setEventsLoading(false);
    }
  }, [
    sessions,
    filterMode,
    sessionId,
    filterDay,
    filterRangeStart,
    filterRangeEnd,
    filterWeekStart,
    filterMonth,
  ]);

  const handlePickObsFolder = useCallback(async () => {
    setObsPickerWarning(null);
    if (typeof window !== "undefined" && "showDirectoryPicker" in window) {
      try {
        const picker = (window as any).showDirectoryPicker;
        const handle = await picker();
        if (handle?.name) {
          setObsFolder((prev) => {
            if (prev && prev.includes(":")) {
              return prev.replace(/[\\/]?[^\\/]*$/, `\\${handle.name}`);
            }
            return handle.name;
          });
          setObsPickerWarning(
            "Browser picker does not expose full path. If videos are not found, paste the full folder path.",
          );
        }
        return;
      } catch {
        return;
      }
    }
    obsPickerRef.current?.click();
  }, []);

  const handleObsPickerChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) {
      return;
    }
    const first: any = files[0];
    if (first?.path) {
      const pathValue = String(first.path);
      const trimmed = pathValue.replace(/[\\/][^\\/]+$/, "");
      setObsFolder(trimmed);
      setObsPickerWarning(null);
    } else if (first?.webkitRelativePath) {
      const rel = String(first.webkitRelativePath);
      const folderName = rel.split(/[\\/]/)[0];
      setObsFolder(folderName || obsFolder);
      setObsPickerWarning(
        "Browser picker does not expose full path. If videos are not found, paste the full folder path.",
      );
    } else {
      setObsPickerWarning("Folder selection did not provide a usable path. Paste the folder path manually.");
    }
    event.target.value = "";
  }, [obsFolder]);

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
    setEvents((prev) => [...normalized, ...prev]);
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
    refreshObsVideos();
  }, [refreshObsVideos]);

  useEffect(() => {
    fetchEventsSnapshot();
  }, [fetchEventsSnapshot]);

  useEffect(() => {
    if (!liveEnabled) {
      return;
    }
    refreshObsVideos();
  }, [liveEnabled, refreshObsVideos]);

  useEffect(() => {
    setError(null);
    if (!sessionId || filterMode !== "session") {
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
  }, [buildStreamUrl, ingestEvents, liveEnabled, sessionId, filterMode]);

  const resolvedSegments = useMemo(() => {
    if (!obsSegments.length) {
      return [];
    }
    return obsSegments.map((segment, index) => {
      let endMs = segment.end_ms;
      if (!endMs && segment.start_ms != null) {
        const next = obsSegments[index + 1];
        if (next?.start_ms != null) {
          endMs = next.start_ms;
        }
      }
      const duration =
        segment.duration_s ??
        (endMs != null && segment.start_ms != null ? Math.max(0, (endMs - segment.start_ms) / 1000) : null);
      return {
        ...segment,
        end_ms: endMs,
        duration_s: duration,
      };
    });
  }, [obsSegments]);

  const filterRange = useMemo(() => {
    const makeRange = (start: number, days: number) => {
      const startMs = start;
      const endMs = startMs + days * 24 * 60 * 60 * 1000;
      return { startMs, endMs };
    };
    if (filterMode === "day") {
      const start = Date.parse(`${filterDay}T00:00:00`);
      return Number.isFinite(start) ? makeRange(start, 1) : null;
    }
    if (filterMode === "range") {
      const start = Date.parse(`${filterRangeStart}T00:00:00`);
      const end = Date.parse(`${filterRangeEnd}T00:00:00`);
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        return null;
      }
      return { startMs: start, endMs: end + 24 * 60 * 60 * 1000 };
    }
    if (filterMode === "week") {
      const start = Date.parse(`${filterWeekStart}T00:00:00`);
      return Number.isFinite(start) ? makeRange(start, 7) : null;
    }
    if (filterMode === "month") {
      const [yearStr, monthStr] = filterMonth.split("-");
      const year = Number(yearStr);
      const month = Number(monthStr);
      if (!Number.isFinite(year) || !Number.isFinite(month)) {
        return null;
      }
      const start = new Date(year, Math.max(0, month - 1), 1).getTime();
      const end = new Date(year, Math.max(0, month), 1).getTime();
      return { startMs: start, endMs: end };
    }
    return null;
  }, [filterMode, filterDay, filterRangeStart, filterRangeEnd, filterWeekStart, filterMonth]);

  const filteredEvents = useMemo(() => {
    let list = events;
    if (filterMode === "session" && sessionId) {
      list = list.filter((event) => event.session_id === sessionId);
    }
    if (filterRange) {
      list = list.filter((event) => event.ts_wall_ms >= filterRange.startMs && event.ts_wall_ms < filterRange.endMs);
    }
    return list;
  }, [events, filterMode, sessionId, filterRange]);

  const sessionRange = useMemo(() => {
    if (filterMode !== "session") {
      return null;
    }
    if (!filteredEvents.length) {
      return null;
    }
    let min = filteredEvents[0].ts_wall_ms;
    let max = filteredEvents[0].ts_wall_ms;
    for (const event of filteredEvents) {
      min = Math.min(min, event.ts_wall_ms);
      max = Math.max(max, event.ts_wall_ms);
    }
    return { startMs: min, endMs: max };
  }, [filterMode, filteredEvents]);

  const obsRange = useMemo(() => {
    if (filterMode === "session") {
      return sessionRange;
    }
    return filterRange;
  }, [filterMode, filterRange, sessionRange]);

  const visibleSegments = useMemo(() => {
    const range = sessionRange ?? filterRange;
    if (!range) {
      return resolvedSegments;
    }
    return resolvedSegments.filter((segment) => {
      if (segment.start_ms == null) {
        return false;
      }
      const endMs = segment.end_ms ?? segment.start_ms;
      return endMs >= range.startMs && segment.start_ms <= range.endMs;
    });
  }, [resolvedSegments, filterRange, sessionRange]);

  const eventCount = filteredEvents.length;
  const displayEvents = useMemo(() => mergeTextInputEvents(filteredEvents), [filteredEvents]);
  const segments = useMemo(() => segmentByActiveWindow(displayEvents), [displayEvents]);

  const activeSegment = useMemo(() => {
    if (activeSegmentId) {
      return visibleSegments.find((segment) => segment.id === activeSegmentId) ?? null;
    }
    if (visibleSegments.length === 1) {
      return visibleSegments[0];
    }
    return null;
  }, [activeSegmentId, visibleSegments]);

  const activeSegmentIndex = useMemo(() => {
    if (!activeSegment) {
      return -1;
    }
    return visibleSegments.findIndex((segment) => segment.id === activeSegment.id);
  }, [activeSegment, visibleSegments]);

  useEffect(() => {
    if (!activeSegmentId && filteredEvents.length && visibleSegments.length) {
      const target = visibleSegments.find((segment) => {
        if (segment.start_ms == null || segment.end_ms == null) {
          return false;
        }
        return (
          filteredEvents[0].ts_wall_ms >= segment.start_ms && filteredEvents[0].ts_wall_ms <= segment.end_ms
        );
      });
      if (target) {
        setActiveSegmentId(target.id);
        setVideoPath(target.path);
      }
    }
  }, [activeSegmentId, filteredEvents, visibleSegments]);

  useEffect(() => {
    if (activeSegmentId && !activeSegment && visibleSegments.length) {
      setActiveSegmentId(visibleSegments[0].id);
      setVideoPath(visibleSegments[0].path);
    }
  }, [activeSegmentId, activeSegment, visibleSegments]);

  useEffect(() => {
    if (activeSegment && videoPath !== activeSegment.path) {
      setVideoPath(activeSegment.path);
    }
  }, [activeSegment, videoPath]);

  const videoUrl = useMemo(() => (videoPath ? buildFileUrl(videoPath) : null), [videoPath]);

  const currentWallMs = useMemo(() => {
    if (!activeSegment?.start_ms) {
      return null;
    }
    return activeSegment.start_ms + currentTime * 1000;
  }, [activeSegment, currentTime]);

  const isEventActive = useCallback(
    (event: EventView) => {
      if (!currentWallMs) {
        return false;
      }
      return Math.abs(event.ts_wall_ms - currentWallMs) <= 400;
    },
    [currentWallMs],
  );

  const findSegmentForWallMs = useCallback(
    (wallMs: number) => {
      for (const segment of visibleSegments) {
        if (segment.start_ms == null || segment.end_ms == null) {
          continue;
        }
        if (wallMs >= segment.start_ms && wallMs <= segment.end_ms) {
          return segment;
        }
      }
      return null;
    },
    [visibleSegments],
  );
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

  const handleSeekToWallMs = useCallback(
    (wallMs: number) => {
      const segment = findSegmentForWallMs(wallMs);
      if (!segment || segment.start_ms == null) {
        setVideoWarning("No video segment found for this event.");
        return;
      }
      const offsetSeconds = Math.max(0, (wallMs - segment.start_ms) / 1000);
      if (segment.path === videoPath && videoRef.current) {
        videoRef.current.currentTime = offsetSeconds;
        pendingPlayRef.current = true;
        videoRef.current
          .play()
          .then(() => {
            /* ignore */
          })
          .catch(() => {
            /* ignore */
          });
      } else {
        setActiveSegmentId(segment.id);
        setVideoPath(segment.path);
        setPendingSeekSeconds(offsetSeconds);
        pendingPlayRef.current = true;
      }
      setVideoWarning(null);
    },
    [findSegmentForWallMs, videoPath],
  );

  const handleTogglePlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    if (video.paused) {
      video.play().catch(() => {
        /* ignore */
      });
    } else {
      video.pause();
    }
  }, []);

  const handleRestart = useCallback(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.currentTime = 0;
    video.play().catch(() => {
      /* ignore */
    });
  }, []);

  const handleSliderChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    const next = Number(event.target.value || "0");
    video.currentTime = Math.max(0, next);
  }, []);

  const handlePlayerPointerMove = useCallback(() => {
    setControlsVisible(true);
    if (hideControlsTimeoutRef.current) {
      window.clearTimeout(hideControlsTimeoutRef.current);
    }
    hideControlsTimeoutRef.current = window.setTimeout(() => {
      const video = videoRef.current;
      if (!video || video.paused) {
        return;
      }
      setControlsVisible(false);
    }, 2000);
  }, []);

  const handlePlayerPointerLeave = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.paused) {
      return;
    }
    setControlsVisible(false);
  }, []);

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    if (Number.isFinite(video.duration)) {
      setVideoDuration(video.duration);
    } else if (activeSegment?.duration_s != null) {
      setVideoDuration(activeSegment.duration_s);
    }
    if (pendingSeekSeconds != null) {
      video.currentTime = Math.max(0, pendingSeekSeconds);
      setPendingSeekSeconds(null);
    }
    if (pendingPlayRef.current) {
      pendingPlayRef.current = false;
      video.play().catch(() => {
        /* ignore */
      });
    }
    switchInFlightRef.current = false;
  }, [activeSegment, pendingSeekSeconds]);

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    setCurrentTime(video.currentTime);
    if (!activeSegment || switchInFlightRef.current) {
      return;
    }
    const duration = activeSegment.duration_s ?? video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      return;
    }
    if (video.currentTime >= duration - 0.05) {
      const next = activeSegmentIndex >= 0 ? visibleSegments[activeSegmentIndex + 1] : null;
      if (next) {
        switchInFlightRef.current = true;
        setActiveSegmentId(next.id);
        setVideoPath(next.path);
        setPendingSeekSeconds(0);
        pendingPlayRef.current = true;
      }
    }
  }, [activeSegment, activeSegmentIndex, visibleSegments]);

  const handleVideoEnded = useCallback(() => {
    const next = activeSegmentIndex >= 0 ? visibleSegments[activeSegmentIndex + 1] : null;
    if (!next) {
      return;
    }
    switchInFlightRef.current = true;
    setActiveSegmentId(next.id);
    setVideoPath(next.path);
    setPendingSeekSeconds(0);
    pendingPlayRef.current = true;
  }, [activeSegmentIndex, visibleSegments]);

  useEffect(() => {
    return () => {
      if (hideControlsTimeoutRef.current) {
        window.clearTimeout(hideControlsTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setCurrentTime(0);
    setVideoDuration(null);
    setVideoError(null);
    setVideoWarning(null);
  }, [videoPath]);

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
          height: "100vh",
          overflowX: "hidden",
          overflowY: "hidden",
          background: "linear-gradient(180deg, #070b16 0%, #0a1224 40%, #0b1120 100%)",
          color: "#e2e8f0",
          padding: "32px 24px 24px",
          fontFamily: '"Space Grotesk", "Segoe UI", system-ui',
          boxSizing: "border-box",
        }}
      >
        <div
          style={{
            maxWidth: "100%",
            margin: "0 auto",
            display: "grid",
            gap: 24,
            height: "100%",
            gridTemplateRows: "auto 1fr",
            minHeight: 0,
            boxSizing: "border-box",
          }}
        >
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
              <h1 style={{ fontSize: 32, margin: 0 }}>Live Events + OBS Timeline</h1>
              <p style={{ margin: 0, color: "#94a3b8" }}>
                Stream timestone events in real time and click to jump the OBS player to the matching moment.
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
                {filterMode === "session" ? (
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
                ) : null}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
                <label style={{ flex: "1 1 320px", display: "grid", gap: 6 }}>
                  <span style={{ color: "#cbd5f5" }}>OBS folder</span>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
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
                      flex: 1,
                      height: 40,
                      boxSizing: "border-box",
                    }}
                  />
                    <button
                      type="button"
                      onClick={handlePickObsFolder}
                      aria-label="Pick OBS folder"
                      title="Pick OBS folder"
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 10,
                        border: "1px solid #1e293b",
                        background: "rgba(15, 23, 42, 0.8)",
                        color: "#e2e8f0",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        lineHeight: 0,
                        cursor: "pointer",
                        height: 40,
                      }}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
                        <path
                          d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v7a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7Z"
                          stroke="#93c5fd"
                          strokeWidth="1.6"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                    <input
                      ref={obsPickerRef}
                      type="file"
                      multiple
                      style={{ display: "none" }}
                      onChange={handleObsPickerChange}
                      {...({ webkitdirectory: "true", directory: "true" } as any)}
                    />
                  </div>
                </label>
                <button
                  type="button"
                  onClick={refreshObsVideos}
                  style={{
                    padding: "8px 12px",
                    borderRadius: 8,
                    border: "1px solid #1e293b",
                    background: "#0f172a",
                    color: "#e2e8f0",
                    cursor: "pointer",
                    height: 40,
                  }}
                >
                  Refresh videos
                </button>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
                <label style={{ display: "grid", gap: 6, minWidth: 200 }}>
                  <span style={{ color: "#cbd5f5" }}>Timeline filter</span>
                  <select
                    value={filterMode}
                    onChange={(event) =>
                      setFilterMode(event.target.value as "all" | "session" | "day" | "range" | "week" | "month")
                    }
                    style={{
                      padding: "8px 10px",
                      borderRadius: 8,
                      border: "1px solid #1e293b",
                      background: "#0b1120",
                      color: "#e2e8f0",
                    }}
                  >
                    <option value="all">All time</option>
                    <option value="session">Session</option>
                    <option value="day">Day</option>
                    <option value="range">Days range</option>
                    <option value="week">Week</option>
                    <option value="month">Month</option>
                  </select>
                </label>
                {filterMode === "day" ? (
                  <label style={{ display: "grid", gap: 6 }}>
                    <span style={{ color: "#cbd5f5" }}>Day</span>
                    <input
                      type="date"
                      value={filterDay}
                      onChange={(event) => setFilterDay(event.target.value)}
                      style={{
                        padding: "8px 10px",
                        borderRadius: 8,
                        border: "1px solid #1e293b",
                        background: "#0b1120",
                        color: "#e2e8f0",
                      }}
                    />
                  </label>
                ) : null}
                {filterMode === "range" ? (
                  <>
                    <label style={{ display: "grid", gap: 6 }}>
                      <span style={{ color: "#cbd5f5" }}>From</span>
                      <input
                        type="date"
                        value={filterRangeStart}
                        onChange={(event) => setFilterRangeStart(event.target.value)}
                        style={{
                          padding: "8px 10px",
                          borderRadius: 8,
                          border: "1px solid #1e293b",
                          background: "#0b1120",
                          color: "#e2e8f0",
                        }}
                      />
                    </label>
                    <label style={{ display: "grid", gap: 6 }}>
                      <span style={{ color: "#cbd5f5" }}>To</span>
                      <input
                        type="date"
                        value={filterRangeEnd}
                        onChange={(event) => setFilterRangeEnd(event.target.value)}
                        style={{
                          padding: "8px 10px",
                          borderRadius: 8,
                          border: "1px solid #1e293b",
                          background: "#0b1120",
                          color: "#e2e8f0",
                        }}
                      />
                    </label>
                  </>
                ) : null}
                {filterMode === "week" ? (
                  <label style={{ display: "grid", gap: 6 }}>
                    <span style={{ color: "#cbd5f5" }}>Week starting</span>
                    <input
                      type="date"
                      value={filterWeekStart}
                      onChange={(event) => setFilterWeekStart(event.target.value)}
                      style={{
                        padding: "8px 10px",
                        borderRadius: 8,
                        border: "1px solid #1e293b",
                        background: "#0b1120",
                        color: "#e2e8f0",
                      }}
                    />
                  </label>
                ) : null}
                {filterMode === "month" ? (
                  <label style={{ display: "grid", gap: 6 }}>
                    <span style={{ color: "#cbd5f5" }}>Month</span>
                    <input
                      type="month"
                      value={filterMonth}
                      onChange={(event) => setFilterMonth(event.target.value)}
                      style={{
                        padding: "8px 10px",
                        borderRadius: 8,
                        border: "1px solid #1e293b",
                        background: "#0b1120",
                        color: "#e2e8f0",
                      }}
                    />
                  </label>
                ) : null}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", color: "#94a3b8" }}>
                <span>Status: {liveEnabled && filterMode === "session" ? status : "Paused"}</span>
                {activeSession ? <span>Started {formatSessionDate(activeSession.start_wall_iso)}</span> : null}
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  Events loaded: {eventCount}
                  {eventsLoading ? (
                    <span style={{ display: "inline-flex", alignItems: "center", lineHeight: 0 }}>
                      <SyncIcon />
                    </span>
                  ) : null}
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  Videos: {obsFilteredCount}
                  {obsTotalCount ? ` / ${obsTotalCount}` : ""}
                  {obsLoading ? (
                    <span style={{ display: "inline-flex", alignItems: "center", lineHeight: 0 }}>
                      <SyncIcon />
                    </span>
                  ) : null}
                </span>
                {lastUpdate ? <span>Last update: {lastUpdate}</span> : null}
              </div>
              {error ? <div style={{ color: "#fca5a5" }}>{error}</div> : null}
              {obsError ? (
                <div style={{ color: "#fca5a5" }}>
                  {obsError.includes("Failed to read folder")
                    ? `Folder not found: ${obsFolder || DEFAULT_OBS_FOLDER}`
                    : obsError}
                </div>
              ) : null}
              {obsPickerWarning ? <div style={{ color: "#fbbf24" }}>{obsPickerWarning}</div> : null}
              {eventsError ? <div style={{ color: "#fca5a5" }}>{eventsError}</div> : null}
            </section>
          </div>

          <section
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) 640px",
              gap: 24,
              alignItems: "start",
              height: "100%",
              minHeight: 0,
              boxSizing: "border-box",
            }}
          >
            <div style={{ display: "grid", gap: 16, minHeight: 0 }}>
              <div
                style={{
                  borderRadius: 16,
                  padding: 16,
                  border: "1px solid rgba(30, 41, 59, 0.7)",
                  background: "rgba(11, 17, 32, 0.9)",
                  display: "grid",
                  gap: 12,
                }}
              >
                <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
                  <strong>Active segment</strong>
                  {activeSegment ? (
                    <>
                      <span style={{ color: "#cbd5f5" }}>{activeSegment.name}</span>
                      <span style={{ color: "#64748b" }}>
                        {activeSegment.start_ms ? new Date(activeSegment.start_ms).toLocaleTimeString() : "Unknown"}
                      </span>
                      {activeSegment.start_source !== "unknown" ? (
                        <span style={{ color: "#64748b" }}>({activeSegment.start_source})</span>
                      ) : null}
                    </>
                  ) : (
                    <span style={{ color: "#94a3b8" }}>No segment selected</span>
                  )}
                </div>
                {videoWarning ? <div style={{ color: "#facc15" }}>{videoWarning}</div> : null}
                {videoError ? <div style={{ color: "#fca5a5" }}>{videoError}</div> : null}
              </div>
              <div
                style={{
                  position: "relative",
                  background: "#111",
                  minHeight: 240,
                  height: "min(56vh, 480px)",
                  borderRadius: 12,
                  overflow: "hidden",
                }}
                onMouseMove={handlePlayerPointerMove}
                onMouseLeave={handlePlayerPointerLeave}
              >
                {videoUrl ? (
                  <video
                    ref={videoRef}
                    src={videoUrl}
                    preload="metadata"
                    playsInline
                    style={{ width: "100%", height: "100%", objectFit: "contain", background: "#0f172a" }}
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                    onTimeUpdate={handleTimeUpdate}
                    onLoadedMetadata={handleLoadedMetadata}
                    onEnded={() => {
                      setIsPlaying(false);
                      handleVideoEnded();
                    }}
                    onError={() =>
                      setVideoError(`Video failed to load. Ensure the server at ${API_BASE} can access the file.`)
                    }
                  />
                ) : (
                  <div
                    style={{
                      height: "100%",
                      display: "grid",
                      placeItems: "center",
                      color: "#94a3b8",
                      background: "#0f172a",
                    }}
                  >
                    No video loaded yet.
                  </div>
                )}
                {captionsEnabled && currentWallMs ? (
                  <div
                    style={{
                      position: "absolute",
                      left: "8%",
                      right: "8%",
                      bottom: 64,
                      padding: "8px 12px",
                      borderRadius: 8,
                      background: "rgba(15, 23, 42, 0.75)",
                      color: "#f8fafc",
                      textAlign: "center",
                      fontSize: 16,
                      lineHeight: 1.4,
                      textShadow: "0 1px 2px rgba(0,0,0,0.6)",
                      pointerEvents: "none",
                    }}
                  >
                    {activeSegment ? activeSegment.name : ""}
                  </div>
                ) : null}
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    bottom: 0,
                    padding: "16px 20px",
                    background: "linear-gradient(rgba(15, 23, 42, 0) 0%, rgba(15, 23, 42, 0.85) 100%)",
                    display: controlsVisible ? "grid" : "none",
                    gap: 12,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <button
                      type="button"
                      aria-label={isPlaying ? "Pause" : "Play"}
                      title={isPlaying ? "Pause" : "Play"}
                      onClick={handleTogglePlayback}
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
                      aria-label={captionsEnabled ? "Disable captions" : "Enable captions"}
                      title={captionsEnabled ? "Disable captions" : "Enable captions"}
                      onClick={() => setCaptionsEnabled((prev) => !prev)}
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: "50%",
                        border: "none",
                        background: captionsEnabled ? "rgba(56, 189, 248, 0.8)" : "rgba(15, 23, 42, 0.55)",
                        color: captionsEnabled ? "#0f172a" : "#f8fafc",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        cursor: "pointer",
                      }}
                    >
                      <SubtitleIcon color={captionsEnabled ? "#0f172a" : "#f8fafc"} />
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
                      <RestartIcon />
                    </button>
                    <span style={{ color: "#e2e8f0", fontVariantNumeric: "tabular-nums" }}>
                      {formatDurationMs(currentTime * 1000)} /{" "}
                      {formatDurationMs((videoDuration ?? activeSegment?.duration_s ?? 0) * 1000)}
                    </span>
                  </div>
                  <input
                    min={0}
                    max={videoDuration ?? activeSegment?.duration_s ?? 0}
                    step={0.05}
                    type="range"
                    value={currentTime}
                    onChange={handleSliderChange}
                    style={{ width: "100%", accentColor: "rgb(56, 189, 248)" }}
                  />
                </div>
              </div>
            </div>
            <div
              style={{
                display: "grid",
                gap: 16,
                width: "100%",
                justifySelf: "end",
                overflowY: "auto",
                paddingRight: 0,
                height: "100%",
                minHeight: 0,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <strong>Live events</strong>
                <span style={{ color: "#94a3b8" }}>{eventCount} events</span>
              </div>
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
                                background: isEventActive(row.events[0])
                                  ? "rgba(30, 64, 175, 0.25)"
                                  : "rgba(9, 14, 26, 0.9)",
                                display: "grid",
                                gap: 6,
                                cursor: "pointer",
                              }}
                              onClick={() => handleSeekToWallMs(row.events[0].ts_wall_ms)}
                            >
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
                                {row.events.length > 1 ? (
                                  <button
                                    type="button"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      toggleGroup(rowId);
                                    }}
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
                                          cursor: "pointer",
                                        }}
                                        onClick={() => handleSeekToWallMs(event.ts_wall_ms)}
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
                              background: isEventActive(event)
                                ? "rgba(30, 64, 175, 0.25)"
                                : "rgba(11, 17, 32, 0.9)",
                              display: "grid",
                              gap: 12,
                              cursor: "pointer",
                            }}
                            onClick={() => handleSeekToWallMs(event.ts_wall_ms)}
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
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
