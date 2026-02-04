import { NextRequest } from "next/server";
import { spawn } from "child_process";
import path from "path";
import os from "os";
import fs from "fs/promises";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    child.on("close", (code) => {
      resolve({ ok: code === 0, err: stderr || "ffmpeg failed" });
    });
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
  const lang = String(body?.lang || "eng");
  const preprocess = String(body?.preprocess || "none");
  const psm = body?.psm != null ? String(body.psm) : "";
  const oem = body?.oem != null ? String(body.oem) : "";
  const scale = body?.scale != null ? String(body.scale) : "";

  if (!filePath || !Number.isFinite(offsetMs)) {
    return new Response(JSON.stringify({ error: "Missing filePath or offsetMs" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mkv-ocr-"));
  const framePath = path.join(tempDir, "frame.jpg");
  try {
    const extracted = await extractFrame(filePath, offsetMs, framePath);
    if (!extracted.ok) {
      return new Response(JSON.stringify({ error: extracted.err || "Failed to extract frame" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const scriptPath = path.join(process.cwd(), "..", "tools", "scripts", "timestone_ocr_frame.py");
    const args = [scriptPath, "--image", framePath, "--lang", lang, "--preprocess", preprocess];
    if (psm) args.push("--psm", psm);
    if (oem) args.push("--oem", oem);
    if (scale) args.push("--scale", scale);
    const tess = process.env.TESSERACT_CMD || process.env.TESSERACT_PATH || "";
    if (tess) {
      args.push("--tesseract", tess);
    }

    const { stdout, stderr, code } = await runPython(args);
    if (code !== 0) {
      return new Response(JSON.stringify({ error: stderr || stdout || "OCR failed" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    const payload = JSON.parse(stdout);
    return new Response(JSON.stringify(payload), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "OCR failed";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
