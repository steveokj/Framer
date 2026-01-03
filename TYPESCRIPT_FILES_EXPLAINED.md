# TypeScript Files - Detailed Explanation

All TypeScript files in the web application have been thoroughly commented with detailed explanations.

## Files Updated

### 1. **web/app/page.tsx** - Home Page
**Purpose**: Displays list of all audio transcription sessions

**Key Features**:
- Server-side rendered using Next.js App Router
- Fetches sessions from FastAPI backend
- Displays session cards with title and file path
- Links to individual session player pages
- Uses no-store cache for fresh data

**Comments Added**:
- Function-level comments explaining data fetching
- Inline comments for UI elements
- Explanation of server component rendering

---

### 2. **web/app/layout.tsx** - Root Layout
**Purpose**: Wraps all pages with common HTML structure

**Key Features**:
- Imports global CSS styles
- Defines page metadata (title, description)
- Provides container div for consistent styling
- Language attribute set to "en"

**Comments Added**:
- Component purpose explanation
- Metadata export documentation
- Container div usage notes

---

### 3. **web/app/api/video/frame/route.ts** - Frame Extraction API
**Purpose**: Extracts video frames using FFmpeg

**Key Features**:
- **Multi-strategy offset calculation**:
  1. Filesystem-based: Parse video filenames to find correct chunk
  2. Database-based: Query Python script for offset
  3. Direct: Use offset_index parameter
  
- **Dual seeking modes**:
  - Fast seek (-ss before -i): Faster but less accurate
  - Accurate seek (-ss after -i): Slower but frame-accurate
  
- **Fallback attempts**: Tries multiple seek positions if extraction fails
- **Thumbnail support**: Optional 50% scaling for thumbnails
- **Duration checking**: Uses ffprobe to validate seek positions

**Comments Added**:
- Detailed explanation of each seeking strategy
- FFmpeg argument building logic
- Error handling and retry mechanism
- Video chunk filename parsing algorithm

---

### 4. **web/app/api/video/neighbor/route.ts** - Frame Navigation API
**Purpose**: Finds adjacent video frames for navigation

**Key Features**:
- Accepts file_path, offset_index, and direction (prev/next)
- Calls Python script to query database
- Returns next/previous frame info or end indicator
- Used by video player for frame-by-frame navigation

**Comments Added**:
- Parameter validation explanations
- Python script invocation details
- Response format documentation

---

### 5. **web/app/api/video/search/route.ts** - Search API
**Purpose**: Searches OCR text and audio transcriptions

**Key Features**:
- **Multi-source search**: OCR frames and/or audio transcriptions
- **Filtering options**: Query text, app name, start time
- **Pagination**: Limit and offset parameters
- **Audio-to-frame mapping**: Links audio results to nearest video frames
- **Environment variables**: Database paths from env

**Comments Added**:
- Parameter extraction and validation
- Database path configuration
- Python script argument building
- Response format documentation

---

### 6. **web/app/video/page.tsx** - Video Search Page
**Purpose**: Search and view video frames with OCR/audio results

**Key Features**:
- **Search interface**:
  - Text query input
  - App name filter
  - Start time filter
  - Source selection (OCR/Audio checkboxes)
  
- **Results display**:
  - Thumbnail grid for OCR frames
  - Transcription cards for audio results
  - Double-click to open in viewer
  
- **Frame viewer**:
  - Prev/Next navigation
  - Play mode with adjustable speed
  - Fit-to-viewer or actual-size display
  - Frame metadata display

**State Management**:
- Search form state (query, filters)
- Results state (ocr, audio arrays)
- Viewer state (current frame, playing, fitMode)
- Loading states

**Comments Added**:
- Type definitions with field explanations
- State variable purposes
- Function-level documentation
- UI component descriptions
- Effect cleanup explanations

---

### 7. **web/app/s/[id]/page.tsx** - Session Player Page
**Purpose**: Audio player with speech-only toggle and transcript sync

**Key Features**:
- **Timeline Conversion System**:
  - `speechToOriginal()`: Maps speech-only time → original time
  - `originalToSpeech()`: Maps original time → speech-only time
  - Segment-based bidirectional mapping
  
- **Speech-Only Mode**:
  - Toggle between original and speech-only audio
  - Preserves playback position during switch
  - Automatically disabled if assets unavailable
  
- **Transcript Sync**:
  - Highlights currently playing line
  - Click line to seek to that position
  - Timestamps always show original time
  
- **Playback Controls**:
  - Play/Pause buttons
  - Skip ±5 seconds
  - HTML5 audio controls

**Timeline Conversion Algorithm**:
```typescript
// For each speech segment:
// - original_start → original_end (in full recording)
// - speech_start → speech_end (in speech-only)
// 
// To convert speech time to original:
// 1. Find segment containing speech time
// 2. Calculate offset within segment
// 3. Add offset to original_start
//
// Example:
// Segment: original 10s-20s → speech 0s-10s
// Speech time 5s → Original time 15s
```

**Comments Added**:
- Comprehensive type definitions
- Timeline processing logic
- Converter function algorithms
- State management explanations
- Effect purposes and cleanup
- UI component descriptions

