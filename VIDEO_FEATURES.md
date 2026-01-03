QUESTION


great! the thing is screenpipe captures frames e.g 30 fps then encodes it with ffmpeg into an mp4 for storage..not for playback. my goal is to build these features

1. playback feature...use a separate audio recording and sync it with the frames like a video playback. audio is playing and the frames are moving accoriding to audio...also i want the transcript plays beneath like a subtitle

2. transcript feature: transcript on the side, when i click on a spot, the audio at that time stamp and frame at that timestamp start playing...and i can then have control from there

3. document feature...convert the video frames + audio + transcript to a document e.g the transcript is a sentence then the frames for that LINE are beaneath it...think of a video clip (option 1 - audio plays with the clip - basically the playback feature) OR option 2 (moving frame carousel  - so i can click back and forth the relevant frames for that line)

__________________________________________________________________________________________________


ANSWER


Excellent project! Let me design architectures for each feature. Since Screenpipe already creates MP4s for storage, we can leverage those.



---



## Architecture Overview



### Data You Have
```
✓ MP4 videos (30 FPS screen recording)
✓ Audio transcriptions with timestamps
✓ OCR text per frame with timestamps
✓ SQLite database linking everything
```

**Implementation notes for Option B**
- Serve the raw Screenpipe MP4 directly (no remux) through an endpoint that honours `Range` so MPC/HTML5 can seek without re-encoding.
- Stream the companion WAV separately; the React control above keeps `<audio>` time-aligned with `<video>` and snaps back when drift exceeds ~100 ms.
- Because Screenpipe may skip similar frames, build a lightweight scheduler: read capture timestamps from `frames`, compute per-frame deltas, and if playback runs faster than real time, apply a compensating `playbackRate` (e.g. `video.playbackRate = 58 / capturedDuration`) while leaving audio at 1.0.
- Use transcript timestamps from `/api/transcript` to drive custom subtitles. Prefetch upcoming lines so transcript changes stay instant even when the DB is remote.
- Add a “Resync” button that reassigns both elements’ `currentTime` to the current transcript start; log drift in analytics so you can fall back to Option A when a session’s drift grows beyond the threshold.



---



## Feature 1: Synchronized Playback





**Goal:** Video + Audio + Subtitles playing together in sync



### Architecture



```
┌─────────────────────────────────────┐
│         HTML5 Video Player          │
│  ┌─────────────────────────────┐   │
│  │   MP4 Video (screen frames)  │   │
│  └─────────────────────────────┘   │
│  ┌─────────────────────────────┐   │
│  │   Audio Track (WAV/MP3)      │   │
│  └─────────────────────────────┘   │
│  ┌─────────────────────────────┐   │
│  │   Subtitle Track (VTT/SRT)   │   │
│  └─────────────────────────────┘   │
└─────────────────────────────────────┘
```



### Implementation





**Option A: Merge Audio into Video (Best)**





**Pre-process: Combine video + audio once:**


```bash
# When recording finishes:
ffmpeg -i screen_video.mp4 -i audio.wav \
  -c:v copy \
  -c:a aac \
  output_with_audio.mp4
```





**Generate subtitle file from transcriptions:**


```python
# Generate WebVTT subtitle file
def generate_subtitles(transcriptions):
    vtt = "WEBVTT\n\n"
    for i, trans in enumerate(transcriptions):
        start = format_time(trans['timestamp'])
        end = format_time(trans['timestamp'] + 2)  # 2 sec duration
        vtt += f"{i+1}\n{start} --> {end}\n{trans['text']}\n\n"
    return vtt

# output.vtt
```





**Frontend (Simple!):**


```tsx
<video 
  src={`/api/video/playback?file_path=${current.file_path}`}
  controls
  autoPlay
>
  <track 
    kind="subtitles" 
    src={`/api/subtitles?session_id=${current.session_id}`}
    srcLang="en" 
    label="English"
    default
  />
</video>
```





