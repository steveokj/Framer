// API endpoint for searching OCR text and audio transcriptions
// Bridges Next.js frontend with Python database query script
import { NextRequest } from "next/server";
import { spawn } from "child_process";
import path from "path";

// Force Node.js runtime for child_process support
export const runtime = "nodejs";
// Disable static optimization for dynamic requests
export const dynamic = "force-dynamic";

// Helper function to execute Python scripts and capture output
// Returns stdout, stderr, and exit code for error handling
function runPython(args: string[]) {
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
    const py = process.env.PYTHON || "python";
    const child = spawn(py, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
    child.on("error", () => resolve({ stdout: "", stderr: "spawn error", code: 1 }));
  });
}

// Main GET handler for video/audio search
// Supports filtering by query text, app name, start time, and source types
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  
  // Extract and validate search parameters
  const q = (url.searchParams.get("q") || "").trim(); // Search query text
  const sources = (url.searchParams.get("sources") || "ocr").toLowerCase(); // "ocr", "audio", or "ocr,audio"
  const appName = url.searchParams.get("app_name") || ""; // Filter by application name (OCR only)
  const startTime = url.searchParams.get("start_time") || ""; // ISO timestamp filter
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") || 24))); // Results per page
  const offset = Math.max(0, Number(url.searchParams.get("offset") || 0)); // Pagination offset
  const mapAudioToFrames = url.searchParams.get("map_audio_to_frames") ?? "1"; // Link audio to nearest frames

  // Database paths from environment
  const screenpipeDbPath = process.env.SCREENPIPE_DB_PATH || ""; // Video/OCR database
  const audioDbPath = process.env.TRANSCRIPTIONS_DB_PATH || path.join(process.cwd(), "..", "transcriptions.sqlite3");

  // Build arguments for Python search script
  const script = path.join(process.cwd(), "scripts", "video_query.py");
  const args = [
    script,
    "search", // Command to search databases
    "--q",
    q, // Search text
    "--sources",
    sources, // Which databases to search (ocr, audio, or both)
    "--app_name",
    appName, // Filter by app (e.g., "chrome", "vscode")
    "--start_time",
    startTime, // Filter results after this timestamp
    "--limit",
    String(limit), // Max results to return
    "--offset",
    String(offset), // Pagination offset
    "--screenpipe_db",
    screenpipeDbPath, // Path to OCR/frames database
    "--audio_db",
    audioDbPath, // Path to audio transcriptions database
    "--map_audio_to_frames",
    mapAudioToFrames, // Whether to link audio results to nearest video frames
  ];

  // Execute Python script
  const { stdout, stderr, code } = await runPython(args);
  
  if (code !== 0) {
    // Python script failed
    return new Response(JSON.stringify({ error: "python failed", details: stderr || stdout }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  
  // Return JSON response from Python script
  // Format: { data: { ocr: [...], audio: [...] } }
  return new Response(stdout, { headers: { "Content-Type": "application/json" } });
}
