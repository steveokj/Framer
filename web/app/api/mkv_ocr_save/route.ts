import { NextRequest } from "next/server";
import { spawn } from "child_process";
import path from "path";
import fs from "fs/promises";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DB_DEFAULT = path.join(process.cwd(), "..", "data", "timestone", "timestone_events.sqlite3");
const OUT_DIR = path.join(process.cwd(), "..", "data", "timestone", "live_ocr_frames");

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

function runFfmpeg(ffmpeg: string, args: string[]) {
  return new Promise<{ ok: boolean; err?: string }>((resolve) => {
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ ok: code === 0, err: stderr || "ffmpeg failed" }));
    child.on("error", () => resolve({ ok: false, err: "ffmpeg spawn error" }));
  });
}

async function extractFrame(filePath: string, offsetMs: number, destPath: string) {
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  const offsetSec = Math.max(0, offsetMs) / 1000;
  const ss = offsetSec.toFixed(3);
  const args = [
    "-y",
    "-loglevel",
    "error",
    "-ss",
    ss,
    "-i",
    filePath,
    "-an",
    "-frames:v",
    "1",
    "-vf",
    "format=yuvj420p",
    "-pix_fmt",
    "yuvj420p",
    "-c:v",
    "mjpeg",
    "-q:v",
    "2",
    destPath,
  ];
  let res = await runFfmpeg(ffmpeg, args);
  if (res.ok) return res;
  const argsAccurate = [
    "-y",
    "-loglevel",
    "error",
    "-i",
    filePath,
    "-ss",
    ss,
    "-an",
    "-frames:v",
    "1",
    "-vf",
    "format=yuvj420p",
    "-pix_fmt",
    "yuvj420p",
    "-c:v",
    "mjpeg",
    "-q:v",
    "2",
    destPath,
  ];
  return await runFfmpeg(ffmpeg, argsAccurate);
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const filePath = String(body?.filePath || "");
  const offsetMs = Number(body?.offsetMs);
  const eventId = Number(body?.eventId);
  const lang = String(body?.lang || "eng");
  const preprocess = String(body?.preprocess || "none");
  const psm = body?.psm != null ? String(body.psm) : "";
  const oem = body?.oem != null ? String(body.oem) : "";
  const scale = body?.scale != null ? String(body.scale) : "";
  const dbPath = String(body?.dbPath || DB_DEFAULT);
  const engine = String(body?.engine || "tesseract");

  if (!filePath || !Number.isFinite(offsetMs) || !Number.isFinite(eventId)) {
    return new Response(JSON.stringify({ error: "Missing filePath, offsetMs, or eventId" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  const filename = `event_${eventId}_${Math.round(offsetMs)}_${Date.now()}.jpg`;
  const destPath = path.join(OUT_DIR, filename);

  const extracted = await extractFrame(filePath, offsetMs, destPath);
  if (!extracted.ok) {
    return new Response(JSON.stringify({ error: extracted.err || "Failed to extract frame" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const scriptPath = path.join(process.cwd(), "..", "tools", "scripts", "timestone_ocr_frame.py");
  const args = [
    scriptPath,
    "--image",
    destPath,
    "--lang",
    lang,
    "--preprocess",
    preprocess,
    "--save-db",
    "--db",
    dbPath,
    "--event-id",
    String(eventId),
    "--engine",
    engine,
  ];
  if (psm) args.push("--psm", psm);
  if (oem) args.push("--oem", oem);
  if (scale) args.push("--scale", scale);
  const tess = process.env.TESSERACT_CMD || process.env.TESSERACT_PATH || "";
  if (tess) args.push("--tesseract", tess);

  const { stdout, stderr, code } = await runPython(args);
  if (code !== 0) {
    return new Response(JSON.stringify({ error: stderr || stdout || "OCR save failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  let payload: any = {};
  try {
    payload = JSON.parse(stdout);
  } catch {
    payload = {};
  }

  return new Response(JSON.stringify({ framePath: destPath, ocr: payload }), {
    headers: { "Content-Type": "application/json" },
  });
}
