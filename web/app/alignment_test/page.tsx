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
  timeline_seconds: number;                                                                                       
  mono_wall_ms: number | null;                                                                                    
  description: string;                                                                                            
  wall_iso: string;                                                                                               
  payload_preview: string | null;                                                                                 
  mouse_preview: string | null;                                                                                   
};                                                                                                                
                                                                                                                  
type SyncPoint = {                                                                                                
  id: string;                                                                                                     
  event_id: number;                                                                                               
  label: string;                                                                                                  
  event_time: number;                                                                                             
  video_time: number;                                                                                             
  offset: number;                                                                                                 
};                                                                                                                
                                                                                                                  
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
                                                                                                                  
function formatPayloadPreview(payload: string | null): string | null {                                            
  if (!payload) {                                                                                                 
    return null;                                                                                                  
  }                                                                                                               
  const parsed = safeJsonParse(payload);                                                                          
  if (parsed && typeof parsed === "object") {                                                                     
    return clipText(JSON.stringify(parsed));                                                                      
  }                                                                                                               
  return clipText(String(payload));                                                                               
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
                                                                                                                  
function formatTime(seconds: number): string {                                                                    
  if (!Number.isFinite(seconds)) {                                                                                
    return "--:--";                                                                                               
  }                                                                                                               
  const total = Math.max(0, seconds);                                                                             
  const hours = Math.floor(total / 3600);                                                                         
  const mins = Math.floor((total % 3600) / 60);                                                                   
  const secs = Math.floor(total % 60);                                                                            
  if (hours > 0) {                                                                                                
    return `${hours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2,
 "0")}`;                                                                                                          
  }                                                                                                               
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;                               
}                                                                                                                 
                                                                                                                  
function formatSignedTime(seconds: number): string {                                                              
  if (!Number.isFinite(seconds)) {                                                                                
    return "--:--";                                                                                               
  }                                                                                                               
  const sign = seconds < 0 ? "-" : "";                                                                            
  return `${sign}${formatTime(Math.abs(seconds))}`;                                                               
}                                                                                                                 
                                                                                                                  
function parseOptionalMs(input: string): number | null {                                                          
  const trimmed = input.trim();                                                                                   
  if (!trimmed) {                                                                                                 
    return null;                                                                                                  
  }                                                                                                               
  if (/^\d+$/.test(trimmed)) {                                                                                    
    const value = Number(trimmed);                                                                                
    return Number.isFinite(value) ? value : null;                                                                 
  }                                                                                                               
  const parsed = Date.parse(trimmed);                                                                             
  return Number.isFinite(parsed) ? parsed : null;                                                                 
}                                                                                                                 
                                                                                                                  
export default function AlignmentTestPage() {                                                                     
  const videoRef = useRef<HTMLVideoElement>(null);                                                                
  const [sessions, setSessions] = useState<TimestoneSession[]>([]);                                               
  const [selectedSessionId, setSelectedSessionId] = useState("");                                                 
  const [events, setEvents] = useState<TimestoneEvent[]>([]);                                                     
  const [loadingSessions, setLoadingSessions] = useState(false);                                                  
  const [loadingEvents, setLoadingEvents] = useState(false);                                                      
  const [sessionError, setSessionError] = useState<string | null>(null);                                          
  const [eventError, setEventError] = useState<string | null>(null);                                              
                                                                                                                  
  const [videoInput, setVideoInput] = useState("");                                                               
  const [videoPath, setVideoPath] = useState("");                                                                 
  const [videoWarning, setVideoWarning] = useState<string | null>(null);                                          
  const [videoError, setVideoError] = useState<string | null>(null);                                              
  const [videoStartOverride, setVideoStartOverride] = useState("");                                               
  const [originMode, setOriginMode] = useState<"video" | "session" | "first_event">("video");                     
  const [offsetSeconds, setOffsetSeconds] = useState(0);                                                          
  const [currentTime, setCurrentTime] = useState(0);                                                              
  const [videoDuration, setVideoDuration] = useState<number | null>(null);                                        
  const [isPlaying, setIsPlaying] = useState(false);                                                              
  const [selectedEventId, setSelectedEventId] = useState<number | null>(null);                                    
  const [syncPoints, setSyncPoints] = useState<SyncPoint[]>([]);                                                  
                                                                                                                  
  const selectedSession = useMemo(                                                                                
    () => sessions.find((session) => session.session_id === selectedSessionId) ?? null,                           
    [sessions, selectedSessionId],                                                                                
  );                                                                                                              
                                                                                                                  
  const { url: videoUrl, warning: fileWarning } = useMemo(() => buildFileUrl(videoPath), [videoPath]);            
                                                                                                                  
  useEffect(() => {                                                                                               
    setVideoWarning(fileWarning);                                                                                 
  }, [fileWarning]);                                                                                              
                                                                                                                  
  const refreshSessions = useCallback(async () => {                                                               
    setLoadingSessions(true);                                                                                     
    setSessionError(null);                                                                                        
    try {                                                                                                         
      const response = await fetch("/api/timestone_sessions", { method: "POST" });                                
      const payload = await response.json();                                                                      
      if (!response.ok) {                                                                                         
        throw new Error(payload?.error || "Failed to load sessions");                                             
      }                                                                                                           
      setSessions(Array.isArray(payload.sessions) ? payload.sessions : []);                                       
    } catch (err) {                                                                                               
      setSessionError(err instanceof Error ? err.message : "Failed to load sessions");                            
    } finally {                                                                                                   
      setLoadingSessions(false);                                                                                  
    }                                                                                                             
  }, []);                                                                                                         
                                                                                                                  
  useEffect(() => {                                                                                               
    refreshSessions();                                                                                            
  }, [refreshSessions]);                                                                                          
                                                                                                                  
  const loadEvents = useCallback(async (sessionId: string) => {                                                   
    setLoadingEvents(true);                                                                                       
    setEventError(null);                                                                                          
    try {                                                                                                         
      const response = await fetch("/api/timestone_events", {                                                     
        method: "POST",                                                                                           
        headers: { "Content-Type": "application/json" },                                                          
        body: JSON.stringify({ sessionId }),                                                                      
      });                                                                                                         
      const payload = await response.json();                                                                      
      if (!response.ok) {                                                                                         
        throw new Error(payload?.error || "Failed to load events");                                               
      }                                                                                                           
      setEvents(Array.isArray(payload.events) ? payload.events : []);                                             
    } catch (err) {                                                                                               
      setEventError(err instanceof Error ? err.message : "Failed to load events");                                
      setEvents([]);                                                                                              
    } finally {                                                                                                   
      setLoadingEvents(false);                                                                                    
    }                                                                                                             
  }, []);                                                                                                         
                                                                                                                  
  useEffect(() => {                                                                                               
    if (!selectedSessionId) {                                                                                     
      setEvents([]);                                                                                              
      return;                                                                                                     
    }                                                                                                             
    loadEvents(selectedSessionId);                                                                                
  }, [selectedSessionId, loadEvents]);                                                                            
                                                                                                                  
  const videoStartOverrideMs = useMemo(() => parseOptionalMs(videoStartOverride), [videoStartOverride]);          
  const videoStartWallMs = useMemo(() => videoStartOverrideMs ?? parseObsStartMs(videoPath), [videoStartOverrideMs
, videoPath]);                                                                                                    
                                                                                                                  
  const originMs = useMemo(() => {                                                                                
    if (originMode === "video" && videoStartWallMs != null) {                                                     
      return videoStartWallMs;                                                                                    
    }                                                                                                             
    if (originMode === "session" && selectedSession?.start_wall_ms) {                                             
      return selectedSession.start_wall_ms;                                                                       
    }                                                                                                             
    if (originMode === "first_event" && events.length > 0) {                                                      
      return events[0].ts_wall_ms;                                                                                
    }                                                                                                             
    if (videoStartWallMs != null) {                                                                               
      return videoStartWallMs;                                                                                    
    }                                                                                                             
    if (selectedSession?.start_wall_ms) {                                                                         
      return selectedSession.start_wall_ms;                                                                       
    }                                                                                                             
    if (events.length > 0) {                                                                                      
      return events[0].ts_wall_ms;                                                                                
    }                                                                                                             
    return null;                                                                                                  
  }, [originMode, videoStartWallMs, selectedSession, events]);                                                    
                                                                                                                  
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
    return events.map((event) => {                                                                                
      const monoWall = monoBaseMs != null && Number.isFinite(event.ts_mono_ms) ? monoBaseMs + event.ts_mono_ms : e
vent.ts_wall_ms;                                                                                                  
      const timelineSeconds = originMs != null ? (monoWall - originMs) / 1000 : 0;                                
      const description = describeEvent(event);                                                                   
      return {                                                                                                    
        ...event,                                                                                                 
        timeline_seconds: timelineSeconds,                                                                        
        mono_wall_ms: monoBaseMs != null ? monoWall : null,                                                       
        description,                                                                                              
        wall_iso: Number.isFinite(event.ts_wall_ms) ? new Date(event.ts_wall_ms).toISOString() : "--",            
        payload_preview: formatPayloadPreview(event.payload),                                                     
        mouse_preview: formatPayloadPreview(event.mouse),                                                         
      };                                                                                                          
    });                                                                                                           
  }, [events, originMs, monoBaseMs]);                                                                             
                                                                                                                  
  const selectedEvent = useMemo(                                                                                  
    () => eventsWithTimeline.find((event) => event.id === selectedEventId) ?? null,                               
    [eventsWithTimeline, selectedEventId],                                                                        
  );                                                                                                              
                                                                                                                  
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
                                                                                                                  
  const handleSeekToEvent = useCallback(                                                                          
    (event: EventView) => {                                                                                       
      const video = videoRef.current;                                                                             
      if (!video) {                                                                                               
        return;                                                                                                   
      }                                                                                                           
      const target = event.timeline_seconds + offsetSeconds;                                                      
      const clamped = Math.max(0, target);                                                                        
      video.currentTime = clamped;                                                                                
    },                                                                                                            
    [offsetSeconds],                                                                                              
  );                                                                                                              
                                                                                                                  
  const handleSyncSelected = useCallback(() => {                                                                  
    if (!selectedEvent || !videoRef.current) {                                                                    
      return;                                                                                                     
    }                                                                                                             
    const videoTime = videoRef.current.currentTime;
    const offset = videoTime - selectedEvent.timeline_seconds;                                                    
    setOffsetSeconds(offset);                                                                                     
    setSyncPoints((prev) => [                                                                                     
      {                                                                                                           
        id: `${selectedEvent.id}-${Date.now()}`,                                                                  
        event_id: selectedEvent.id,                                                                               
        label: `${selectedEvent.event_type} @ ${formatSignedTime(selectedEvent.timeline_seconds)}`,               
        event_time: selectedEvent.timeline_seconds,                                                               
        video_time: videoTime,                                                                                    
        offset,                                                                                                   
      },                                                                                                          
      ...prev,                                                                                                    
    ]);                                                                                                           
  }, [selectedEvent]);                                                                                            
                                                                                                                  
  const handleApplySyncPoint = useCallback((point: SyncPoint) => {                                                
    setOffsetSeconds(point.offset);                                                                               
  }, []);                                                                                                         
                                                                                                                  
  const formattedCurrentTime = useMemo(() => formatTime(currentTime), [currentTime]);                             
  const formattedDuration = useMemo(() => formatTime(videoDuration ?? 0), [videoDuration]);                       
  const offsetPreview = useMemo(() => (Number.isFinite(offsetSeconds) ? offsetSeconds : 0), [offsetSeconds]);     
                                                                                                                  
  return (                                                                                                        
    <main                                                                                                         
      style={{                                                                                                    
        minHeight: "100vh",                                                                                       
        background: "linear-gradient(180deg, #070b16 0%, #0a1224 40%, #0b1120 100%)",                             
        color: "#e2e8f0",                                                                                         
        padding: "32px 24px 80px",                                                                                
        fontFamily: '"Space Grotesk", "Segoe UI", system-ui',                                                     
      }}                                                                                                          
    >                                                                                                             
      <div style={{ maxWidth: 1280, margin: "0 auto", display: "grid", gap: 24 }}>                                
        <header style={{ display: "grid", gap: 8 }}>                                                              
          <h1 style={{ fontSize: 32, margin: 0 }}>Timestone Alignment Test</h1>                                   
          <p style={{ margin: 0, color: "#94a3b8" }}>                                                             
            Use this page to compare raw timestone events against a single MKV file and capture offsets for alignm
ent.                                                                                                              
          </p>                                                                                                    
        </header>                                                                                                 
                                                                                                                  
        <section                                                                                                  
          style={{                                                                                                
            background: "rgba(15, 23, 42, 0.7)",                                                                  
            borderRadius: 14,                                                                                     
            padding: 20,                                                                                          
            display: "grid",                                                                                      
            gap: 16,                                                                                              
            border: "1px solid rgba(30, 41, 59, 0.8)",                                                            
          }}                                                                                                      
        >                                                                                                         
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>                      
            <label style={{ display: "grid", gap: 6, minWidth: 240, flex: "1 1 240px" }}>                         
              <span style={{ color: "#cbd5f5" }}>Timestone session</span>                                         
              <select                                                                                             
                value={selectedSessionId}                                                                         
                onChange={(e) => setSelectedSessionId(e.target.value)}
                style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #1e293b", background: "#0b1120",
 color: "#e2e8f0" }}                                                                                              
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
                background: selectedSession?.obs_video_path ? "rgba(56, 189, 248, 0.18)" : "rgba(15, 23, 42, 0.6)"
