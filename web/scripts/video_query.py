#!/usr/bin/env python3
# Query script for searching OCR and audio transcription databases
# Supports video frame search, neighbor navigation, and timestamp offset calculation
# Used by Next.js API routes to bridge between web UI and SQLite databases

import argparse  # For parsing command-line arguments
import json  # For outputting JSON responses
import sqlite3  # For querying SQLite databases
from typing import Any, Dict, List, Optional  # Type hints for better code documentation
from datetime import datetime  # For timestamp parsing and calculations


# Opens a SQLite database connection with optimizations for concurrent reading
# Returns connection configured with Row factory and performance pragmas
# Args:
#   path: str - File path to the SQLite database
# Returns:
#   sqlite3.Connection - Configured database connection
def open_db(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path, check_same_thread=False)  # Allow multi-threaded access
    conn.row_factory = sqlite3.Row  # Return rows as dict-like objects instead of tuples
    
    # Apply concurrency-friendly pragmas for better read performance
    try:
        conn.execute("PRAGMA journal_mode = WAL;")  # Enable Write-Ahead Logging for concurrent readers
    except Exception:
        pass  # Ignore if already in WAL mode or not supported
    
    conn.execute("PRAGMA busy_timeout = 2000;")  # Wait up to 2 seconds if database is locked
    conn.execute("PRAGMA cache_size = -2000;")  # Use 2MB cache for better query performance
    conn.execute("PRAGMA temp_store = MEMORY;")  # Store temp tables in memory instead of disk
    return conn


# Checks if a table exists in the database
# Used to detect if FTS (Full-Text Search) tables are available for faster searching
# Args:
#   conn: sqlite3.Connection - Database connection
#   name: str - Name of the table to check
# Returns:
#   bool - True if table exists, False otherwise
def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",  # Query system table
        (name,),  # Table name parameter (prevents SQL injection)
    ).fetchone()
    return row is not None  # If row found, table exists


