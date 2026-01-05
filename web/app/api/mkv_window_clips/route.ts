import { NextRequest } from "next/server";
import path from "path";
import { spawn } from "child_process";
import fs from "fs/promises";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROJECT_ROOT = path.join(process.cwd(), "..");

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
  const args: string[] = [path.join(process.cwd(), "scripts", "mkv_window_clips.py"), "--video", videoPath];

  const mkvDbInput = (body?.mkvDb as string | undefined)?.trim() || process.env.MKV_DB_PATH;
  if (mkvDbInput) {
    const resolvedDb = await resolvePath(mkvDbInput);
    args.push("--mkv-db", resolvedDb);
  }

  const { stdout, stderr, code } = await runPython(args);
  if (code !== 0) {
    const message = stderr || stdout || "Failed to compute mkv window clips";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    JSON.parse(stdout);
  } catch {
    return new Response(JSON.stringify({ error: "mkv window clip script did not return valid JSON" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(stdout, { headers: { "Content-Type": "application/json" } });
}
