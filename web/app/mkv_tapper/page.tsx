"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

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

type PinnedSession = {
  session_id: string;
  pinned_at: number;
};

type PinnedEvent = {
  event_id: number;
  pinned_at: number;
  session_id: string;
};

type OcrBox = {
  text: string;
  conf: number;
  left: number;
  top: number;
  width: number;
  height: number;
};

type OcrPreset = {
  id: string;
  label: string;
  description: string;
  psm: number;
  preprocess: string;
  scale?: number;
  oem?: number;
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
const PINNED_ONLY_STORAGE_KEY = "timestone:pinnedOnly:mkv_tapper";
const PINNED_EVENTS_ONLY_STORAGE_KEY = "timestone:pinnedEventsOnly:mkv_tapper";
const DEFAULT_OCR_PRESET_ID = "clean-ui";

const OCR_PRESETS: OcrPreset[] = [
  {
    id: "clean-ui",
    label: "Clean UI",
    description: "Gray + autocontrast + 2x up + PSM 11",
    psm: 11,
    preprocess: "gray_autocontrast",
    scale: 2,
  },
  {
    id: "dense-ui",
    label: "Dense UI",
    description: "Gray + autocontrast + PSM 6",
    psm: 6,
    preprocess: "gray_autocontrast",
    scale: 1,
  },
  {
    id: "high-contrast",
    label: "High Contrast",
    description: "Gray + adaptive threshold + PSM 11",
    psm: 11,
    preprocess: "gray_autocontrast_adaptive",
    scale: 1,
  },
  {
    id: "raw",
    label: "Raw Baseline",
    description: "No preprocess + PSM 11",
    psm: 11,
    preprocess: "none",
    scale: 1,
  },
];

// Icon maps for event types and applications
const EVENT_ICON_MAP: Record<string, string | undefined> = {
  mouse_click: process.env.NEXT_PUBLIC_EVENT_ICON_MOUSE_CLICK,
  key_down: process.env.NEXT_PUBLIC_EVENT_ICON_KEY_DOWN,
  key_shortcut: process.env.NEXT_PUBLIC_EVENT_ICON_KEY_SHORTCUT,
  text_input: process.env.NEXT_PUBLIC_EVENT_ICON_TEXT_INPUT,
  transcript: process.env.NEXT_PUBLIC_EVENT_ICON_TRANSCRIPT,
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

// Event row type for grouping consecutive events of same type
type EventRow =
  | { kind: "single"; event: EventView }
  | { kind: "group"; event_type: string; events: EventView[] };

// Segment type: groups events by active window (each active_window_changed starts a new segment)
type EventSegment = {
  id: string;
  events: EventView[];
};

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

// Resolves icon path to a full URL
function resolveIconSrc(path: string | null | undefined): string | null {
  if (!path) {
    return null;
  }
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  return buildFileUrl(path);
}

// Formats elapsed time as MM:SS.mmm
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

// Truncates text to a maximum length with ellipsis
function clipText(text: string, maxLen = 240): string {
  if (text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, maxLen)}...`;
}

// Formats keyboard shortcut from payload data
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

// Gets display name for an event's window
function windowLabel(event: EventView): string | null {
  return event.window_title || event.process_name || event.window_class || null;
}

// Segments events by active window - each active_window_changed starts a new segment
// All events after an active_window_changed belong to that segment until the next one
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
  // Reverse so newest segments come first, sort events within each segment newest first
  // (active_window_changed will naturally end up at the bottom since it's chronologically first)
  return segments
    .reverse()
    .map((segment) => ({
      ...segment,
      events: [...segment.events].sort((a, b) => b.ts_wall_ms - a.ts_wall_ms),
    }));
}

// Groups consecutive events of the same type within a segment for cleaner display
// Note: active_window_changed is kept as single (it's always first in segment anyway)
function groupConsecutiveByType(events: EventView[]): EventRow[] {
  const rows: EventRow[] = [];
  for (const event of events) {
    // active_window_changed is always first and never grouped
    if (event.event_type === "active_window_changed") {
      rows.push({ kind: "single", event });
      continue;
    }
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
  const [theaterMode, setTheaterMode] = useState(true);
  const [framesOnly, setFramesOnly] = useState(true);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [expandAll, setExpandAll] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [manualOffsetSec, setManualOffsetSec] = useState(0.2);
  const [pinnedSessions, setPinnedSessions] = useState<PinnedSession[]>([]);
  const [pinnedOnly, setPinnedOnly] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    try {
      const saved = localStorage.getItem(PINNED_ONLY_STORAGE_KEY);
      if (!saved) {
        return false;
      }
      return saved === "1" || saved.toLowerCase() === "true";
    } catch {
      return false;
    }
  });
  const [pinnedEvents, setPinnedEvents] = useState<PinnedEvent[]>([]);
  const [pinnedEventsOnly, setPinnedEventsOnly] = useState(() => {
    if (typeof window === "undefined") {
      return true;
    }
    try {
      const saved = localStorage.getItem(PINNED_EVENTS_ONLY_STORAGE_KEY);
      if (!saved) {
        return true;
      }
      return saved === "1" || saved.toLowerCase() === "true";
    } catch {
      return true;
    }
  });
  const [pinnedEventsLoading, setPinnedEventsLoading] = useState(false);
  const [pinnedEventsError, setPinnedEventsError] = useState<string | null>(null);
  const [initialPinnedEventApplied, setInitialPinnedEventApplied] = useState(false);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [pinsLoading, setPinsLoading] = useState(false);
  const [pinsError, setPinsError] = useState<string | null>(null);
  const [pinsLoaded, setPinsLoaded] = useState(false);
  const [initialPinApplied, setInitialPinApplied] = useState(false);
  const [ocrMode, setOcrMode] = useState(false);
  const [ocrPresetId, setOcrPresetId] = useState(DEFAULT_OCR_PRESET_ID);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [ocrText, setOcrText] = useState<string | null>(null);
  const [ocrBoxes, setOcrBoxes] = useState<OcrBox[]>([]);
  const [ocrFrameUrl, setOcrFrameUrl] = useState<string | null>(null);
  const [ocrFrameLoading, setOcrFrameLoading] = useState(false);
  const [ocrFrameError, setOcrFrameError] = useState<string | null>(null);
  const [ocrImageSize, setOcrImageSize] = useState<{ width: number; height: number } | null>(null);
  const [ocrContext, setOcrContext] = useState<{ eventId: number; filePath: string; offsetMs: number } | null>(null);
  const [ocrSaving, setOcrSaving] = useState(false);
  const [ocrSaveError, setOcrSaveError] = useState<string | null>(null);
  const [ocrSaveSuccess, setOcrSaveSuccess] = useState<string | null>(null);
  const [showOcrBoxes, setShowOcrBoxes] = useState(true);
  const [minOcrConf, setMinOcrConf] = useState(50);
  const [settingsMenuPos, setSettingsMenuPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const settingsRef = useRef<HTMLDivElement | null>(null);
  const settingsPanelRef = useRef<HTMLDivElement | null>(null);
  const sessionMenuRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    localStorage.setItem(PINNED_ONLY_STORAGE_KEY, pinnedOnly ? "1" : "0");
  }, [pinnedOnly]);

  useEffect(() => {
    localStorage.setItem(PINNED_EVENTS_ONLY_STORAGE_KEY, pinnedEventsOnly ? "1" : "0");
  }, [pinnedEventsOnly]);

  const activeSession = useMemo(
    () => sessions.find((session) => session.session_id === sessionId) || null,
    [sessions, sessionId]
  );
  const pinnedSessionSet = useMemo(() => {
    return new Set(pinnedSessions.map((pin) => pin.session_id));
  }, [pinnedSessions]);
  const pinnedEventSet = useMemo(() => {
    return new Set(pinnedEvents.map((pin) => pin.event_id));
  }, [pinnedEvents]);
  const eventsById = useMemo(() => {
    return new Map(events.map((event) => [event.id, event]));
  }, [events]);
  const ocrPreset = useMemo(
    () => OCR_PRESETS.find((preset) => preset.id === ocrPresetId) || OCR_PRESETS[0],
    [ocrPresetId]
  );

  const eventTypes = useMemo(() => {
    const types = new Set<string>();
    events.forEach((event) => types.add(event.event_type));
    return Array.from(types).sort();
  }, [events]);

  const missingPinnedSessions = useMemo(() => {
    if (!pinnedSessions.length) {
      return [];
    }
    return pinnedSessions.filter((pin) => !sessions.some((session) => session.session_id === pin.session_id));
  }, [pinnedSessions, sessions]);

  const visibleSessions = useMemo(() => {
    if (!pinnedOnly) {
      return sessions;
    }
    return sessions.filter((session) => pinnedSessionSet.has(session.session_id));
  }, [pinnedOnly, pinnedSessionSet, sessions]);

  const resetOcrState = useCallback(() => {
    setOcrLoading(false);
    setOcrError(null);
    setOcrText(null);
    setOcrBoxes([]);
    setOcrFrameUrl(null);
    setOcrFrameLoading(false);
    setOcrFrameError(null);
    setOcrImageSize(null);
    setOcrContext(null);
    setOcrSaving(false);
    setOcrSaveError(null);
    setOcrSaveSuccess(null);
    setShowOcrBoxes(true);
    setMinOcrConf(50);
  }, []);

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

  useEffect(() => {
    if (!ocrMode) {
      resetOcrState();
    }
  }, [ocrMode, resetOcrState]);

  useEffect(() => {
    resetOcrState();
  }, [sessionId, resetOcrState]);

  useEffect(() => {
    setInitialPinnedEventApplied(false);
  }, [sessionId]);

  const filteredEvents = useMemo(() => {
    let list = events;
    // When framesOnly is active, only show events that have captured frames
    if (framesOnly) {
      list = list.filter((event) => eventFrameIds.has(event.id));
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter((event) => eventSearchBlob(event).includes(q));
    }
    list = list.filter((event) => eventVisibility[event.event_type] !== false);
    if (pinnedEventsOnly) {
      list = list.filter((event) => pinnedEventSet.has(event.id));
    }
    return list;
  }, [events, eventVisibility, searchQuery, framesOnly, eventFrameIds, pinnedEventsOnly, pinnedEventSet]);

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
      const offsetMs =
        offsetBefore + Math.max(0, event.ts_wall_ms - match.start_wall_ms) + manualOffsetSec * 1000;
      return { path: match.obs_path, offsetMs };
    },
    [manualOffsetSec, segmentOffsets, segments],
  );

  // Toggles expansion state for event groups
  const toggleGroup = useCallback((rowId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) {
        next.delete(rowId);
      } else {
        next.add(rowId);
      }
      return next;
    });
  }, []);

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

  const buildMkvFrameUrl = useCallback((filePath: string, offsetMs: number) => {
    const params = new URLSearchParams();
    params.set("file_path", filePath);
    params.set("offset_ms", String(Math.round(offsetMs)));
    params.set("t", String(Date.now()));
    return `/api/mkv_frame?${params.toString()}`;
  }, []);

  const runOcrForEvent = useCallback(
    async (event: EventView) => {
      const info = resolveVideoInfo(event);
      if (!info?.path) {
        setOcrError("No video path available for OCR.");
        return;
      }
      selectEvent(event);
      setOcrSaveError(null);
      setOcrSaveSuccess(null);
      setOcrLoading(true);
      setOcrError(null);
      setOcrText(null);
      setOcrBoxes([]);
      setOcrImageSize(null);
      setOcrContext({ eventId: event.id, filePath: info.path, offsetMs: info.offsetMs });
      const nextFrameUrl = buildMkvFrameUrl(info.path, info.offsetMs);
      setOcrFrameUrl(nextFrameUrl);
      setOcrFrameLoading(true);
      setOcrFrameError(null);
      try {
        const res = await fetch("/api/mkv_ocr", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filePath: info.path,
            offsetMs: info.offsetMs,
            preprocess: ocrPreset.preprocess,
            psm: ocrPreset.psm,
            oem: ocrPreset.oem,
            scale: ocrPreset.scale,
          }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(payload.error || `OCR failed (${res.status})`);
        }
        const payload = await res.json();
        const text = typeof payload?.text === "string" ? payload.text : "";
        const boxes = Array.isArray(payload?.boxes) ? payload.boxes : [];
        const width = Number(payload?.width);
        const height = Number(payload?.height);
        setOcrText(text ? text : null);
        setOcrBoxes(boxes as OcrBox[]);
        if (Number.isFinite(width) && Number.isFinite(height)) {
          setOcrImageSize({ width, height });
        }
      } catch (err) {
        setOcrError(err instanceof Error ? err.message : "OCR failed");
      } finally {
        setOcrLoading(false);
      }
    },
    [buildMkvFrameUrl, ocrPreset, resolveVideoInfo, selectEvent],
  );

  const saveOcr = useCallback(async () => {
    if (!ocrContext) {
      setOcrSaveError("Run OCR before saving.");
      return;
    }
    setOcrSaving(true);
    setOcrSaveError(null);
    setOcrSaveSuccess(null);
    try {
      const res = await fetch("/api/mkv_ocr_save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventId: ocrContext.eventId,
          filePath: ocrContext.filePath,
          offsetMs: ocrContext.offsetMs,
          preprocess: ocrPreset.preprocess,
          psm: ocrPreset.psm,
          oem: ocrPreset.oem,
          scale: ocrPreset.scale,
          engine: "tesseract",
        }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `Save failed (${res.status})`);
      }
      const payload = await res.json().catch(() => ({}));
      const savedPath = typeof payload?.framePath === "string" ? payload.framePath : "";
      setOcrSaveSuccess(savedPath ? `Saved: ${savedPath}` : "Saved OCR.");
    } catch (err) {
      setOcrSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setOcrSaving(false);
    }
  }, [ocrContext, ocrPreset]);

  const fetchPinnedSessions = useCallback(async () => {
    setPinsLoading(true);
    setPinsError(null);
    try {
      const res = await fetch("/api/mkv_pins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "list" }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `Failed to load pins (${res.status})`);
      }
      const data = await res.json();
      const list = Array.isArray(data?.pins) ? data.pins : [];
      setPinnedSessions(list);
    } catch (err) {
      setPinnedSessions([]);
      setPinsError(err instanceof Error ? err.message : "Failed to load pins");
    } finally {
      setPinsLoading(false);
      setPinsLoaded(true);
    }
  }, []);

  const fetchPinnedEvents = useCallback(async (sessionIdValue: string) => {
    if (!sessionIdValue) {
      setPinnedEvents([]);
      return;
    }
    setPinnedEvents([]);
    setPinnedEventsLoading(true);
    setPinnedEventsError(null);
    try {
      const res = await fetch("/api/mkv_event_pins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "list", sessionId: sessionIdValue }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `Failed to load pinned events (${res.status})`);
      }
      const data = await res.json();
      const list = Array.isArray(data?.pins) ? data.pins : [];
      setPinnedEvents(list);
    } catch (err) {
      setPinnedEvents([]);
      setPinnedEventsError(err instanceof Error ? err.message : "Failed to load pinned events");
    } finally {
      setPinnedEventsLoading(false);
    }
  }, []);

  const updatePinnedEvent = useCallback(async (eventId: number, shouldPin: boolean) => {
    if (!sessionId) {
      return;
    }
    setPinnedEventsLoading(true);
    setPinnedEventsError(null);
    try {
      const res = await fetch("/api/mkv_event_pins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, sessionId, pinned: shouldPin }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `Failed to update pinned event (${res.status})`);
      }
      await fetchPinnedEvents(sessionId);
    } catch (err) {
      setPinnedEventsError(err instanceof Error ? err.message : "Failed to update pinned event");
    } finally {
      setPinnedEventsLoading(false);
    }
  }, [fetchPinnedEvents, sessionId]);

  const updatePinnedSession = useCallback(async (sessionIdToUpdate: string, shouldPin: boolean) => {
    if (!sessionIdToUpdate) {
      return;
    }
    setPinsLoading(true);
    setPinsError(null);
    try {
      const res = await fetch("/api/mkv_pins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sessionIdToUpdate, pinned: shouldPin }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `Failed to update pin (${res.status})`);
      }
      await fetchPinnedSessions();
    } catch (err) {
      setPinsError(err instanceof Error ? err.message : "Failed to update pin");
    } finally {
      setPinsLoading(false);
    }
  }, [fetchPinnedSessions]);

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
      await fetchPinnedSessions();
      setStatus("Ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sessions");
      setStatus("Error");
    }
  }, [fetchPinnedSessions]);

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
    if (!sessionId) {
      setPinnedEvents([]);
      return;
    }
    fetchPinnedEvents(sessionId);
  }, [fetchPinnedEvents, sessionId]);

  useEffect(() => {
    if (initialPinApplied || !pinsLoaded || sessions.length === 0) {
      return;
    }
    if (pinnedSessions.length > 0) {
      const preferred =
        pinnedSessions.find((pin) => sessions.some((session) => session.session_id === pin.session_id))
          ?.session_id || pinnedSessions[0]?.session_id;
      if (preferred) {
        setSessionId(preferred);
      }
      setInitialPinApplied(true);
      return;
    }
    if (!sessionId && sessions.length > 0) {
      setSessionId(sessions[0].session_id);
    }
    setInitialPinApplied(true);
  }, [initialPinApplied, pinsLoaded, pinnedSessions, sessionId, sessions]);

  useEffect(() => {
    fetchEvents();
    fetchSegments();
    fetchEventFrameIndex();
  }, [fetchEvents, fetchSegments, fetchEventFrameIndex]);

  useEffect(() => {
    if (initialPinnedEventApplied || pinnedEventsLoading || !sessionId) {
      return;
    }
    if (selectedEvent) {
      setInitialPinnedEventApplied(true);
      return;
    }
    if (!pinnedEvents.length) {
      setInitialPinnedEventApplied(true);
      return;
    }
    for (const pin of pinnedEvents) {
      const event = eventsById.get(pin.event_id);
      if (event) {
        selectEvent(event);
        setInitialPinnedEventApplied(true);
        return;
      }
    }
    setInitialPinnedEventApplied(true);
  }, [eventsById, initialPinnedEventApplied, pinnedEvents, pinnedEventsLoading, selectEvent, selectedEvent, sessionId]);

  // Reset video/frames when session changes
  useEffect(() => {
    setVideoSrc(null);
    setSelectedEvent(null);
    setEventFrames([]);
    setFrameIndex(0);
    setExpandedGroups(new Set());
  }, [sessionId]);

  // Close settings dropdown when clicking outside
  useEffect(() => {
    if (!settingsOpen) {
      return;
    }
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (settingsRef.current?.contains(target)) {
        return;
      }
      if (settingsPanelRef.current?.contains(target)) {
        return;
      }
      if (settingsRef.current) {
        setSettingsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [settingsOpen]);

  useEffect(() => {
    if (!settingsOpen) {
      setSettingsMenuPos(null);
      return;
    }
    if (!settingsRef.current) {
      return;
    }
    const rect = settingsRef.current.getBoundingClientRect();
    const width = 280;
    const margin = 8;
    const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
    const top = rect.bottom + margin;
    const maxHeight = Math.max(160, Math.min(400, window.innerHeight - top - 12));
    setSettingsMenuPos({ left, top, maxHeight });
  }, [settingsOpen]);

  useEffect(() => {
    if (!sessionMenuOpen) {
      return;
    }
    const handleClickOutside = (e: MouseEvent) => {
      if (sessionMenuRef.current && !sessionMenuRef.current.contains(e.target as Node)) {
        setSessionMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [sessionMenuOpen]);

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

  // Segment filtered events by active window for sidebar display
  const eventSegments = useMemo(() => segmentByActiveWindow(filteredEvents), [filteredEvents]);

  // Renders event details like clipboard content, shortcuts, typed text
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
      <div style={{ display: "grid", gap: 6, overflowWrap: "anywhere", wordBreak: "break-word", minWidth: 0 }}>
        {event.event_type === "transcript" && clipTextValue ? (
          <div style={{ color: "#cbd5f5", whiteSpace: "pre-wrap" }}>{clipText(clipTextValue, 600)}</div>
        ) : null}
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
            <div style={{ color: "#64748b", overflowWrap: "anywhere" }}>{clipboardPath}</div>
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
          <div style={{ color: "#94a3b8" }}>
            Click @ {mouse.x},{mouse.y}
          </div>
        ) : null}
      </div>
    );
  };

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
      <style>{`
        .mkv-tapper-sidebar {
          scrollbar-width: thin;
          scrollbar-color: rgba(148, 163, 184, 0.5) transparent;
          scrollbar-gutter: stable;
        }
        .mkv-tapper-sidebar::-webkit-scrollbar {
          width: 8px;
        }
        .mkv-tapper-sidebar::-webkit-scrollbar-track {
          background: transparent;
        }
        .mkv-tapper-sidebar::-webkit-scrollbar-thumb {
          background: rgba(51, 65, 85, 0.7);
          border-radius: 999px;
        }
        .mkv-tapper-sidebar::-webkit-scrollbar-thumb:hover {
          background: rgba(100, 116, 139, 0.9);
        }
      `}</style>
      <div style={{ maxWidth: "100%", margin: "0 auto", display: "grid", gap: 20 }}>
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
          <div ref={sessionMenuRef} style={{ display: "grid", gap: 6, minWidth: 260, position: "relative" }}>
            <span style={{ color: "#cbd5f5" }}>Timestone session</span>
            <button
              type="button"
              onClick={() => setSessionMenuOpen((prev) => !prev)}
              style={{
                padding: "8px 10px",
                borderRadius: 8,
                border: "1px solid #1e293b",
                background: "#0b1120",
                color: "#e2e8f0",
                textAlign: "left",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <span>
                {activeSession
                  ? `${formatSessionDate(activeSession.start_wall_iso)} (${activeSession.session_id.slice(0, 8)})`
                  : "Select a session..."}
              </span>
              <span style={{ color: "#64748b" }}>{sessionMenuOpen ? "^" : "v"}</span>
            </button>
            {sessionMenuOpen ? (
              <div
                style={{
                  position: "absolute",
                  top: "100%",
                  left: 0,
                  right: 0,
                  marginTop: 8,
                  background: "#0b1120",
                  border: "1px solid #1e293b",
                  borderRadius: 10,
                  padding: 10,
                  zIndex: 20,
                  boxShadow: "0 18px 40px rgba(15, 23, 42, 0.45)",
                  display: "grid",
                  gap: 8,
                  maxHeight: 320,
                  overflowY: "auto",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ color: "#cbd5f5", fontSize: 13 }}>Pinned only</span>
                  <button
                    type="button"
                    onClick={() => setPinnedOnly((prev) => !prev)}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 999,
                      border: "1px solid #1e293b",
                      background: pinnedOnly ? "rgba(56, 189, 248, 0.18)" : "#0f172a",
                      color: pinnedOnly ? "#e0f2fe" : "#94a3b8",
                      cursor: "pointer",
                      fontSize: 12,
                    }}
                  >
                    {pinnedOnly ? "On" : "Off"}
                  </button>
                </div>
                {visibleSessions.length ? (
                  <div style={{ display: "grid", gap: 6 }}>
                    {visibleSessions.map((session) => {
                      const isPinned = pinnedSessionSet.has(session.session_id);
                      return (
                        <button
                          key={session.session_id}
                          type="button"
                          onClick={() => {
                            setSessionId(session.session_id);
                            setSessionMenuOpen(false);
                            setInitialPinApplied(true);
                          }}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 10,
                            padding: "8px 10px",
                            borderRadius: 8,
                            border: activeSession?.session_id === session.session_id
                              ? "1px solid rgba(56, 189, 248, 0.7)"
                              : "1px solid rgba(30, 41, 59, 0.6)",
                            background: activeSession?.session_id === session.session_id
                              ? "rgba(56, 189, 248, 0.12)"
                              : "rgba(15, 23, 42, 0.7)",
                            color: "#e2e8f0",
                            cursor: "pointer",
                            textAlign: "left",
                          }}
                        >
                          <span style={{ fontSize: 13 }}>
                            {formatSessionDate(session.start_wall_iso)} ({session.session_id.slice(0, 8)})
                          </span>
                          <span
                            onClick={(e) => {
                              e.stopPropagation();
                              updatePinnedSession(session.session_id, !isPinned);
                            }}
                            style={{
                              width: 24,
                              height: 24,
                              borderRadius: 6,
                              border: "1px solid rgba(30, 41, 59, 0.7)",
                              background: isPinned ? "rgba(251, 191, 36, 0.2)" : "transparent",
                              color: isPinned ? "#facc15" : "#94a3b8",
                              display: "grid",
                              placeItems: "center",
                              cursor: "pointer",
                              flexShrink: 0,
                            }}
                            title={isPinned ? "Unpin session" : "Pin session"}
                          >
                            {isPinned ? (
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M12 2l2.9 6.6 7.1.6-5.4 4.6 1.7 7-6.3-3.8-6.3 3.8 1.7-7L2 9.2l7.1-.6L12 2z" />
                              </svg>
                            ) : (
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                                <path d="M12 2l2.9 6.6 7.1.6-5.4 4.6 1.7 7-6.3-3.8-6.3 3.8 1.7-7L2 9.2l7.1-.6L12 2z" />
                              </svg>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div style={{ color: "#64748b", fontSize: 13 }}>
                    {pinnedOnly ? "No pinned sessions." : "No sessions available."}
                  </div>
                )}
                {missingPinnedSessions.length ? (
                  <div style={{ display: "grid", gap: 6 }}>
                    <div style={{ color: "#64748b", fontSize: 12 }}>Missing pinned sessions</div>
                    {missingPinnedSessions.map((pin) => (
                      <div
                        key={pin.session_id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 10,
                          padding: "6px 8px",
                          borderRadius: 8,
                          border: "1px dashed rgba(148, 163, 184, 0.4)",
                          color: "#94a3b8",
                          fontSize: 12,
                        }}
                      >
                        <span>{pin.session_id.slice(0, 12)} (missing)</span>
                        <button
                          type="button"
                          onClick={() => updatePinnedSession(pin.session_id, false)}
                          style={{
                            padding: "2px 8px",
                            borderRadius: 999,
                            border: "1px solid rgba(30, 41, 59, 0.7)",
                            background: "transparent",
                            color: "#94a3b8",
                            cursor: "pointer",
                            fontSize: 11,
                          }}
                        >
                          Unpin
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
                {pinsLoading ? <div style={{ color: "#64748b", fontSize: 12 }}>Updating pins...</div> : null}
                {pinsError ? <div style={{ color: "#fca5a5", fontSize: 12 }}>{pinsError}</div> : null}
              </div>
            ) : null}
          </div>
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
            onClick={() => setOcrMode((prev) => !prev)}
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              border: "1px solid #1e293b",
              background: ocrMode ? "rgba(56, 189, 248, 0.18)" : "#0f172a",
              color: ocrMode ? "#e0f2fe" : "#94a3b8",
              cursor: "pointer",
            }}
          >
            OCR mode {ocrMode ? "On" : "Off"}
          </button>
          <div style={{ color: "#94a3b8" }}>{status}</div>
          {error ? <div style={{ color: "#fca5a5" }}>{error}</div> : null}
        </section>

        <section
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) minmax(380px, 520px)",
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
              <div style={{ marginBottom: 8, color: "#94a3b8", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>{activeSession?.obs_video_path ? `Video: ${activeSession.obs_video_path}` : "No OBS video path"}</span>
                <button
                  type="button"
                  onClick={() => setTheaterMode((prev) => !prev)}
                  title={theaterMode ? "Exit theater mode" : "Enter theater mode"}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 8,
                    border: "1px solid #1e293b",
                    background: theaterMode ? "rgba(56, 189, 248, 0.18)" : "#0f172a",
                    color: theaterMode ? "#e0f2fe" : "#94a3b8",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 13,
                  }}
                >
                  {/* Expand/collapse icon */}
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    {theaterMode ? (
                      <>
                        {/* Collapse icon */}
                        <polyline points="4 14 10 14 10 20" />
                        <polyline points="20 10 14 10 14 4" />
                        <line x1="14" y1="10" x2="21" y2="3" />
                        <line x1="3" y1="21" x2="10" y2="14" />
                      </>
                    ) : (
                      <>
                        {/* Expand icon */}
                        <polyline points="15 3 21 3 21 9" />
                        <polyline points="9 21 3 21 3 15" />
                        <line x1="21" y1="3" x2="14" y2="10" />
                        <line x1="3" y1="21" x2="10" y2="14" />
                      </>
                    )}
                  </svg>
                  {theaterMode ? "Compact" : "Theater"}
                </button>
              </div>
              <div style={{ position: "relative", width: "100%", height: theaterMode ? "calc(100vh - 380px)" : "min(60vh, 520px)" }}>
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
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <strong>{ocrMode ? "OCR frame" : "Event frame"}</strong>
                {ocrMode ? (
                  <>
                    <select
                      value={ocrPresetId}
                      onChange={(event) => setOcrPresetId(event.target.value)}
                      style={{
                        padding: "6px 8px",
                        borderRadius: 8,
                        border: "1px solid #1e293b",
                        background: "#0f172a",
                        color: "#e2e8f0",
                      }}
                    >
                      {OCR_PRESETS.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {preset.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => selectedEvent && runOcrForEvent(selectedEvent)}
                      disabled={!selectedEvent || ocrLoading}
                      style={{
                        padding: "6px 10px",
                        borderRadius: 8,
                        border: "1px solid #1e293b",
                        background: "#0f172a",
                        color: "#e2e8f0",
                        cursor: "pointer",
                      }}
                    >
                      Run OCR
                    </button>
                    <button
                      type="button"
                      onClick={saveOcr}
                      disabled={!ocrText || ocrSaving}
                      style={{
                        padding: "6px 10px",
                        borderRadius: 8,
                        border: "1px solid #1e293b",
                        background: "rgba(34, 197, 94, 0.18)",
                        color: "#bbf7d0",
                        cursor: "pointer",
                      }}
                    >
                      {ocrSaving ? "Saving..." : "Save OCR"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowOcrBoxes((prev) => !prev)}
                      style={{
                        padding: "6px 10px",
                        borderRadius: 8,
                        border: "1px solid #1e293b",
                        background: showOcrBoxes ? "rgba(56, 189, 248, 0.18)" : "#0f172a",
                        color: showOcrBoxes ? "#e0f2fe" : "#94a3b8",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                      title={showOcrBoxes ? "Hide boxes" : "Show boxes"}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                        <rect
                          x="4"
                          y="4"
                          width="16"
                          height="16"
                          rx="2.5"
                          stroke="currentColor"
                          strokeWidth="1.6"
                        />
                      </svg>
                      Boxes
                    </button>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ color: "#94a3b8", fontSize: 12 }}>Min conf</span>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={minOcrConf}
                        onChange={(event) => setMinOcrConf(Number(event.target.value))}
                        style={{ width: 90 }}
                      />
                      <span style={{ color: "#cbd5f5", fontSize: 12, minWidth: 28 }}>{minOcrConf}%</span>
                    </div>
                    <span style={{ color: "#64748b" }}>{ocrPreset.description}</span>
                    {ocrLoading ? <span style={{ color: "#94a3b8" }}>Running OCR...</span> : null}
                    {ocrError ? <span style={{ color: "#fca5a5" }}>{ocrError}</span> : null}
                    {ocrFrameError ? <span style={{ color: "#fca5a5" }}>{ocrFrameError}</span> : null}
                    {ocrSaveError ? <span style={{ color: "#fca5a5" }}>{ocrSaveError}</span> : null}
                    {ocrSaveSuccess ? <span style={{ color: "#86efac" }}>{ocrSaveSuccess}</span> : null}
                  </>
                ) : (
                  <>
                    {frameLoading ? <span style={{ color: "#94a3b8" }}>Loading...</span> : null}
                    {frameError ? <span style={{ color: "#fca5a5" }}>{frameError}</span> : null}
                  </>
                )}
              </div>
              <div style={{ position: "relative", width: "100%", minHeight: 260 }}>
                {ocrMode ? (
                  ocrFrameUrl ? (
                    <div style={{ position: "relative", width: "100%" }}>
                      <img
                        src={ocrFrameUrl}
                        alt="OCR frame"
                        onLoad={(event) => {
                          setOcrFrameLoading(false);
                          const target = event.currentTarget;
                          if (target?.naturalWidth && target?.naturalHeight) {
                            setOcrImageSize({ width: target.naturalWidth, height: target.naturalHeight });
                          }
                        }}
                        onError={() => {
                          setOcrFrameLoading(false);
                          setOcrFrameError("Failed to load OCR frame.");
                        }}
                        style={{ width: "100%", height: "auto", borderRadius: 12, border: "1px solid #1e293b" }}
                      />
                      {ocrFrameLoading ? (
                        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
                          <div style={{ color: "#94a3b8" }}>Loading frame...</div>
                        </div>
                      ) : null}
                      {showOcrBoxes && ocrBoxes.length && ocrImageSize ? (
                        <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
                          {ocrBoxes.map((box, idx) => {
                            const confValue = Number.isFinite(box.conf) ? box.conf : -1;
                            if (confValue >= 0 && confValue < minOcrConf) {
                              return null;
                            }
                            const left = (box.left / ocrImageSize.width) * 100;
                            const top = (box.top / ocrImageSize.height) * 100;
                            const width = (box.width / ocrImageSize.width) * 100;
                            const height = (box.height / ocrImageSize.height) * 100;
                            const labelAbove = top > 3;
                            const labelTop = labelAbove ? top - 3 : top + 1;
                            return (
                              <div
                                key={`${box.text}-${idx}`}
                                title={`${box.text} (${Math.round(confValue)})`}
                                style={{
                                  position: "absolute",
                                  left: `${left}%`,
                                  top: `${top}%`,
                                  width: `${width}%`,
                                  height: `${height}%`,
                                  border: "1px solid rgba(56, 189, 248, 0.8)",
                                  boxShadow: "0 0 0 1px rgba(14, 116, 144, 0.35) inset",
                                  background: "rgba(56, 189, 248, 0.08)",
                                }}
                              >
                                <div
                                  style={{
                                    position: "absolute",
                                    left: 0,
                                    top: `${labelTop}%`,
                                    transform: labelAbove ? "translateY(-100%)" : "none",
                                    background: "rgba(15, 23, 42, 0.88)",
                                    color: "#e2e8f0",
                                    border: "1px solid rgba(56, 189, 248, 0.6)",
                                    borderRadius: 6,
                                    padding: "1px 6px",
                                    fontSize: 10,
                                    whiteSpace: "nowrap",
                                    maxWidth: "220px",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                  }}
                                >
                                  {box.text} ({Math.round(confValue)}%)
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div style={{ color: "#64748b" }}>Click OCR on an event to extract a frame.</div>
                  )
                ) : currentFrameUrl ? (
                  <img
                    src={currentFrameUrl}
                    alt="Event frame"
                    style={{ width: "100%", height: "auto", borderRadius: 12, border: "1px solid #1e293b" }}
                  />
                ) : (
                  <div style={{ color: "#64748b" }}>No frame loaded.</div>
                )}
              </div>
              {ocrMode ? (
                <div style={{ display: "grid", gap: 8 }}>
                  <strong>OCR text</strong>
                  {ocrLoading ? (
                    <div style={{ color: "#94a3b8" }}>Running OCR...</div>
                  ) : ocrText ? (
                    <div style={{ color: "#cbd5f5", whiteSpace: "pre-wrap" }}>{ocrText}</div>
                  ) : (
                    <div style={{ color: "#64748b" }}>No OCR text yet.</div>
                  )}
                </div>
              ) : (
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
              )}
            </div>
          </div>

          <aside
            className="mkv-tapper-sidebar"
            style={{
              background: "#0b1120",
              borderRadius: 14,
              padding: 16,
              border: "1px solid #1e293b",
              maxHeight: "calc(100vh - 160px)",
              overflowY: "auto",
              overflowX: "hidden",
              minWidth: 0,
            }}
          >
            {/* Sticky header section with filters */}
            <div
              style={{
                position: "sticky",
                top: -16,
                zIndex: 10,
                background: "#0b1120",
                paddingTop: 16,
                paddingBottom: 12,
                marginTop: -16,
                marginLeft: -16,
                marginRight: -16,
                paddingLeft: 16,
                paddingRight: 16,
              }}
            >
              {/* Sidebar header with event count and settings */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <strong>Events</strong>
                  <span style={{ color: "#94a3b8" }}>{filteredEvents.length} events</span>
                </div>
                {/* Settings dropdown */}
                <div ref={settingsRef} style={{ position: "relative" }}>
                  <button
                    type="button"
                    onClick={() => setSettingsOpen((prev) => !prev)}
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 8,
                      border: "1px solid #1e293b",
                      background: settingsOpen ? "rgba(56, 189, 248, 0.18)" : "#0f172a",
                      color: settingsOpen ? "#e0f2fe" : "#94a3b8",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                    title="Event settings"
                  >
                    {/* Gear icon */}
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z"
                        stroke="currentColor"
                        strokeWidth="1.6"
                      />
                      <path
                        d="M19.4 13.5a1 1 0 0 0 .2 1.1l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6.9V19a2 2 0 0 1-4 0v-.1a1 1 0 0 0-.6-.9 1 1 0 0 0-1.1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1 1 0 0 0 .2-1.1 1 1 0 0 0-.9-.6H5a2 2 0 0 1 0-4h.1a1 1 0 0 0 .9-.6 1 1 0 0 0-.2-1.1l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1 1 0 0 0 1.1.2 1 1 0 0 0 .6-.9V5a2 2 0 0 1 4 0v.1a1 1 0 0 0 .6.9 1 1 0 0 0 1.1-.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1 1 0 0 0-.2 1.1 1 1 0 0 0 .9.6H19a2 2 0 0 1 0 4h-.1a1 1 0 0 0-.9.6Z"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                  {/* Dropdown panel rendered via portal */}
                </div>
              </div>

              {/* Search input */}
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
                  width: "100%",
                  boxSizing: "border-box",
                }}
              />
            </div>

            {/* Event list segmented by active window */}
            <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
              {eventSegments.length === 0 ? (
                <div style={{ color: "#64748b" }}>No events loaded.</div>
              ) : (
                eventSegments.map((segment) => {
                  // Find the active_window_changed event (last in the sorted array - oldest chronologically)
                  const awcEvent = segment.events.find((e) => e.event_type === "active_window_changed");
                  const segmentHasNoFrames = awcEvent ? !eventFrameIds.has(awcEvent.id) : false;

                  // Group all events in the segment by consecutive type
                  const rows = groupConsecutiveByType(segment.events);

                  return (
                    <div
                      key={segment.id}
                      style={{
                        borderRadius: 16,
                        padding: 16,
                        border: segmentHasNoFrames
                          ? "1px solid rgba(244, 114, 182, 0.5)"
                          : "1px solid rgba(30, 41, 59, 0.7)",
                        borderLeft: segmentHasNoFrames
                          ? "3px solid rgba(244, 114, 182, 0.7)"
                          : "3px solid rgba(56, 189, 248, 0.7)",
                        background: segmentHasNoFrames
                          ? "rgba(244, 114, 182, 0.08)"
                          : "rgba(11, 17, 32, 0.9)",
                        display: "grid",
                        gap: 12,
                      }}
                    >
                      {/* All events within this segment */}
                      <div style={{ display: "grid", gap: 10 }}>
                        {rows.map((row, rowIndex) => {
                          const rowId = `${segment.id}-${rowIndex}`;

                            // Grouped events (consecutive same-type events)
                          if (row.kind === "group") {
                            const expanded = expandAll || expandedGroups.has(rowId);
                              const groupMonoTime = activeSession
                                ? formatDurationMs(row.events[0].ts_wall_ms - activeSession.start_wall_ms)
                                : formatDurationMs(row.events[0].ts_mono_ms);
                              const groupIcon = resolveIconSrc(EVENT_ICON_MAP[row.event_type]);
                              const groupSelected = selectedEvent?.id === row.events[0].id;
                              const groupPinned = pinnedEventSet.has(row.events[0].id);

                              return (
                                <div
                                  key={rowId}
                                  style={{
                                    borderRadius: 12,
                                    padding: "10px 12px",
                                    border: selectedEvent && row.events.some((e) => e.id === selectedEvent.id)
                                      ? "1px solid #38bdf8"
                                      : "1px solid rgba(30, 41, 59, 0.6)",
                                    background: selectedEvent && row.events.some((e) => e.id === selectedEvent.id)
                                      ? "rgba(30, 64, 175, 0.25)"
                                      : "rgba(9, 14, 26, 0.9)",
                                    display: "grid",
                                    gap: 6,
                                    cursor: "pointer",
                                    minWidth: 0,
                                    overflowWrap: "anywhere",
                                    wordBreak: "break-word",
                                  }}
                                  onClick={() => selectEvent(row.events[0])}
                                >
                                  <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
                                    {/* Expand/collapse button */}
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
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
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                      }}
                                      aria-label={expanded ? "Collapse group" : "Expand group"}
                                    >
                                      {expanded ? "-" : "+"}
                                    </button>

                                    {/* Event type icon */}
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

                                    <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
                                      {groupSelected && ocrMode ? (
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            runOcrForEvent(row.events[0]);
                                          }}
                                          style={{
                                            padding: "4px 8px",
                                            borderRadius: 8,
                                            border: "1px solid rgba(30, 41, 59, 0.8)",
                                            background: "rgba(56, 189, 248, 0.18)",
                                            color: "#e0f2fe",
                                            cursor: "pointer",
                                            fontSize: 12,
                                          }}
                                          title="Run OCR on this event"
                                        >
                                          OCR
                                        </button>
                                      ) : null}
                                      {groupSelected ? (
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            updatePinnedEvent(row.events[0].id, !groupPinned);
                                          }}
                                          style={{
                                            padding: "4px 8px",
                                            borderRadius: 8,
                                            border: "1px solid rgba(30, 41, 59, 0.8)",
                                            background: groupPinned ? "rgba(251, 191, 36, 0.2)" : "transparent",
                                            color: groupPinned ? "#facc15" : "#94a3b8",
                                            cursor: "pointer",
                                            fontSize: 12,
                                            display: "flex",
                                            alignItems: "center",
                                            gap: 6,
                                          }}
                                          title={groupPinned ? "Unpin event" : "Pin event"}
                                        >
                                          {groupPinned ? (
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                                              <path d="M12 2l2.9 6.6 7.1.6-5.4 4.6 1.7 7-6.3-3.8-6.3 3.8 1.7-7L2 9.2l7.1-.6L12 2z" />
                                            </svg>
                                          ) : (
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                                              <path d="M12 2l2.9 6.6 7.1.6-5.4 4.6 1.7 7-6.3-3.8-6.3 3.8 1.7-7L2 9.2l7.1-.6L12 2z" />
                                            </svg>
                                          )}
                                          Pin
                                        </button>
                                      ) : null}
                                      {/* Event count badge */}
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
                                    </div>
                                  </div>

                                  {renderEventDetails(row.events[0])}

                                  {/* Expanded sub-events */}
                                  {expanded ? (
                                    <div style={{ display: "grid", gap: 6, paddingLeft: 10 }}>
                                      {row.events.map((event) => {
                                        const eventPayload = event.payloadData || {};
                                        const eventMouse = event.mouseData || {};
                                        const isSelected = selectedEvent?.id === event.id;
                                        const isPinned = pinnedEventSet.has(event.id);
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
                                              border: selectedEvent?.id === event.id
                                                ? "1px solid #38bdf8"
                                                : "1px solid rgba(30, 41, 59, 0.6)",
                                              background: selectedEvent?.id === event.id
                                                ? "rgba(30, 64, 175, 0.25)"
                                                : "rgba(7, 12, 22, 0.85)",
                                              display: "grid",
                                              gap: 4,
                                              cursor: "pointer",
                                            }}
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              selectEvent(event);
                                            }}
                                          >
                                            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                                              <span style={{ color: "#cbd5f5", fontSize: 12 }}>
                                                {formatWallTime(event.ts_wall_ms)}
                                              </span>
                                              <span style={{ color: "#94a3b8", fontSize: 12 }}>
                                                {event.event_type.replace(/_/g, " ")}
                                              </span>
                                              {isSelected ? (
                                                <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
                                                  {ocrMode ? (
                                                    <button
                                                      type="button"
                                                      onClick={(e) => {
                                                        e.stopPropagation();
                                                        runOcrForEvent(event);
                                                      }}
                                                      style={{
                                                        padding: "4px 8px",
                                                        borderRadius: 8,
                                                        border: "1px solid rgba(30, 41, 59, 0.8)",
                                                        background: "rgba(56, 189, 248, 0.18)",
                                                        color: "#e0f2fe",
                                                        cursor: "pointer",
                                                        fontSize: 12,
                                                      }}
                                                      title="Run OCR on this event"
                                                    >
                                                      OCR
                                                    </button>
                                                  ) : null}
                                                  <button
                                                    type="button"
                                                    onClick={(e) => {
                                                      e.stopPropagation();
                                                      updatePinnedEvent(event.id, !isPinned);
                                                    }}
                                                    style={{
                                                      padding: "4px 8px",
                                                      borderRadius: 8,
                                                      border: "1px solid rgba(30, 41, 59, 0.8)",
                                                      background: isPinned ? "rgba(251, 191, 36, 0.2)" : "transparent",
                                                      color: isPinned ? "#facc15" : "#94a3b8",
                                                      cursor: "pointer",
                                                      fontSize: 12,
                                                      display: "flex",
                                                      alignItems: "center",
                                                      gap: 6,
                                                    }}
                                                    title={isPinned ? "Unpin event" : "Pin event"}
                                                  >
                                                    {isPinned ? (
                                                      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                                                        <path d="M12 2l2.9 6.6 7.1.6-5.4 4.6 1.7 7-6.3-3.8-6.3 3.8 1.7-7L2 9.2l7.1-.6L12 2z" />
                                                      </svg>
                                                    ) : (
                                                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                                                        <path d="M12 2l2.9 6.6 7.1.6-5.4 4.6 1.7 7-6.3-3.8-6.3 3.8 1.7-7L2 9.2l7.1-.6L12 2z" />
                                                      </svg>
                                                    )}
                                                    Pin
                                                  </button>
                                                </div>
                                              ) : null}
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

                            // Single event (not grouped)
                          const event = row.event;
                          const wallTime = formatWallTime(event.ts_wall_ms);
                          const monoTime = activeSession
                            ? formatDurationMs(event.ts_wall_ms - activeSession.start_wall_ms)
                            : formatDurationMs(event.ts_mono_ms);
                          const eventWindowName = windowLabel(event);
                          const windowInitial = eventWindowName ? eventWindowName.slice(0, 1).toUpperCase() : "?";
                          const eventIcon = resolveIconSrc(EVENT_ICON_MAP[event.event_type]);
                          const isActiveWindow = event.event_type === "active_window_changed";
                          const isSelected = selectedEvent?.id === event.id;
                          const isPinned = pinnedEventSet.has(event.id);
                          const appIcon = resolveIconSrc(
                            isActiveWindow
                              ? (event.payloadData?.app_icon_path as string | undefined) ||
                                  APP_ICON_MAP[event.process_name || ""] ||
                                  null
                              : null
                          );

                          return (
                            <div
                              key={event.id}
                              style={{
                                borderRadius: 14,
                                padding: isActiveWindow ? 16 : "10px 12px",
                                border: selectedEvent?.id === event.id
                                  ? "1px solid #38bdf8"
                                  : "1px solid rgba(30, 41, 59, 0.6)",
                                borderLeft: isActiveWindow && selectedEvent?.id !== event.id
                                  ? "3px solid rgba(56, 189, 248, 0.7)"
                                  : undefined,
                                background: selectedEvent?.id === event.id
                                  ? "rgba(30, 64, 175, 0.25)"
                                  : "rgba(9, 14, 26, 0.9)",
                                display: "grid",
                                gap: isActiveWindow ? 12 : 6,
                                cursor: "pointer",
                                minWidth: 0,
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                              }}
                              onClick={() => selectEvent(event)}
                            >
                              {isActiveWindow ? (
                                // Active window changed - special styling with app icon
                                <div
                                  style={{
                                    display: "flex",
                                    flexWrap: "wrap",
                                    gap: 12,
                                    alignItems: "center",
                                    minWidth: 0,
                                  }}
                                >
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
                                  <div style={{ display: "grid", gap: 4, minWidth: 0, flex: 1 }}>
                                    <div style={{ display: "flex", flexDirection: "row", gap: 16, flexWrap: "wrap" }}>
                                      <strong style={{ textTransform: "capitalize" }}>
                                        {event.event_type.replace(/_/g, " ")}
                                      </strong>
                                      <div style={{ alignSelf: "start", display: "flex", gap: 12, alignItems: "center" }}>
                                        <span style={{ color: "#cbd5f5" }}>{wallTime}</span>
                                        <span style={{ color: "#64748b" }}>+{monoTime}</span>
                                      </div>
                                      {isSelected ? (
                                        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
                                          {ocrMode ? (
                                            <button
                                              type="button"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                runOcrForEvent(event);
                                              }}
                                              style={{
                                                padding: "4px 8px",
                                                borderRadius: 8,
                                                border: "1px solid rgba(30, 41, 59, 0.8)",
                                                background: "rgba(56, 189, 248, 0.18)",
                                                color: "#e0f2fe",
                                                cursor: "pointer",
                                                fontSize: 12,
                                              }}
                                              title="Run OCR on this event"
                                            >
                                              OCR
                                            </button>
                                          ) : null}
                                          <button
                                            type="button"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              updatePinnedEvent(event.id, !isPinned);
                                            }}
                                            style={{
                                              padding: "4px 8px",
                                              borderRadius: 8,
                                              border: "1px solid rgba(30, 41, 59, 0.8)",
                                              background: isPinned ? "rgba(251, 191, 36, 0.2)" : "transparent",
                                              color: isPinned ? "#facc15" : "#94a3b8",
                                              cursor: "pointer",
                                              fontSize: 12,
                                              display: "flex",
                                              alignItems: "center",
                                              gap: 6,
                                            }}
                                            title={isPinned ? "Unpin event" : "Pin event"}
                                          >
                                            {isPinned ? (
                                              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                                                <path d="M12 2l2.9 6.6 7.1.6-5.4 4.6 1.7 7-6.3-3.8-6.3 3.8 1.7-7L2 9.2l7.1-.6L12 2z" />
                                              </svg>
                                            ) : (
                                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                                                <path d="M12 2l2.9 6.6 7.1.6-5.4 4.6 1.7 7-6.3-3.8-6.3 3.8 1.7-7L2 9.2l7.1-.6L12 2z" />
                                              </svg>
                                            )}
                                            Pin
                                          </button>
                                        </div>
                                      ) : null}
                                    </div>
                                    {eventWindowName ? (
                                      <div style={{ color: "#cbd5f5", overflowWrap: "anywhere" }}>{eventWindowName}</div>
                                    ) : null}
                                  </div>
                                </div>
                              ) : (
                                // Other event types
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
                                    {isSelected ? (
                                      <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
                                        {ocrMode ? (
                                          <button
                                            type="button"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              runOcrForEvent(event);
                                            }}
                                            style={{
                                              padding: "4px 8px",
                                              borderRadius: 8,
                                              border: "1px solid rgba(30, 41, 59, 0.8)",
                                              background: "rgba(56, 189, 248, 0.18)",
                                              color: "#e0f2fe",
                                              cursor: "pointer",
                                              fontSize: 12,
                                            }}
                                            title="Run OCR on this event"
                                          >
                                            OCR
                                          </button>
                                        ) : null}
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            updatePinnedEvent(event.id, !isPinned);
                                          }}
                                          style={{
                                            padding: "4px 8px",
                                            borderRadius: 8,
                                            border: "1px solid rgba(30, 41, 59, 0.8)",
                                            background: isPinned ? "rgba(251, 191, 36, 0.2)" : "transparent",
                                            color: isPinned ? "#facc15" : "#94a3b8",
                                            cursor: "pointer",
                                            fontSize: 12,
                                            display: "flex",
                                            alignItems: "center",
                                            gap: 6,
                                          }}
                                          title={isPinned ? "Unpin event" : "Pin event"}
                                        >
                                          {isPinned ? (
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                                              <path d="M12 2l2.9 6.6 7.1.6-5.4 4.6 1.7 7-6.3-3.8-6.3 3.8 1.7-7L2 9.2l7.1-.6L12 2z" />
                                            </svg>
                                          ) : (
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                                              <path d="M12 2l2.9 6.6 7.1.6-5.4 4.6 1.7 7-6.3-3.8-6.3 3.8 1.7-7L2 9.2l7.1-.6L12 2z" />
                                            </svg>
                                          )}
                                          Pin
                                        </button>
                                      </div>
                                    ) : null}
                                  </div>
                                  {eventWindowName ? (
                                    <div style={{ color: "#94a3b8", overflowWrap: "anywhere" }}>{eventWindowName}</div>
                                  ) : null}
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
          </aside>
        </section>
        {settingsOpen && settingsMenuPos
          ? createPortal(
              <div
                ref={settingsPanelRef}
                style={{
                  position: "fixed",
                  left: settingsMenuPos.left,
                  top: settingsMenuPos.top,
                  width: 280,
                  maxHeight: settingsMenuPos.maxHeight,
                  overflowY: "auto",
                  background: "#0f172a",
                  border: "1px solid #1e293b",
                  borderRadius: 12,
                  padding: 12,
                  zIndex: 2000,
                  display: "grid",
                  gap: 12,
                  boxShadow: "0 8px 32px rgba(0, 0, 0, 0.4)",
                }}
              >
                {/* Expand all toggle */}
                <button
                  type="button"
                  onClick={() => setExpandAll((prev) => !prev)}
                  style={{
                    padding: "8px 12px",
                    borderRadius: 8,
                    border: "1px solid",
                    borderColor: expandAll ? "#38bdf8" : "#1e293b",
                    background: expandAll ? "rgba(56, 189, 248, 0.18)" : "transparent",
                    color: expandAll ? "#e0f2fe" : "#94a3b8",
                    fontSize: 13,
                    cursor: "pointer",
                    textAlign: "left",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  {/* Expand icon */}
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="15 3 21 3 21 9" />
                    <polyline points="9 21 3 21 3 15" />
                    <line x1="21" y1="3" x2="14" y2="10" />
                    <line x1="3" y1="21" x2="10" y2="14" />
                  </svg>
                  Expand all groups
                </button>

                {/* Frames only toggle */}
                <button
                  type="button"
                  onClick={() => setFramesOnly((prev) => !prev)}
                  style={{
                    padding: "8px 12px",
                    borderRadius: 8,
                    border: "1px solid",
                    borderColor: framesOnly ? "#22c55e" : "#1e293b",
                    background: framesOnly ? "rgba(34, 197, 94, 0.18)" : "transparent",
                    color: framesOnly ? "#bbf7d0" : "#94a3b8",
                    fontSize: 13,
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  Frames only
                </button>

                <button
                  type="button"
                  onClick={() => setPinnedEventsOnly((prev) => !prev)}
                  style={{
                    padding: "8px 12px",
                    borderRadius: 8,
                    border: "1px solid",
                    borderColor: pinnedEventsOnly ? "#f59e0b" : "#1e293b",
                    background: pinnedEventsOnly ? "rgba(251, 191, 36, 0.18)" : "transparent",
                    color: pinnedEventsOnly ? "#fde68a" : "#94a3b8",
                    fontSize: 13,
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  Pinned only
                </button>

                {pinnedEventsLoading ? (
                  <div style={{ color: "#94a3b8", fontSize: 12 }}>Loading pinned events...</div>
                ) : null}
                {pinnedEventsError ? <div style={{ color: "#fca5a5", fontSize: 12 }}>{pinnedEventsError}</div> : null}

                <label style={{ display: "grid", gap: 6, fontSize: 12, color: "#cbd5f5" }}>
                  <span>Manual offset (sec)</span>
                  <input
                    type="number"
                    step="0.5"
                    value={manualOffsetSec}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      if (Number.isNaN(next)) {
                        return;
                      }
                      setManualOffsetSec(next);
                    }}
                    style={{
                      padding: "6px 8px",
                      borderRadius: 8,
                      border: "1px solid #1e293b",
                      background: "#0b1120",
                      color: "#e2e8f0",
                    }}
                  />
                  <span style={{ color: "#64748b" }}>Applies to video seek only.</span>
                </label>

                {/* Divider */}
                <div style={{ height: 1, background: "#1e293b" }} />

                {/* Event type filters */}
                <div style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: 1 }}>
                  Event Types
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
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
                          padding: "5px 10px",
                          borderRadius: 999,
                          border: "1px solid",
                          borderColor: active ? "#38bdf8" : "#1e293b",
                          background: active ? "rgba(56, 189, 248, 0.18)" : "transparent",
                          color: active ? "#e0f2fe" : "#94a3b8",
                          fontSize: 11,
                          cursor: "pointer",
                        }}
                      >
                        {type.replace(/_/g, " ")}
                      </button>
                    );
                  })}
                </div>
              </div>,
              document.body,
            )
          : null}
      </div>
    </div>
  );
}
