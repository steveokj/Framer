import { NextRequest } from "next/server";
import path from "path";
import { spawn } from "child_process";
import fs from "fs/promises";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROJECT_ROOT = path.join(process.cwd(), "..");
const INGEST_SCRIPT = path.join(PROJECT_ROOT, "cli", "mkv_ingest.py");

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function resolvePath(input: string): Promise<string> {
  if (path.isAbsolute(input)) {
    return input;
  }
  const candidateRoot = path.join(PROJECT_ROOT, input);
  if (await fileExists(candidateRoot)) {
    return candidateRoot;
  }
  return path.join(process.cwd(), input);
}

function detectStage(line: string): string | null {
  const lower = line.toLowerCase();
  if (lower.includes("transcribing audio")) {
    return "transcribing";
  }
  if (lower.includes("transcription saved") || lower.includes("transcription already exists")) {
    return "transcribed";
  }
  if (
    lower.includes("extracting") ||
    lower.includes("extract:") ||
    lower.includes("extracted") ||
    lower.includes("saving frames") ||
    lower.includes("kept")
  ) {
    return "processing";
  }
  if (lower.includes("video:")) {
    return "ingesting";
  }
  return null;
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

  const videoPathInput = (body?.videoPath as string | undefined)?.trim();
  if (!videoPathInput) {
    return new Response(JSON.stringify({ error: "videoPath is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const videoPath = await resolvePath(videoPathInput);
  const fast = Boolean(body?.fast);
  const maxFpsRaw = body?.maxFps;
  const maxFps =
    typeof maxFpsRaw === "number"
      ? maxFpsRaw
      : typeof maxFpsRaw === "string"
        ? Number.parseFloat(maxFpsRaw)
        : null;
  const dedupRaw = body?.dedupThreshold;
  const dedupThreshold =
    typeof dedupRaw === "number" ? dedupRaw : typeof dedupRaw === "string" ? Number.parseFloat(dedupRaw) : null;
  const encoder = new TextEncoder();
  let child: ReturnType<typeof spawn> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const sendEvent = (event: string, payload: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      sendEvent("stage", { stage: "starting" });

      const py = process.env.PYTHON || "python";
      const args = [INGEST_SCRIPT, "--video", videoPath];
      if (fast) {
        const fps = maxFps && maxFps > 0 ? maxFps : 2;
        const dedup = dedupThreshold && dedupThreshold > 0 ? dedupThreshold : 0.02;
        args.push("--max-fps", String(fps), "--dedup-threshold", String(dedup));
      }
      child = spawn(py, ["-u", ...args], {
        cwd: PROJECT_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      });

      let currentStage: string | null = null;
      let stdoutBuffer = "";
      let stderrBuffer = "";

      const flushLine = (line: string, streamName: "stdout" | "stderr") => {
        const trimmed = line.trim();
        if (!trimmed) {
          return;
        }
        sendEvent("log", { stream: streamName, line: trimmed });
        const stage = detectStage(trimmed);
        if (stage && stage !== currentStage) {
          currentStage = stage;
          sendEvent("stage", { stage });
        }
      };

      child.stdout.on("data", (data: Buffer) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        lines.forEach((line) => flushLine(line, "stdout"));
      });

      child.stderr.on("data", (data: Buffer) => {
        stderrBuffer += data.toString();
        const lines = stderrBuffer.split(/\r?\n/);
        stderrBuffer = lines.pop() ?? "";
        lines.forEach((line) => flushLine(line, "stderr"));
      });

      child.on("error", () => {
        sendEvent("error", { message: "Failed to start ingest process" });
        controller.close();
      });

      child.on("close", (code) => {
        if (stdoutBuffer) {
          flushLine(stdoutBuffer, "stdout");
        }
        if (stderrBuffer) {
          flushLine(stderrBuffer, "stderr");
        }
        sendEvent("done", { code: code ?? 0 });
        controller.close();
      });
    },
    cancel() {
      if (child) {
        child.kill();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
