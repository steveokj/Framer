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

type ClipIngestState = {
  phase: IngestPhase;
  progress: IngestProgress | null;
  error: string | null;
};

type DisplayEvent = {
  id: string;
  timeline_seconds: number;
  event_type: string;
  description: string;
  source: EventView;
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
    return `${hours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2
, "0")}`;                                                                                                        
  }                                                                                                              
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;                              
}                                                                                                                
                                                                                                                 
function getTimelineDuration(meta: Metadata | null): number | null {                                             
  if (!meta) {                                                                                                   
    return null;                                                                                                 
  }                                                                                                              
  if (Number.isFinite(meta.video.duration ?? NaN)) {                                                             
    return meta.video.duration as number;                                                                        
  }                                                                                                              
  if (!meta.frames.length) {                                                                                     
    return null;                                                                                                 
  }                                                                                                              
  return meta.frames[meta.frames.length - 1].seconds_from_video_start;                                           
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
    const startSeconds = entry.event.timeline_seconds;
    const next = windowEvents[index + 1];
    let endSeconds = next ? next.event.timeline_seconds : endFallback;
    if (endSeconds < startSeconds) {
      endSeconds = startSeconds;
    }
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

function FrameCarouselIcon({ size = 20, color = "#f8fafc" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" stroke={color} strokeWidth={1.8} />
      <line x1="9" y1="5.5" x2="9" y2="18.5" stroke={color} strokeWidth={1.4} />
      <line x1="15" y1="5.5" x2="15" y2="18.5" stroke={color} strokeWidth={1.4} />
    </svg>
  );
}

type ClipCardProps = {
  clip: Clip;
  videoUrl: string | null;
  serverHint: string;
  transcriptSegments: Segment[];
  transcriptForClip: Segment[];
  eventsForClip: EventView[];
  ingestState: ClipIngestState | null;
  onIngestFrames: (clip: Clip) => void;
  detailsMaxWidth: number;
};

function ClipCard({
  clip,
  videoUrl,
  serverHint,
  transcriptSegments,
  transcriptForClip,
  eventsForClip,
  ingestState,
  onIngestFrames,
  detailsMaxWidth,
}: ClipCardProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hideControlsTimeoutRef = useRef<number | null>(null);
  const [clipTime, setClipTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [videoError, setVideoError] = useState<string | null>(null);
  const effectiveDuration = useMemo(() => {
    if (videoDuration != null && Number.isFinite(videoDuration)) {
      return Math.min(clip.end_seconds, videoDuration);
    }
    return clip.end_seconds;
  }, [clip.end_seconds, videoDuration]);
  const clipDuration = Math.max(0.05, effectiveDuration - clip.start_seconds);
  const timelineSeconds = clip.start_seconds + clipTime;
  const formattedCurrentTime = useMemo(() => formatTime(clipTime), [clipTime]);
  const formattedTotalTime = useMemo(() => formatTime(clipDuration), [clipDuration]);
  const displayEvents = useMemo(() => buildDisplayEvents(eventsForClip), [eventsForClip]);
  const ingestPercent = useMemo(() => {
    if (!ingestState?.progress || !ingestState.progress.total) {
      return null;
    }
    return Math.min(100, Math.round((ingestState.progress.done / ingestState.progress.total) * 100));
  }, [ingestState]);
  const ingestLabel = useMemo(() => {
    if (!ingestState) {
      return "";
    }
    switch (ingestState.phase) {
      case "starting":
        return "Starting";
      case "ingesting":
        return "Preparing";
      case "processing":
        return "Processing frames";
      case "transcribing":
        return "Transcribing";
      case "transcribed":
        return "Transcript ready";
      case "done":
        return "Frames ready";
      case "error":
        return "Error";
      default:
        return "";
    }
  }, [ingestState]);
  const ingestBusy =
    ingestState &&
    ingestState.phase !== "idle" &&
    ingestState.phase !== "done" &&
    ingestState.phase !== "error";

  const activeSegment = useMemo(() => {
    if (!transcriptSegments.length) {
      return null;
    }
    return transcriptSegments.find((segment) => timelineSeconds >= segment.start && timelineSeconds <= segment.end) ?? null;
  }, [transcriptSegments, timelineSeconds]);
  const activeSegmentText = activeSegment ? stripTranscriptTimestamp(activeSegment.text) : "";

  const seekTimeline = useCallback(
    (targetTimeline: number, shouldPlay: boolean) => {
      const video = videoRef.current;
      if (!video) {
        return;
      }
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : videoDuration;
      let nextTime = Math.max(0, targetTimeline);
      if (duration != null && Number.isFinite(duration)) {
        const safeEnd = Math.min(clip.end_seconds, duration);
        nextTime = Math.min(nextTime, safeEnd);
      }
      video.currentTime = nextTime;
      const relative = Math.max(0, targetTimeline - clip.start_seconds);
      setClipTime(Math.min(relative, clipDuration));
      if (shouldPlay) {
        video.play().catch(() => {
          /* ignore */
        });
      }
    },
    [clip.start_seconds, clipDuration, videoDuration],
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
    seekTimeline(clip.start_seconds, true);
  }, [clip.start_seconds, seekTimeline]);

  const handleSliderChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const next = Number(event.target.value || "0");
      seekTimeline(clip.start_seconds + next, false);
    },
    [clip.start_seconds, seekTimeline],
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

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    const duration = Number.isFinite(video.duration) ? video.duration : videoDuration;
    const currentTimeline = video.currentTime;
    const safeEnd = duration != null && Number.isFinite(duration) ? Math.min(clip.end_seconds, duration) : clip.end_seconds;
    if (currentTimeline >= safeEnd - 0.01) {
      video.currentTime = Math.max(0, safeEnd);
      video.pause();
      setIsPlaying(false);
      setClipTime(clipDuration);
      return;
    }
    const relative = Math.max(0, currentTimeline - clip.start_seconds);
    setClipTime(Math.min(relative, clipDuration));
  }, [clip.end_seconds, clip.start_seconds, clipDuration, videoDuration]);

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    if (Number.isFinite(video.duration)) {
      setVideoDuration(video.duration);
    }
    seekTimeline(clip.start_seconds, false);
  }, [clip.start_seconds, seekTimeline]);

  const handleSeekToEvent = useCallback(
    (event: EventView) => {
      seekTimeline(event.timeline_seconds, true);
    },
    [seekTimeline],
  );

  const handleSeekToSegment = useCallback(
    (segment: Segment) => {
      seekTimeline(segment.start, true);
    },
    [seekTimeline],
  );

  useEffect(() => {
    return () => {
      if (hideControlsTimeoutRef.current) {
        window.clearTimeout(hideControlsTimeoutRef.current);
      }
    };
  }, []);

  return (
    <div
      style={{
        border: "1px solid #1e293b",
        borderRadius: 12,
        padding: 16,
        background: "rgba(11, 17, 32, 0.9)",
        display: "grid",
        gap: 12,
        gridTemplateColumns: "minmax(0, 2fr) minmax(260px, 1fr)",
        alignItems: "start",
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", gridColumn: "1 / -1" }}>
        <strong style={{ fontSize: 18 }}>{clip.window_name}</strong>
        <span style={{ color: "#94a3b8" }}>
          {formatTime(clip.start_seconds)} - {formatTime(effectiveDuration)}
        </span>
        <span style={{ color: "#64748b" }}>{displayEvents.length} events</span>
      </div>

      <div
        style={{
          position: "relative",
          background: "#111",
          minHeight: 200,
          height: "min(45vh, 320px)",
          borderRadius: 12,
          overflow: "hidden",
          gridColumn: "1 / 2",
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
                  bottom: 56,
                  padding: "8px 12px",
                  borderRadius: 8,
                  background: "rgba(15, 23, 42, 0.75)",
                  color: "#f8fafc",
                  textAlign: "center",
                  fontSize: 15,
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
                padding: "12px 16px",
                background: "linear-gradient(0deg, rgba(15, 23, 42, 0.85) 0%, rgba(15, 23, 42, 0) 100%)",
                display: controlsVisible ? "grid" : "none",
                gap: 10,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <button
                  type="button"
                  onClick={handleTogglePlayback}
                  aria-label={isPlaying ? "Pause" : "Play"}
                  title={isPlaying ? "Pause" : "Play"}
                  style={{
                    width: 36,
                    height: 36,
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
                    width: 36,
                    height: 36,
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
                  aria-label="Restart clip"
                  title="Restart clip"
                  style={{
                    width: 36,
                    height: 36,
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
                <button
                  type="button"
                  onClick={() => onIngestFrames(clip)}
                  aria-label="Generate frames"
                  title="Generate frames for this clip"
                  disabled={!videoUrl || ingestBusy}
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: "50%",
                    border: "none",
                    background: ingestBusy ? "rgba(15, 23, 42, 0.35)" : "rgba(30, 64, 175, 0.75)",
                    color: ingestBusy ? "#475569" : "#f8fafc",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: ingestBusy ? "not-allowed" : "pointer",
                    marginLeft: "auto",
                    transition: "background 0.2s ease",
                  }}
                >
                  <FrameCarouselIcon color={ingestBusy ? "#475569" : "#f8fafc"} />
                </button>
              </div>
              <input
                type="range"
                min={0}
                max={clipDuration}
                step={0.05}
                value={Math.min(Math.max(clipTime, 0), clipDuration)}
                onChange={handleSliderChange}
                style={{ width: "100%", accentColor: "#38bdf8" }}
                disabled={clipDuration <= 0.05}
              />
            </div>
          </>
        ) : (
          <div style={{ padding: 32, color: "#eee" }}>Enter a video path to start playback.</div>
        )}
      </div>
      {videoError && <div style={{ color: "#fca5a5", gridColumn: "1 / 2" }}>{videoError}</div>}
      {ingestState && ingestState.phase !== "idle" && (
        <div style={{ display: "grid", gap: 6, color: "#cbd5f5", gridColumn: "1 / 2" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
            <strong>Frames:</strong>
            <span>{ingestLabel}</span>
            {ingestPercent != null && <span style={{ color: "#94a3b8" }}>{ingestPercent}%</span>}
          </div>
          {ingestState.progress && (
            <>
              <div style={{ color: "#94a3b8" }}>
                {ingestState.progress.phase === "extract"
                  ? `Extracting frames ${ingestState.progress.done}/${ingestState.progress.total}`
                  : `Processing frames ${ingestState.progress.done}/${ingestState.progress.total}${ingestState.progress.kept != null ? `, kept ${ingestState.progress.kept}` : ""}`}
              </div>
              <div style={{ height: 6, background: "#1e293b", borderRadius: 999, overflow: "hidden" }}>
                <div
                  style={{
                    height: "100%",
                    width: `${ingestPercent ?? 0}%`,
                    background: ingestState.progress.phase === "extract" ? "#38bdf8" : "#22c55e",
                    transition: "width 0.2s ease",
                  }}
                />
              </div>
            </>
          )}
          {ingestState.error && <div style={{ color: "#fca5a5" }}>{ingestState.error}</div>}
        </div>
      )}

      <div
        style={{
          gridColumn: "2 / 3",
          gridRow: "2 / span 3",
          justifySelf: "end",
          width: "100%",
          maxWidth: detailsMaxWidth,
          display: "grid",
          gap: 12,
        }}
      >
      <div style={{ display: "grid", gap: 10 }}>
        <strong>Events</strong>
        {displayEvents.length === 0 ? (
          <div style={{ color: "#94a3b8" }}>No events in this window range.</div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {displayEvents.map((eventItem) => {
              const relativeTime = Math.max(0, eventItem.timeline_seconds - clip.start_seconds);
              const isEventActive = Math.abs(clipTime - relativeTime) < 0.4;
              return (
                <button
                  key={eventItem.id}
                  type="button"
                  onClick={() => handleSeekToEvent(eventItem.source)}
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
                    {formatTime(relativeTime)}
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
              const relativeStart = Math.max(0, segment.start - clip.start_seconds);
              const relativeEnd = Math.max(relativeStart, segment.end - clip.start_seconds);
              const isSegmentActive = clipTime >= relativeStart && clipTime <= relativeEnd;
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
                    {formatTime(relativeStart)} - {formatTime(relativeEnd)}
                  </span>
                  <span>{stripTranscriptTimestamp(segment.text)}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

export default function WindowsEventsPage() {
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
  const [clipIngest, setClipIngest] = useState<Record<number, ClipIngestState>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [searchWindows, setSearchWindows] = useState(true);
  const [searchEvents, setSearchEvents] = useState(true);
  const [searchTranscripts, setSearchTranscripts] = useState(true);
  const [enabledEventTypes, setEnabledEventTypes] = useState<string[]>([...EVENT_TYPE_PRESET]);
  const [detailsMaxWidth, setDetailsMaxWidth] = useState(420);
                                                                                                                 
  const { url: videoUrl, warning: videoWarning } = useMemo(() => buildFileUrl(videoPath), [videoPath]);          
  const serverHint = API_BASE || "http://localhost:8001";                                                        
                                                                                                                 
  const timelineDuration = useMemo(
    () => metadata?.video.duration ?? getTimelineDuration(metadata),
    [metadata],
  );
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
    const creationTime = metadata?.video.creation_time ?? null;
    const duration = metadata?.video.duration ?? null;
    if (creationTime) {
      const startMs = Date.parse(creationTime);
      if (Number.isFinite(startMs)) {
        const endMs = duration != null ? startMs + duration * 1000 : null;
        return {
          first: startMs,
          last: endMs != null && Number.isFinite(endMs) ? endMs : null,
        };
      }
    }
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
      const monoWall = monoBaseMs != null && Number.isFinite(event.ts_mono_ms) ? monoBaseMs + event.ts_mono_ms : event.ts_wall_ms;
      const timelineSeconds = origin != null ? (monoWall - origin) / 1000 : 0;                                   
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
  }, [events, timelineOriginMs, monoBaseMs]);

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
      while (clipIndex < sortedClips.length && timelineSeconds >= sortedClips[clipIndex].end_seconds) {
        clipIndex += 1;
      }
      if (clipIndex >= sortedClips.length) {
        break;
      }
      const clip = sortedClips[clipIndex];
      if (timelineSeconds >= clip.start_seconds && timelineSeconds < clip.end_seconds) {
        map.get(clip.id)?.push(event);
      }
    }                                                                                                            
    return map;                                                                                                  
  }, [clips, filteredEvents]);                                                                                   

  const updateClipIngest = useCallback((clipId: number, next: Partial<ClipIngestState>) => {
    setClipIngest((prev) => {
      const current = prev[clipId] ?? { phase: "idle", progress: null, error: null };
      return { ...prev, [clipId]: { ...current, ...next } };
    });
  }, []);

  const startClipIngest = useCallback(
    async (clip: Clip) => {
      if (!videoPath.trim()) {
        return;
      }
      updateClipIngest(clip.id, { phase: "starting", progress: null, error: null });
      try {
        const res = await fetch("/api/mkv_ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            videoPath,
            clipStart: clip.start_seconds,
            clipEnd: clip.end_seconds,
            fast: true,
            maxFps: 1,
            skipMetadata: true,
            noTranscribe: true,
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
                    updateClipIngest(clip.id, { progress: { done, total, kept: null, phase: "extract" } });
                  }
                }
                const progressMatch = line.match(/frames:\s*(\d+)\s*\/\s*(\d+)(?:\s+kept=(\d+))?/i);
                if (progressMatch) {
                  const done = Number(progressMatch[1]);
                  const total = Number(progressMatch[2]);
                  const kept = progressMatch[3] ? Number(progressMatch[3]) : null;
                  if (Number.isFinite(done) && Number.isFinite(total) && total > 0) {
                    updateClipIngest(clip.id, { progress: { done, total, kept: kept ?? null, phase: "process" } });
                  }
                }
              }
            } else if (eventType === "stage") {
              const stage = payload?.stage as IngestPhase | undefined;
              if (stage) {
                updateClipIngest(clip.id, { phase: stage });
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
        updateClipIngest(clip.id, { phase: "done" });
      } catch (err) {
        updateClipIngest(clip.id, {
          phase: "error",
          error: err instanceof Error ? err.message : "Ingest failed",
        });
      }
    },
    [updateClipIngest, videoPath],
  );
                                                                                                                 
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
  }, [selectedSessionId, enabledEventTypes]);
                                                                                                
                                                                                                                 
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
          <h1 style={{ fontSize: 32, margin: 0 }}>Windows App Clips (MKV)</h1>                                   
          <p style={{ margin: 0, color: "#94a3b8" }}>                                                            
            Scroll through independent window clips, with per-clip playback and transcript slices.              
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

                                                                                                                 
        <section style={{ background: "#0f172a", color: "#f8fafc", padding: 16, borderRadius: 8, display: "grid", gap: 12 }}>
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
                                                                                                                 
        <section style={{ display: "grid", gap: 16 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
            <h2 style={{ margin: 0 }}>Window clips</h2>
            <span style={{ color: "#94a3b8" }}>{filteredClips.length} clips</span>
            <span style={{ color: "#94a3b8" }}>{filteredEvents.length} events</span>
            {loadingEvents && <span style={{ color: "#94a3b8" }}>Loading events...</span>}
            {eventError && <span style={{ color: "#fca5a5" }}>{eventError}</span>}
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto", color: "#94a3b8" }}>
              <span>Details width</span>
              <input
                type="range"
                min={280}
                max={640}
                step={20}
                value={detailsMaxWidth}
                onChange={(e) => setDetailsMaxWidth(Number(e.target.value || "420"))}
                style={{ accentColor: "#38bdf8" }}
              />
              <span style={{ minWidth: 48 }}>{detailsMaxWidth}px</span>
            </label>
          </div>
          {filteredClips.length === 0 ? (
            <div style={{ color: "#94a3b8" }}>No window clips match this search.</div>
          ) : (
            <div style={{ display: "grid", gap: 16 }}>
              {filteredClips.map((clip) => {
                const eventsForClip = clipEventsMap.get(clip.id) ?? [];
                const transcriptForClip = clipTranscriptMap.get(clip.id) ?? [];
                return (
                  <ClipCard
                    key={clip.id}
                    clip={clip}
                    videoUrl={videoUrl}
                    serverHint={serverHint}
                    transcriptSegments={timelineSegments}
                    transcriptForClip={transcriptForClip}
                    eventsForClip={eventsForClip}
                    ingestState={clipIngest[clip.id] ?? null}
                    onIngestFrames={startClipIngest}
                    detailsMaxWidth={detailsMaxWidth}
                  />
                );
              })}
            </div>
          )}
        </section>
      </div>                                                                                                     
    </main>                                                                                                      
  );                                                                                                             
}   
