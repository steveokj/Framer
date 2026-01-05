"use client";                                                                                                    
                                                                                                                 
import { useCallback, useEffect, useMemo, useRef, useState } from "react";   
                                                                                                                 
type Segment = {                                                                                                 
  id: number;                                                                                                    
  start: number;                                                                                                 
  end: number;                                                                                                   
  text: string;                                                                                                  
};                                                                                                               
                                                                                                                 
type Clip = {                                                                                                    
  id: number;                                                                                                    
  window_name: string;                                                                                           
  start_seconds: number;                                                                                         
  end_seconds: number;                                                                                           
  start_timestamp: string;                                                                                       
  end_timestamp: string;                                                                                         
  start_offset_index: number;                                                                                    
  end_offset_index: number;                                                                                      
  frame_count: number;                                                                                           
};                                                                                                               
                                                                                                                 
type FrameEntry = {
  offset_index: number;
  timestamp: string | null;
  seconds_from_video_start: number;
  frame_path?: string | null;
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

const DEFAULT_VIDEO = "";
const EVENT_TYPE_PRESET = [                                                                                      
  "active_window_changed",                                                                                       
  "window_rect_changed",                                                                                         
  "key_shortcut",                                                                                                
  "key_down",                                                                                                    
  "text_input",                                                                                                  
  "mouse_click",                                                                                                 
  "marker",                                                                                                      
  "mouse_move",                                                                                                  
  "snapshot",                                                                                                    
];                                                                                                               
                                                                                                                 
const API_BASE = (                                                                                               
  process.env.NEXT_PUBLIC_API_BASE && process.env.NEXT_PUBLIC_API_BASE.trim().length > 0                         
    ? process.env.NEXT_PUBLIC_API_BASE                                                                           
    : "http://localhost:8001"                                                                                    
).replace(/\/$/, "");                                                                                            
                                                                                                                 
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
    return `${hours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2
, "0")}`;                                                                                                        
  }                                                                                                              
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;                              
}                                                                                                                
                                                                                                                 
function getTimelineDuration(meta: Metadata | null): number | null {                                             
  if (!meta || !meta.frames.length) {                                                                            
    return null;                                                                                                 
  }                                                                                                              
  return meta.frames[meta.frames.length - 1].seconds_from_video_start;                                           
}                                                                                                                
                                                                                                                 
function mapVideoTimeToTimeline(videoTime: number, videoDuration: number | null | undefined, meta: Metadata | null): number {                                                                                                     
  if (!meta || !meta.frames.length) {                                                                            
    return videoTime;                                                                                            
  }                                                                                                              
  const frames = meta.frames;                                                                                    
  const lastIndex = frames.length - 1;                                                                           
  if (lastIndex === 0) {                                                                                         
    return frames[0].seconds_from_video_start;                                                                   
  }                                                                                                              
  const duration = Number.isFinite(videoDuration || 0) && (videoDuration || 0) > 0 ? (videoDuration as number) : frames[lastIndex].seconds_from_video_start;                                                                      
  if (!(duration > 0)) {                                                                                         
    return videoTime;                                                                                            
  }                                                                                                              
  const fraction = Math.min(Math.max(videoTime / duration, 0), 1);                                               
  const position = fraction * lastIndex;                                                                         
  const lowerIdx = Math.floor(position);                                                                         
  const upperIdx = Math.min(lastIndex, lowerIdx + 1);                                                            
  if (upperIdx === lowerIdx) {                                                                                   
    return frames[lowerIdx].seconds_from_video_start;                                                            
  }                                                                                                              
  const frameFraction = position - lowerIdx;                                                                     
  const lowerSeconds = frames[lowerIdx].seconds_from_video_start;                                                
  const upperSeconds = frames[upperIdx].seconds_from_video_start;                                                
  return lowerSeconds + (upperSeconds - lowerSeconds) * frameFraction;                                           
}                                                                                                                
                                                                                                                 
