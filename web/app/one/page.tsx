"use client";                                                                                                    
                                                                                                                 
import { useCallback, useEffect, useMemo, useRef, useState } from "react";                                       
                                                                                                                 
type Segment = {                                                                                                 
  id: number;                                                                                                    
  start: number;                                                                                                 
  end: number;                                                                                                   
  text: string;                                                                                                  
};                                                                                                               
                                                                                                                 
type WindowSpan = {                                                                                              
  id: number;                                                                                                    
  window_name: string;                                                                                           
  start_seconds: number;                                                                                         
  end_seconds: number;                                                                                           
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
  frames: Array<{ offset_index: number; timestamp: string | null; seconds_from_video_start: number }>;           
  transcription?: string | null;                                                                                 
};                                                                                                               
                                                                                                                 
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
  timeline_seconds: number;                                                                                      
  description: string;                                                                                           
  search_blob: string;                                                                                           
};                                                                                                               
                                                                                                                 
type DisplayEvent = {
  id: string;
  timeline_seconds: number;
  event_type: string;
  description: string;
  source: EventView;
};

type TimelineItem = {
  id: string;
  kind: "event" | "transcript";
  timeline_seconds: number;
  end_seconds?: number;
  label: string;
  event_type?: string;
  sourceEvent?: EventView;
  segment?: Segment;
};

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

function SearchIcon({ size = 18, color = "#f8fafc" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx={11} cy={11} r={7} stroke={color} strokeWidth={1.6} />
      <path d="m16.5 16.5 4 4" stroke={color} strokeWidth={1.6} strokeLinecap="round" />
    </svg>
  );
}