,                                                                                                                 
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
                                                                                                                  
          <div style={{ display: "grid", gap: 12 }}>                                                              
            <label style={{ display: "grid", gap: 6 }}>                                                           
              <span style={{ color: "#cbd5f5" }}>Video path (absolute or project-relative)</span>                 
              <input                                                                                              
                value={videoInput}                                                                                
                onChange={(e) => setVideoInput(e.target.value)}                                                   
                placeholder="C:\\path\\to\\video.mkv"                                                             
                style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #1e293b", background: "#0b1120",
 color: "#e2e8f0" }}                                                                                              
              />                                                                                                  
            </label>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>                    
              <button                                                                                             
                type="button"                                                                                     
                onClick={() => setVideoPath(videoInput.trim())}                                                   
                style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #1e293b", background: "#0f172a",
 color: "#e2e8f0" }}                                                                                              
              >                                                                                                   
                Load video                                                                                        
              </button>                                                                                           
              {videoWarning && <span style={{ color: "#fca5a5" }}>{videoWarning}</span>}                          
            </div>                                                                                                
          </div>                                                                                                  
                                                                                                                  
          <div style={{ display: "grid", gap: 12 }}>                                                              
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center" }}>                    
              <label style={{ display: "grid", gap: 6 }}>                                                         
                <span style={{ color: "#cbd5f5" }}>Timeline origin</span>                                         
                <select                                                                                           
                  value={originMode}                                                                              
                  onChange={(e) => setOriginMode(e.target.value as "video" | "session" | "first_event")}          
                  style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #1e293b", background: "#0b1120
