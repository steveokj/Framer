// API endpoint for extracting video frames using FFmpeg
// Supports timestamp-based and offset-based seeking with fallback strategies
import { NextRequest } from "next/server";
import { spawn } from "child_process";
import path from "path";
import fs from "fs/promises";

// Force Node.js runtime (not Edge) for child_process support
export const runtime = "nodejs";
// Disable static optimization to handle dynamic requests
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

// Main GET handler for frame extraction
// Accepts file_path, offset_index, optional timestamp, and optional thumb flag
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  let filePath = url.searchParams.get("file_path");
  const offsetIndex = url.searchParams.get("offset_index"); // seconds offset
  const thumb = url.searchParams.get("thumb"); // if set, scale to 50%
  const timestamp = url.searchParams.get("timestamp"); // ISO timestamp of frame

  // Validate required parameters
  if (!filePath || !offsetIndex) {
    return new Response(JSON.stringify({ error: "Missing file_path or offset_index" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  let ssNum = 0; // Seek position in seconds
  let ssStr = "0.000";
  
  // Strategy 1: Use timestamp-based offset calculation
  // Prefer timestamp over offset_index to handle chunked video files correctly
  if (timestamp) {
    const screenpipeDbPath = process.env.SCREENPIPE_DB_PATH || "";
    if (!screenpipeDbPath) {
      return new Response(JSON.stringify({ error: "SCREENPIPE_DB_PATH not set" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    
    // Try filesystem-based calculation first (faster)
    // Parse filename to find video chunk by monitor ID and timestamp
    const tsMs = Date.parse(timestamp);
    if (!Number.isNaN(tsMs)) {
      const dir = path.dirname(filePath!);
      const base = path.basename(filePath!);
      const m = base.match(/^(monitor_\d+)_/i);
      if (m) {
        const prefix = m[1];
        try {
          const entries = await fs.readdir(dir);
          const candidates: { fp: string; startMs: number }[] = [];
          
          // Build list of video chunks with their start times
          for (const name of entries) {
            if (!name.startsWith(prefix + "_") || !name.toLowerCase().endsWith(".mp4")) continue;
            // Parse filename format: monitor_1_2024-01-15_14-30-45.mp4
            const mm = name.match(/^(monitor_\d+)_([0-9]{4}-[0-9]{2}-[0-9]{2})_([0-9]{2}-[0-9]{2}-[0-9]{2})/);
            if (!mm) continue;
            const iso = `${mm[2]}T${mm[3].replace(/-/g, ":")}:00Z`;
            const start = Date.parse(iso);
            if (!Number.isNaN(start)) {
              candidates.push({ fp: path.join(dir, name), startMs: start });
            }
          }
          
          if (candidates.length) {
            candidates.sort((a, b) => a.startMs - b.startMs);
            // Pick the latest chunk that started before or at the frame timestamp
            let chosen = candidates[0];
            for (const c of candidates) {
              if (c.startMs <= tsMs) chosen = c; else break;
            }
            filePath = chosen.fp; // Override DB path with correct chunk file
            const offset = Math.max(0, (tsMs - chosen.startMs) / 1000);
            ssNum = offset;
            ssStr = ssNum.toFixed(3);
          }
        } catch {}
      }
    }
    
    // Strategy 2: Fallback to database-based offset calculation
    // Query Python script to calculate offset from earliest frame in chunk
    if (ssNum === 0 && timestamp) {
      const script = path.join(process.cwd(), "scripts", "video_query.py");
      const args = [
        script,
        "offset",
        "--screenpipe_db",
        screenpipeDbPath,
        "--file_path",
        filePath!,
        "--timestamp",
        timestamp,
      ];
      const { stdout, stderr, code } = await runPython(args);
      if (code !== 0) {
        return new Response(JSON.stringify({ error: "offset calc failed", details: stderr || stdout }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      try {
        const data = JSON.parse(stdout);
        if (data && typeof data.offset_sec === "number") {
          ssNum = Math.max(0, data.offset_sec);
          ssStr = ssNum.toFixed(3);
        }
      } catch {}
    }
  } else if (offsetIndex) {
    // Strategy 3: Use offset_index directly
    const n = Number(offsetIndex);
    ssNum = isFinite(n) ? Math.max(0, n) : 0;
    ssStr = ssNum.toFixed(3);
  }
  
  // Build FFmpeg arguments for frame extraction
  // Using fast seek (-ss before -i) for performance
  function buildArgs(at: number): string[] {
    const ss = Math.max(0, at).toFixed(3);
    const a: string[] = [
      "-y", // Overwrite output
      "-loglevel",
      "error", // Only show errors
      "-ss",
      ss, // Seek position (fast seek when before -i)
      "-i",
      filePath!,
      "-an", // Disable audio
      "-frames:v",
      "1", // Extract single frame
    ];
    if (thumb) {
      // Thumbnail mode: scale to 50% and convert to JPEG-compatible format
      a.push("-vf", "scale=iw*0.5:ih*0.5,format=yuvj420p");
    } else {
      // Full size frame
      a.push("-vf", "format=yuvj420p");
    }
    a.push(
      "-pix_fmt",
      "yuvj420p", // JPEG pixel format
      "-c:v",
      "mjpeg", // Motion JPEG codec
      "-strict",
      "unofficial",
      "-threads",
      "1", // Single thread for faster startup
      "-q:v",
      "8", // JPEG quality (2-31, lower is better)
      "-f",
      "mjpeg",
      "pipe:1", // Output to stdout
    );
    return a;
  }

  // Attempts frame extraction with fallback to accurate seeking
  async function tryAt(at: number): Promise<{ ok: boolean; buf?: Buffer; err?: string }> {
    const run = (args: string[]) =>
      new Promise<{ ok: boolean; buf?: Buffer; err?: string }>((resolve) => {
        const child = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
        const chunks: Buffer[] = [];
        let stderr = "";
        child.stdout.on("data", (d) => chunks.push(Buffer.from(d)));
        child.stderr.on("data", (d) => (stderr += d.toString()));
        child.on("close", (code) => {
          if (code === 0 && chunks.length > 0) {
            resolve({ ok: true, buf: Buffer.concat(chunks) });
          } else {
            resolve({ ok: false, err: stderr });
          }
        });
      });

    // Try fast seek first (-ss before -i)
    // Fast but may not be frame-accurate
    let res = await run(buildArgs(at));
    if (res.ok) return res;

    // Fallback: Accurate seek (-ss after -i)
    // Slower but frame-accurate
    const ss = Math.max(0, at).toFixed(3);
    const argsAccurate: string[] = [
      "-y",
      "-loglevel",
      "error",
      "-i",
      filePath!,
      "-ss",
      ss, // Seek after input = accurate but slow
      "-an",
      "-frames:v",
      "1",
    ];
    if (thumb) {
      argsAccurate.push("-vf", "scale=iw*0.5:ih*0.5,format=yuvj420p");
    } else {
      argsAccurate.push("-vf", "format=yuvj420p");
    }
    argsAccurate.push(
      "-pix_fmt",
      "yuvj420p",
      "-c:v",
      "mjpeg",
      "-strict",
      "unofficial",
      "-threads",
      "1",
      "-q:v",
      "8",
      "-f",
      "mjpeg",
      "pipe:1",
    );
    return await run(argsAccurate);
  }

  // Query video duration using ffprobe
  // Used to clamp seek position and avoid seeking past end
  async function ffprobeDuration(file: string): Promise<number | null> {
    const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => m.replace(/ffmpeg/i, "ffprobe"));
    return await new Promise((resolve) => {
      const child = spawn(ffprobe, [
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        file,
      ], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.on("close", () => {
        try {
          const j = JSON.parse(out);
          const dur = j?.format?.duration ? parseFloat(j.format.duration) : NaN;
          resolve(Number.isFinite(dur) ? dur : null);
        } catch {
          resolve(null);
        }
      });
      child.on("error", () => resolve(null));
    });
  }

  // Try multiple seek positions as fallback strategy
  // Sometimes exact offset doesn't work, try slightly earlier positions
  const dur = await ffprobeDuration(filePath);
  let base = ssNum;
  if (dur != null) {
    // Clamp to slightly before end if seeking past duration
    if (base >= dur) base = Math.max(0, dur - 0.05);
  }
  // Attempt array: exact position, then progressively earlier
  const attempts = [base, base - 0.5, base - 1, base - 2, base - 5, base - 10].filter((x) => x >= 0);
  
  for (const at of attempts) {
    const res = await tryAt(at);
    if (res.ok && res.buf) {
      // Success! Return the JPEG frame
      return new Response(res.buf, {
        headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" },
      });
    }
  }
  
  // All attempts failed
  return new Response(
    JSON.stringify({ error: "ffmpeg failed: empty output after attempts", ss: ssNum, duration: dur, attempts }),
    { status: 500, headers: { "Content-Type": "application/json" } }
  );
}