function SettingsIcon({ size = 18, color = "#f8fafc" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z"
        stroke={color}
        strokeWidth={1.6}
      />
      <path
        d="M19.4 13.5a1 1 0 0 0 .2 1.1l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6.9V19a2 2 0 0 1-4 0v-.1a1 1 0 0 0-.6-.9 1 1 0 0 0-1.1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1 1 0 0 0 .2-1.1 1 1 0 0 0-.9-.6H5a2 2 0 0 1 0-4h.1a1 1 0 0 0 .9-.6 1 1 0 0 0-.2-1.1l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1 1 0 0 0 1.1.2 1 1 0 0 0 .6-.9V5a2 2 0 0 1 4 0v.1a1 1 0 0 0 .6.9 1 1 0 0 0 1.1-.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1 1 0 0 0-.2 1.1 1 1 0 0 0 .9.6H19a2 2 0 0 1 0 4h-.1a1 1 0 0 0-.9.6Z"
        stroke={color}
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const DEFAULT_VIDEO = "";
const LAST_VIDEO_STORAGE_KEY = "timestone:lastVideoPath:one";
const LAST_SESSION_STORAGE_KEY = "timestone:lastSessionId:one";

const EVENT_TYPE_OPTIONS = [
  { type: "transcript", label: "Transcript" },
  { type: "typed", label: "Typed" },
  { type: "key_shortcut", label: "Shortcut" },
  { type: "key_down", label: "Key down" },
  { type: "key_up", label: "Key up" },
  { type: "text_input", label: "Text input" },
  { type: "marker", label: "Marker" },
  { type: "mouse_click", label: "Mouse click" },
  { type: "mouse_move", label: "Mouse move" },
  { type: "mouse_scroll", label: "Mouse scroll" },
  { type: "active_window_changed", label: "Active window" },
  { type: "window_rect_changed", label: "Window rect" },
  { type: "snapshot", label: "Snapshot" },
];

const DEFAULT_VISIBLE_TYPES = new Set(["transcript", "typed", "key_shortcut"]);
const API_BASE = (                                                                                               
  process.env.NEXT_PUBLIC_API_BASE && process.env.NEXT_PUBLIC_API_BASE.trim().length > 0                         
    ? process.env.NEXT_PUBLIC_API_BASE                                                                           
    : "http://localhost:8001"                                                                                    
).replace(/\/$/, "");                                                                                            
                                                                                                                 
const ABSOLUTE_PATH_REGEX = /^[a-zA-Z]:[\\/]|^\//;
                                                                                                                 
function normalisePath(input: string): string {                                                                  
  return input.replace(/\\/g, "/").replace(/^\.?\//, "");                                                        
}                                                                                                                
                                                                                                                 
function parseObsStartMs(pathValue: string): number | null {                                                     
  const trimmed = pathValue.trim();                                                                              
  if (!trimmed) {                                                                                                
    return null;                                                                                                 
  }                                                                                                              
  const baseName = trimmed.split(/[/\\]/).pop() || "";                                                           
  const match = baseName.match(/(\d{4}-\d{2}-\d{2})[ _T](\d{2})[-.](\d{2})[-.](\d{2})/);                         
  if (!match) {                                                                                                  
    return null;                                                                                                 
  }                                                                                                              
  const datePart = match[1];                                                                                     
  const timePart = `${match[2]}:${match[3]}:${match[4]}`;                                                        
  const parsed = new Date(`${datePart}T${timePart}`);                                                            
  const ms = parsed.getTime();                                                                                   
  return Number.isFinite(ms) ? ms : null;                                                                        
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
  if (!Number.isFinite(seconds)) {                                                                               
    return "--:--";                                                                                              
  }                                                                                                              
  const total = Math.max(0, seconds);                                                                            
  const hours = Math.floor(total / 3600);                                                                        
  const mins = Math.floor((total % 3600) / 60);                                                                  
  const secs = Math.floor(total % 60);                                                                           
  if (hours > 0) {
    return `${hours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs                      
      .toString()                                                                                                
      .padStart(2, "0")}`;                                                                                       
  }                                                                                                              
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;                              
}                                                                                                                
                                                                                                                 
function stripTranscriptTimestamp(text: string): string {                                                        
  return text.replace(/\[\s*\d+(\.\d+)?s?\s*->\s*\d+(\.\d+)?s?\s*\]\s*/gi, "").trim();                           
}                                                                                                                
                                                                                                                 
function buildTranscriptSegments(text: string | null | undefined, duration: number | null): Segment[] {          
  if (!text) {                                                                                                   
    return [];                                                                                                   
  }                                                                                                              
  const cleaned = text                                                                                           
    .split(/\r?\n/)                                                                                              
    .map((line) => line.trim())                                                                                  
    .filter(Boolean)                                                                                             
    .join(" ");                                                                                                  
  if (!cleaned) {                                                                                                
    return [];                                                                                                   
  }                                                                                                              
  const pieces = cleaned                                                                                         
    .split(/(?<=[.!?])\s+/)                                                                                      
    .map((part) => part.trim())                                                                                  
    .filter(Boolean);                                                                                            
  if (pieces.length === 0) {                                                                                     
    return [];                                                                                                   
  }                                                                                                              
  const totalDuration = duration && duration > 0 ? duration : pieces.length;                                     
  const weights = pieces.map((part) => Math.max(part.length, 1));                                                
  const totalWeight = weights.reduce((sum, value) => sum + value, 0) || 1;                                       
  let cursor = 0;                                                                                                
  return pieces.map((part, index) => {                                                                           
    const segmentDuration = (weights[index] / totalWeight) * totalDuration;                                      
    const start = cursor;                                                                                        
    const end = index === pieces.length - 1 ? totalDuration : cursor + segmentDuration;                          
    cursor = end;                                                                                                
    return {                                                                                                     
      id: index + 1,                                                                                             
      start,                                                                                                     
      end,                                                                                                       
      text: part,                                                                                                
    };                                                                                                           
  });                                                                                                            
}
                                                                                                                 
function safeJsonParse(value: string | null): any {                                                              
  if (!value) {                                                                                                  
    return null;                                                                                                 
  }                                                                                                              
  try {                                                                                                          
    return JSON.parse(value);                                                                                    
  } catch {                                                                                                      
    return null;                                                                                                 
  }                                                                                                              
}                                                                                                                
                                                                                                                 
function clipText(text: string, max = 90): string {                                                              
  if (text.length <= max) {                                                                                      
    return text;                                                                                                 
  }                                                                                                              
  const limit = Math.max(0, max - 3);                                                                            
  return `${text.slice(0, limit)}...`;                                                                           
}                                                                                                                
                                                                                                                 
function formatShortcut(payload: any): string | null {                                                           
  if (!payload || typeof payload !== "object") {                                                                 
    return null;                                                                                                 
  }                                                                                                              
  const modifiers = Array.isArray(payload.modifiers) ? payload.modifiers : [];                                   
  const key = payload.key || payload.vk;                                                                         
  const parts = [...modifiers, key].filter(Boolean);                                                             
  if (!parts.length) {                                                                                           
    return null;                                                                                                 
  }                                                                                                              
  return parts.join("+");                                                                                        
}                                                                                                                
                                                                                                                 
function describeEvent(event: TimestoneEvent): string {                                                          
  const payload = safeJsonParse(event.payload);                                                                  
  const mouse = safeJsonParse(event.mouse);                                                                      
  const windowLabel = event.window_title || event.window_class || "";                                            
  switch (event.event_type) {                                                                                    
    case "marker": {                                                                                             
      const note = payload?.note ? String(payload.note) : "Marker";                                              
      return windowLabel ? `${note} @ ${windowLabel}` : note;                                                    
    }                                                                                                            
    case "text_input": {                                                                                         
      const text = payload?.text ? clipText(String(payload.text)) : "Text input";                                
      return windowLabel ? `${text} @ ${windowLabel}` : text;                                                    
    }                                                                                                            
    case "key_shortcut": {                                                                                       
      const shortcut = formatShortcut(payload) || "Shortcut";                                                    
      return windowLabel ? `${shortcut} @ ${windowLabel}` : shortcut;                                            
    }                                                                                                            
    case "key_down": {                                                                                           
      const key = payload?.key || payload?.vk || "Key down";                                                     
      return windowLabel ? `${key} @ ${windowLabel}` : String(key);                                              
    }                                                                                                            
    case "mouse_click": {                                                                                        
      if (mouse?.x != null && mouse?.y != null) {                                                                
        const coords = `Click @ ${mouse.x},${mouse.y}`;                                                          
        return windowLabel ? `${coords} (${windowLabel})` : coords;                                              
      }                                                                                                          
      return windowLabel ? `Click @ ${windowLabel}` : "Mouse click";                                             
    }                                                                                                            
    case "active_window_changed":                                                                                
      return windowLabel ? `Window: ${windowLabel}` : "Active window changed";                                   
    case "window_rect_changed":                                                                                  
      return windowLabel ? `Window resized: ${windowLabel}` : "Window rect changed";                             
    default:                                                                                                     
      return windowLabel ? `${event.event_type} @ ${windowLabel}` : event.event_type;                            
  }                                                                                                              
}                                                                                                                
                                                                                                                 
function keyEventToChar(event: EventView): string | null {                                                       
  if (event.event_type !== "key_down") {                                                                         
    return null;                                                                                                 
  }                                                                                                              
  const payload = safeJsonParse(event.payload);                                                                  
  const raw = payload?.key ?? payload?.vk;                                                                       
  if (raw == null) {                                                                                             
    return null;                                                                                                 
  }                                                                                                              
  const value = String(raw);                                                                                     
  if (value.length === 1) {                                                                                      
    return value;                                                                                                
  }                                                                                                              
  const upper = value.toUpperCase();                                                                             
  if (upper === "SPACE" || upper === "VK_SPACE") {                                                               
    return " ";                                                                                                  
  }                                                                                                              
  if (upper === "TAB" || upper === "VK_TAB") {                                                                   
    return "\t";                                                                                                 
  }                                                                                                              
  if (upper === "ENTER" || upper === "VK_RETURN") {                                                              
    return "\n";                                                                                                 
  }                                                                                                              
  return null;                                                                                                   
}                                                                                                                
                                                                                                                 
function buildDisplayEvents(events: EventView[]): DisplayEvent[] {
  if (!events.length) {
    return [];
  }
  const sorted = [...events].sort((a, b) => a.timeline_seconds - b.timeline_seconds);                            
  const output: DisplayEvent[] = [];                                                                             
  let buffer = "";                                                                                               
  let bufferStart: EventView | null = null;                                                                      
  let lastTime = 0;                                                                                              
  let lastWindow = "";                                                                                           
                                                                                                                 
  const flushBuffer = () => {                                                                                    
    if (!bufferStart || !buffer) {                                                                               
      buffer = "";                                                                                               
      bufferStart = null;                                                                                        
      return;                                                                                                    
    }                                                                                                            
    const displayText = buffer.replace(/\n/g, "\\n").replace(/\t/g, "  ");                                       
    output.push({                                                                                                
      id: `typed-${bufferStart.id}`,                                                                             
      timeline_seconds: bufferStart.timeline_seconds,                                                            
      event_type: "typed",                                                                                       
      description: `Typed: ${displayText}`,                                                                      
      source: bufferStart,                                                                                       
    });                                                                                                          
    buffer = "";                                                                                                 
    bufferStart = null;                                                                                          
  };                                                                                                             
                                                                                                                 
  for (const event of sorted) {                                                                                  
    const char = keyEventToChar(event);                                                                          
    const windowKey = event.window_title || event.window_class || event.process_name || "";                      
    if (char) {                                                                                                  
      const withinWindow = bufferStart ? windowKey === lastWindow : true;                                        
      const withinGap = bufferStart ? event.timeline_seconds - lastTime <= 0.7 : true;                           
      if (!withinWindow || !withinGap) {                                                                         
        flushBuffer();                                                                                           
      }                                                                                                          
      if (!bufferStart) {                                                                                        
        bufferStart = event;                                                                                     
        lastWindow = windowKey;                                                                                  
      }                                                                                                          
      buffer += char;                                                                                            
      lastTime = event.timeline_seconds;
      continue;                                                                                                  
    }                                                                                                            
    flushBuffer();                                                                                               
    output.push({                                                                                                
      id: String(event.id),                                                                                      
      timeline_seconds: event.timeline_seconds,                                                                  
      event_type: event.event_type,                                                                              
      description: event.description,                                                                            
      source: event,                                                                                             
    });                                                                                                          
  }                                                                                                              
  flushBuffer();
  return output;
}

function buildTimelineItems(displayEvents: DisplayEvent[], segments: Segment[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const event of displayEvents) {
    items.push({
      id: `event-${event.id}`,
      kind: "event",
      timeline_seconds: event.timeline_seconds,
      label: event.description,
      event_type: event.event_type,
      sourceEvent: event.source,
    });
  }
  for (const segment of segments) {
    items.push({
      id: `seg-${segment.id}-${segment.start.toFixed(2)}`,
      kind: "transcript",
      timeline_seconds: segment.start,
      end_seconds: segment.end,
      label: stripTranscriptTimestamp(segment.text),
      event_type: "transcript",
      segment,
    });
  }
  return items.sort((a, b) => a.timeline_seconds - b.timeline_seconds);
}

function buildWindowSpans(events: EventView[], timelineEnd: number | null): WindowSpan[] {
  if (!events.length) {
    return [];
  }
  const windowEvents = events                                                                                    
    .filter((event) => event.event_type === "active_window_changed")                                             
    .map((event) => ({                                                                                           
      event,                                                                                                     
      name: event.window_title || event.window_class || event.process_name || "Unknown window",                  
    }))                                                                                                          
    .sort((a, b) => a.event.timeline_seconds - b.event.timeline_seconds);                                        
  const sortedEvents = [...events].sort((a, b) => a.timeline_seconds - b.timeline_seconds);                      
  const fallbackEnd = timelineEnd ?? (sortedEvents.length ? sortedEvents[sortedEvents.length - 1].timeline_seconds : 0) + 1;                                                                                                      
  if (windowEvents.length === 0) {                                                                               
    const first = sortedEvents[0];                                                                               
    const name = first.window_title || first.window_class || first.process_name || "Unknown window";             
    return [                                                                                                     
      {                                                                                                          
        id: 0,                                                                                                   
        window_name: name,                                                                                       
        start_seconds: 0,                                                                                        
        end_seconds: Math.max(0.05, fallbackEnd),                                                                
      },                                                                                                         
    ];                                                                                                           
  }                                                                                                              
  const endFallback = timelineEnd ?? windowEvents[windowEvents.length - 1].event.timeline_seconds + 1;           
  return windowEvents.map((entry, index) => {                                                                    
    const startSeconds = entry.event.timeline_seconds;                                                           
    const next = windowEvents[index + 1];                                                                        
    let endSeconds = next ? next.event.timeline_seconds : endFallback;                                           
    if (endSeconds < startSeconds) {                                                                             
      endSeconds = startSeconds;                                                                                 
    }                                                                                                            
    return {                                                                                                     
      id: index,                                                                                                 
      window_name: entry.name,                                                                                   
      start_seconds: startSeconds,                                                                               
      end_seconds: endSeconds,                                                                                   
    };                                                                                                           
  });                                                                                                            
}                                                                                                                
                                                                                                                 
export default function OnePage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hideControlsTimeoutRef = useRef<number | null>(null);
  const activeItemRef = useRef<HTMLButtonElement | null>(null);
                                                                                                                 
  const [videoInput, setVideoInput] = useState(DEFAULT_VIDEO);                                                   
  const [videoPath, setVideoPath] = useState(DEFAULT_VIDEO);                                                     
  const [metadata, setMetadata] = useState<Metadata | null>(null);                                               
  const [loadingMetadata, setLoadingMetadata] = useState(false);                                                 
  const [metadataError, setMetadataError] = useState<string | null>(null);                                       
  const [segments, setSegments] = useState<Segment[]>([]);                                                       
  const [loadingTranscript, setLoadingTranscript] = useState(false);                                             
  const [transcriptError, setTranscriptError] = useState<string | null>(null);                                   
  const [sessions, setSessions] = useState<TimestoneSession[]>([]);                                              
  const [loadingSessions, setLoadingSessions] = useState(false);                                                 
  const [sessionError, setSessionError] = useState<string | null>(null);                                         
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");                                        
  const [events, setEvents] = useState<TimestoneEvent[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [eventError, setEventError] = useState<string | null>(null);
  const [detailsMaxWidth, setDetailsMaxWidth] = useState(420);
  const [alignmentOffsetSeconds, setAlignmentOffsetSeconds] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [eventVisibility, setEventVisibility] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const option of EVENT_TYPE_OPTIONS) {
      initial[option.type] = DEFAULT_VISIBLE_TYPES.has(option.type);
    }
    return initial;
  });
  const [searchScopes, setSearchScopes] = useState<Record<string, boolean>>({
    transcript: true,
    typed: true,
    shortcut: true,
    key: true,
    window: true,
    mouse: false,
    marker: false,
  });
  const [showConfigPanel, setShowConfigPanel] = useState(true);
  const [videoWarning, setVideoWarning] = useState<string | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);                                             
  const [controlsVisible, setControlsVisible] = useState(true);                                                  
  const [isPlaying, setIsPlaying] = useState(false);                                                             
  const [captionsEnabled, setCaptionsEnabled] = useState(true);                                                  
  const [currentTime, setCurrentTime] = useState(0);                                                             
  const [videoDuration, setVideoDuration] = useState<number | null>(null);                                       
                                                                                                                 
  const { url: videoUrl, warning: fileWarning } = useMemo(() => buildFileUrl(videoPath), [videoPath]);
  const serverHint = API_BASE || "http://localhost:8001";

  useEffect(() => {
    const saved = localStorage.getItem(LAST_VIDEO_STORAGE_KEY);
    if (saved) {
      setVideoInput(saved);
      setVideoPath(saved);
      setShowConfigPanel(false);
    }
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem(LAST_SESSION_STORAGE_KEY);
    if (saved) {
      setSelectedSessionId(saved);
    }
  }, []);

  useEffect(() => {
    if (!videoPath.trim()) {
      localStorage.removeItem(LAST_VIDEO_STORAGE_KEY);
      return;
    }
    localStorage.setItem(LAST_VIDEO_STORAGE_KEY, videoPath);
  }, [videoPath]);

  useEffect(() => {
    if (!selectedSessionId.trim()) {
      localStorage.removeItem(LAST_SESSION_STORAGE_KEY);
      return;
    }
    localStorage.setItem(LAST_SESSION_STORAGE_KEY, selectedSessionId);
  }, [selectedSessionId]);

  useEffect(() => {
    setVideoWarning(fileWarning);
  }, [fileWarning]);
                                                                                                                 
  const selectedSession = useMemo(                                                                               
    () => sessions.find((session) => session.session_id === selectedSessionId) ?? null,                          
    [sessions, selectedSessionId],
  );                                                                                                             
                                                                                                                 
  useEffect(() => {                                                                                              
    if (!selectedSession?.obs_video_path) {                                                                      
      return;                                                                                                    
    }                                                                                                            
    if (!videoInput.trim()) {                                                                                    
      setVideoInput(selectedSession.obs_video_path);                                                             
      setVideoPath(selectedSession.obs_video_path);                                                              
    }                                                                                                            
  }, [selectedSession, videoInput]);                                                                             
                                                                                                                 
  useEffect(() => {                                                                                              
    const fetchMetadata = async () => {                                                                          
      if (!videoPath.trim()) {                                                                                   
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
          body: JSON.stringify({ videoPath }),                                                                   
        });                                                                                                      
        if (!res.ok) {                                                                                           
          const payload = await res.json().catch(() => ({}));                                                    
          throw new Error(payload.error || `Metadata request failed (status ${res.status})`);                    
        }                                                                                                        
        const data: Metadata = await res.json();                                                                 
        setMetadata(data);                                                                                       
      } catch (err) {                                                                                            
        setMetadata(null);                                                                                       
        const message = err instanceof Error ? err.message : "Failed to load metadata";                          
        setMetadataError(message);                                                                               
      } finally {                                                                                                
        setLoadingMetadata(false);                                                                               
      }                                                                                                          
    };                                                                                                           
    fetchMetadata();                                                                                             
  }, [videoPath]);                                                                                               
                                                                                                                 
  useEffect(() => {                                                                                              
    if (!metadata?.transcription) {                                                                              
      setSegments([]);                                                                                           
      setTranscriptError(null);                                                                                  
      setLoadingTranscript(false);                                                                               
      return;                                                                                                    
    }                                                                                                            
    setLoadingTranscript(true);                                                                                  
    setTranscriptError(null);                                                                                    
    try {                                                                                                        
      const duration = metadata.video.duration ?? null;                                                          
      const derived = buildTranscriptSegments(metadata.transcription, duration ?? null);                         
      setSegments(derived);                                                                                      
    } catch (err) {                                                                                              
      setSegments([]);                                                                                           
      setTranscriptError(err instanceof Error ? err.message : "Failed to parse transcript");                     
    } finally {                                                                                                  
      setLoadingTranscript(false);                                                                               
    }                                                                                                            
  }, [metadata]);                                                                                                
                                                                                                                 
  useEffect(() => {                                                                                              
    const fetchSessions = async () => {                                                                          
      setLoadingSessions(true);                                                                                  
      setSessionError(null);                                                                                     
      try {                                                                                                      
        const res = await fetch("/api/timestone_sessions", { method: "POST" });                                  
        if (!res.ok) {                                                                                           
          const payload = await res.json().catch(() => ({}));                                                    
          throw new Error(payload.error || "Failed to load sessions");                                           
        }                                                                                                        
        const data = await res.json();                                                                           
        setSessions(Array.isArray(data?.sessions) ? (data.sessions as TimestoneSession[]) : []);                 
      } catch (err) {                                                                                            
        setSessions([]);                                                                                         
        setSessionError(err instanceof Error ? err.message : "Failed to load sessions");                         
      } finally {                                                                                                
        setLoadingSessions(false);                                                                               
      }                                                                                                          
    };                                                                                                           
    fetchSessions();                                                                                             
  }, []);                                                                                                        
                                                                                                                 
  useEffect(() => {                                                                                              
    const fetchEvents = async () => {                                                                            
      if (!selectedSessionId) {                                                                                  
        setEvents([]);                                                                                           
        setEventError(null);                                                                                     
        return;                                                                                                  
      }                                                                                                          
      setLoadingEvents(true);                                                                                    
      setEventError(null);                                                                                       
      try {                                                                                                      
        const res = await fetch("/api/timestone_events", {                                                       
          method: "POST",                                                                                        
          headers: { "Content-Type": "application/json" },                                                       
          body: JSON.stringify({ sessionId: selectedSessionId }),                                                
        });                                                                                                      
        if (!res.ok) {                                                                                           
          const body = await res.json().catch(() => ({}));                                                       
          throw new Error(body.error || `Failed to load events (status ${res.status})`);                         
        }                                                                                                        
        const data = await res.json();                                                                           
        setEvents(Array.isArray(data?.events) ? (data.events as TimestoneEvent[]) : []);                         
      } catch (err) {                                                                                            
        setEvents([]);                                                                                           
        setEventError(err instanceof Error ? err.message : "Failed to load events");                             
      } finally {                                                                                                
        setLoadingEvents(false);                                                                                 
      }                                                                                                          
    };                                                                                                           
    fetchEvents();                                                                                               
  }, [selectedSessionId]);                                                                                       
                                                                                                                 
  const timelineDuration = useMemo(() => {                                                                       
    if (metadata?.video.duration && metadata.video.duration > 0) {                                               
      return metadata.video.duration;                                                                            
    }                                                                                                            
    if (events.length > 0) {                                                                                     
      const last = events[events.length - 1];                                                                    
      return Math.max(0, (last.ts_wall_ms - events[0].ts_wall_ms) / 1000);                                       
    }                                                                                                            
    return null;                                                                                                 
  }, [metadata, events]);                                                                                        
                                                                                                                 
  const videoStartWallMs = useMemo(() => {                                                                       
    const parsed = parseObsStartMs(videoPath);                                                                   
    if (parsed != null) {                                                                                        
      return parsed;                                                                                             
    }                                                                                                            
    if (metadata?.video.creation_time) {                                                                         
      const parsedMeta = Date.parse(metadata.video.creation_time);                                               
      if (Number.isFinite(parsedMeta)) {                                                                         
        return parsedMeta;                                                                                       
      }                                                                                                          
    }                                                                                                            
    return null;                                                                                                 
  }, [videoPath, metadata]);                                                                                     

  const timelineOriginMs = useMemo(() => {                                                                       
    if (videoStartWallMs != null) {                                                                              
      return videoStartWallMs;                                                                                   
    }                                                                                                            
    if (events.length > 0) {                                                                                     
      return events[0].ts_wall_ms;                                                                               
    }                                                                                                            
    if (selectedSession?.start_wall_ms) {                                                                        
      return selectedSession.start_wall_ms;                                                                      
    }                                                                                                            
    return null;                                                                                                 
  }, [videoStartWallMs, events, selectedSession]);                                                               
                                                                                                                 
  const monoBaseMs = useMemo(() => {                                                                             
    const first = events.find((event) => Number.isFinite(event.ts_wall_ms) && Number.isFinite(event.ts_mono_ms));
    if (!first) {                                                                                                
      return null;                                                                                               
    }                                                                                                            
    return first.ts_wall_ms - first.ts_mono_ms;                                                                  
  }, [events]);                                                                                                  
                                                                                                                 
  const eventsWithTimeline = useMemo<EventView[]>(() => {
    if (!events.length) {
      return [];
    }
    const origin = timelineOriginMs;
    return events.map((event) => {
      const monoWall =
        monoBaseMs != null && Number.isFinite(event.ts_mono_ms) ? monoBaseMs + event.ts_mono_ms : event.ts_wall_ms;
      const timelineSeconds =
        origin != null ? (monoWall - origin) / 1000 + alignmentOffsetSeconds : alignmentOffsetSeconds;
      const description = describeEvent(event);
      const searchBlob = [
        description,
        event.event_type,
        event.process_name || "",                                                                                
        event.window_title || "",                                                                                
        event.window_class || "",                                                                                
      ]                                                                                                          
        .join(" ")                                                                                               
        .toLowerCase();                                                                                          
      return {
        ...event,
        timeline_seconds: timelineSeconds,
        description,
        search_blob: searchBlob,
      };
    });
  }, [events, timelineOriginMs, monoBaseMs, alignmentOffsetSeconds]);
                                                                                                                 
  const windowSpans = useMemo(() => buildWindowSpans(eventsWithTimeline, timelineDuration), [eventsWithTimeline, 
timelineDuration]);                                                                                              
                                                                                                                 
  const timelineSegments = useMemo(() => segments, [segments]);                                                  
                                                                                                                 
  const windowTranscriptMap = useMemo(() => {                                                                    
    const map = new Map<number, Segment[]>();                                                                    
    for (const span of windowSpans) {                                                                            
      const segs = timelineSegments                                                                              
        .filter((seg) => seg.end > span.start_seconds && seg.start < span.end_seconds)                           
        .map((seg) => {                                                                                          
          const clippedStart = Math.max(seg.start, span.start_seconds);                                          
          const clippedEnd = Math.min(seg.end, span.end_seconds);                                                
          const trimmedStart = clippedStart > seg.start + 0.01;                                                  
          const trimmedEnd = clippedEnd < seg.end - 0.01;                                                        
          const prefix = trimmedStart ? "..." : "";                                                              
          const suffix = trimmedEnd ? "..." : "";                                                                
          const baseText = stripTranscriptTimestamp(seg.text);                                                   
          return {                                                                                               
            ...seg,                                                                                              
            start: clippedStart,                                                                                 
            end: clippedEnd,                                                                                     
            text: `${prefix}${baseText}${suffix}`,                                                               
          };                                                                                                     
        });                                                                                                      
      map.set(span.id, segs);                                                                                    
    }                                                                                                            
    return map;                                                                                                  
  }, [windowSpans, timelineSegments]);                                                                           
                                                                                                                 
  const windowEventsMap = useMemo(() => {
    const map = new Map<number, EventView[]>();
    if (!windowSpans.length) {
      return map;
    }                                                                                                            
    const sorted = [...windowSpans].sort((a, b) => a.start_seconds - b.start_seconds);                           
    for (const span of sorted) {                                                                                 
      map.set(span.id, []);                                                                                      
    }                                                                                                            
    let spanIndex = 0;                                                                                           
    for (const event of eventsWithTimeline) {                                                                    
      const timelineSeconds = event.timeline_seconds;                                                            
      while (spanIndex < sorted.length && timelineSeconds >= sorted[spanIndex].end_seconds) {                    
        spanIndex += 1;                                                                                          
      }                                                                                                          
      if (spanIndex >= sorted.length) {                                                                          
        break;                                                                                                   
      }                                                                                                          
      const span = sorted[spanIndex];                                                                            
      if (timelineSeconds >= span.start_seconds && timelineSeconds < span.end_seconds) {                         
        map.get(span.id)?.push(event);                                                                           
      }                                                                                                          
    }                                                                                                            
    return map;
  }, [windowSpans, eventsWithTimeline]);

  const activeSegment = useMemo(() => {                                                                          
    if (!segments.length) {                                                                                      
      return null;                                                                                               
    }                                                                                                            
    return segments.find((segment) => currentTime >= segment.start && currentTime <= segment.end) ?? null;       
  }, [segments, currentTime]);                                                                                   
  const activeSegmentText = activeSegment ? stripTranscriptTimestamp(activeSegment.text) : "";                   
                                                                                                                 
  const handleUseSessionVideo = useCallback(() => {                                                              
    if (!selectedSession?.obs_video_path) {                                                                      
      return;                                                                                                    
    }                                                                                                            
    setVideoInput(selectedSession.obs_video_path);                                                               
    setVideoPath(selectedSession.obs_video_path);                                                                
  }, [selectedSession]);                                                                                         
                                                                                                                 
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
                                                                                                                 
  const handleTimeUpdate = useCallback(() => {                                                                   
    const video = videoRef.current;                                                                              
    if (!video) {                                                                                                
      return;                                                                                                    
    }                                                                                                            
    setCurrentTime(video.currentTime);                                                                           
  }, []);                                                                                                        
                                                                                                                 
  const handleLoadedMetadata = useCallback(() => {                                                               
    const video = videoRef.current;                                                                              
    if (!video) {                                                                                                
      return;                                                                                                    
    }                                                                                                            
    if (Number.isFinite(video.duration)) {                                                                       
      setVideoDuration(video.duration);                                                                          
    }                                                                                                            
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
                                                                                                                 
  useEffect(() => {
    return () => {
      if (hideControlsTimeoutRef.current) {
        window.clearTimeout(hideControlsTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isPlaying) {
      return;
    }
    if (activeItemRef.current) {
      activeItemRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [currentTime, isPlaying]);
                                                                                                                 
  const videoMaxWidth = metadata?.video.width ? `min(100%, ${metadata.video.width}px)` : "100%";
  const videoMaxHeight = metadata?.video.height ? `min(100%, ${metadata.video.height}px)` : "100%";
  const sliderMax = videoDuration ?? 0;
  const subtitleIconColor = captionsEnabled ? "#0f172a" : "#f8fafc";
  const normalizedQuery = searchQuery.trim().toLowerCase();

  const isScopeEnabled = (type: string | undefined) => {
    if (!type) {
      return false;
    }
    if (type === "transcript") {
      return searchScopes.transcript;
    }
    if (type === "typed") {
      return searchScopes.typed;
    }
    if (type === "key_shortcut") {
      return searchScopes.shortcut;
    }
    if (type === "key_down" || type === "key_up") {
      return searchScopes.key;
    }
    if (type.startsWith("mouse_")) {
      return searchScopes.mouse;
    }
    if (type === "marker") {
      return searchScopes.marker;
    }
    if (type.includes("window")) {
      return searchScopes.window;
    }
    return true;
  };
                                                                                                                 
  return (                                                                                                       
    <main
      style={{
        height: "100vh",
        overflow: "hidden",
        background: "linear-gradient(180deg, #070b16 0%, #0a1224 40%, #0b1120 100%)",
        color: "#e2e8f0",
        padding: "32px 24px 24px",
        fontFamily: '"Space Grotesk", "Segoe UI", system-ui',
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "100%",
          margin: "0 auto",
          display: "grid",
          gap: 24,
          height: "100%",
          gridTemplateRows: "auto auto 1fr",
          minHeight: 0,
        }}
      >
        <header style={{ display: "grid", gap: 8 }}>                                                             
          <h1 style={{ fontSize: 32, margin: 0 }}>Single Timeline Playback</h1>                                  
          <p style={{ margin: 0, color: "#94a3b8" }}>                                                            
            One video, timeline-accurate events, and window sections with grouped keystrokes.                    
          </p>                                                                                                   
        </header>                                                                                                
                                                                                                                 
        <section
          style={{
            background: "rgba(15, 23, 42, 0.7)",
            borderRadius: 14,
            padding: 20,
            display: "grid",
            gap: 16,
          }}
        >
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "grid", gap: 4 }}>
              <strong>Session and video</strong>
              {selectedSession && (
                <span style={{ color: "#94a3b8", fontSize: 12 }}>
                  Session started {selectedSession.start_wall_iso}
                  {selectedSession.obs_video_path ? ` | OBS: ${selectedSession.obs_video_path}` : ""}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => setShowConfigPanel((prev) => !prev)}
              style={{
                padding: "6px 10px",
                borderRadius: 8,
                border: "1px solid #1e293b",
                background: "rgba(15, 23, 42, 0.6)",
                color: "#e2e8f0",
                cursor: "pointer",
              }}
            >
              {showConfigPanel ? "Hide settings" : "Show settings"}
            </button>
          </div>
          {showConfigPanel && (
            <>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
                <label style={{ display: "grid", gap: 6, minWidth: 240, flex: "1 1 240px" }}>
                  <span style={{ color: "#cbd5f5" }}>Timestone session</span>
                  <select
                    value={selectedSessionId}
                    onChange={(e) => setSelectedSessionId(e.target.value)}
                    style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #1e293b", background: "#0b1120", color: "#e2e8f0" }}
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
                  onClick={() => {
                    setLoadingSessions(true);
                    setSessionError(null);
                    fetch("/api/timestone_sessions", { method: "POST" })
                      .then((res) => res.json())
                      .then((data) => setSessions(Array.isArray(data?.sessions) ? data.sessions : []))
                      .catch((err) => setSessionError(err instanceof Error ? err.message : "Failed to load sessions"))
                      .finally(() => setLoadingSessions(false));
                  }}
                  style={{ padding: "8px 12px" }}
                >
                  Refresh sessions
                </button>
                <button
                  type="button"
                  onClick={handleUseSessionVideo}
                  disabled={!selectedSession?.obs_video_path}
                  style={{
                    padding: "8px 12px",
                    borderRadius: 8,
                    border: "1px solid",
                    borderColor: selectedSession?.obs_video_path ? "#38bdf8" : "#1e293b",
                    background: selectedSession?.obs_video_path ? "rgba(56, 189, 248, 0.18)" : "rgba(15, 23, 42, 0.6)",
                    color: selectedSession?.obs_video_path ? "#e0f2fe" : "#64748b",
                    cursor: selectedSession?.obs_video_path ? "pointer" : "not-allowed",
                  }}
                >
                  Use session video path
                </button>
                {loadingSessions && <span style={{ color: "#94a3b8" }}>Loading sessions...</span>}
                {sessionError && <span style={{ color: "#fca5a5" }}>{sessionError}</span>}
              </div>

              <div style={{ display: "grid", gap: 12 }}>
                <label style={{ display: "grid", gap: 6 }}>
                  <span style={{ color: "#cbd5f5" }}>Video path (absolute or project-relative)</span>
                  <input
                    value={videoInput}
                    onChange={(e) => setVideoInput(e.target.value)}
                    placeholder="C:\path\to\video.mkv"
                    style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #1e293b", background: "#0b1120", color: "#e2e8f0" }}
                  />
                </label>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                  <button
                    type="button"
                    onClick={() => setVideoPath(videoInput.trim())}
                    style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #1e293b", background: "#0f172a", color: "#e2e8f0" }}
                  >
                    Load video
                  </button>
                  {videoWarning && <span style={{ color: "#fca5a5" }}>{videoWarning}</span>}
                </div>
              </div>
            </>
          )}
        </section>

        <section
          style={{
            display: "grid",
            gap: 24,
            gridTemplateColumns: `minmax(0, 1fr) minmax(280px, ${detailsMaxWidth}px)`,
            alignItems: "start",
            minHeight: 0,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 16, minHeight: 0 }}>
            <div
              style={{
                width: "100%",
                maxWidth: videoMaxWidth,
                margin: "0 auto",
                position: "relative",
                background: "#111",
                minHeight: 240,
                height: "100%",
                maxHeight: videoMaxHeight,
                borderRadius: 12,
                overflow: "hidden",
                flex: "1 1 auto",
              }}
              onMouseMove={handlePlayerPointerMove}
              onMouseLeave={handlePlayerPointerLeave}
              onTouchStart={handlePlayerPointerMove}
              onFocusCapture={handlePlayerPointerMove}
            >
              {videoUrl ? (
                <>
                  <video
                    ref={videoRef}
                    src={videoUrl}
                    style={{ width: "100%", height: "100%", objectFit: "contain", background: "#0f172a" }}
                    preload="metadata"
                    onClick={handleTogglePlayback}
                    onError={() =>
                      setVideoError(
                        `Video failed to load. Ensure the FastAPI server at ${serverHint} is running and the file path is correct.`,
                      )
                    }
                    onLoadedData={() => setVideoError(null)}
                    onLoadedMetadata={handleLoadedMetadata}
                    onTimeUpdate={handleTimeUpdate}
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                    playsInline
                  />
                  {captionsEnabled && activeSegmentText && (
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
                      {activeSegmentText}
                    </div>
                  )}
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      right: 0,
                      bottom: 0,
                      padding: "16px 20px",
                      background: "linear-gradient(180deg, rgba(15,23,42,0) 0%, rgba(15,23,42,0.85) 100%)",
                      display: controlsVisible ? "grid" : "none",
                      gap: 12,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <button
                        type="button"
                        onClick={handleTogglePlayback}
                        aria-label={isPlaying ? "Pause" : "Play"}
                        title={isPlaying ? "Pause" : "Play"}
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
                        onClick={() => setCaptionsEnabled((prev) => !prev)}
                        aria-label={captionsEnabled ? "Disable subtitles" : "Enable subtitles"}
                        title={captionsEnabled ? "Disable subtitles" : "Enable subtitles"}
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
                        <SubtitleIcon color={subtitleIconColor} />
                      </button>
                      <button
                        type="button"
                        onClick={handleRestart}
                        aria-label="Restart"
                        title="Restart"
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
                        {formatTime(currentTime)} / {formatTime(videoDuration ?? 0)}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={sliderMax}
                      step={0.05}
                      value={currentTime}
                      onChange={handleSliderChange}
                      style={{ width: "100%", accentColor: "#38bdf8" }}
                      disabled={sliderMax <= 0.05}
                    />
                  </div>
                </>
              ) : (
                <div style={{ padding: 40, color: "#eee" }}>Enter a video path to start playback.</div>
              )}
            </div>
            {videoError && <div style={{ color: "#fca5a5" }}>{videoError}</div>}

            <section
              style={{
                background: "#0f172a",
                color: "#f8fafc",
                padding: 16,
                borderRadius: 8,
                display: "grid",
                gap: 12,
              }}
            >
              <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
                <strong>Video summary:</strong>
                {loadingMetadata && <span style={{ color: "#94a3b8" }}>Loading metadata...</span>}
                {metadataError && <span style={{ color: "#fca5a5" }}>{metadataError}</span>}
                {metadata && (
                  <>
                    <span>fps = {metadata.video.fps ?? "--"}</span>
                    <span>duration = {metadata.video.duration ? `${metadata.video.duration.toFixed(2)}s` : "--"}</span>
                    <span>
                      size = {metadata.video.width && metadata.video.height ? `${metadata.video.width}x${metadata.video.height}` : "--"}
                    </span>
                  </>
                )}
              </div>
              <div>
                <strong>Transcript:</strong>
                <div style={{ marginTop: 8, minHeight: 24 }}>
                  {loadingTranscript
                    ? "Loading transcript..."
                    : segments.length > 0
                      ? `${segments.length} segments loaded`
                      : "No transcript loaded"}
                </div>
              </div>
              {transcriptError && <div style={{ color: "#fca5a5" }}>{transcriptError}</div>}
            </section>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 16,
              alignContent: "start",
              height: "100%",
              minHeight: 0,
              overflow: "hidden",
            }}
          >
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
              <h2 style={{ margin: 0 }}>Window sections</h2>
              <span style={{ color: "#94a3b8" }}>{windowSpans.length} windows</span>
              <span style={{ color: "#94a3b8" }}>{eventsWithTimeline.length} events</span>
              {loadingEvents && <span style={{ color: "#94a3b8" }}>Loading events...</span>}
              {eventError && <span style={{ color: "#fca5a5" }}>{eventError}</span>}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search events or transcripts"
                style={{
                  flex: "1 1 220px",
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "1px solid #1e293b",
                  background: "#0b1120",
                  color: "#e2e8f0",
                }}
              />
              <button
                type="button"
                onClick={() => setSearchModalOpen(true)}
                title="Search filters"
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  border: "1px solid #1e293b",
                  background: "#0f172a",
                  color: "#e2e8f0",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                }}
              >
                <SearchIcon size={16} />
              </button>
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                title="Event settings"
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  border: "1px solid #1e293b",
                  background: "#0f172a",
                  color: "#e2e8f0",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                }}
              >
                <SettingsIcon size={16} />
              </button>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", color: "#94a3b8" }}>
              <span>Event offset</span>
              <button type="button" onClick={() => setAlignmentOffsetSeconds((prev) => prev - 3)} style={{ padding: "6px 10px" }}>
                -3s
              </button>
              <button type="button" onClick={() => setAlignmentOffsetSeconds((prev) => prev - 1)} style={{ padding: "6px 10px" }}>
                -1s
              </button>
              <button type="button" onClick={() => setAlignmentOffsetSeconds((prev) => prev + 1)} style={{ padding: "6px 10px" }}>
                +1s
              </button>
              <button type="button" onClick={() => setAlignmentOffsetSeconds((prev) => prev + 3)} style={{ padding: "6px 10px" }}>
                +3s
              </button>
              <button type="button" onClick={() => setAlignmentOffsetSeconds(0)} style={{ padding: "6px 10px" }}>
                Reset
              </button>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                {alignmentOffsetSeconds >= 0 ? "+" : ""}
                {alignmentOffsetSeconds.toFixed(1)}s
              </span>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, color: "#94a3b8" }}>
              <span>Details width</span>
              <input
                type="range"
                min={280}
                max={720}
                step={20}
                value={detailsMaxWidth}
                onChange={(e) => setDetailsMaxWidth(Number(e.target.value || "420"))}
                style={{ accentColor: "#38bdf8" }}
              />
              <span style={{ minWidth: 48 }}>{detailsMaxWidth}px</span>
            </label>

            <div style={{ flex: "1 1 auto", overflowY: "auto", paddingRight: 8, minHeight: 0 }}>
              {windowSpans.length === 0 ? (
                <div style={{ color: "#94a3b8" }}>No window sections found yet.</div>
              ) : (
                <div style={{ display: "grid", gap: 16 }}>
                  {windowSpans.map((span) => {
                  const eventsForSpan = windowEventsMap.get(span.id) ?? [];
                  const displayEvents = buildDisplayEvents(eventsForSpan);
                  const transcriptForSpan = windowTranscriptMap.get(span.id) ?? [];
                  const timelineItems = buildTimelineItems(displayEvents, transcriptForSpan);
                  const windowLabel = span.window_name || "";
                  const windowBlob = windowLabel.toLowerCase();
                  const windowMatches = Boolean(normalizedQuery && searchScopes.window && windowBlob.includes(normalizedQuery));
                  const filteredItems = timelineItems.filter((item) => {
                    const type = item.event_type || (item.kind === "transcript" ? "transcript" : "");
                    if (!eventVisibility[type]) {
                      return false;
                    }
                    if (!normalizedQuery) {
                      return true;
                    }
                    if (windowMatches) {
                      return true;
                    }
                    if (!isScopeEnabled(type)) {
                      return false;
                    }
                    const baseText = item.label.toLowerCase();
                    const sourceText = item.sourceEvent?.search_blob ?? "";
                    return `${baseText} ${sourceText}`.includes(normalizedQuery);
                  });
                  if (normalizedQuery && filteredItems.length === 0) {
                    return null;
                  }
                  const spanActive = currentTime >= span.start_seconds && currentTime <= span.end_seconds;
                  return (
                    <div
                      key={span.id}
                      style={{
                        border: "1px solid #1e293b",
                        borderRadius: 12,
                        padding: 16,
                        background: spanActive ? "rgba(15, 23, 42, 0.9)" : "rgba(11, 17, 32, 0.9)",
                        display: "grid",
                        gap: 12,
                      }}
                    >
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
                        <strong style={{ fontSize: 18 }}>{span.window_name}</strong>
                        <span style={{ color: "#94a3b8" }}>
                          {formatTime(span.start_seconds)} - {formatTime(span.end_seconds)}
                        </span>
                        <span style={{ color: spanActive ? "#38bdf8" : "#64748b" }}>
                          {spanActive ? "Active now" : `${filteredItems.length} items`}
                        </span>
                      </div>

                      <div style={{ display: "grid", gap: 10 }}>
                        <div style={{ color: "#94a3b8", fontSize: 13 }}>Timeline</div>
                        <div style={{ height: 6, background: "#1e293b", borderRadius: 999, overflow: "hidden" }}>
                          <div
                            style={{
                              width: `${spanActive ? Math.min(100, ((currentTime - span.start_seconds) / Math.max(0.1, span.end_seconds - span.start_seconds)) * 100) : 0}%`,
                              height: "100%",
                              background: "#38bdf8",
                            }}
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            if (videoRef.current) {
                              videoRef.current.currentTime = Math.max(0, span.start_seconds);
                              videoRef.current.play().catch(() => {
                                /* ignore */
                              });
                            }
                          }}
                          style={{ padding: "6px 10px", width: "fit-content" }}
                        >
                          Jump to start
                        </button>
                      </div>

                      <div style={{ display: "grid", gap: 10 }}>
                        <strong>Events</strong>
                        {filteredItems.length === 0 ? (
                          <div style={{ color: "#94a3b8" }}>No events in this window.</div>
                        ) : (
                          <div style={{ display: "grid", gap: 8 }}>
                            {filteredItems.map((item) => {
                              const relativeStart = Math.max(0, item.timeline_seconds - span.start_seconds);
                              const relativeEnd =
                                item.end_seconds != null
                                  ? Math.max(relativeStart, item.end_seconds - span.start_seconds)
                                  : null;
                              const isTranscript = item.kind === "transcript";
                              const isActive = isTranscript
                                ? currentTime >= (item.segment?.start ?? item.timeline_seconds) &&
                                  currentTime <= (item.segment?.end ?? item.timeline_seconds)
                                : Math.abs(currentTime - item.timeline_seconds) < 0.4;
                              const borderColor = isActive
                                ? isTranscript
                                  ? "#22c55e"
                                  : "#38bdf8"
                                : "#1e293b";
                              const background = isActive
                                ? isTranscript
                                  ? "rgba(34, 197, 94, 0.15)"
                                  : "rgba(56, 189, 248, 0.15)"
                                : "rgba(15, 23, 42, 0.7)";
                              return (                                                                            
                                <button                                                                          
                                  key={item.id}                                                                   
                                  type="button"                                                                  
                                  ref={isActive ? activeItemRef : null}                                          
                                  onClick={() => {                                                               
                                    if (videoRef.current) {                                                      
                                      videoRef.current.currentTime = Math.max(0, item.timeline_seconds);         
                                      videoRef.current.play().catch(() => {
                                        /* ignore */
                                      });
                                    }
                                  }}
                                  style={{
                                    display: "grid",
                                    gridTemplateColumns: isTranscript ? "120px 1fr" : "80px 1fr",
                                    gap: 12,
                                    padding: "10px 12px",
                                    borderRadius: 8,
                                    border: "1px solid",
                                    borderColor,
                                    background,
                                    color: "#e2e8f0",
                                    textAlign: "left",
                                    cursor: "pointer",
                                  }}
                                >
                                  <span style={{ fontVariantNumeric: "tabular-nums", color: "#cbd5f5" }}>
                                    {isTranscript && relativeEnd != null
                                      ? `${formatTime(relativeStart)} - ${formatTime(relativeEnd)}`
                                      : formatTime(relativeStart)}
                                  </span>
                                  <span>
                                    {isTranscript ? `Transcript: ${clipText(item.label, 140)}` : clipText(item.label, 140)}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                  })}
                </div>
              )}
            </div>
          </div>
        </section>
        {settingsOpen && (
          <div
            role="dialog"
            aria-label="Event settings"
            onClick={() => setSettingsOpen(false)}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(5, 10, 20, 0.6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 80,
            }}
          >
            <div
              onClick={(event) => event.stopPropagation()}
              style={{
                width: "min(480px, 92vw)",
                background: "#0f172a",
                borderRadius: 12,
                border: "1px solid #1e293b",
                padding: 18,
                display: "grid",
                gap: 12,
                color: "#e2e8f0",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <strong>Event visibility</strong>
                <button
                  type="button"
                  onClick={() => setSettingsOpen(false)}
                  style={{ border: "none", background: "transparent", color: "#94a3b8", cursor: "pointer" }}
                >
                  Close
                </button>
              </div>
              <div style={{ display: "grid", gap: 8 }}>
                {EVENT_TYPE_OPTIONS.map((option) => (
                  <label key={option.type} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={eventVisibility[option.type] ?? false}
                      onChange={(event) =>
                        setEventVisibility((prev) => ({ ...prev, [option.type]: event.target.checked }))
                      }
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
              <button
                type="button"
                onClick={() => {
                  const next: Record<string, boolean> = {};
                  for (const option of EVENT_TYPE_OPTIONS) {
                    next[option.type] = DEFAULT_VISIBLE_TYPES.has(option.type);
                  }
                  setEventVisibility(next);
                }}
                style={{ padding: "6px 10px", width: "fit-content" }}
              >
                Reset to defaults
              </button>
            </div>
          </div>
        )}
        {searchModalOpen && (
          <div
            role="dialog"
            aria-label="Search filters"
            onClick={() => setSearchModalOpen(false)}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(5, 10, 20, 0.6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 80,
            }}
          >
            <div
              onClick={(event) => event.stopPropagation()}
              style={{
                width: "min(440px, 92vw)",
                background: "#0f172a",
                borderRadius: 12,
                border: "1px solid #1e293b",
                padding: 18,
                display: "grid",
                gap: 12,
                color: "#e2e8f0",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <strong>Search scope</strong>
                <button
                  type="button"
                  onClick={() => setSearchModalOpen(false)}
                  style={{ border: "none", background: "transparent", color: "#94a3b8", cursor: "pointer" }}
                >
                  Close
                </button>
              </div>
              <div style={{ display: "grid", gap: 8 }}>
                {[
                  { key: "transcript", label: "Transcript" },
                  { key: "typed", label: "Typed" },
                  { key: "shortcut", label: "Shortcut" },
                  { key: "key", label: "Key events" },
                  { key: "window", label: "Window title/class" },
                  { key: "mouse", label: "Mouse events" },
                  { key: "marker", label: "Markers" },
                ].map((scope) => (
                  <label key={scope.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={searchScopes[scope.key]}
                      onChange={(event) =>
                        setSearchScopes((prev) => ({ ...prev, [scope.key]: event.target.checked }))
                      }
                    />
                    <span>{scope.label}</span>
                  </label>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  onClick={() =>
                    setSearchScopes({
                      transcript: true,
                      typed: true,
                      shortcut: true,
                      key: true,
                      window: true,
                      mouse: true,
                      marker: true,
                    })
                  }
                  style={{ padding: "6px 10px" }}
                >
                  All
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setSearchScopes({
                      transcript: false,
                      typed: false,
                      shortcut: false,
                      key: false,
                      window: false,
                      mouse: false,
                      marker: false,
                    })
                  }
                  style={{ padding: "6px 10px" }}
                >
                  None
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );                                                                                                             
}              