**Benefits:**
- ✅ Native browser playback (60 FPS)
- ✅ Hardware acceleration
- ✅ Perfect sync (no manual timing)
- ✅ Built-in controls
- ✅ Subtitle styling via CSS



---





**Option B: Separate Audio + Video (More Control)**



```tsx
const VideoPlayback = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [currentTranscript, setCurrentTranscript] = useState("");

  // Sync audio with video
  useEffect(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video || !audio) return;

    const syncAudio = () => {
      const timeDiff = Math.abs(video.currentTime - audio.currentTime);
      if (timeDiff > 0.1) {  // If out of sync by >100ms
        audio.currentTime = video.currentTime;
      }
    };

    video.addEventListener('play', () => audio.play());
    video.addEventListener('pause', () => audio.pause());
    video.addEventListener('seeked', syncAudio);
    video.addEventListener('timeupdate', () => {
      setCurrentTime(video.currentTime);
      syncAudio();
    });

    return () => {
      video.removeEventListener('play', () => audio.play());
      // ... cleanup
    };
  }, []);

  // Update transcript based on currentTime
  useEffect(() => {
    const transcript = transcriptions.find(t => 
      t.timestamp <= currentTime && 
      currentTime < t.timestamp + t.duration
    );
    if (transcript) {
      setCurrentTranscript(transcript.text);
    }
  }, [currentTime, transcriptions]);

  return (
    <div>
      <video ref={videoRef} src={videoUrl} controls />
      <audio ref={audioRef} src={audioUrl} />
      
      {/* Custom subtitle display */}
      <div className="subtitles">
        {currentTranscript}
      </div>
    </div>
  );
};
```





**Benefits:**
- ✅ Full control over timing
- ✅ Custom subtitle styling
- ✅ Can highlight words/phrases



---



## Feature 2: Transcript Navigation





**Goal:** Click transcript → Jump to that moment



### Implementation



```tsx
const TranscriptNavigation = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  
  const jumpToTimestamp = (timestamp: string) => {
    const seconds = parseTimestamp(timestamp);
    
    if (videoRef.current) {
      videoRef.current.currentTime = seconds;
      videoRef.current.play();
    }
    
    if (audioRef.current) {
      audioRef.current.currentTime = seconds;
      audioRef.current.play();
    }
  };

  return (
    <div className="transcript-viewer">
      {/* Left: Video/Audio Player */}
      <div className="player">
        <video ref={videoRef} src={videoUrl} controls />
        <audio ref={audioRef} src={audioUrl} />
      </div>
      
      {/* Right: Transcript */}
      <div className="transcript">
        {transcriptions.map((trans, i) => (
          <div 
            key={i}
            className="transcript-line"
            onClick={() => jumpToTimestamp(trans.timestamp)}
            style={{ 
              cursor: 'pointer',
              backgroundColor: isActive(trans) ? 'yellow' : 'transparent'
            }}
          >
            <span className="timestamp">{formatTime(trans.timestamp)}</span>
            <span className="text">{trans.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
```





**API for transcript data:**


```typescript
// /api/transcript?session_id=...
export async function GET(req: NextRequest) {
  const sessionId = req.searchParams.get("session_id");
  const session = await db.getSession(sessionId);
  const canonicalName = canonicalizePath(session.file_path);
  
  const transcriptions = await db.query(`
    SELECT id, created_at, transcription, 
           LAG(created_at) OVER (ORDER BY created_at) as prev_created_at,
           LEAD(created_at) OVER (ORDER BY created_at) as next_created_at
    FROM audio_transcriptions
    WHERE name = ?
    ORDER BY created_at
  `, [canonicalName]);
  
  return Response.json(transcriptions);
}
```



---



## Feature 3: Document with Embedded Clips





**Goal:** Transcript lines with corresponding frame clips



### Architecture



