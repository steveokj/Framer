"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Segment = {
  id: number;
  start: number;
  end: number;
  text: string;
};

type ClipTranscriptSegment = {
  id: number;
  start: number;
  end: number;
  text: string;
  trimmedStart: boolean;
  trimmedEnd: boolean;
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

type Metadata = {
  video: {
    path: string;
    frame_count: number;
    first_timestamp: string;
    last_timestamp: string;
  };
  audio: {
    path: string;
    session_id: number | null;
    start_timestamp: string;
    end_timestamp: string;
    duration_seconds: number;
  };
  alignment: {
    origin_timestamp: string;
    timeline_end_timestamp: string;
    audio_offset_seconds: number;
    audio_lead_seconds: number;
    audio_delay_seconds: number;
  };
  frames: {
    offset_index: number;
    timestamp: string;
    seconds_from_video_start: number;
  }[];
};

type WindowClipsResponse = {
  first_timestamp: string | null;
  last_timestamp: string | null;
  clips: Array<{
    window_name: string;
    start_seconds: number;
    end_seconds: number;
    start_timestamp: string;
    end_timestamp: string;
    start_offset_index: number;
    end_offset_index: number;
    frame_count: number;
  }>;
};

const DEFAULT_VIDEO = "C:\\Users\\steve\\.screenpipe\\data\\monitor_52305895_2025-10-12_02-13-01.mp4";
const DEFAULT_AUDIO = "C:\\Users\\steve\\Desktop\\Whisper\\sessions\\session-20251011-221322.wav";
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
    const normalised = normalisePath(trimmed);
    const absoluteUrl = `${API_BASE}/files_abs?path=${encodeURIComponent(normalised)}`;
    return { url: absoluteUrl, warning: null };
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

function formatOffset(offset: number): string {
  const abs = Math.abs(offset).toFixed(2);
  if (offset > 0) {
    return `+${abs}s`;
  }
  if (offset < 0) {
    return `-${abs}s`;
  }
  return "0.00s";
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

export default function WindowsPage() {
  const [videoInput, setVideoInput] = useState(DEFAULT_VIDEO);
  const [audioInput, setAudioInput] = useState(DEFAULT_AUDIO);
  const [videoPath, setVideoPath] = useState(DEFAULT_VIDEO);
  const [audioPath, setAudioPath] = useState(DEFAULT_AUDIO);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [clips, setClips] = useState<Clip[]>([]);
  const [loadingClips, setLoadingClips] = useState(false);
  const [clipError, setClipError] = useState<string | null>(null);
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [loadingMetadata, setLoadingMetadata] = useState(false);
  const [manualOffset, setManualOffset] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [activeClipId, setActiveClipId] = useState<number | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [videoLoadError, setVideoLoadError] = useState<string | null>(null);
  const [audioLoadError, setAudioLoadError] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement>(null);
  const clipVideoRefs = useRef<Map<number, HTMLVideoElement>>(new Map());

  const { url: videoUrl, warning: videoWarning } = useMemo(() => buildFileUrl(videoPath), [videoPath]);
  const { url: audioUrl, warning: audioWarning } = useMemo(() => buildFileUrl(audioPath), [audioPath]);

  const audioOffset = metadata?.alignment.audio_offset_seconds ?? 0;
  const combinedOffset = audioOffset + manualOffset;
  const serverHint = API_BASE || "http://localhost:8001";
  const timelineDuration = useMemo(() => {
    if (!metadata || !metadata.frames.length) return null;
    return metadata.frames[metadata.frames.length - 1].seconds_from_video_start;
  }, [metadata]);
  const displayScale = useMemo(() => {
    if (!timelineDuration || videoDuration == null || !(videoDuration > 0)) {
      return 1;
    }
    return timelineDuration / videoDuration;
  }, [timelineDuration, videoDuration]);

  useEffect(() => {
    const fetchTranscript = async () => {
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
        if (err instanceof TypeError && err.message && err.message.toLowerCase().includes("fetch")) {
          setTranscriptError("Failed to reach transcription API. Restart the Next.js dev server and try again.");
        } else {
          setTranscriptError(err instanceof Error ? err.message : "Failed to load transcript");
        }
      } finally {
        setLoadingTranscript(false);
      }
    };
    fetchTranscript();
  }, [audioPath]);

  useEffect(() => {
    const fetchMetadata = async () => {
      if (!videoPath.trim() || !audioPath.trim()) {
        setMetadata(null);
        setMetadataError(null);
        return;
      }
      setLoadingMetadata(true);
      setMetadataError(null);
      try {
        const res = await fetch("/api/video_web_playback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videoPath, audioPath }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(payload.error || `Metadata request failed (status ${res.status})`);
        }
        const data: Metadata = await res.json();
        setMetadata(data);
      } catch (err) {
        setMetadata(null);
        setMetadataError(err instanceof Error ? err.message : "Failed to load metadata");
      } finally {
        setLoadingMetadata(false);
      }
    };
    fetchMetadata();
  }, [videoPath, audioPath]);

  useEffect(() => {
    const fetchClips = async () => {
      if (!videoPath.trim()) {
        setClips([]);
        setClipError(null);
        return;
      }
      setLoadingClips(true);
      setClipError(null);
      try {
        const res = await fetch("/api/windows_clips", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videoPath }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(payload.error || `Failed to load window clips (status ${res.status})`);
        }
        const data: WindowClipsResponse = await res.json();
        const mapped: Clip[] = data.clips.map((clip, idx) => ({
          id: idx,
          window_name: clip.window_name || "Unknown window",
          start_seconds: clip.start_seconds,
          end_seconds: clip.end_seconds,
          start_timestamp: clip.start_timestamp,
          end_timestamp: clip.end_timestamp,
          start_offset_index: clip.start_offset_index,
          end_offset_index: clip.end_offset_index,
          frame_count: clip.frame_count,
        }));
        setClips(mapped);
      } catch (err) {
        setClips([]);
        setClipError(err instanceof Error ? err.message : "Failed to load window clips");
      } finally {
        setLoadingClips(false);
      }
    };
    fetchClips();
  }, [videoPath]);

  useEffect(() => {
    if (!videoUrl) {
      setVideoLoadError(null);
    }
  }, [videoUrl]);

  useEffect(() => {
    const video = audioRef.current;
    if (!video) return;
    setAudioLoadError(null);
  }, [audioUrl]);

  const clipTranscriptMap = useMemo(() => {
    const map = new Map<number, ClipTranscriptSegment[]>();
    for (const clip of clips) {
      const segs = segments
        .filter((seg) => seg.end > clip.start_seconds && seg.start < clip.end_seconds)
        .map((seg) => {
          const clippedStart = Math.max(seg.start, clip.start_seconds);
          const clippedEnd = Math.min(seg.end, clip.end_seconds);
          const trimmedStart = clippedStart > seg.start + 0.01;
          const trimmedEnd = clippedEnd < seg.end - 0.01;
          const prefix = trimmedStart ? "..." : "";
          const suffix = trimmedEnd ? "..." : "";
          const baseText = (seg.text || '').trim();
          const displayText = prefix + baseText + suffix;

          return {
            id: seg.id,
            start: clippedStart,
            end: clippedEnd,
            text: displayText,
            trimmedStart,
            trimmedEnd,
          };
        });
      map.set(clip.id, segs);
    }
    return map;
  }, [clips, segments]);

  const pauseAll = useCallback((excludeId?: number, pauseAudio = true) => {
    clipVideoRefs.current.forEach((node, id) => {
      try {
        if (!node) return;
        if (excludeId != null && id === excludeId) return;
        node.pause();
      } catch {
        /* ignore */
      }
    });
    if (pauseAudio) {
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
      }
    }
  }, []);

  const syncClipMedia = useCallback(
    (clip: Clip, video: HTMLVideoElement, options?: { fromVideo?: boolean }) => {
      const audio = audioRef.current;
      if (!audio) return;
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : videoDuration;
      if (!duration || duration <= 0) {
        return;
      }
      if (timelineDuration && timelineDuration > 0) {
        const rate = duration / timelineDuration;
        video.playbackRate = rate > 0 ? rate : 1;
      } else {
        video.playbackRate = 1;
      }

      if (options?.fromVideo) {
        const timelineSeconds = mapVideoTimeToTimeline(video.currentTime, duration, metadata);
        const targetAudioTime = Math.max(0, timelineSeconds + combinedOffset);
        if (Math.abs(audio.currentTime - targetAudioTime) > 0.02) {
          audio.currentTime = targetAudioTime;
        }
        setCurrentTime(Math.max(0, audio.currentTime));
        return;
      }

      const timelineSeconds = Math.max(0, audio.currentTime - combinedOffset);
      const desiredVideo = mapTimelineToVideo(timelineSeconds, duration, metadata);
      if (Number.isFinite(desiredVideo) && Math.abs(video.currentTime - desiredVideo) > 0.03) {
        video.currentTime = desiredVideo;
      }
      setCurrentTime(Math.max(0, audio.currentTime));
      if (timelineSeconds >= clip.end_seconds - 0.05) {
        video.pause();
        audio.pause();
        setActiveClipId(null);
      }
    },
    [combinedOffset, metadata, timelineDuration, videoDuration],
  );

  const handleRestartClip = useCallback(
    (clip: Clip) => {
      const video = clipVideoRefs.current.get(clip.id);
      const audio = audioRef.current;
      if (!video || !audio) return;

      pauseAll();

      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : videoDuration;
      if (duration && duration > 0) {
        const videoTime = mapTimelineToVideo(clip.start_seconds, duration, metadata);
        video.currentTime = videoTime;
      }

      const targetAudioTime = Math.max(0, clip.start_seconds + combinedOffset);
      audio.currentTime = targetAudioTime;
      setCurrentTime(targetAudioTime);
      setActiveClipId(clip.id);

      video.defaultMuted = true;
      video.muted = true;
      syncClipMedia(clip, video);

      video
        .play()
        .catch(() => {
          /* ignore */
        });

      audio.muted = false;
      audio.playbackRate = 1;
      audio
        .play()
        .catch(() => {
          /* ignore */
        });
    },
    [combinedOffset, metadata, pauseAll, syncClipMedia, videoDuration],
  );

  const playClip = useCallback(
    (clip: Clip) => {
      const video = clipVideoRefs.current.get(clip.id);
      const audio = audioRef.current;
      if (!video || !audio) return;

      pauseAll();

      const currentTimeline = Math.max(0, audio.currentTime - combinedOffset);
      const inClipRange =
        activeClipId === clip.id &&
        currentTimeline >= clip.start_seconds &&
        currentTimeline <= clip.end_seconds;

      if (!inClipRange) {
        const targetAudioTime = Math.max(0, clip.start_seconds + combinedOffset);
        audio.currentTime = targetAudioTime;
        setCurrentTime(targetAudioTime);
        syncClipMedia(clip, video);
      } else {
        syncClipMedia(clip, video);
      }

      setActiveClipId(clip.id);
      video.defaultMuted = true;
      video.muted = true;
      video
        .play()
        .catch(() => {
          /* ignore */
        });

      audio.muted = false;
      audio.playbackRate = 1;
      audio
        .play()
        .catch(() => {
          /* ignore */
        });
    },
    [activeClipId, combinedOffset, pauseAll, syncClipMedia],
  );

  const pauseClip = useCallback((clip: Clip) => {
    pauseAll();
  }, [pauseAll]);

  const handleClipSeek = useCallback(
    (clip: Clip, timelineSeconds: number) => {
      const video = clipVideoRefs.current.get(clip.id);
      const audio = audioRef.current;
      if (!video || !audio) return;

      const clampedTimeline = Math.min(
        Math.max(timelineSeconds, clip.start_seconds),
        clip.end_seconds,
      );
      const targetAudioTime = Math.max(0, clampedTimeline + combinedOffset);
      const wasPlaying = !audio.paused;

      audio.currentTime = targetAudioTime;
      setCurrentTime(targetAudioTime);
      setActiveClipId(clip.id);
      syncClipMedia(clip, video);

      if (wasPlaying) {
        video
          .play()
          .catch(() => {
            /* ignore */
          });
        audio
          .play()
          .catch(() => {
            /* ignore */
          });
      }
    },
    [combinedOffset, syncClipMedia],
  );

  useEffect(() => {
    setCurrentTime(0);
    setActiveClipId(null);
    pauseAll();
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
    }
  }, [audioPath, videoPath, pauseAll]);

  useEffect(() => {
    setVideoDuration(null);
  }, [videoPath]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const updateCurrent = () => {
      setCurrentTime(Math.max(0, audio.currentTime));
      if (activeClipId != null) {
        const clip = clips.find((c) => c.id === activeClipId);
        if (clip) {
          const video = clipVideoRefs.current.get(clip.id);
          if (video) {
            syncClipMedia(clip, video);
          }
        }
      }
    };
    audio.addEventListener("timeupdate", updateCurrent);
    return () => {
      audio.removeEventListener("timeupdate", updateCurrent);
    };
  }, [activeClipId, clips, syncClipMedia]);

  useEffect(() => {
    clipVideoRefs.current.forEach((node) => {
      if (!node) return;
      if (!videoUrl) {
        node.removeAttribute("data-current-src");
        node.removeAttribute("src");
        node.load();
        return;
      }
      const current = node.getAttribute("data-current-src");
      if (current !== videoUrl) {
        node.setAttribute("data-current-src", videoUrl);
        node.src = videoUrl;
        node.load();
      }
    });
  }, [videoUrl]);

  const handleFormSubmit = (evt: React.FormEvent<HTMLFormElement>) => {
    evt.preventDefault();
    setVideoPath(videoInput.trim());
    setAudioPath(audioInput.trim());
  };

  const filteredCurrentClipTranscript: ClipTranscriptSegment[] =
    activeClipId != null ? clipTranscriptMap.get(activeClipId) ?? [] : [];
  const serverErrorMessage = useMemo(() => {
    if (!videoUrl && !audioUrl) {
      return "Provide both video and audio paths to begin.";
    }
    if (!videoUrl) {
      return "Provide a valid video path.";
    }
    if (!audioUrl) {
      return "Provide a valid audio path.";
    }
    return null;
  }, [videoUrl, audioUrl]);

  return (
    <main style={{ display: "grid", gap: 24, padding: 24 }}>
      <header>
        <h1>Window Clips</h1>
        <p style={{ color: "#607080" }}>
          Groups contiguous frames by recorded window title so you can jump between context clips while keeping the audio and transcript in sync.
        </p>
      </header>

      <section>
        <form onSubmit={handleFormSubmit} style={{ display: "grid", gap: 12, maxWidth: 640 }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span>Video path (absolute or project-relative)</span>
            <input
              type="text"
              value={videoInput}
              onChange={(e) => setVideoInput(e.target.value)}
              style={{ padding: "8px 10px" }}
            />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span>Audio path (absolute or project-relative)</span>
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

      <section style={{ background: "#0f172a", color: "#f8fafc", padding: 16, borderRadius: 8, display: "grid", gap: 12 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
          <strong>Alignment:</strong>
          {loadingMetadata && <span style={{ color: "#94a3b8" }}>Loading metadata...</span>}
          {metadataError && <span style={{ color: "#fca5a5" }}>{metadataError}</span>}
          {metadata && (
            <>
              <span>audioOffset = {formatOffset(metadata.alignment.audio_offset_seconds)}</span>
              <span>timelineScale = {displayScale.toFixed(3)}x</span>
              <span>manual = {manualOffset.toFixed(2)}s</span>
              <span>frames = {metadata.video.frame_count}</span>
            </>
          )}
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span>Manual audio offset (s)</span>
            <input
              type="number"
              value={manualOffset}
              onChange={(e) => {
                const val = Number(e.target.value);
                setManualOffset(Number.isFinite(val) ? val : 0);
              }}
              step={0.05}
              min={-5}
              max={5}
              style={{ width: 80, padding: "4px 6px" }}
            />
          </label>
          <button type="button" onClick={() => setManualOffset(0)} style={{ padding: "4px 10px" }}>
            Reset Offset
          </button>
        </div>
        {filteredCurrentClipTranscript.length > 0 && (
          <div>
            <strong>Active clip transcript:</strong>
            <div style={{ marginTop: 8, display: "grid", gap: 4 }}>
              {filteredCurrentClipTranscript.map((seg) => (
                <div key={seg.id} style={{ color: "#e2e8f0" }}>
                  [{formatTime(seg.start)} - {formatTime(seg.end)}] {seg.text}
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {serverErrorMessage && <div style={{ color: "#b54747" }}>{serverErrorMessage}</div>}

      <audio
        ref={audioRef}
        src={audioUrl || undefined}
        preload="metadata"
        onError={() =>
          setAudioLoadError(`Audio failed to load. Ensure the FastAPI server at ${serverHint} is running.`)
        }
        onLoadedData={() => setAudioLoadError(null)}
      />
      {audioLoadError && <div style={{ color: "#fca5a5" }}>{audioLoadError}</div>}
      {videoLoadError && <div style={{ color: "#fca5a5" }}>{videoLoadError}</div>}

      <section style={{ display: "grid", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h2 style={{ margin: 0 }}>Window clips</h2>
          {loadingClips && <span style={{ color: "#64748b" }}>Loading clips...</span>}
          {clipError && <span style={{ color: "#b54747" }}>{clipError}</span>}
        </div>
        <div style={{ display: "grid", gap: 16 }}>
          {clips.length === 0 && !loadingClips ? (
            <div style={{ color: "#94a3b8" }}>No window clips detected for this recording.</div>
          ) : (
            clips.map((clip) => {
              const transcript = clipTranscriptMap.get(clip.id) ?? [];
              const isActive = activeClipId === clip.id;
              const audioEl = audioRef.current;
              const isPlaying = isActive && audioEl ? !audioEl.paused : false;
              const clipDuration = Math.max(clip.end_seconds - clip.start_seconds, 0.001);
              const timelineSeconds = Math.max(0, currentTime - combinedOffset);
              const effectiveTimeline = Math.min(Math.max(timelineSeconds, clip.start_seconds), clip.end_seconds);
              const sliderValue = isActive ? effectiveTimeline - clip.start_seconds : 0;
              const clipCurrentDisplay = clip.start_seconds + sliderValue;
              return (
                <div
                  key={clip.id}
                  style={{
                    border: `1px solid ${isActive ? "#1d4ed8" : "#1e293b"}`,
                    borderRadius: 8,
                    padding: 16,
                    display: "grid",
                    gap: 12,
                    background: "#0b1120",
                    color: "#e2e8f0",
                  }}
                >
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
                    <strong style={{ fontSize: 18 }}>{clip.window_name || "Unknown window"}</strong>
                    <span style={{ color: "#94a3b8" }}>
                      {formatTime(clip.start_seconds)} - {formatTime(clip.end_seconds)}
                    </span>
                    <span style={{ color: "#64748b" }}>{clip.frame_count} frames</span>
                  </div>

                  <div style={{ display: "grid", gap: 4 }}>
                    <strong>Transcript</strong>
                    {transcript.length === 0 ? (
                      <div style={{ color: "#94a3b8" }}>No transcript segments in this range.</div>
                    ) : (
                      transcript.map((seg) => (
                        <div key={seg.id} style={{ color: "#cbd5f5" }}>
                          [{formatTime(seg.start)} - {formatTime(seg.end)}] {seg.text}
                        </div>
                      ))
                    )}
                  </div>

                  <div style={{ display: "grid", gap: 8 }}>
                    <div
                      style={{
                        position: "relative",
                        background: "#111",
                        minHeight: 200,
                        borderRadius: 8,
                        overflow: "hidden",
                      }}
                    >
                      {videoUrl ? (
                        <video
                          ref={(node) => {
                            if (node) {
                              node.defaultMuted = true;
                              node.muted = true;
                              node.volume = 0;
                              if (!(node as any).__enforceMute) {
                                const enforceMute = () => {
                                  if (!node.muted) {
                                    node.muted = true;
                                  }
                                  if (node.volume !== 0) {
                                    node.volume = 0;
                                  }
                                };
                                (node as any).__enforceMute = enforceMute;
                                node.addEventListener("volumechange", enforceMute);
                              }
                              node.preload = "metadata";
                              if (videoUrl) {
                                const current = node.getAttribute("data-current-src");
                                if (current !== videoUrl) {
                                  node.setAttribute("data-current-src", videoUrl);
                                  node.src = videoUrl;
                                  node.load();
                                }
                              }
                              node.onloadedmetadata = () => {
                                setVideoDuration((prev) => prev ?? (Number.isFinite(node.duration) ? node.duration : prev));
                                const duration = Number.isFinite(node.duration) && node.duration > 0 ? node.duration : videoDuration;
                                node.currentTime = mapTimelineToVideo(clip.start_seconds, duration, metadata);
                              };
                              clipVideoRefs.current.set(clip.id, node);
                            } else {
                              const prevNode = clipVideoRefs.current.get(clip.id);
                              if (prevNode && (prevNode as any).__enforceMute) {
                                prevNode.removeEventListener("volumechange", (prevNode as any).__enforceMute);
                                delete (prevNode as any).__enforceMute;
                              }
                              clipVideoRefs.current.delete(clip.id);
                            }
                          }}
                          onError={() =>
                            setVideoLoadError(
                              `Video failed to load. Ensure the FastAPI server at ${serverHint} is running and the file path is correct.`,
                            )
                          }
                          onLoadedData={() => setVideoLoadError(null)}
                          style={{ width: "100%", height: "100%", objectFit: "contain" }}
                        />
                      ) : (
                        <div style={{ padding: 40, color: "#eee" }}>Enter a video path to view clips.</div>
                      )}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        alignItems: "center",
                        gap: 12,
                        marginTop: 12,
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => (isPlaying ? pauseClip(clip) : playClip(clip))}
                        style={{ padding: "4px 10px" }}
                      >
                        {isPlaying ? "Pause" : "Play"}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRestartClip(clip)}
                        style={{ padding: "4px 10px" }}
                      >
                        Restart
                      </button>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 160 }}>
                        <input
                          type="range"
                          min={0}
                          max={clipDuration}
                          step={0.05}
                          value={sliderValue}
                          onChange={(event) =>
                            handleClipSeek(clip, clip.start_seconds + Number(event.target.value || "0"))
                          }
                          onMouseDown={() => setActiveClipId(clip.id)}
                          disabled={clipDuration <= 0.01}
                          style={{ flex: 1 }}
                        />
                        <span style={{ color: "#94a3b8", fontVariantNumeric: "tabular-nums" }}>
                          {formatTime(clipCurrentDisplay)} / {formatTime(clip.end_seconds)}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>
    </main>
  );
}

