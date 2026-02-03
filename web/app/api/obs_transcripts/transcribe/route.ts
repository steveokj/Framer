import { NextRequest } from "next/server";
import path from "path";
import fs from "fs/promises";
import { spawn } from "child_process";
import fsSync from "fs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveRepoRoot(): Promise<string> {
  const cwd = process.cwd();
  if (await fileExists(path.join(cwd, "tools"))) {
    return cwd;
  }
  const parent = path.join(cwd, "..");
  if (await fileExists(path.join(parent, "tools"))) {
    return parent;
  }
  return cwd;
}

async function resolveDbPath(input?: string): Promise<string> {
  const root = await resolveRepoRoot();
  if (input && path.isAbsolute(input)) {
    return input;
  }
  if (input && input.trim().length > 0) {
    return path.join(root, input);
  }
  return path.join(root, "data", "timestone", "timestone_transcripts.sqlite3");
}

function resolvePython(root: string): string {
  const pythonw = process.env.PYTHONW;
  if (pythonw && pythonw.trim().length > 0) {
    return pythonw.trim();
  }
  const python = process.env.PYTHON;
  if (python && python.trim().length > 0) {
    return python.trim();
  }
  const venvPythonw = path.join(root, ".venv", "Scripts", "pythonw.exe");
  if (fsSync.existsSync(venvPythonw)) {
    return venvPythonw;
  }
  const venvPython = path.join(root, ".venv", "Scripts", "python.exe");
  if (fsSync.existsSync(venvPython)) {
    return venvPython;
  }
  return "python";
}

export async function POST(req: NextRequest) {
  let body: any = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }

  const videos = Array.isArray(body?.videos) ? body.videos.map(String) : [];
  if (!videos.length) {
    return new Response(JSON.stringify({ error: "videos is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const model = typeof body?.model === "string" && body.model.trim().length > 0 ? body.model.trim() : "medium";
  const language = typeof body?.language === "string" ? body.language.trim() : "";
  const dbPath = await resolveDbPath(body?.dbPath);
  const root = await resolveRepoRoot();
  const scriptPath = path.join(root, "tools", "scripts", "timestone_transcribe_videos.py");
  const args: string[] = [scriptPath, "--db", dbPath, "--model", model];
  if (language) {
    args.push("--language", language);
  }
  for (const video of videos) {
    args.push("--video", video);
  }

  const py = resolvePython(root);
  const logsDir = path.join(root, "data", "timestone", "logs");
  await fs.mkdir(logsDir, { recursive: true });
  const logPath = path.join(logsDir, "transcripts.log");
  const logStream = fsSync.createWriteStream(logPath, { flags: "a" });
  logStream.write(`[transcripts] ${new Date().toISOString()} starting ${videos.length} video(s)\n`);

  const child = spawn(py, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    windowsHide: true,
  });
  child.stdout.on("data", (d) => logStream.write(d));
  child.stderr.on("data", (d) => logStream.write(d));
  child.on("close", (code) => {
    logStream.write(`[transcripts] ${new Date().toISOString()} exit ${code ?? 0}\n`);
    logStream.end();
  });
  child.unref();

  return new Response(JSON.stringify({ ok: true, count: videos.length, model }), {
    headers: { "Content-Type": "application/json" },
  });
}