```
Document Structure:
┌─────────────────────────────────┐
│ [Timestamp: 00:00:05]           │
│ "User opened Chrome browser"    │ ← Transcript
│                                 │
│ ┌───────────────────────────┐ │
│ │  [Frame Carousel/Video]    │ │ ← Frames for this line
│ │  ◀ [===🖼️==🖼️==🖼️===] ▶  │ │
│ └───────────────────────────┘ │
├─────────────────────────────────┤
│ [Timestamp: 00:00:12]           │
│ "Navigated to Gmail"            │
│                                 │
│ ┌───────────────────────────┐ │
│ │  [Frame Carousel/Video]    │ │
│ │  ◀ [===🖼️==🖼️==🖼️===] ▶  │ │
│ └───────────────────────────┘ │
└─────────────────────────────────┘
```



### Implementation





**Option 1: Video Clips (Audio Plays)**



```tsx
const DocumentView = () => {
  const [segments, setSegments] = useState<Segment[]>([]);
  
  useEffect(() => {
    // Fetch transcript segments with time ranges
    fetch('/api/document/segments?session_id=...')
      .then(res => res.json())
      .then(setSegments);
  }, []);

  return (
    <div className="document">
      {segments.map((segment, i) => (
        <div key={i} className="segment">
          {/* Transcript text */}
          <div className="transcript-text">
            <span className="timestamp">{formatTime(segment.start_time)}</span>
            <p>{segment.text}</p>
          </div>
          
          {/* Video clip for this segment */}
          <VideoClip
            videoUrl={`/api/video/clip?file_path=${segment.video_path}&start=${segment.start_time}&end=${segment.end_time}`}
            audioUrl={`/api/audio/clip?file_path=${segment.audio_path}&start=${segment.start_time}&end=${segment.end_time}`}
          />
        </div>
      ))}
    </div>
  );
};

const VideoClip = ({ videoUrl, audioUrl }) => {
  return (
    <div className="clip">
      <video controls preload="metadata">
        <source src={videoUrl} type="video/mp4" />
        <track kind="subtitles" src={`${videoUrl}.vtt`} />
      </video>
      {/* Audio embedded in video or separate */}
    </div>
  );
};
```





**API for video clips:**


```typescript
// /api/video/clip?file_path=...&start=5.0&end=10.0
export async function GET(req: NextRequest) {
  const filePath = req.searchParams.get("file_path");
  const start = parseFloat(req.searchParams.get("start") || "0");
  const end = parseFloat(req.searchParams.get("end") || "0");
  const duration = end - start;
  
  // Extract clip with FFmpeg
  const ffmpeg = spawn("ffmpeg", [
    "-ss", start.toString(),
    "-t", duration.toString(),
    "-i", filePath,
    "-c", "copy",  // Fast copy, no re-encoding
    "-f", "mp4",
    "-movflags", "frag_keyframe+empty_moov",  // Stream-friendly
    "pipe:1"
  ]);
  
  return new Response(ffmpeg.stdout, {
    headers: { "Content-Type": "video/mp4" },
  });
}
```



---





**Option 2: Frame Carousel (Manual Navigation)**



```tsx
const FrameCarousel = ({ frames }: { frames: Frame[] }) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  
  // Auto-advance for playback
  useEffect(() => {
    if (!isPlaying) return;
    
    const timer = setInterval(() => {
      setCurrentIndex(i => (i + 1) % frames.length);
    }, 1000 / 30);  // 30 FPS
    
    return () => clearInterval(timer);
  }, [isPlaying, frames.length]);

  return (
    <div className="frame-carousel">
      {/* Current frame */}
      <img 
        src={`/api/video/frame?file_path=${frames[currentIndex].file_path}&offset_index=${frames[currentIndex].offset_index}`}
        alt="frame"
      />
      
      {/* Controls */}
      <div className="controls">
        <button onClick={() => setCurrentIndex(i => Math.max(0, i - 1))}>◀ Prev</button>
        <button onClick={() => setIsPlaying(!isPlaying)}>
          {isPlaying ? '⏸ Pause' : '▶ Play'}
        </button>
        <button onClick={() => setCurrentIndex(i => Math.min(frames.length - 1, i + 1))}>Next ▶</button>
      </div>
      
      {/* Frame timeline */}
      <div className="timeline">
        {frames.map((frame, i) => (
          <div
            key={i}
            className={`thumbnail ${i === currentIndex ? 'active' : ''}`}
            onClick={() => setCurrentIndex(i)}
          >
            <img src={`/api/video/frame?file_path=${frame.file_path}&offset_index=${frame.offset_index}&thumb=1`} />
          </div>
        ))}
      </div>
    </div>
  );
};
```





