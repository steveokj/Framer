"use client";

// Session player page - plays audio with synchronized transcript
// Supports speech-only mode with bidirectional timeline conversion
// Displays transcript with clickable lines for seeking

import { useEffect, useMemo, useRef, useState } from "react";
import { getApiBase } from "@/lib/api";
import { msToTimestamp } from "@/lib/time";

// Transcript item structure
type Item = { id: number; start_ms: number | null; end_ms: number | null; text: string };

// Timeline segment mapping speech-only time to original time
// Each segment represents a continuous speech region
type TimelineSegment = {
  original_start_ms: number; // Start in original audio
  original_end_ms: number; // End in original audio
  speech_start_ms: number; // Start in speech-only audio
  speech_end_ms: number; // End in speech-only audio
  duration_ms: number; // Duration of this speech segment
};

// Complete timeline data from server
type SpeechTimeline = {
  segments: TimelineSegment[];
  silence_spans?: { start_ms: number; end_ms: number; duration_ms: number }[];
  total_original_ms?: number; // Full recording duration
  total_speech_ms?: number; // Duration with silence removed
};

// Timeline converter functions for bidirectional time mapping
type TimelineConverters = {
  speechToOriginal: (ms: number) => number; // Speech time -> original time
  originalToSpeech: (ms: number) => number; // Original time -> speech time
};