# Searches OCR frames and audio transcriptions across databases
# Returns combined results with optional mapping of audio to nearest video frames
# Supports full-text search via FTS indexes when available
# Args:
#   q: str - Search query text (e.g., "error message")
#   sources: List[str] - Which databases to search (["ocr"], ["audio"], or ["ocr", "audio"])
#   app_name: str - Filter OCR results by application name (e.g., "chrome", "vscode")
#   start_time: str - Filter results after this ISO timestamp (e.g., "2024-01-15T10:00:00Z")
#   limit: int - Maximum number of results to return per source
#   offset: int - Pagination offset (skip this many results)
#   screenpipe_db: Optional[str] - Path to OCR/frames database (or None)
#   audio_db: Optional[str] - Path to audio transcriptions database (or None)
#   map_audio_to_frames: bool - Whether to link audio results to nearest video frames
# Returns:
#   Dict with structure: {"data": {"ocr": [...], "audio": [...]}}
def search(
    q: str,
    sources: List[str],
    app_name: str,
    start_time: str,
    limit: int,
    offset: int,
    screenpipe_db: Optional[str],
    audio_db: Optional[str],
    map_audio_to_frames: bool,
) -> Dict[str, Any]:
    result: Dict[str, Any] = {"data": {"ocr": [], "audio": []}}  # Initialize empty result structure

    # Search OCR text from screenpipe database (video frames with text)
    if "ocr" in sources and screenpipe_db:
        oc = open_db(screenpipe_db)  # Open connection to OCR database
        try:
            use_fts = table_exists(oc, "ocr_text_fts")  # Check if FTS index exists for faster text search
            params: List[Any] = []  # Parameters for SQL query (prevents SQL injection)
            where_parts: List[str] = ["1=1"]  # Start with always-true condition to simplify AND logic
            join = ""  # Additional JOIN clauses (for FTS)
            
            # Build query based on search text
            if q:  # If search query provided
                if use_fts:  # Use full-text search for faster matching
                    join += " JOIN ocr_text_fts ON ocr_text.frame_id = ocr_text_fts.frame_id "
                    where_parts.append("ocr_text_fts MATCH ?")  # FTS MATCH syntax
                    params.append(q)  # Add query as parameter
                else:  # Fallback to LIKE for substring matching
                    where_parts.append("ocr_text.text LIKE ?")
                    params.append(f"%{q}%")  # Wrap with % for substring search
            
            # Filter by application name if specified
            if app_name:
                where_parts.append("frames.app_name LIKE ?")  # Partial match on app name
                params.append(f"%{app_name}%")  # e.g., "chrom" matches "chrome.exe"
            
            # Filter by timestamp if specified
            if start_time:
                where_parts.append("frames.timestamp >= ?")  # Only frames after this time
                params.append(start_time)  # ISO timestamp string

            # Build SQL query joining frames, video_chunks, and ocr_text tables
            # Returns frame metadata along with OCR text and file paths
            sql = f'''
                SELECT
                  frames.id AS frame_id,
                  ocr_text.text AS ocr_text,
                  frames.timestamp AS timestamp,
                  frames.name AS frame_name,
                  video_chunks.file_path AS file_path,
                  frames.offset_index AS offset_index,
                  frames.app_name AS app_name,
                  frames.window_name AS window_name
                FROM frames
                JOIN video_chunks ON frames.video_chunk_id = video_chunks.id
                JOIN ocr_text ON frames.id = ocr_text.frame_id
                {join}
                WHERE {' AND '.join(where_parts)}
                GROUP BY frames.id
                ORDER BY frames.timestamp DESC
                LIMIT ? OFFSET ?
            '''
            params2 = list(params)  # Copy params list
            params2 += [limit, offset]  # Add pagination parameters at the end
            rows = oc.execute(sql, params2).fetchall()  # Execute query and fetch all results
            result["data"]["ocr"] = [dict(r) | {"source": "ocr"} for r in rows]  # Convert rows to dicts and add source field
        finally:
            oc.close()  # Always close database connection

    # Search audio transcriptions from separate database
    if "audio" in sources and audio_db:
        ac = open_db(audio_db)  # Open connection to audio transcriptions database
        try:
            use_fts = table_exists(ac, "audio_transcriptions_fts")  # Check if FTS index exists
            params: List[Any] = []  # SQL parameters list
            where_parts: List[str] = ["1=1"]  # Start with always-true condition
            join = ""  # Additional JOIN clauses
            
            # Build query based on search text
            if q:  # If search query provided
                if use_fts:  # Use full-text search if available
                    join = " JOIN audio_transcriptions_fts fts ON fts.rowid = audio_transcriptions.id "
                    where_parts.append("fts MATCH ?")  # FTS MATCH syntax
                    params.append(q)  # Search query
                else:  # Fallback to LIKE for substring matching
                    where_parts.append("audio_transcriptions.transcription LIKE ?")
                    params.append(f"%{q}%")  # Wrap with % for substring search
            
            # Filter by timestamp if specified
            if start_time:
                where_parts.append("audio_transcriptions.created_at >= ?")  # Only transcriptions after this time
                params.append(start_time)  # ISO timestamp string

            # Build SQL query for audio transcriptions
            sql = f'''
                SELECT id, name, model_size, transcription, created_at
                FROM audio_transcriptions
                {join}
                WHERE {' AND '.join(where_parts)}
                ORDER BY created_at DESC
                LIMIT ? OFFSET ?
            '''
            params2 = list(params) + [limit, offset]  # Combine params with pagination
            rows = ac.execute(sql, params2).fetchall()  # Execute query
            audio_items = []
            for r in rows:
                item = dict(r)
                # Preserve backward compatibility for callers expecting canonical_path
                item.setdefault("canonical_path", item.get("name"))
                item["timestamp"] = item.get("created_at")  # Derived field for backward compatibility
                item["source"] = "audio"
                audio_items.append(item)
        finally:
            ac.close()  # Always close database connection

        # Optionally map audio transcriptions to nearest video frames
        # This allows showing a video frame alongside audio transcriptions in the UI
        if map_audio_to_frames and screenpipe_db and audio_items:
            oc = open_db(screenpipe_db)  # Reopen OCR database for frame queries
            try:
                # Query to find frame closest in time to a given timestamp
                # Uses julianday() to calculate absolute time difference in seconds
                nearest_sql = (
                    """
                    SELECT f.id as frame_id, f.timestamp as frame_timestamp, f.offset_index, vc.file_path
                    FROM frames f
                    JOIN video_chunks vc ON f.video_chunk_id = vc.id
                    ORDER BY ABS((julianday(f.timestamp) - julianday(?))*86400.0) ASC
                    LIMIT 1
                    """
                )
                # For each audio item, find the nearest video frame
                for item in audio_items:
                    try:
                        m = oc.execute(nearest_sql, (item["timestamp"],)).fetchone()  # Query nearest frame
                        if m is None:  # No frames found
                            continue
                        
                        # Calculate time difference between audio and frame timestamps
                        diff = abs(
                            (
                                datetime.fromisoformat(str(m["frame_timestamp"]).replace("Z", "+00:00")).timestamp()
                                - datetime.fromisoformat(str(item["timestamp"]).replace("Z", "+00:00")).timestamp()
                            )
                        )
                        
                        # Only associate if frame is within 5 seconds of audio
                        if diff <= 5:  # 5 second tolerance
                            item["nearest_frame"] = {
                                "file_path": m["file_path"],
                                "offset_index": m["offset_index"],
                                "frame_id": m["frame_id"],
                                "frame_timestamp": m["frame_timestamp"],
                            }
                    except Exception:
                        pass  # Skip this item if timestamp parsing fails
            finally:
                oc.close()  # Always close connection

        result["data"]["audio"] = audio_items  # Add audio results to response

    return result  # Return combined search results