function mapTimelineToVideo(                                                                                     
  timelineSeconds: number,                                                                                       
  videoDuration: number | null | undefined,                                                                      
  meta: Metadata | null,                                                                                         
): number {                                                                                                      
  if (!meta || !meta.frames.length) {                                                                            
    return Math.max(0, timelineSeconds);                                                                         
  }                                                                                                              
  const frames = meta.frames;                                                                                    
  const lastIndex = frames.length - 1;                                                                           
  if (lastIndex === 0) {                                                                                         
    if (videoDuration && videoDuration > 0) {                                                                    
      return Math.min(Math.max(timelineSeconds, 0), videoDuration);                                              
    }                                                                                                            
    return Math.max(0, timelineSeconds);                                                                         
  }                                                                                                              
  if (!(videoDuration && videoDuration > 0)) {                                                                   
    return Math.max(0, timelineSeconds);                                                                         
  }                                                                                                              
  const lastTimeline = frames[lastIndex].seconds_from_video_start;                                               
  if (timelineSeconds <= frames[0].seconds_from_video_start) {                                                   
    return 0;                                                                                                    
  }                                                                                                              
  if (timelineSeconds >= lastTimeline) {                                                                         
    return videoDuration;                                                                                        
  }                                                                                                              
  let lo = 0;                                                                                                    
  let hi = lastIndex;                                                                                            
  while (lo <= hi) {                                                                                             
    const mid = Math.floor((lo + hi) / 2);                                                                       
    const midVal = frames[mid].seconds_from_video_start;                                                         
    if (midVal < timelineSeconds) {
      lo = mid + 1;                                                                                              
    } else if (midVal > timelineSeconds) {                                                                       
      hi = mid - 1;                                                                                              
    } else {                                                                                                     
      const midFraction = mid / lastIndex;                                                                       
      return midFraction * videoDuration;                                                                        
    }                                                                                                            
  }                                                                                                              
  const upperIdx = Math.min(lastIndex, Math.max(1, lo));                                                         
  const lowerIdx = upperIdx - 1;                                                                                 
  const lowerSeconds = frames[lowerIdx].seconds_from_video_start;                                                
  const upperSeconds = frames[upperIdx].seconds_from_video_start;                                                
  const segmentSpan = upperSeconds - lowerSeconds || 1;                                                          
  const segmentFraction = (timelineSeconds - lowerSeconds) / segmentSpan;                                        
  const lowerVideo = (lowerIdx / lastIndex) * videoDuration;                                                     
  const upperVideo = (upperIdx / lastIndex) * videoDuration;                                                     
  return lowerVideo + (upperVideo - lowerVideo) * segmentFraction;                                               
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

function safeJsonParse(input: string | null): any | null {                                                       
  if (!input) {                                                                                                  
    return null;                                                                                                 
  }                                                                                                              
  try {                                                                                                          
    return JSON.parse(input);                                                                                    
  } catch {                                                                                                      
    return null;                                                                                                 
  }                                                                                                              
}                                                                                                                
                                                                                                                 
function clipText(input: string, limit = 120): string {                                                          
  if (input.length <= limit) {                                                                                   
    return input;                                                                                                
  }                                                                                                              
  return `${input.slice(0, Math.max(limit - 3, 0))}...`;                                                         
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

function buildWindowClipsFromEvents(events: EventView[], timelineEnd: number | null, originMs: number | null): Clip[] {
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
    if (!sortedEvents.length) {
      return [];
    }
    const first = sortedEvents[0];
    const name = first.window_title || first.window_class || first.process_name || "Unknown window";
    const startWall = originMs != null ? originMs : first.ts_wall_ms;
    const endWall = originMs != null ? originMs + fallbackEnd * 1000 : first.ts_wall_ms + fallbackEnd * 1000;
    return [
      {
        id: 0,
        window_name: name,
        start_seconds: 0,
        end_seconds: Math.max(0.05, fallbackEnd),
        start_timestamp: new Date(startWall).toISOString(),
        end_timestamp: new Date(endWall).toISOString(),
        start_offset_index: 0,
        end_offset_index: 0,
        frame_count: 0,
      },
    ];
  }
  const endFallback = timelineEnd ?? windowEvents[windowEvents.length - 1].event.timeline_seconds + 1;
  return windowEvents.map((entry, index) => {
    const startSeconds = Math.max(0, entry.event.timeline_seconds);
    const next = windowEvents[index + 1];
    const endSeconds = Math.max(startSeconds + 0.05, next ? next.event.timeline_seconds : endFallback);
    const startWall = originMs != null ? originMs + startSeconds * 1000 : entry.event.ts_wall_ms;
    const endWall = originMs != null ? originMs + endSeconds * 1000 : entry.event.ts_wall_ms + (endSeconds - startSeconds) * 1000;
    return {
      id: index,
      window_name: entry.name,
      start_seconds: startSeconds,
      end_seconds: endSeconds,
      start_timestamp: new Date(startWall).toISOString(),
      end_timestamp: new Date(endWall).toISOString(),
      start_offset_index: 0,
      end_offset_index: 0,
      frame_count: 0,
    };
  });
}

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
                                                                                                                 
export default function WindowsEventsPage() {
  const [videoInput, setVideoInput] = useState(DEFAULT_VIDEO);
  const [videoPath, setVideoPath] = useState(DEFAULT_VIDEO);
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [loadingMetadata, setLoadingMetadata] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [ingestPhase, setIngestPhase] = useState<IngestPhase>("idle");
  const [ingestProgress, setIngestProgress] = useState<IngestProgress | null>(null);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [ingestTargetPath, setIngestTargetPath] = useState<string | null>(null);
  const [metadataRefreshKey, setMetadataRefreshKey] = useState(0);
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
  const [searchQuery, setSearchQuery] = useState("");                                                            
  const [searchWindows, setSearchWindows] = useState(true);                                                      
  const [searchEvents, setSearchEvents] = useState(true);                                                        
  const [searchTranscripts, setSearchTranscripts] = useState(true);                                              
  const [enabledEventTypes, setEnabledEventTypes] = useState<string[]>([...EVENT_TYPE_PRESET]);                  
  const [currentTime, setCurrentTime] = useState(0);                                                             
  const [videoDuration, setVideoDuration] = useState<number | null>(null);                                       
  const [videoLoadError, setVideoLoadError] = useState<string | null>(null);                                     
  const [isPlaying, setIsPlaying] = useState(false);                                                             
  const [controlsVisible, setControlsVisible] = useState(true);                                                  
  const [captionsEnabled, setCaptionsEnabled] = useState(true);                                                  
                                                                                                                 
  const videoRef = useRef<HTMLVideoElement>(null);
  const autoIngestedRef = useRef<Set<string>>(new Set());
  const hideControlsTimeoutRef = useRef<number | null>(null);                                                    
                                                                                                                 
  const { url: videoUrl, warning: videoWarning } = useMemo(() => buildFileUrl(videoPath), [videoPath]);          
  const serverHint = API_BASE || "http://localhost:8001";                                                        
                                                                                                                 
  const timelineDuration = useMemo(() => getTimelineDuration(metadata), [metadata]);
  const sliderMax = timelineDuration ?? videoDuration ?? 0;
  const formattedCurrentTime = useMemo(() => formatTime(currentTime), [currentTime]);
  const formattedTotalTime = useMemo(() => formatTime(sliderMax), [sliderMax]);
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
  const ingestStatusLabel = useMemo(() => {
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
        return "Idle";
    }
  }, [ingestPhase]);
                                                                                                                 
  const selectedSession = useMemo(                                                                               
    () => sessions.find((session) => session.session_id === selectedSessionId) ?? null,                          
    [sessions, selectedSessionId],                                                                               
  );                                                                                                             
                                                                                                                 
  const eventTypeOptions = useMemo(() => {                                                                       
    const set = new Set<string>(EVENT_TYPE_PRESET);
    for (const event of events) {                                                                                
      if (event.event_type) {                                                                                    
        set.add(event.event_type);                                                                               
      }                                                                                                          
    }                                                                                                            
    return Array.from(set);                                                                                      
  }, [events]);                                                                                                  
                                                                                                                 
  const timelineBounds = useMemo(() => {
    if (!metadata?.frames?.length) {
      return { first: null as number | null, last: null as number | null };
    }
    const firstTs = metadata.frames[0]?.timestamp ? Date.parse(metadata.frames[0].timestamp as string) : NaN;
    const lastFrame = metadata.frames[metadata.frames.length - 1];
    const lastTs = lastFrame?.timestamp ? Date.parse(lastFrame.timestamp as string) : NaN;
    return {
      first: Number.isFinite(firstTs) ? firstTs : null,
      last: Number.isFinite(lastTs) ? lastTs : null,
    };
  }, [metadata]);

  const timelineOriginMs = useMemo(() => {
    if (timelineBounds.first != null) {
      return timelineBounds.first;
    }
    if (events.length > 0) {
      return events[0].ts_wall_ms;
    }
    if (selectedSession?.start_wall_ms) {
      return selectedSession.start_wall_ms;
    }
    return null;
  }, [timelineBounds.first, events, selectedSession]);

  const eventsWithTimeline = useMemo<EventView[]>(() => {
    if (!events.length) {
      return [];
    }
    const origin = timelineOriginMs;
    return events.map((event) => {                                                                               
      const timelineSeconds = origin != null ? (event.ts_wall_ms - origin) / 1000 : 0;                           
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
  }, [events, timelineOriginMs]);

  const clips = useMemo(
    () => buildWindowClipsFromEvents(eventsWithTimeline, timelineDuration, timelineOriginMs),
    [eventsWithTimeline, timelineDuration, timelineOriginMs],
  );
                                                                                                                 
  const normalizedQuery = useMemo(
    () => searchQuery.trim().toLowerCase(),
    [searchQuery]
  );                                                      
                                                                                                                 
  const filteredEvents = useMemo(() => {                                                                         
    const enabledSet = new Set(enabledEventTypes);                                                               
    return eventsWithTimeline.filter((event) => {                                                                
      if (enabledSet.size > 0 && !enabledSet.has(event.event_type)) {                                            
        return false;                                                                                            
      }                                                                                                          
      if (normalizedQuery && searchEvents) {                                                                     
        return event.search_blob.includes(normalizedQuery);                                                      
      }                                                                                                          
      return true;                                                                                               
    });                                                                                                          
  }, [eventsWithTimeline, enabledEventTypes, normalizedQuery, searchEvents]);                                    
                                                                                                                 
  const timelineSegments = useMemo(() => segments, [segments]);
                                                                                                                 
  const clipTranscriptMap = useMemo(() => {
    const map = new Map<number, Segment[]>();                                                                    
    for (const clip of clips) {                                                                                  
      const segs = timelineSegments                                                                              
        .filter((seg) => seg.end > clip.start_seconds && seg.start < clip.end_seconds)                           
        .map((seg) => {                                                                                          
          const clippedStart = Math.max(seg.start, clip.start_seconds);                                          
          const clippedEnd = Math.min(seg.end, clip.end_seconds);                                                
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
      map.set(clip.id, segs);                                                                                    
    }                                                                                                            
    return map;
  }, [clips, timelineSegments]);

  const startIngest = useCallback(async (video: string) => {
    setIngestPhase("starting");
    setIngestProgress(null);
    setIngestError(null);
    setIngestTargetPath(video);
    try {
      const res = await fetch("/api/mkv_ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoPath: video,
          fast: true,
          maxFps: 1,
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
              const extractMatch = line.match(/extract:\s*(\d+)\s*\/\s*(\d+)/i);
              if (extractMatch) {
                const done = Number(extractMatch[1]);
                const total = Number(extractMatch[2]);
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
            }
          } else if (eventType === "stage") {
            const stage = payload?.stage as IngestPhase | undefined;
            if (stage) {
              setIngestPhase(stage);
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
      setIngestPhase("done");
    } catch (err) {
      setIngestPhase("error");
      setIngestError(err instanceof Error ? err.message : "Ingest failed");
      throw err;
    }
  }, []);
                                                                                                                 
  const clipEventsMap = useMemo(() => {                                                                          
    const map = new Map<number, EventView[]>();                                                                  
    if (!clips.length) {                                                                                         
      return map;                                                                                                
    }                                                                                                            
    const sortedClips = [...clips].sort((a, b) => a.start_seconds - b.start_seconds);                            
    for (const clip of sortedClips) {                                                                            
      map.set(clip.id, []);                                                                                      
    }                                                                                                            
    let clipIndex = 0;                                                                                           
    for (const event of filteredEvents) {                                                                        
      const timelineSeconds = event.timeline_seconds;                                                            
      while (clipIndex < sortedClips.length && timelineSeconds > sortedClips[clipIndex].end_seconds) {           
        clipIndex += 1;                                                                                          
      }                                                                                                          
      if (clipIndex >= sortedClips.length) {                                                                     
        break;                                                                                                   
      }                                                                                                          
      const clip = sortedClips[clipIndex];                                                                       
      if (timelineSeconds >= clip.start_seconds && timelineSeconds <= clip.end_seconds) {                        
        map.get(clip.id)?.push(event);                                                                           
      }                                                                                                          
    }                                                                                                            
    return map;                                                                                                  
  }, [clips, filteredEvents]);                                                                                   
                                                                                                                 
  const filteredClips = useMemo(() => {                                                                          
    if (!normalizedQuery) {                                                                                      
      return clips;                                                                                              
    }                                                                                                            
    return clips.filter((clip) => {                                                                              
      const windowMatch = searchWindows && clip.window_name.toLowerCase().includes(normalizedQuery);             
      if (windowMatch) {                                                                                         
        return true;                                                                                             
      }                                                                                                          
      const eventMatch =                                                                                         
        searchEvents &&                                                                                          
        (clipEventsMap.get(clip.id) || []).some((event) => event.search_blob.includes(normalizedQuery));         
      if (eventMatch) {                                                                                          
        return true;                                                                                             
      }                                                                                                          
      const transcriptMatch =                                                                                    
        searchTranscripts &&                                                                                     
        (clipTranscriptMap.get(clip.id) || []).some((seg) => stripTranscriptTimestamp(seg.text).toLowerCase().includes(normalizedQuery));                                                                                         
      return transcriptMatch;                                                                                    
    });                                                                                                          
  }, [clips, normalizedQuery, searchWindows, searchEvents, searchTranscripts, clipEventsMap, clipTranscriptMap]);
                                                                                                                 
  const activeClipId = useMemo(() => {                                                                           
    const target = currentTime;                                                                                  
    const match = clips.find((clip) => target >= clip.start_seconds && target <= clip.end_seconds);              
    return match ? match.id : null;                                                                              
  }, [currentTime, clips]);                                                                                      
                                                                                                                 
  const activeSegment = useMemo(() => {                                                                          
    if (!timelineSegments.length) {                                                                              
      return null;                                                                                               
    }                                                                                                            
    return timelineSegments.find((segment) => currentTime >= segment.start && currentTime <= segment.end) ?? null
;                                                                                                                
  }, [timelineSegments, currentTime]);                                                                           
                                                                                                                 
  const activeSegmentText = activeSegment ? stripTranscriptTimestamp(activeSegment.text) : "";
                                                                                                                 
  const refreshSessions = useCallback(async () => {                                                              
    setLoadingSessions(true);                                                                                    
    setSessionError(null);                                                                                       
    try {                                                                                                        
      const res = await fetch("/api/timestone_sessions", { method: "POST" });                                    
      if (!res.ok) {                                                                                             
        const payload = await res.json().catch(() => ({}));                                                      
        throw new Error(payload.error || `Failed to load sessions (status ${res.status})`);                      
      }                                                                                                          
      const data = await res.json();                                                                             
      const list = Array.isArray(data?.sessions) ? (data.sessions as TimestoneSession[]) : [];                   
      setSessions(list);                                                                                         
      if (!selectedSessionId && list.length > 0) {                                                               
        setSelectedSessionId(list[0].session_id);                                                                
      }                                                                                                          
    } catch (err) {                                                                                              
      setSessions([]);                                                                                           
      setSessionError(err instanceof Error ? err.message : "Failed to load sessions");                           
    } finally {                                                                                                  
      setLoadingSessions(false);                                                                                 
    }                                                                                                            
  }, [selectedSessionId]);                                                                                       
                                                                                                                 
  useEffect(() => {                                                                                              
    refreshSessions().catch(() => {                                                                              
      /* handled */                                                                                              
    });                                                                                                          
  }, [refreshSessions]);                                                                                         
                                                                                                                 
  useEffect(() => {                                                                                              
    if (!selectedSessionId && sessions.length > 0) {                                                             
      setSelectedSessionId(sessions[0].session_id);                                                              
    }                                                                                                            
  }, [sessions, selectedSessionId]);                                                                             
                                                                                                                 
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
    if (ingestTargetPath && ingestTargetPath !== videoPath && ingestPhase !== "idle") {
      setIngestPhase("idle");
      setIngestProgress(null);
      setIngestError(null);
      setIngestTargetPath(null);
    }
  }, [videoPath, ingestTargetPath, ingestPhase]);
                                                                                                                 
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
        const lower = message.toLowerCase();
        const missing = lower.includes("no video record");
        if (missing && !ingestInProgressForVideo && !autoIngestedRef.current.has(videoPath)) {
          autoIngestedRef.current.add(videoPath);
          startIngest(videoPath)
            .then(() => setMetadataRefreshKey((prev) => prev + 1))
            .catch(() => {
              /* handled by ingest state */
            });
        }
      } finally {
        setLoadingMetadata(false);
      }
    };
    fetchMetadata();
  }, [videoPath, metadataRefreshKey, ingestInProgressForVideo, startIngest]);

                                                                                                                 
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
      const duration = metadata.video.duration ?? getTimelineDuration(metadata);
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
    const fetchEvents = async () => {
      if (!selectedSessionId) {
        setEvents([]);
        setEventError(null);
        return;
      }
      setLoadingEvents(true);
      setEventError(null);
      try {
        const payload: any = {
          sessionId: selectedSessionId,
        };
        if (enabledEventTypes.length > 0) {
          payload.eventTypes = enabledEventTypes.includes("active_window_changed")
            ? enabledEventTypes
            : [...enabledEventTypes, "active_window_changed"];
        }
        if (timelineBounds.first != null) {
          payload.startMs = timelineBounds.first;
        }
        if (timelineBounds.last != null) {
          payload.endMs = timelineBounds.last;
        }
        const res = await fetch("/api/timestone_events", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
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
  }, [selectedSessionId, enabledEventTypes, normalizedQuery, searchEvents, timelineBounds.first, timelineBounds.last]);
                                                                                                
                                                                                                                 
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
    setCurrentTime(0);
    video.play().catch(() => {                                                                                   
      /* ignore */                                                                                               
    });                                                                                                          
  }, []);                                                                                                        
                                                                                                                 
  const handleSeekTimeline = useCallback(                                                                        
    (timelineSeconds: number, options?: { play?: boolean }) => {                                                 
      const video = videoRef.current;                                                                            
      if (!video) {                                                                                              
        return;                                                                                                  
      }                                                                                                          
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : videoDuration;   
      const targetVideo = mapTimelineToVideo(timelineSeconds, duration ?? null, metadata);                       
      if (Number.isFinite(targetVideo)) {                                                                        
        video.currentTime = targetVideo;                                                                         
      }                                                                                                          
      setCurrentTime(Math.max(0, timelineSeconds));                                                              
      if (options?.play) {                                                                                       
        video.play().catch(() => {                                                                               
          /* ignore */                                                                                           
        });                                                                                                      
      }                                                                                                          
    },                                                                                                           
    [metadata, videoDuration],                                                                                   
  );                                                                                                             
                                                                                                                 
  const handleTimelineSliderChange = useCallback(                                                                
    (event: React.ChangeEvent<HTMLInputElement>) => {                                                            
      const next = Number(event.target.value || "0");                                                            
      handleSeekTimeline(next, { play: false });                                                                 
    },                                                                                                           
    [handleSeekTimeline],                                                                                        
  );                                                                                                             
                                                                                                                 
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
                                                                                                                 
  const handleVideoTimeUpdate = useCallback(() => {                                                              
    const video = videoRef.current;                                                                              
    if (!video) {                                                                                                
      return;                                                                                                    
    }                                                                                                            
    const duration = Number.isFinite(video.duration) ? video.duration : videoDuration;                           
    const timelineSeconds = mapVideoTimeToTimeline(video.currentTime, duration ?? null, metadata);               
    setCurrentTime(Math.max(0, timelineSeconds));                                                                
  }, [metadata, videoDuration]);                                                                                 
                                                                                                                 
  const handleLoadedMetadata = useCallback(() => {                                                               
    const video = videoRef.current;                                                                              
    if (!video) {                                                                                                
      return;                                                                                                    
    }                                                                                                            
    if (Number.isFinite(video.duration)) {                                                                       
      setVideoDuration(video.duration);                                                                          
    }                                                                                                            
  }, []);                                                                                                        
                                                                                                                 
  const handleSeekToEvent = useCallback(                                                                         
    (event: EventView) => {                                                                                      
      handleSeekTimeline(event.timeline_seconds, { play: true });                                                
    },                                                                                                           
    [handleSeekTimeline],                                                                                        
  );                                                                                                             
                                                                                                                 
  const handleSeekToSegment = useCallback(                                                                       
    (segment: Segment) => {                                                                                      
      handleSeekTimeline(segment.start, { play: true });                                                         
    },                                                                                                           
    [handleSeekTimeline],                                                                                        
  );                                                                                                             
                                                                                                                 
  const handleUseSessionVideo = useCallback(() => {                                                              
    if (!selectedSession?.obs_video_path) {                                                                      
      return;                                                                                                    
    }                                                                                                            
    setVideoInput(selectedSession.obs_video_path);                                                               
    setVideoPath(selectedSession.obs_video_path);                                                                
  }, [selectedSession]);                                                                                         
                                                                                                                 
  const clearSearch = useCallback(() => {                                                                        
    setSearchQuery("");                                                                                          
  }, []);                                                                                                        
                                                                                                                 
  const toggleEventType = useCallback((eventType: string) => {                                                   
    setEnabledEventTypes((prev) => {                                                                             
      if (prev.includes(eventType)) {                                                                            
        return prev.filter((item) => item !== eventType);                                                        
      }                                                                                                          
      return [...prev, eventType];                                                                               
    });                                                                                                          
  }, []);                                                                                                        
                                                                                                                 
  const selectAllEventTypes = useCallback(() => {                                                                
    setEnabledEventTypes([...eventTypeOptions]);                                                                 
  }, [eventTypeOptions]);                                                                                        
                                                                                                                 
  const clearEventTypes = useCallback(() => {                                                                    
    setEnabledEventTypes([]);                                                                                    
  }, []);                                                                                                        
                                                                                                                 
  return (                                                                                                       
    <main                                                                                                        
      style={{                                                                                                   
        minHeight: "100vh",                                                                                      
        background: "linear-gradient(180deg, #070b16 0%, #0a1224 40%, #0b1120 100%)",                            
        color: "#e2e8f0",                                                                                        
        padding: "32px 24px 80px",                                                                               
        fontFamily: "\"Space Grotesk\", \"Segoe UI\", system-ui",                                                
      }}                                                                                                         
    >                                                                                                            
      <div style={{ maxWidth: 1200, margin: "0 auto", display: "grid", gap: 24 }}>                               
        <header style={{ display: "grid", gap: 8 }}>                                                             
          <h1 style={{ fontSize: 32, margin: 0 }}>Windows Event Playback</h1>                                    
          <p style={{ margin: 0, color: "#94a3b8" }}>                                                            
            Search sessions, align events to your capture, and scrub by window context with the same player contr
ols as                                                                                                           
            video_frame_mkv.                                                                                     
          </p>                                                                                                   
        </header>                                                                                                
                                                                                                                 
        <section style={{ background: "rgba(15, 23, 42, 0.7)", borderRadius: 14, padding: 20, display: "grid", gap: 16 }}>                                                                                                        
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>                     
            <label style={{ flex: "1 1 280px", display: "grid", gap: 6 }}>                                       
              <span style={{ color: "#cbd5f5" }}>Search everything</span>                                        
              <input                                                                                             
                value={searchQuery}                                                                              
                onChange={(e) => setSearchQuery(e.target.value)}                                                 
                placeholder="Search windows, events, or transcript"                                              
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
              onClick={clearSearch}                                                                              
              style={{                                                                                           
                padding: "8px 14px",                                                                             
                borderRadius: 8,                                                                                 
                border: "1px solid #1e293b",                                                                     
                background: "#0f172a",                                                                           
                color: "#e2e8f0",                                                                                
                cursor: "pointer",                                                                               
              }}                                                                                                 
            >                                                                                                    
              Clear                                                                                              
            </button>                                                                                            
          </div>                                                                                                 
                                                                                                                 
          <details style={{ borderRadius: 10, padding: 12, background: "rgba(15, 23, 42, 0.6)", border: "1px solid #1e293b" }}>                                                                                                   
            <summary style={{ cursor: "pointer", color: "#cbd5f5" }}>In-depth search toggles</summary>           
            <div style={{ display: "grid", gap: 12, marginTop: 12 }}>                                            
              <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>                                       
                <label style={{ display: "flex", alignItems: "center", gap: 8 }}>                                
                  <input type="checkbox" checked={searchWindows} onChange={(e) => setSearchWindows(e.target.checked)} />                                                                                                          
                  <span>Windows</span>                                                                           
                </label>                                                                                         
                <label style={{ display: "flex", alignItems: "center", gap: 8 }}>                                
                  <input type="checkbox" checked={searchEvents} onChange={(e) => setSearchEvents(e.target.checked)} />                                                                                                            
                  <span>Events</span>                                                                            
                </label>                                                                                         
                <label style={{ display: "flex", alignItems: "center", gap: 8 }}>                                
                  <input type="checkbox" checked={searchTranscripts} onChange={(e) => setSearchTranscripts(e.target.checked)} />                                                                                                  
                  <span>Transcripts</span>                                                                       
                </label>                                                                                         
              </div>                                                                                             
                                                                                                                 
              <div style={{ display: "grid", gap: 8 }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>                
                  <strong style={{ color: "#cbd5f5" }}>Event types</strong>                                      
                  <button type="button" onClick={selectAllEventTypes} style={{ padding: "4px 8px" }}>            
                    All                                                                                          
                  </button>                                                                                      
                  <button type="button" onClick={clearEventTypes} style={{ padding: "4px 8px" }}>                
                    None                                                                                         
                  </button>                                                                                      
                </div>                                                                                           
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>                                      
                  {eventTypeOptions.map((eventType) => {                                                         
                    const enabled = enabledEventTypes.includes(eventType);                                       
                    return (                                                                                     
                      <button                                                                                    
                        key={eventType}                                                                          
                        type="button"                                                                            
                        onClick={() => toggleEventType(eventType)}                                               
                        style={{                                                                                 
                          padding: "6px 10px",                                                                   
                          borderRadius: 999,                                                                     
                          border: "1px solid",                                                                   
                          borderColor: enabled ? "#38bdf8" : "#1e293b",                                          
                          background: enabled ? "rgba(56, 189, 248, 0.18)" : "rgba(15, 23, 42, 0.7)",            
                          color: enabled ? "#e0f2fe" : "#94a3b8",                                                
                          cursor: "pointer",                                                                     
                          fontSize: 12,                                                                          
                        }}                                                                                       
                      >                                                                                          
                        {eventType}                                                                              
                      </button>                                                                                  
                    );                                                                                           
                  })}                                                                                            
                </div>                                                                                           
              </div>                                                                                             
            </div>                                                                                               
          </details>                                                                                             
                                                                                                                 
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>                     
            <label style={{ display: "grid", gap: 6, minWidth: 240 }}>                                           
              <span style={{ color: "#cbd5f5" }}>Timestone session</span>                                        
              <select                                                                                            
                value={selectedSessionId}                                                                        
                onChange={(e) => setSelectedSessionId(e.target.value)}                                           
                style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #1e293b", background: "#0b1120"
, color: "#e2e8f0" }}                                                                                            
              >                                                                                                  
                <option value="">Select a session...</option>                                                    
                {sessions.map((session) => (                                                                     
                  <option key={session.session_id} value={session.session_id}>                                   
                    {session.start_wall_iso} ({session.session_id.slice(0, 8)})                                  
                  </option>                                                                                      
                ))}                                                                                              
              </select>                                                                                          
            </label>                                                                                             
            <button type="button" onClick={refreshSessions} style={{ padding: "8px 12px" }}>                     
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
          {selectedSession && (                                                                                  
            <div style={{ color: "#94a3b8" }}>                                                                   
              Session started {selectedSession.start_wall_iso}                                                   
              {selectedSession.obs_video_path ? ` | OBS: ${selectedSession.obs_video_path}` : ""}                
            </div>                                                                                               
          )}                                                                                                     
        </section>                                                                                               
                                                                                                                 
        <section style={{ background: "rgba(11, 17, 32, 0.8)", borderRadius: 14, padding: 20, display: "grid", gap: 16 }}>
          <div style={{ display: "grid", gap: 12 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <span style={{ color: "#cbd5f5" }}>Video path (absolute or project-relative)</span>
              <input
                value={videoInput}
                onChange={(e) => setVideoInput(e.target.value)}
                placeholder="C:\\path\\to\\video.mp4"
                style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #1e293b", background: "#0b1120", color: "#e2e8f0" }}
              />
            </label>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
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
        </section>

        {ingestPhase !== "idle" && (
          <section style={{ background: "rgba(15, 23, 42, 0.6)", borderRadius: 12, padding: 16, display: "grid", gap: 8 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
              <strong>Ingest status:</strong>
              <span style={{ color: "#cbd5f5" }}>{ingestStatusLabel}</span>
              {ingestPercent != null && <span style={{ color: "#94a3b8" }}>{ingestPercent}%</span>}
            </div>
            {ingestProgress && (
              <>
                <div style={{ color: "#94a3b8" }}>
                  {ingestProgress.phase === "extract"
                    ? `Extracting frames ${ingestProgress.done}/${ingestProgress.total}`
                    : `Processing frames ${ingestProgress.done}/${ingestProgress.total}${ingestProgress.kept != null ? `, kept ${ingestProgress.kept}` : ""}`}
                </div>
                <div style={{ height: 8, background: "#1e293b", borderRadius: 999, overflow: "hidden" }}>
                  <div
                    style={{
                      height: "100%",
                      width: `${ingestPercent ?? 0}%`,
                      background: ingestProgress.phase === "extract" ? "#38bdf8" : "#22c55e",
                      transition: "width 0.2s ease",
                    }}
                  />
                </div>
              </>
            )}
            {ingestInProgressForVideo && <div style={{ color: "#cbd5f5" }}>Auto-ingesting this video...</div>}
            {ingestError && <div style={{ color: "#fca5a5" }}>{ingestError}</div>}
          </section>
        )}
                                                                                               
                                                                                                                 
        <section style={{ display: "grid", gap: 16 }}>                                                           
          <div                                                                                                   
            style={{                                                                                             
              position: "relative",                                                                              
              background: "#111",                                                                                
              minHeight: 240,                                                                                    
              height: "min(52vh, 420px)",                                                                        
              borderRadius: 12,                                                                                  
              overflow: "hidden",                                                                                
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
                    setVideoLoadError(                                                                           
                      `Video failed to load. Ensure the FastAPI server at ${serverHint} is running and the file p
ath is correct.`,                                                                                                
                    )                                                                                            
                  }                                                                                              
                  onLoadedData={() => setVideoLoadError(null)}                                                   
                  onLoadedMetadata={handleLoadedMetadata}                                                        
                  onTimeUpdate={handleVideoTimeUpdate}                                                           
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
                      <SubtitleIcon color={captionsEnabled ? "#0f172a" : "#f8fafc"} />                           
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
                      {formattedCurrentTime} / {formattedTotalTime}                                              
                    </span>                                                                                      
                  </div>                                                                                         
                  <input                                                                                         
                    type="range"                                                                                 
                    min={0}                                                                                      
                    max={sliderMax}                                                                              
                    step={0.05}                                                                                  
                    value={Math.min(Math.max(currentTime, 0), sliderMax || 0)}                                   
                    onChange={handleTimelineSliderChange}                                                        
                    style={{ width: "100%", accentColor: "#38bdf8" }}                                            
                    disabled={sliderMax <= 0.05}                                                                 
                  />                                                                                             
                </div>                                                                                           
              </>                                                                                                
            ) : (                                                                                                
              <div style={{ padding: 40, color: "#eee" }}>Enter a video path to start playback.</div>            
            )}                                                                                                   
          </div>                                                                                                 
          {videoLoadError && <div style={{ color: "#fca5a5" }}>{videoLoadError}</div>}                           
        </section>                                                                                               
                                                                                                                 
        <section style={{ background: "#0f172a", color: "#f8fafc", padding: 16, borderRadius: 8, display: "grid", gap: 12 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
            <strong>Ingest summary:</strong>
            {loadingMetadata && <span style={{ color: "#94a3b8" }}>Loading metadata...</span>}
            {metadataError && !ingestInProgressForVideo && <span style={{ color: "#fca5a5" }}>{metadataError}</span>}
            {metadata && (
              <>
                <span>frames = {metadata.video.frame_count ?? metadata.frames.length}</span>
                <span>kept = {metadata.video.kept_frames ?? metadata.frames.length}</span>
                <span>fps = {metadata.video.fps ?? "--"}</span>
                <span>duration = {metadata.video.duration ? `${metadata.video.duration.toFixed(2)}s` : "--"}</span>
                <span>
                  size = {metadata.video.width && metadata.video.height ? `${metadata.video.width}x${metadata.video.height}` : "--"}
                </span>
              </>
            )}
          </div>
          <div>
            <strong>Current transcript:</strong>
            <div style={{ marginTop: 8, minHeight: 40 }}>
              {activeSegmentText ? activeSegmentText : loadingTranscript ? "Loading..." : "--"}
            </div>
          </div>
          {transcriptError && <div style={{ color: "#fca5a5" }}>{transcriptError}</div>}
        </section>
                                                                                                                 
        <section style={{ display: "grid", gap: 16 }}>                                                           
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>                     
            <h2 style={{ margin: 0 }}>Window clips</h2>                                                          
            <span style={{ color: "#94a3b8" }}>{filteredClips.length} clips</span>                               
            <span style={{ color: "#94a3b8" }}>{filteredEvents.length} events</span>                             
          </div>                                                                                                 
          {filteredClips.length === 0 ? (                                                                        
            <div style={{ color: "#94a3b8" }}>No window clips match this search.</div>                           
          ) : (                                                                                                  
            <div style={{ display: "grid", gap: 16 }}>                                                           
              {filteredClips.map((clip) => {                                                                     
                const eventsForClip = clipEventsMap.get(clip.id) ?? [];                                          
                const transcriptForClip = clipTranscriptMap.get(clip.id) ?? [];                                  
                const isActive = activeClipId === clip.id;                                                       
                return (                                                                                         
                  <div                                                                                           
                    key={clip.id}                                                                                
                    style={{                                                                                     
                      border: `1px solid ${isActive ? "#1d4ed8" : "#1e293b"}`,                                   
                      borderRadius: 12,                                                                          
                      padding: 16,                                                                               
                      background: "rgba(11, 17, 32, 0.9)",                                                       
                      display: "grid",                                                                           
                      gap: 12,                                                                                   
                    }}                                                                                           
                  >                                                                                              
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
                      <strong style={{ fontSize: 18 }}>{clip.window_name}</strong>                               
                      <span style={{ color: "#94a3b8" }}>                                                        
                        {formatTime(clip.start_seconds)} - {formatTime(clip.end_seconds)}                        
                      </span>                                                                                    
                      <span style={{ color: "#64748b" }}>{eventsForClip.length} events</span>
                    </div>                                                                                       
                                                                                                                 
                    <div style={{ display: "grid", gap: 10 }}>                                                   
                      <strong>Events</strong>                                                                    
                      {loadingEvents && <span style={{ color: "#64748b" }}>Loading events...</span>}             
                      {eventError && <span style={{ color: "#fca5a5" }}>{eventError}</span>}                     
                      {eventsForClip.length === 0 ? (                                                            
                        <div style={{ color: "#94a3b8" }}>No events in this window range.</div>                  
                      ) : (                                                                                      
                        <div style={{ display: "grid", gap: 8 }}>                                                
                          {eventsForClip.map((eventItem) => {                                                    
                            const isEventActive = Math.abs(currentTime - eventItem.timeline_seconds) < 0.4;      
                            return (                                                                             
                              <button                                                                            
                                key={eventItem.id}                                                               
                                type="button"                                                                    
                                onClick={() => handleSeekToEvent(eventItem)}                                     
                                style={{                                                                         
                                  display: "grid",                                                               
                                  gridTemplateColumns: "80px 1fr",                                               
                                  gap: 12,                                                                       
                                  padding: "10px 12px",                                                          
                                  borderRadius: 8,                                                               
                                  border: "1px solid",                                                           
                                  borderColor: isEventActive ? "#38bdf8" : "#1e293b",                            
                                  background: isEventActive ? "rgba(56, 189, 248, 0.15)" : "rgba(15, 23, 42, 0.7)",                                                                                                               
                                  color: "#e2e8f0",                                                              
                                  textAlign: "left",                                                             
                                  cursor: "pointer",                                                             
                                }}                                                                               
                              >                                                                                  
                                <span style={{ fontVariantNumeric: "tabular-nums", color: "#cbd5f5" }}>          
                                  {formatTime(eventItem.timeline_seconds)}                                       
                                </span>                                                                          
                                <span>                                                                           
                                  <strong style={{ textTransform: "capitalize" }}>{eventItem.event_type.replace(/_/g, " ")}</strong>                                                                                              
                                  {eventItem.description ? ` - ${eventItem.description}` : ""}                   
                                </span>                                                                          
                              </button>                                                                          
                            );                                                                                   
                          })}                                                                                    
                        </div>                                                                                   
                      )}                                                                                         
                    </div>                                                                                       
                                                                                                                 
                    <div style={{ display: "grid", gap: 10 }}>                                                   
                      <strong>Transcript</strong>                                                                
                      {transcriptForClip.length === 0 ? (                                                        
                        <div style={{ color: "#94a3b8" }}>No transcript segments in this range.</div>            
                      ) : (                                                                                      
                        <div style={{ display: "grid", gap: 8 }}>                                                
                          {transcriptForClip.map((segment) => {                                                  
                            const isSegmentActive = currentTime >= segment.start && currentTime <= segment.end;  
                            return (                                                                             
                              <button                                                                            
                                key={`${clip.id}-${segment.id}-${segment.start.toFixed(2)}`}                     
                                type="button"                                                                    
                                onClick={() => handleSeekToSegment(segment)}                                     
                                style={{                                                                         
                                  display: "grid",                                                               
                                  gridTemplateColumns: "120px 1fr",                                              
                                  gap: 12,                                                                       
                                  padding: "10px 12px",                                                          
                                  borderRadius: 8,                                                               
                                  border: "1px solid",                                                           
                                  borderColor: isSegmentActive ? "#22c55e" : "#1e293b",                          
                                  background: isSegmentActive ? "rgba(34, 197, 94, 0.15)" : "rgba(15, 23, 42, 0.7)",                                                                                                              
                                  color: "#e2e8f0",                                                              
                                  textAlign: "left",                                                             
                                  cursor: "pointer",                                                             
                                }}                                                                               
                              >                                                                                  
                                <span style={{ fontVariantNumeric: "tabular-nums", color: "#cbd5f5" }}>          
                                  {formatTime(segment.start)} - {formatTime(segment.end)}                        
                                </span>                                                                          
                                <span>{stripTranscriptTimestamp(segment.text)}</span>                            
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
        </section>                                                                                               
      </div>                                                                                                     
    </main>                                                                                                      
  );                                                                                                             
}   