---

## Key Architectural Patterns Explained

### 1. Server vs Client Components
- **page.tsx** (home): Server Component - fetches data at build/request time
- **layout.tsx**: Server Component - static wrapper
- **video/page.tsx**: Client Component - interactive state management
- **s/[id]/page.tsx**: Client Component - complex state and audio playback

### 2. API Route Pattern
All API routes follow this pattern:
```typescript
1. Force Node.js runtime (export const runtime = "nodejs")
2. Disable caching (export const dynamic = "force-dynamic")
3. Extract and validate parameters
4. Call Python script or FFmpeg
5. Return JSON or binary response
```

### 3. State Management Strategy
- **Local state** for UI interactions (useState)
- **Refs** for DOM access and stable values (useRef)
- **Memoization** for expensive computations (useMemo)
- **Callbacks** for stable function references (useCallback)
- **Effects** for side effects and cleanup (useEffect)

### 4. Timeline Conversion Pattern
The session player uses a sophisticated time mapping system:

**Problem**: Play speech-only audio while showing original timestamps

**Solution**: Bidirectional time converters
- Timeline segments map speech regions to original positions
- Converters iterate through segments to find correct mapping
- Handles edge cases (before first segment, after last segment)

**Use Cases**:
- Display correct timestamp during playback
- Seek to original time when clicking transcript
- Preserve position when toggling speech mode

---

## Error Handling Patterns

### API Routes
```typescript
// 1. Parameter validation
if (!required) return 400 error

// 2. Environment check  
if (!env.VAR) return 400 error

// 3. Process execution
if (code !== 0) return 500 error

// 4. Success response
return data with proper headers
```

### React Components
```typescript
// 1. Try-catch in async functions
catch (e) { setErrorMsg(...) }

// 2. Optional chaining for safety
manifest?.audio?.timeline

// 3. Fallback values
value ?? defaultValue

// 4. Conditional rendering
{error && <ErrorDisplay />}
```

---

## Performance Optimizations

### 1. Memoization
- `useMemo` for timeline processing (expensive sort/validate)
- `useMemo` for converter functions (avoid recreation)
- `useMemo` for audio URL (prevent unnecessary rerenders)

### 2. Callback Stability
- `useCallback` for event handlers passed to children
- Prevents unnecessary child rerenders

### 3. Effect Cleanup
- Clear timeouts on unmount
- Remove event listeners
- Cancel async operations with flags

### 4. Image Key Strategy
```typescript
const imgKey = useMemo(() => 
  `${file_path}:${offset_index}`, 
  [current]
);
// Forces img reload when frame changes
```

---

## Component Communication Flow

### Video Search Flow:
```
User Input → doSearch() 
  → /api/video/search
  → Python script
  → Database queries
  → JSON response
  → Update state
  → Render results
```

### Frame Viewing Flow:
```
Double-click thumbnail → openItem()
  → Update current state
  → imgKey changes
  → <img> requests new frame
  → /api/video/frame
  → FFmpeg extraction
  → JPEG response
```

### Session Playback Flow:
```
Load page → Fetch manifest + transcript
  → Parse timeline
  → Create converters
  → Select audio URL
  → Render player
  
During playback:
  Audio position → Convert time → Find line → Highlight
  
Click transcript:
  Original time → Convert (if speech mode) → Seek → Play
```

---

## TypeScript Type Safety

All components use strict typing:
- **Props**: Typed interfaces for component props
- **State**: Explicit type annotations for useState
- **API responses**: Type definitions for data structures
- **Functions**: Return type annotations
- **Events**: Typed event handlers

**Benefits**:
- Catch errors at compile time
- Autocomplete in IDE
- Self-documenting code
- Refactoring safety

---

## Testing Considerations

### API Routes
```bash
# Test frame extraction
curl "http://localhost:3000/api/video/frame?file_path=...&offset_index=5"

# Test search
curl "http://localhost:3000/api/video/search?q=test&sources=ocr"

# Test neighbor
curl "http://localhost:3000/api/video/neighbor?file_path=...&offset_index=5&dir=next"
```

### React Components
- Test timeline conversion with various segment configurations
- Verify state updates on user interactions
- Check cleanup in useEffect hooks
- Validate error handling paths

---

## Future Enhancement Ideas

Based on the documented code:

1. **Session Player**:
   - Add waveform visualization
   - Implement frame viewer integration
   - Support multiple audio tracks
   - Export transcript feature

2. **Video Search**:
   - Infinite scroll for results
   - Advanced filters (date range, duration)
   - Save search queries
   - Bookmark favorite frames

3. **API Routes**:
   - Request caching
   - Rate limiting
   - WebSocket for real-time updates
   - Batch operations

---

## Summary

All TypeScript files now have comprehensive inline documentation explaining:
- **Purpose** of each component/route
- **Logic** of complex algorithms
- **State management** strategies
- **Side effects** and cleanup
- **Type definitions** and data structures
- **User interactions** and event handling

This documentation makes the codebase:
- ✅ More maintainable
- ✅ Easier to onboard new developers
- ✅ Better for debugging
- ✅ Ready for future enhancements

