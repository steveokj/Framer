import { NextRequest } from "next/server";
import { spawn } from "child_process";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function runFfmpeg(ffmpeg: string, args: string[]) {
  return new Promise<{ ok: boolean; buf?: Buffer; err?: string }>((resolve) => {
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (d) => chunks.push(Buffer.from(d)));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      if (code === 0 && chunks.length > 0) {
        resolve({ ok: true, buf: Buffer.concat(chunks) });
      } else {
        resolve({ ok: false, err: stderr || "ffmpeg failed" });
      }
    });
    child.on("error", () => resolve({ ok: false, err: "ffmpeg spawn error" }));
  });
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const filePath = url.searchParams.get("file_path");
  const offsetMsRaw = url.searchParams.get("offset_ms") || "0";
  const maxWidthRaw = url.searchParams.get("max_width") || "";

  if (!filePath) {
    return new Response(JSON.stringify({ error: "Missing file_path" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const offsetMs = Number(offsetMsRaw);
  const offsetSec = Number.isFinite(offsetMs) ? Math.max(0, offsetMs) / 1000 : 0;
  const maxWidth = maxWidthRaw ? Number(maxWidthRaw) : 0;
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";

  const vf = maxWidth && Number.isFinite(maxWidth)
    ? `scale=${Math.max(1, Math.round(maxWidth))}:-1,format=yuvj420p`
    : "format=yuvj420p";

  const buildArgs = (seekAfter: boolean) => {
    const ss = offsetSec.toFixed(3);
    const args: string[] = ["-y", "-loglevel", "error"];
    if (seekAfter) {
      args.push("-i", filePath, "-ss", ss);
    } else {
      args.push("-ss", ss, "-i", filePath);
    }
    args.push(
      "-an",
      "-frames:v",
      "1",
      "-vf",
      vf,
      "-pix_fmt",
      "yuvj420p",
      "-c:v",
      "mjpeg",
      "-q:v",
      "2",
      "-f",
      "mjpeg",
      "pipe:1",
    );
    return args;
  };

  let res = await runFfmpeg(ffmpeg, buildArgs(false));
  if (!res.ok) {
    res = await runFfmpeg(ffmpeg, buildArgs(true));
  }

  if (res.ok && res.buf) {
    return new Response(res.buf, {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" },
    });
  }

  return new Response(JSON.stringify({ error: res.err || "ffmpeg failed" }), {
    status: 500,
    headers: { "Content-Type": "application/json" },
  });
}