", color: "#e2e8f0" }}                                                                                            
                >                                                                                                 
                  <option value="video">Video start</option>                                                      
                  <option value="session">Session start</option>                                                  
                  <option value="first_event">First event</option>                                                
                </select>                                                                                         
              </label>                                                                                            
              <label style={{ display: "grid", gap: 6, minWidth: 240 }}>                                          
                <span style={{ color: "#cbd5f5" }}>Video start override (ms or ISO)</span>                        
                <input                                                                                            
                  value={videoStartOverride}                                                                      
                  onChange={(e) => setVideoStartOverride(e.target.value)}                                         
                  placeholder="2026-01-05T00:36:35 or 1767579736494"                                              
                  style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #1e293b", background: "#0b1120
", color: "#e2e8f0" }}                                                                                            
                />                                                                                                
              </label>                                                                                            
              <label style={{ display: "grid", gap: 6 }}>                                                         
                <span style={{ color: "#cbd5f5" }}>Offset seconds</span>
                <input                                                                                            
                  type="number"                                                                                   
                  step="0.01"                                                                                     
                  value={Number.isFinite(offsetSeconds) ? offsetSeconds : 0}                                      
                  onChange={(e) => setOffsetSeconds(Number(e.target.value || "0"))}                               
                  style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #1e293b", background: "#0b1120