**API for segment frames:**


```typescript
// /api/document/segments?session_id=...
export async function GET(req: NextRequest) {
  const sessionId = req.searchParams.get("session_id");
  const session = await db.getSession(sessionId);
  const canonicalName = canonicalizePath(session.file_path);
  
  const segments = await db.query(`
    WITH transcript_segments AS (
      SELECT 
        id,
        transcription as text,
        created_at as start_time,
        LEAD(created_at) OVER (ORDER BY created_at) as end_time
      FROM audio_transcriptions
      WHERE name = ?
    )
    SELECT 
      ts.*,
      json_group_array(
        json_object(
          'file_path', f.file_path,
          'offset_index', f.offset_index,
          'timestamp', f.timestamp
        )
      ) as frames
    FROM transcript_segments ts
    LEFT JOIN frames f ON 
      f.timestamp >= ts.start_time AND 
      f.timestamp < COALESCE(ts.end_time, ts.start_time + 5)
    GROUP BY ts.id
    ORDER BY ts.start_time
  `, [canonicalName]);
  
  return Response.json(segments);
}
```



---



## Recommended Tech Stack



### For All Features





**Backend:**


```typescript
// Next.js API Routes
/api/video/playback    // Serve merged video+audio
/api/subtitles         // Generate VTT/SRT from transcriptions
/api/video/clip        // Extract video segment
/api/audio/clip        // Extract audio segment
/api/transcript        // Get full transcript with timestamps
/api/document/segments // Get transcript segments with frames
```





**Frontend:**


```tsx
// Components
<SyncedPlayback />      // Feature 1
<TranscriptNavigator /> // Feature 2
<DocumentView />        // Feature 3
  ├─ <VideoClip />         // Option 1
  └─ <FrameCarousel />     // Option 2
```



---



## Performance Optimizations



### 1. Pre-process During Recording



```bash
# When recording stops:
# 1. Merge video + audio
ffmpeg -i screen.mp4 -i audio.wav -c:v copy -c:a aac output.mp4

# 2. Generate subtitle file
python generate_subtitles.py --session_id=... > subtitles.vtt

# 3. Extract keyframes for thumbnails
ffmpeg -i output.mp4 -vf "select='eq(pict_type,I)'" -vsync vfr thumb_%04d.jpg
```



### 2. Use Range Requests



```typescript
// Support partial content for seeking
export async function GET(req: NextRequest) {
  const range = req.headers.get("range");
  if (range) {
    // Parse range, send partial content
    return new Response(videoChunk, {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Accept-Ranges": "bytes",
      },
    });
  }
}
```



### 3. Cache Frequently Accessed Clips



```typescript
const clipCache = new Map<string, Buffer>();

export async function GET(req: NextRequest) {
  const cacheKey = `${filePath}_${start}_${end}`;
  
  if (clipCache.has(cacheKey)) {
    return new Response(clipCache.get(cacheKey));
  }
  
  const clip = await extractClip(filePath, start, end);
  clipCache.set(cacheKey, clip);
  
  return new Response(clip);
}
```



---



## Summary



| Feature | Best Approach | Key Component |
|---------|---------------|---------------|
| **Playback** | HTML5 video with merged audio | `<video>` + WebVTT subtitles |
| **Navigation** | Click transcript → seek video | `video.currentTime = timestamp` |
| **Document (Option 1)** | Video clips per segment | FFmpeg clip extraction |
| **Document (Option 2)** | Frame carousel | Image slideshow with controls |



**Start with Feature 1 (easiest)**, then add 2 and 3. The HTML5 video player handles most of the heavy lifting!

