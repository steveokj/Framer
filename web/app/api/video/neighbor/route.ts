// API endpoint for navigating to adjacent video frames
// Finds the next or previous frame within the same video chunk
import { NextRequest } from "next/server"; // Next.js request type
import { spawn } from "child_process"; // For executing Python scripts
import path from "path"; // For constructing file paths

// Force Node.js runtime for child_process support
// (Edge runtime doesn't support child_process)
export const runtime = "nodejs";

// Disable static optimization for dynamic requests
// Forces fresh execution on each request
export const dynamic = "force-dynamic";

// Helper function to execute Python scripts and capture output
// Returns stdout, stderr, and exit code for error handling
// Args: array of command-line arguments to pass to Python
function runPython(args: string[]) {
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
    const py = process.env.PYTHON || "python"; // Use env var or default to "python"
    const child = spawn(py, args, { stdio: ["ignore", "pipe", "pipe"] }); // Spawn Python process
    let stdout = ""; // Accumulate standard output
    let stderr = ""; // Accumulate standard error
    child.stdout.on("data", (d) => (stdout += d.toString())); // Collect stdout chunks
    child.stderr.on("data", (d) => (stderr += d.toString())); // Collect stderr chunks
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 })); // Process exited
    child.on("error", () => resolve({ stdout: "", stderr: "spawn error", code: 1 })); // Spawn failed
  });
}

// Main GET handler for neighbor frame navigation
// Accepts file_path, offset_index, and dir (prev/next)
// Returns JSON with next/prev frame info or end indicator
export async function GET(req: NextRequest) {
  // Parse URL to extract query parameters
  const url = new URL(req.url);
  const filePath = url.searchParams.get("file_path"); // Video file path (e.g., "monitor_1_2024-01-15_14-30-45.mp4")
  const offsetIndexRaw = url.searchParams.get("offset_index"); // Current frame offset in seconds (as string)
  const dir = (url.searchParams.get("dir") || "next").toLowerCase(); // Direction: "prev" or "next" (default "next")
  const screenpipeDbPath = process.env.SCREENPIPE_DB_PATH || ""; // Database path from environment

  // Validate required parameters
  // Both file_path and offset_index must be provided
  if (!filePath || !offsetIndexRaw) {
    return new Response(JSON.stringify({ error: "Missing file_path or offset_index" }), {
      status: 400, // Bad Request
      headers: { "Content-Type": "application/json" },
    });
  }
  
  // Ensure database path is configured
  // Script needs this to query frame database
  if (!screenpipeDbPath) {
    return new Response(JSON.stringify({ error: "SCREENPIPE_DB_PATH not set" }), {
      status: 400, // Bad Request
      headers: { "Content-Type": "application/json" },
    });
  }

  // Validate offset_index is a valid number
  // Convert string to number and check it's finite
  const offsetIndex = Number(offsetIndexRaw); // Parse string to number
  if (!isFinite(offsetIndex)) { // Check for NaN, Infinity, -Infinity
    return new Response(JSON.stringify({ error: "Invalid offset_index" }), {
      status: 400, // Bad Request
      headers: { "Content-Type": "application/json" },
    });
  }

  // Call Python script to query database for adjacent frame
  // The script finds the next/prev frame in the same video chunk
  // Python script queries: SELECT ... FROM frames WHERE video_chunk_id = ? AND offset_index [>/<] ? ORDER BY offset_index [ASC/DESC] LIMIT 1
  const script = path.join(process.cwd(), "scripts", "video_query.py"); // Build path to Python script
  const args = [
    script, // Script path
    "neighbor", // Command to find adjacent frame
    "--file_path", // Parameter name
    filePath, // Current video file
    "--offset_index", // Parameter name
    String(offsetIndex), // Current frame offset (converted to string)
    "--dir", // Parameter name
    dir, // Direction: "prev" or "next"
    "--screenpipe_db", // Parameter name
    screenpipeDbPath, // Database file path
  ];
  
  // Execute Python script and wait for completion
  const { stdout, stderr, code } = await runPython(args);
  
  // Check if Python script executed successfully
  if (code !== 0) {
    // Python script failed - return error with details
    return new Response(JSON.stringify({ error: "python failed", details: stderr || stdout }), {
      status: 500, // Internal Server Error
      headers: { "Content-Type": "application/json" },
    });
  }
  
  // Return the JSON response from Python script
  // Success case: { file_path, offset_index, timestamp }
  // End case: { end: true } (no more frames in that direction)
  return new Response(stdout, { headers: { "Content-Type": "application/json" } });
}
