import { NextRequest } from "next/server";
import { spawn } from "child_process";
import path from "path";
import fs from "fs/promises";

function resolvePath(p: string): string {
  if (path.isAbsolute(p)) {
    return p;
  }
  return path.join(process.cwd(), p);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
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

  const audioPath = (body?.audioPath as string | undefined)?.trim();
  if (!audioPath) {
    return new Response(JSON.stringify({ error: "audioPath is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const resolvedAudio = resolvePath(audioPath);
  if (!(await fileExists(resolvedAudio))) {
    return new Response(JSON.stringify({ error: `Audio file not found: ${resolvedAudio}` }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const scriptPath = path.join(process.cwd(), "scripts", "transcribe_audio.py");
  if (!(await fileExists(scriptPath))) {
    return new Response(JSON.stringify({ error: "transcribe_audio.py not found on server" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const python = process.env.PYTHON || "python";
  const args: string[] = [scriptPath, "--audio-path", resolvedAudio];
  if (body?.modelSize) {
    args.push("--model-size", String(body.modelSize));
  }
  if (body?.device) {
    args.push("--device", String(body.device));
  }
  if (body?.computeType) {
    args.push("--compute-type", String(body.computeType));
  }
  if (body?.beamSize) {
    args.push("--beam-size", String(body.beamSize));
  }
  if (body?.temperature != null) {
    args.push("--temperature", String(body.temperature));
  }
  if (body?.vadFilter) {
    args.push("--vad-filter");
  }

  const child = spawn(python, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const exitCode: number = await new Promise((resolve) => {
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(1));
  });

  if (exitCode !== 0) {
    let payload: any = null;
    try {
      payload = JSON.parse(stdout || "{}");
    } catch {
      payload = null;
    }
    const message = payload?.error || stderr || "Transcription failed";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const data = JSON.parse(stdout || "{}");
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return new Response(JSON.stringify({ error: "Failed to parse transcription output" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