# Finds the next or previous video frame within the same video chunk
# Used for frame-by-frame navigation in the video player UI
# Args:
#   screenpipe_db: str - Path to the OCR/frames database
#   file_path: str - Video file path (e.g., "monitor_1_2024-01-15_14-30-45.mp4")
#   offset_index: int - Current frame offset in seconds
#   direction: str - "prev" or "next"
# Returns:
#   Dict with frame info: {"file_path": str, "offset_index": int, "timestamp": str}
#   Or end indicator: {"end": True} if no more frames in that direction
#   Or error: {"error": str} if video chunk not found
def neighbor(screenpipe_db: str, file_path: str, offset_index: int, direction: str) -> Dict[str, Any]:
    oc = open_db(screenpipe_db)  # Open database connection
    try:
        # Find the video chunk containing this file
        chunk = oc.execute(
            "SELECT id FROM video_chunks WHERE file_path = ? LIMIT 1", (file_path,)
        ).fetchone()
        if not chunk:  # Video file not found in database
            return {"error": "video_chunk not found for file_path"}

        # Build query based on direction
        if direction == "prev":
            # Find largest offset_index that's smaller than current (previous frame)
            sql = (
                "SELECT offset_index, timestamp FROM frames WHERE video_chunk_id = ? AND offset_index < ? ORDER BY offset_index DESC LIMIT 1"
            )
        else:
            # Find smallest offset_index that's larger than current (next frame)
            sql = (
                "SELECT offset_index, timestamp FROM frames WHERE video_chunk_id = ? AND offset_index > ? ORDER BY offset_index ASC LIMIT 1"
            )
        
        row = oc.execute(sql, (chunk["id"], offset_index)).fetchone()  # Execute query
        if not row:  # No more frames in that direction
            return {"end": True}  # Return end indicator
        
        # Return frame information
        return {
            "file_path": file_path,  # Same video file
            "offset_index": row["offset_index"],  # New offset
            "timestamp": row["timestamp"],  # Frame timestamp
        }
    finally:
        oc.close()  # Always close connection


# Parses ISO timestamp strings with timezone handling
# Tries multiple formats for robustness
# Args:
#   ts: str - ISO timestamp string (e.g., "2024-01-15T10:30:45Z")
# Returns:
#   datetime object or None if parsing fails
def parse_ts(ts: str) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00"))  # Try ISO format with timezone
    except Exception:
        try:
            return datetime.strptime(str(ts)[:19], "%Y-%m-%dT%H:%M:%S")  # Fallback: format without timezone
        except Exception:
            return None  # Parsing failed


# Calculates offset in seconds of a frame timestamp from the start of its video chunk
# Used by ffmpeg to seek to the correct position within a video file
# Args:
#   screenpipe_db: str - Path to the OCR/frames database
#   file_path: str - Video file path
#   frame_timestamp: str - ISO timestamp of the desired frame
# Returns:
#   Dict with offset: {"offset_sec": float}
#   Or error: {"error": str} if video chunk not found or timestamps invalid
def offset_seconds(screenpipe_db: str, file_path: str, frame_timestamp: str) -> Dict[str, Any]:
    oc = open_db(screenpipe_db)  # Open database connection
    try:
        # Find video chunk ID for this file
        chunk = oc.execute(
            "SELECT id FROM video_chunks WHERE file_path = ? LIMIT 1", (file_path,)
        ).fetchone()
        if not chunk:  # Video file not found
            return {"error": "video_chunk not found for file_path"}
        
        # Find the earliest frame timestamp in this chunk (video start time)
        row = oc.execute(
            "SELECT MIN(timestamp) AS start_ts FROM frames WHERE video_chunk_id = ?",
            (chunk["id"],),
        ).fetchone()
        if not row or row["start_ts"] is None:  # No frames in this chunk
            return {"error": "no frames for video_chunk"}
        
        # Parse both timestamps
        start_dt = parse_ts(row["start_ts"])  # Video chunk start time
        frame_dt = parse_ts(frame_timestamp)  # Desired frame time
        if not start_dt or not frame_dt:  # Parsing failed
            return {"error": "failed to parse timestamps"}
        
        # Calculate offset in seconds from video start
        diff = (frame_dt - start_dt).total_seconds()
        if diff < 0:  # Frame is before video start (shouldn't happen)
            diff = 0.0  # Clamp to 0
        
        return {"offset_sec": diff}  # Return offset for ffmpeg seeking
    finally:
        oc.close()  # Always close connection


