import { NextRequest } from "next/server";
import path from "path";
import fs from "fs/promises";
import { spawn } from "child_process";

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

function runPython(args: string[]) {
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
    const py = process.env.PYTHONW || process.env.PYTHON || "python";
    const child = spawn(py, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
    child.on("error", () => resolve({ stdout: "", stderr: "spawn error", code: 1 }));
  });
}

export async function POST(req: NextRequest) {
  let body: any = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }

  const dbPath = await resolveDbPath(body?.dbPath);
  const videos = Array.isArray(body?.videos) ? body.videos.map(String) : [];
  const model = typeof body?.model === "string" ? body.model.trim() : "";
  const root = await resolveRepoRoot();
  const scriptPath = path.join(root, "tools", "scripts", "timestone_transcripts_query.py");
  const args: string[] = [scriptPath, "--db", dbPath, "--mode", "status"];
  if (model) {
    args.push("--model", model);
  }
  for (const video of videos) {
    args.push("--video", video);
  }

  const { stdout, stderr, code } = await runPython(args);
  if (code !== 0) {
    const message = stderr || stdout || "Failed to load transcript status";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const payload = JSON.parse(stdout);
    return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
  } catch {
    return new Response(JSON.stringify({ error: "status script did not return valid JSON" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