", color: "#e2e8f0", width: 140 }}                                                                                
                />                                                                                                
              </label>                                                                                            
              <button                                                                                             
                type="button"                                                                                     
                onClick={handleSyncSelected}                                                                      
                disabled={!selectedEvent || !videoUrl}                                                            
                style={{                                                                                          
                  padding: "8px 12px",                                                                            
                  borderRadius: 8,                                                                                
                  border: "1px solid",                                                                            
                  borderColor: selectedEvent ? "#38bdf8" : "#1e293b",                                             
                  background: selectedEvent ? "rgba(56, 189, 248, 0.18)" : "rgba(15, 23, 42, 0.6)",               
                  color: selectedEvent ? "#e0f2fe" : "#64748b",                                                   
                  cursor: selectedEvent ? "pointer" : "not-allowed",                                              
                }}                                                                                                
              >                                                                                                   
                Sync selected event to current video time                                                         
              </button>                                                                                           
              <button                                                                                             
                type="button"                                                                                     
                onClick={() => setSyncPoints([])}                                                                 
                style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #1e293b", background: "#0f172a",
 color: "#e2e8f0" }}                                                                                              
              >                                                                                                   
                Clear sync points                                                                                 
              </button>                                                                                           
            </div>                                                                                                
                                                                                                                  
            <div style={{ display: "flex", flexWrap: "wrap", gap: 18, color: "#94a3b8", fontSize: 13 }}>          
              <span>Video start: {videoStartWallMs ? `${videoStartWallMs} (${new Date(videoStartWallMs).toISOStrin
g()})` : "n/a"}</span>                                                                                            
              <span>Origin: {originMs ? `${originMs} (${new Date(originMs).toISOString()})` : "n/a"}</span>       
              <span>Mono base: {monoBaseMs != null ? monoBaseMs : "n/a"}</span>                                   
              <span>Current offset: {offsetPreview.toFixed(2)}s</span>
            </div>                                                                                                
          </div>                                                                                                  
        </section>                                                                                                
                                                                                                                  
        <section style={{ display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}
>                                                                                                                 
          <div style={{ display: "grid", gap: 12 }}>                                                              
            <div                                                                                                  
              style={{                                                                                            
                position: "relative",                                                                             
                background: "#111",                                                                               
                minHeight: 240,                                                                                   
                height: "min(55vh, 460px)",                                                                       
                borderRadius: 12,                                                                                 
                overflow: "hidden",                                                                               
                border: "1px solid #1e293b",                                                                      
              }}                                                                                                  
            >                                                                                                     
              {videoUrl ? (                                                                                       
                <>                                                                                                
                  <video                                                                                          
                    ref={videoRef}                                                                                
                    src={videoUrl}                                                                                
                    style={{ width: "100%", height: "100%", objectFit: "contain", background: "#0f172a" }}        
                    preload="metadata"                                                                            
                    onError={() => setVideoError(`Video failed to load. Ensure the server at ${API_BASE} can acces
s this file.`)}                                                                                                   
                    onLoadedData={() => setVideoError(null)}                                                      
                    onLoadedMetadata={handleLoadedMetadata}                                                       
                    onTimeUpdate={handleTimeUpdate}                                                               
                    onPlay={() => setIsPlaying(true)}                                                             
                    onPause={() => setIsPlaying(false)}                                                           
                    playsInline                                                                                   
                  />                                                                                              
                  <div                                                                                            
                    style={{                                                                                      
                      position: "absolute",                                                                       
                      left: 0,                                                                                    
                      right: 0,                                                                                   
                      bottom: 0,                                                                                  
                      padding: "12px 16px",                                                                       
                      background: "linear-gradient(0deg, rgba(15, 23, 42, 0.85) 0%, rgba(15, 23, 42, 0) 100%)",   
                      display: "grid",
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
                        {isPlaying ? "||" : ">"}
                      </button>                                                                                   
                      <button                                                                                     
                        type="button"                                                                             
                        onClick={handleRestart}                                                                   
                        aria-label="Restart"                                                                      
                        title="Restart"                                                                           
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
                        R
                      </button>                                                                                   
                      <span style={{ color: "#e2e8f0", fontVariantNumeric: "tabular-nums" }}>                     
                        {formattedCurrentTime} / {formattedDuration}                                              
                      </span>                                                                                     
                    </div>                                                                                        
                    <input                                                                                        
                      type="range"                                                                                
                      min={0}                                                                                     
                      max={videoDuration ?? 0}                                                                    
                      step={0.05}                                                                                 
                      value={currentTime}                                                                         
                      onChange={handleSliderChange}                                                               
                      style={{ width: "100%", accentColor: "#38bdf8" }}                                           
                      disabled={!videoDuration}                                                                   
                    />                                                                                            
                  </div>                                                                                          
                </>                                                                                               
              ) : (                                                                                               
                <div style={{ padding: 32, color: "#94a3b8" }}>Load a video to start alignment.</div>             
              )}                                                                                                  
            </div>                                                                                                
            {videoError && <div style={{ color: "#fca5a5" }}>{videoError}</div>}                                  
                                                                                                                  
            <div style={{ display: "grid", gap: 8, background: "#0f172a", color: "#f8fafc", padding: 16, borderRad
ius: 8 }}>                                                                                                        
              <strong>Alignment readout</strong>                                                                  
              <div>Current video time: {currentTime.toFixed(2)}s</div>                                            
              {selectedEvent ? (                                                                                  
                <div style={{ display: "grid", gap: 6 }}>                                                         
                  <div>Selected event: {selectedEvent.event_type}</div>                                           
                  <div>Event time: {selectedEvent.timeline_seconds.toFixed(2)}s</div>                             
                  <div>Adjusted time: {(selectedEvent.timeline_seconds + offsetSeconds).toFixed(2)}s</div>        
                  <div>Offset needed: {(currentTime - selectedEvent.timeline_seconds).toFixed(2)}s</div>          
                </div>                                                                                            
              ) : (                                                                                               
                <div style={{ color: "#94a3b8" }}>Select an event on the right to compare.</div>                  
              )}                                                                                                  
            </div>                                                                                                
                                                                                                                  
            {syncPoints.length > 0 && (                                                                           
              <div style={{ display: "grid", gap: 10, background: "#0b1120", borderRadius: 10, padding: 12, border
: "1px solid #1e293b" }}>                                                                                         
                <strong>Captured sync points</strong>                                                             
                {syncPoints.map((point) => (                                                                      
                  <button                                                                                         
                    key={point.id}                                                                                
                    type="button"                                                                                 
                    onClick={() => handleApplySyncPoint(point)}
                    style={{                                                                                      
                      display: "grid",                                                                            
                      gap: 4,                                                                                     
                      padding: "8px 10px",                                                                        
                      borderRadius: 8,                                                                            
                      border: "1px solid #1e293b",                                                                
                      background: "rgba(15, 23, 42, 0.65)",                                                       
                      color: "#e2e8f0",                                                                           
                      textAlign: "left",                                                                          
                      cursor: "pointer",                                                                          
                    }}                                                                                            
                  >                                                                                               
                    <span style={{ fontSize: 13, color: "#94a3b8" }}>{point.label}</span>                         
                    <span style={{ fontSize: 13 }}>
                      event {point.event_time.toFixed(2)}s -> video {point.video_time.toFixed(2)}s (offset {point.offset.toFixed(2)}s)
                    </span>
                  </button>                                                                                       
                ))}                                                                                               
              </div>                                                                                              
            )}                                                                                                    
          </div>                                                                                                  
                                                                                                                  
          <div style={{ display: "grid", gap: 12 }}>                                                              
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>                    
              <h2 style={{ margin: 0 }}>Session events</h2>                                                       
              <span style={{ color: "#94a3b8" }}>{eventsWithTimeline.length} events</span>                        
              {loadingEvents && <span style={{ color: "#94a3b8" }}>Loading events...</span>}                      
              {eventError && <span style={{ color: "#fca5a5" }}>{eventError}</span>}                              
            </div>                                                                                                
            <div style={{ maxHeight: "70vh", overflowY: "auto", border: "1px solid #1e293b", borderRadius: 10 }}> 
              {eventsWithTimeline.length === 0 && !loadingEvents ? (                                              
                <div style={{ padding: 16, color: "#94a3b8" }}>No events loaded yet.</div>                        
              ) : (                                                                                               
                eventsWithTimeline.map((event) => {                                                               
                  const adjusted = event.timeline_seconds + offsetSeconds;                                        
                  const isSelected = selectedEventId === event.id;                                                
                  return (                                                                                        
                    <button                                                                                       
                      key={event.id}                                                                              
                      type="button"                                                                               
                      onClick={() => {                                                                            
                        setSelectedEventId(event.id);                                                             
                        handleSeekToEvent(event);                                                                 
                      }}                                                                                          
                      style={{                                                                                    
                        display: "grid",                                                                          
                        gridTemplateColumns: "100px 1fr",                                                         
                        gap: 12,                                                                                  
                        width: "100%",                                                                            
                        textAlign: "left",                                                                        
                        padding: "10px 14px",                                                                     
                        background: isSelected ? "rgba(56, 189, 248, 0.18)" : "transparent",                      
                        color: "#e2e8f0",                                                                         
                        border: "none",                                                                           
                        borderBottom: "1px solid #1e293b",                                                        
                        cursor: "pointer",                                                                        
                      }}                                                                                          
                    >                                                                                             
                      <div style={{ display: "grid", gap: 6 }}>                                                   
                        <span style={{ fontVariantNumeric: "tabular-nums", color: "#cbd5f5" }}>{formatSignedTime(a
djusted)}</span>                                                                                                  
                        <span style={{ fontSize: 12, color: "#64748b" }}>{formatSignedTime(event.timeline_seconds)
}</span>                                                                                                          
                      </div>                                                                                      
                      <div style={{ display: "grid", gap: 4 }}>                                                   
                        <span style={{ fontWeight: 600, textTransform: "capitalize" }}>{event.event_type.replace(/
_/g, " ")}</span>                                                                                                 
                        <span>{event.description}</span>                                                          
                        {event.payload_preview && <span style={{ color: "#94a3b8", fontSize: 12 }}>Payload: {event
.payload_preview}</span>}                                                                                         
                        {event.mouse_preview && <span style={{ color: "#94a3b8", fontSize: 12 }}>Mouse: {event.mou
se_preview}</span>}                                                                                               
                        <span style={{ color: "#64748b", fontSize: 12 }}>                                         
                          wall {event.wall_iso} | id {event.id}                                                   
                        </span>                                                                                   
                      </div>                                                                                      
                    </button>                                                                                     
                  );                                                                                              
                })                                                                                                
              )}                                                                                                  
            </div>                                                                                                
          </div>                                                                                                  
        </section>                                                                                                
      </div>                                                                                                      
    </main>                                                                                                       
  );                                                                                                              
}                                                                                                                 
                       