# Main CLI entry point
# Parses command line arguments and routes to appropriate function
# Outputs JSON results to stdout for consumption by Node.js API routes
# Commands: search, neighbor, offset
def main() -> None:
    p = argparse.ArgumentParser()  # Create argument parser
    sub = p.add_subparsers(dest="cmd", required=True)  # Create subcommands (search, neighbor, offset)

    # Define "search" command and its arguments
    s = sub.add_parser("search")  # Search OCR and audio databases
    s.add_argument("--q", default="")  # Search query text
    s.add_argument("--sources", default="ocr")  # Comma-separated: "ocr", "audio", or "ocr,audio"
    s.add_argument("--app_name", default="")  # Filter by app name (OCR only)
    s.add_argument("--start_time", default="")  # Filter by timestamp (ISO format)
    s.add_argument("--limit", type=int, default=24)  # Max results per source
    s.add_argument("--offset", type=int, default=0)  # Pagination offset
    s.add_argument("--screenpipe_db", default="")  # Path to OCR database
    s.add_argument("--audio_db", default="")  # Path to audio database
    s.add_argument("--map_audio_to_frames", default="1")  # Link audio to nearest frames (1=yes, 0=no)

    # Define "neighbor" command and its arguments
    n = sub.add_parser("neighbor")  # Find adjacent frame
    n.add_argument("--screenpipe_db", required=True)  # Path to OCR database
    n.add_argument("--file_path", required=True)  # Video file path
    n.add_argument("--offset_index", type=int, required=True)  # Current frame offset
    n.add_argument("--dir", default="next")  # Direction: "prev" or "next"

    # Define "offset" command and its arguments
    o = sub.add_parser("offset")  # Calculate frame offset
    o.add_argument("--screenpipe_db", required=True)  # Path to OCR database
    o.add_argument("--file_path", required=True)  # Video file path
    o.add_argument("--timestamp", required=True)  # Frame timestamp (ISO format)

    args = p.parse_args()  # Parse command line arguments

    # Route to appropriate function based on command
    if args.cmd == "search":
        # Parse sources from comma-separated string to list
        sources = [s for s in args.sources.split(",") if s]  # e.g., "ocr,audio" -> ["ocr", "audio"]
        
        # Execute search command
        res = search(
            q=args.q,  # Search query
            sources=sources,  # Which databases to search
            app_name=args.app_name,  # App filter
            start_time=args.start_time,  # Time filter
            limit=args.limit,  # Max results
            offset=args.offset,  # Pagination
            screenpipe_db=args.screenpipe_db or None,  # OCR database path (or None)
            audio_db=args.audio_db or None,  # Audio database path (or None)
            map_audio_to_frames=(args.map_audio_to_frames not in ("0", "false", "False", "no", "")),  # Convert to bool
        )
        print(json.dumps(res))  # Output JSON to stdout
        
    elif args.cmd == "neighbor":
        # Execute neighbor command to find adjacent frame
        res = neighbor(
            screenpipe_db=args.screenpipe_db,  # Database path
            file_path=args.file_path,  # Video file
            offset_index=args.offset_index,  # Current offset
            direction=args.dir,  # "prev" or "next"
        )
        print(json.dumps(res))  # Output JSON to stdout
        
    elif args.cmd == "offset":
        # Execute offset command to calculate frame position
        res = offset_seconds(
            screenpipe_db=args.screenpipe_db,  # Database path
            file_path=args.file_path,  # Video file
            frame_timestamp=args.timestamp,  # Target timestamp
        )
        print(json.dumps(res))  # Output JSON to stdout


# Entry point when script is executed directly
if __name__ == "__main__":
    main()  # Run main function