// Session player page component
// Displays audio player, transcript, and frame viewer
export default function SessionPage({ params }: { params: { id: string } }) {
  const id = params.id;
  const base = getApiBase();
  
  // Data state
  const [manifest, setManifest] = useState<any>(null); // Session metadata and URLs
  const [items, setItems] = useState<Item[]>([]); // Transcript lines
  const [activeIdx, setActiveIdx] = useState<number | null>(null); // Currently playing line
  
  // Audio player state
  const audioRef = useRef<HTMLAudioElement>(null);
  const [useSpeech, setUseSpeech] = useState(true); // Use speech-only audio if available
  const [pendingSeekMs, setPendingSeekMs] = useState<number | null>(null); // Deferred seek position

  // Load session data on mount
  useEffect(() => {
    (async () => {
      const man = await fetch(`${base}/sessions/${id}/manifest`).then((r) => r.json());
      setManifest(man);
      const tx = await fetch(`${base}/sessions/${id}/transcript`).then((r) => r.json());
      setItems(tx);
    })();
  }, [id, base]);

  // Process and validate timeline data from manifest
  // Sorts segments and fills in missing totals
  const timeline = useMemo(() => {
    const raw = manifest?.audio?.timeline as SpeechTimeline | undefined;
    if (!raw || !Array.isArray(raw.segments)) {
      return undefined;
    }
    const segments = [...raw.segments].sort((a, b) => a.speech_start_ms - b.speech_start_ms);
    if (segments.length === 0) {
      return undefined;
    }
    const totalOriginal = raw.total_original_ms ?? segments[segments.length - 1].original_end_ms;
    const totalSpeech = raw.total_speech_ms ?? segments[segments.length - 1].speech_end_ms;
    return {
      ...raw,
      segments,
      total_original_ms: totalOriginal,
      total_speech_ms: totalSpeech,
    };
  }, [manifest]);

  // Determines if speech-only mode is available
  // Requires both speech audio file and valid timeline
  const canUseSpeech = useMemo(() => {
    return Boolean(manifest?.audio?.speech_url && timeline && timeline.segments.length > 0);
  }, [manifest, timeline]);

  // Disable speech mode if it becomes unavailable
  useEffect(() => {
    if (!canUseSpeech && useSpeech) {
      setUseSpeech(false);
    }
  }, [canUseSpeech, useSpeech]);

  // Creates timeline converter functions for time mapping
  // Enables conversion between speech-only and original timestamps
  const converters: TimelineConverters = useMemo(() => {
    if (!timeline || timeline.segments.length === 0) {
      // No timeline - identity mapping
      return {
        speechToOriginal: (ms: number) => ms,
        originalToSpeech: (ms: number) => ms,
      };
    }
    const segments = timeline.segments;
    const clampOriginal = timeline.total_original_ms ?? segments[segments.length - 1].original_end_ms;
    const clampSpeech = timeline.total_speech_ms ?? segments[segments.length - 1].speech_end_ms;

    // Converts speech-only time to original time
    // Finds which segment contains the time and maps within that segment
    const speechToOriginal = (ms: number) => {
      for (const seg of segments) {
        if (ms < seg.speech_start_ms) {
          // Before this segment - return its start in original time
          return seg.original_start_ms;
        }
        if (ms <= seg.speech_end_ms) {
          // Within this segment - proportional mapping
          const within = Math.min(ms - seg.speech_start_ms, seg.duration_ms);
          return seg.original_start_ms + within;
        }
      }
      // Past all segments - clamp to end
      return clampOriginal;
    };

    // Converts original time to speech-only time
    // Inverse of speechToOriginal function
    const originalToSpeech = (ms: number) => {
      for (const seg of segments) {
        if (ms < seg.original_start_ms) {
          // Before this segment - return its start in speech time
          return seg.speech_start_ms;
        }
        if (ms <= seg.original_end_ms) {
          // Within this segment - proportional mapping
          const within = Math.min(ms - seg.original_start_ms, seg.duration_ms);
          return seg.speech_start_ms + within;
        }
      }
      // Past all segments - clamp to end
      return clampSpeech;
    };

    return { speechToOriginal, originalToSpeech };
  }, [timeline]);

  const speechToOriginalMs = converters.speechToOriginal;
  const originalToSpeechMs = converters.originalToSpeech;

  // Determines which audio URL to use based on speech mode
  // Returns speech-only URL when enabled and available, otherwise original
  const audioUrl = useMemo(() => {
    if (!manifest) return "";
    if (useSpeech && canUseSpeech && manifest.audio.speech_url) {
      return `${base}${manifest.audio.speech_url}`;
    }
    return `${base}${manifest.audio.original_url}`;
  }, [manifest, useSpeech, base, canUseSpeech]);

  // Updates active transcript line based on audio playback position
  // Converts speech time to original time when in speech mode
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    
    const onTime = () => {
      const rawMs = el.currentTime * 1000; // Current position in playing audio
      // Convert to original time if using speech-only audio
      const logicalMs = useSpeech && canUseSpeech ? speechToOriginalMs(rawMs) : rawMs;
      
      // Find transcript line containing this timestamp
      const idx = items.findIndex(
        (it) =>
          it.start_ms !== null &&
          it.end_ms !== null &&
          logicalMs >= it.start_ms &&
          logicalMs < it.end_ms,
      );
      setActiveIdx(idx >= 0 ? idx : null);
    };
    
    el.addEventListener("timeupdate", onTime);
    return () => el.removeEventListener("timeupdate", onTime);
  }, [items, useSpeech, canUseSpeech, speechToOriginalMs]);

  // Handles deferred seeking when audio becomes ready
  // Needed when switching between audio sources
  useEffect(() => {
    if (pendingSeekMs == null) return;
    const el = audioRef.current;
    if (!el) return;
    
    const seek = () => {
      el.currentTime = pendingSeekMs / 1000;
      setPendingSeekMs(null);
    };
    
    // If audio is ready, seek immediately
    if (el.readyState >= 1) {
      seek();
      return;
    }
    
    // Otherwise wait for metadata to load
    const onLoaded = () => {
      seek();
      el.removeEventListener("loadedmetadata", onLoaded);
    };
    el.addEventListener("loadedmetadata", onLoaded);
    return () => el.removeEventListener("loadedmetadata", onLoaded);
  }, [pendingSeekMs]);

  // Seeks to a specific timestamp in the transcript
  // Converts original time to speech time when in speech mode
  const jump = (ms: number) => {
    const el = audioRef.current;
    if (!el) return;
    // Convert original time to speech time if needed
    const target = useSpeech && canUseSpeech ? originalToSpeechMs(ms) : ms;
    el.currentTime = target / 1000;
    void el.play();
  };

  // Handles speech-only toggle with playback position preservation
  // Converts current time to equivalent position in new audio
  const handleSpeechToggle = (checked: boolean) => {
    if (!canUseSpeech) {
      setUseSpeech(false);
      return;
    }
    const el = audioRef.current;
    let target: number | null = null;
    
    if (el && timeline) {
      const currentMs = el.currentTime * 1000;
      if (checked && !useSpeech) {
        // Switching to speech-only: convert original time to speech time
        target = originalToSpeechMs(currentMs);
      } else if (!checked && useSpeech) {
        // Switching to original: convert speech time to original time
        target = speechToOriginalMs(currentMs);
      }
    }
    
    setUseSpeech(checked);
    if (target !== null) {
      setPendingSeekMs(target);
    }
  };

  return (
    <main className="grid">
      {/* Audio player panel */}
      <section className="panel">
        <div className="row">
          <button onClick={() => audioRef.current?.play()}>Play</button>
          <button onClick={() => audioRef.current?.pause()}>Pause</button>
          {/* Skip backward 5 seconds */}
          <button
            onClick={() => {
              const el = audioRef.current;
              if (!el) return;
              el.currentTime = Math.max(0, el.currentTime - 5);
            }}
          >
            -5s
          </button>
          {/* Skip forward 5 seconds */}
          <button
            onClick={() => {
              const el = audioRef.current;
              if (!el) return;
              el.currentTime = el.currentTime + 5;
            }}
          >
            +5s
          </button>
          {/* Speech-only toggle - disabled if not available */}
          <label className="row gap">
            <input
              type="checkbox"
              checked={useSpeech && canUseSpeech}
              onChange={(e) => handleSpeechToggle(e.target.checked)}
              disabled={!canUseSpeech}
            />
            Speech-only
          </label>
        </div>
        {/* HTML5 audio element with controls */}
        <audio ref={audioRef} src={audioUrl} controls preload="metadata" style={{ width: "100%" }} />
      </section>
      
      {/* Transcript panel */}
      <section className="panel">
        <h2>Transcript</h2>
        <div className="transcript">
          {items.map((it, i) => (
            <div
              key={it.id}
              className={`line ${i === activeIdx ? "active" : ""}`}
              onClick={() => it.start_ms != null && jump(it.start_ms)}
            >
              {/* Timestamp in original time */}
              <span className="tc">{it.start_ms != null ? msToTimestamp(it.start_ms) : "--:--"}</span>
              {/* Transcribed text */}
              <span className="txt">{it.text}</span>
            </div>
          ))}
        </div>
      </section>
      
      {/* Frame viewer panel (placeholder) */}
      <section className="panel">
        <h2>Frame</h2>
        <div className="muted">Hook this to your Rust frames endpoint (nearest-by-time).</div>
      </section>
    </main>
  );
}
