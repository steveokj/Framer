"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Segment = {
  id: number;
  start: number;
  end: number;
  text: string;
};

type FrameEntry = {
  offset_index: number;
  timestamp: string;
  seconds_from_video_start: number;
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
  frames: FrameEntry[];
};

const DEFAULT_VIDEO = "C:\\Users\\steve\\.screenpipe\\data\\monitor_52305895_2025-10-12_02-13-01.mp4";
const DEFAULT_AUDIO = "C:\\Users\\steve\\Desktop\\Whisper\\sessions\\session-20251011-221322.wav";
const API_BASE = (
  process.env.NEXT_PUBLIC_API_BASE && process.env.NEXT_PUBLIC_API_BASE.trim().length > 0
    ? process.env.NEXT_PUBLIC_API_BASE
    : "http://localhost:8001"
).replace(/\/$/, "");

const ABSOLUTE_PATH_REGEX = /^[a-zA-Z]:[\\/]|^\//;

function normalisePath(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.?\//, "");
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

export default function VideoWebPlaybackPage() {
  const [videoInput, setVideoInput] = useState(DEFAULT_VIDEO);
  const [audioInput, setAudioInput] = useState(DEFAULT_AUDIO);
  const [videoPath, setVideoPath] = useState(DEFAULT_VIDEO);
  const [audioPath, setAudioPath] = useState(DEFAULT_AUDIO);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [loadingMetadata, setLoadingMetadata] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoLoadError, setVideoLoadError] = useState<string | null>(null);
  const [audioLoadError, setAudioLoadError] = useState<string | null>(null);
  const [manualOffset, setManualOffset] = useState(0);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [audioDuration, setAudioDuration] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const lastSyncedRef = useRef(0);
  const hideControlsTimeoutRef = useRef<number | null>(null);

  const { url: videoUrl, warning: videoWarning } = useMemo(() => buildFileUrl(videoPath), [videoPath]);
  const { url: audioUrl, warning: audioWarning } = useMemo(() => buildFileUrl(audioPath), [audioPath]);

  const audioOffset = metadata?.alignment.audio_offset_seconds ?? 0;
  const combinedOffset = audioOffset + manualOffset;
  const serverHint = API_BASE || "http://localhost:8001";
  const timelineDuration = useMemo(() => getTimelineDuration(metadata), [metadata]);
  const displayScale = useMemo(() => {
    if (!timelineDuration || videoDuration == null || !(videoDuration > 0)) {
      return 1;
    }
    return timelineDuration / videoDuration;
  }, [timelineDuration, videoDuration]);
  const effectiveDuration = useMemo(() => {
    if (metadata?.audio.duration_seconds && metadata.audio.duration_seconds > 0) {
      return metadata.audio.duration_seconds;
    }
    if (audioDuration && audioDuration > 0) {
      return audioDuration;
    }
    if (timelineDuration && timelineDuration > 0) {
      return timelineDuration;
    }
    if (videoDuration && videoDuration > 0) {
      return videoDuration;
    }
    return Math.max(currentTime, 0);
  }, [metadata, audioDuration, timelineDuration, videoDuration, currentTime]);
  const clampedCurrentTime = Math.min(Math.max(currentTime, 0), effectiveDuration || Math.max(currentTime, 0));
  const sliderMax = effectiveDuration > 0 ? effectiveDuration : Math.max(currentTime || 0, 1);
  const formattedCurrentTime = formatTime(clampedCurrentTime);
  const formattedTotalTime = formatTime(sliderMax > 0 ? sliderMax : Math.max(clampedCurrentTime, 0));

  const clearHideControlsTimeout = useCallback(() => {
    if (hideControlsTimeoutRef.current != null) {
      window.clearTimeout(hideControlsTimeoutRef.current);
      hideControlsTimeoutRef.current = null;
    }
  }, []);

  const queueHideControls = useCallback(() => {
    if (!isPlaying) {
      return;
    }
    clearHideControlsTimeout();
    hideControlsTimeoutRef.current = window.setTimeout(() => {
      setControlsVisible(false);
      hideControlsTimeoutRef.current = null;
    }, 2000);
  }, [clearHideControlsTimeout, isPlaying]);

  useEffect(() => {
    if (!isPlaying) {
      clearHideControlsTimeout();
      setControlsVisible(true);
      return;
    }
    setControlsVisible(true);
    queueHideControls();
    return () => {
      clearHideControlsTimeout();
    };
  }, [isPlaying, queueHideControls, clearHideControlsTimeout]);

  useEffect(
    () => () => {
      clearHideControlsTimeout();
    },
    [clearHideControlsTimeout],
  );

  const seekToMediaTime = useCallback(
    (targetAudioSeconds: number, autoplay = false) => {
      const video = videoRef.current;
      const audio = audioRef.current;
      if (!video || !audio) {
        return;
      }
      const audioCap =
        metadata?.audio.duration_seconds && metadata.audio.duration_seconds > 0
          ? metadata.audio.duration_seconds
          : audioDuration && audioDuration > 0
            ? audioDuration
            : null;
      const clampedAudio = Math.max(0, Math.min(targetAudioSeconds, audioCap ?? targetAudioSeconds));
      const duration =
        (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : videoDuration) ?? null;
      const timelineSeconds = Math.max(0, clampedAudio - combinedOffset);
      const videoTime = mapTimelineToVideo(timelineSeconds, duration, metadata);
      if (Number.isFinite(videoTime)) {
        try {
          video.currentTime = videoTime;
        } catch {
          /* ignore */
        }
      }
      try {
        audio.currentTime = clampedAudio;
      } catch {
        /* ignore */
      }
      setCurrentTime(clampedAudio);
      if (autoplay) {
        video
          .play()
          .then(() => {
            /* noop */
          })
          .catch(() => {
            /* ignore */
          });
      }
    },
    [audioDuration, combinedOffset, metadata, videoDuration],
  );

  const handleTimelineSliderChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const rawValue = Number(event.target.value);
    if (!Number.isFinite(rawValue)) {
      return;
    }
    const video = videoRef.current;
    const shouldAutoplay = !!video && !video.paused;
    seekToMediaTime(rawValue, shouldAutoplay);
    setControlsVisible(true);
    if (shouldAutoplay) {
      queueHideControls();
    } else {
      clearHideControlsTimeout();
    }
  };

  const handleTogglePlayback = () => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    setControlsVisible(true);
    if (video.paused) {
      video
        .play()
        .then(() => {
          /* noop */
        })
        .catch(() => {
          /* ignore */
        });
    } else {
      video.pause();
    }
  };

  const handleRestart = () => {
    setControlsVisible(true);
    clearHideControlsTimeout();
    seekToMediaTime(0, true);
  };

  const handlePlayerPointerMove = () => {
    setControlsVisible(true);
    queueHideControls();
  };

  const handlePlayerPointerLeave = () => {
    if (!isPlaying) {
      return;
    }
    clearHideControlsTimeout();
    setControlsVisible(false);
  };

  const handleVideoError = useCallback(() => {
    setVideoLoadError(
      `Video stream failed to load. Ensure the FastAPI server at ${serverHint} is running and the path is accessible.`,
    );
  }, [serverHint]);

  const handleAudioError = useCallback(() => {
    setAudioLoadError(
      `Audio stream failed to load. Ensure the FastAPI server at ${serverHint} is running and the path is accessible.`,
    );
  }, [serverHint]);

  const fetchTranscript = useCallback(async () => {
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
  }, [audioPath]);

  const fetchMetadata = useCallback(
    async (video: string, audio: string) => {
      const trimmedVideo = video.trim();
      const trimmedAudio = audio.trim();
      if (!trimmedVideo || !trimmedAudio) {
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
          body: JSON.stringify({ videoPath: trimmedVideo, audioPath: trimmedAudio }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(payload.error || `Metadata request failed (status ${res.status})`);
        }
        const data: Metadata = await res.json();
        setMetadata(data);
      } catch (err) {
        setMetadata(null);
        setMetadataError(err instanceof Error ? err.message : "Failed to load playback metadata");
      } finally {
        setLoadingMetadata(false);
      }
    },
    []
  );

  useEffect(() => {
    fetchTranscript();
  }, [fetchTranscript]);

  useEffect(() => {
    fetchMetadata(videoPath, audioPath);
  }, [videoPath, audioPath, fetchMetadata]);

  useEffect(() => {
    lastSyncedRef.current = 0;
    setCurrentTime(0);
  }, [videoPath, audioPath]);

  useEffect(() => {
    setVideoDuration(null);
  }, [videoPath]);

  useEffect(() => {
    setAudioDuration(null);
  }, [audioPath]);

  useEffect(() => {
    setVideoLoadError(null);
  }, [videoUrl]);

  useEffect(() => {
    setAudioLoadError(null);
  }, [audioUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const updateDuration = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        setVideoDuration(video.duration);
      }
    };
    video.addEventListener("loadedmetadata", updateDuration);
    video.addEventListener("durationchange", updateDuration);
    updateDuration();
    return () => {
      video.removeEventListener("loadedmetadata", updateDuration);
      video.removeEventListener("durationchange", updateDuration);
    };
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const updateDuration = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setAudioDuration(audio.duration);
      }
    };
    audio.addEventListener("loadedmetadata", updateDuration);
    audio.addEventListener("durationchange", updateDuration);
    updateDuration();
    return () => {
      audio.removeEventListener("loadedmetadata", updateDuration);
      audio.removeEventListener("durationchange", updateDuration);
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    if (timelineDuration && videoDuration && videoDuration > 0) {
      const rate = videoDuration / timelineDuration;
      video.playbackRate = rate > 0 ? rate : 1;
    } else {
      video.playbackRate = 1;
    }
  }, [timelineDuration, videoDuration]);

  useEffect(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video || !audio) {
      return;
    }

    const computeTargetAudioTime = () => {
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : videoDuration;
      const timelineTime = mapVideoTimeToTimeline(video.currentTime, duration, metadata);
      const target = Math.max(0, timelineTime + combinedOffset);
      return Number.isFinite(target) ? target : 0;
    };

    const handlePlay = () => {
      if (timelineDuration && videoDuration && videoDuration > 0) {
        const rate = videoDuration / timelineDuration;
        video.playbackRate = rate > 0 ? rate : 1;
      }
      setIsPlaying(true);
      audio.muted = false;
      audio.playbackRate = 1;
      const nextTime = computeTargetAudioTime();
      try {
        audio.currentTime = nextTime;
      } catch {
        /* ignore */
      }
      audio.play().catch(() => {
        /* ignore */
      });
    };

    const handlePause = () => {
      audio.pause();
      setIsPlaying(false);
      clearHideControlsTimeout();
      setControlsVisible(true);
    };

    const handleSeeking = () => {
      const nextTime = computeTargetAudioTime();
      try {
        audio.currentTime = nextTime;
      } catch {
        /* ignore */
      }
    };

    const handleSeeked = () => {
      const nextTime = computeTargetAudioTime();
      try {
        audio.currentTime = nextTime;
      } catch {
        /* ignore */
      }
    };

    video.addEventListener("play", handlePlay);
    video.addEventListener("pause", handlePause);
    video.addEventListener("seeking", handleSeeking);
    video.addEventListener("seeked", handleSeeked);
    handleSeeked();

    return () => {
      video.removeEventListener("play", handlePlay);
      video.removeEventListener("pause", handlePause);
      video.removeEventListener("seeking", handleSeeking);
      video.removeEventListener("seeked", handleSeeked);
    };
  }, [metadata, combinedOffset, videoDuration, timelineDuration, clearHideControlsTimeout]);

  useEffect(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video || !audio) {
      return;
    }

    const syncFromAudio = () => {
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : videoDuration;
      if (metadata && duration && duration > 0) {
        const timelineSeconds = Math.max(0, audio.currentTime - combinedOffset);
        const desiredVideo = mapTimelineToVideo(timelineSeconds, duration, metadata);
        if (Number.isFinite(desiredVideo) && Math.abs(video.currentTime - desiredVideo) > 0.15) {
          try {
            video.currentTime = desiredVideo;
          } catch {
            /* ignore */
          }
        }
      }
      const audioTime = Math.max(0, audio.currentTime);
      if (Math.abs(audioTime - lastSyncedRef.current) > 0.03) {
        lastSyncedRef.current = audioTime;
        setCurrentTime(audioTime);
      }
    };

    syncFromAudio();

    audio.addEventListener("timeupdate", syncFromAudio);
    audio.addEventListener("seeking", syncFromAudio);
    audio.addEventListener("seeked", syncFromAudio);
    audio.addEventListener("play", syncFromAudio);
    audio.addEventListener("loadedmetadata", syncFromAudio);

    return () => {
      audio.removeEventListener("timeupdate", syncFromAudio);
      audio.removeEventListener("seeking", syncFromAudio);
      audio.removeEventListener("seeked", syncFromAudio);
      audio.removeEventListener("play", syncFromAudio);
      audio.removeEventListener("loadedmetadata", syncFromAudio);
    };
  }, [metadata, combinedOffset, videoDuration]);

  const activeSegment = useMemo(() => {
    return segments.find((seg) => currentTime >= seg.start && currentTime < seg.end) || null;
  }, [segments, currentTime]);

  const handleSeekToSegment = (segment: Segment) => {
    seekToMediaTime(Math.max(0, segment.start), true);
    setControlsVisible(true);
  };

  const handleFormSubmit = (evt: React.FormEvent<HTMLFormElement>) => {
    evt.preventDefault();
    setVideoPath(videoInput.trim());
    setAudioPath(audioInput.trim());
  };

  return (
    <main style={{ display: "grid", gap: 24, padding: 24 }}>
      <header>
        <h1>Video + Audio + Transcript (Web Playback)</h1>
        <p style={{ color: "#607080" }}>
          Loads original Screenpipe chunks directly in the browser and aligns audio using frame timestamps from the database
          (no ffmpeg merge). Useful for testing quick playback and sync accuracy.
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

      <section style={{ display: "grid", gap: 16 }}>
        <div
          style={{ position: "relative", background: "#111", minHeight: 320, borderRadius: 12, overflow: "hidden" }}
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
                onError={handleVideoError}
                onLoadedData={() => setVideoLoadError(null)}
                playsInline
              />
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
                  value={clampedCurrentTime}
                  onChange={handleTimelineSliderChange}
                  style={{ width: "100%" }}
                  disabled={sliderMax <= 0.05}
                />
              </div>
            </>
          ) : (
            <div style={{ padding: 40, color: "#eee" }}>
              Enter an absolute or project-relative video path to start playback.
            </div>
          )}
          <audio
            ref={audioRef}
            src={audioUrl || undefined}
            preload="metadata"
            onError={handleAudioError}
            onLoadedData={() => setAudioLoadError(null)}
          />
        </div>
        {(videoLoadError || audioLoadError) && (
          <div style={{ color: "#fca5a5", marginTop: 8 }}>
            {videoLoadError}
            {videoLoadError && audioLoadError ? " " : ""}
            {audioLoadError}
          </div>
        )}

        <div style={{ display: "grid", gap: 8, background: "#0f172a", color: "#f8fafc", padding: 16, borderRadius: 8 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
            <strong>Alignment:</strong>
            {loadingMetadata && <span style={{ color: "#94a3b8" }}>Loading metadata...</span>}
            {metadataError && <span style={{ color: "#fca5a5" }}>{metadataError}</span>}
            {metadata && (
              <>
                <span>audioOffset = {formatOffset(metadata.alignment.audio_offset_seconds)}</span>
                <span>lead = {metadata.alignment.audio_lead_seconds.toFixed(2)}s</span>
                <span>delay = {metadata.alignment.audio_delay_seconds.toFixed(2)}s</span>
                <span>timelineScale = {displayScale.toFixed(3)}×</span>
                <span>frames = {metadata.video.frame_count}</span>
                <span>manual = {manualOffset.toFixed(2)}s</span>
              </>
            )}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span>Manual audio offset (s)</span>
              <input
                type="number"
                value={manualOffset}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  setManualOffset(Number.isFinite(next) ? next : 0);
                }}
                step={0.05}
                min={-5}
                max={5}
                style={{ width: 90, padding: "4px 6px" }}
              />
            </label>
            <button type="button" onClick={() => setManualOffset(0)} style={{ padding: "4px 10px" }}>
              Reset Offset
            </button>
          </div>
          <div>
            <strong>Current transcript:</strong>
            <div style={{ marginTop: 8, minHeight: 40 }}>
              {activeSegment ? activeSegment.text : loadingTranscript ? "Transcribing..." : "--"}
            </div>
          </div>
        </div>
      </section>

      <section style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h2 style={{ margin: 0 }}>Transcript segments</h2>
          {loadingTranscript && <span style={{ color: "#64748b" }}>Loading transcript...</span>}
          {transcriptError && <span style={{ color: "#b54747" }}>{transcriptError}</span>}
        </div>
        <div style={{ maxHeight: 320, overflowY: "auto", border: "1px solid #1e293b", borderRadius: 8 }}>
          {segments.length === 0 && !loadingTranscript ? (
            <div style={{ padding: 16, color: "#94a3b8" }}>No transcript segments available.</div>
          ) : (
            segments.map((segment) => {
              const isActive = activeSegment?.id === segment.id;
              return (
                <button
                  key={segment.id}
                  onClick={() => handleSeekToSegment(segment)}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "80px 1fr",
                    gap: 12,
                    width: "100%",
                    textAlign: "left",
                    padding: "10px 14px",
                    background: isActive ? "#1d4ed8" : "transparent",
                    color: isActive ? "#ffffff" : "#e2e8f0",
                    border: "none",
                    borderBottom: "1px solid #1e293b",
                    cursor: "pointer",
                  }}
                >
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>
                    {formatTime(segment.start)} - {formatTime(segment.end)}
                  </span>
                  <span>{segment.text}</span>
                </button>
              );
            })
          )}
        </div>
      </section>
    </main>
  );
}

