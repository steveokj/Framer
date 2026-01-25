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
    body = {};
  }

  const dbPathInput = (body?.dbPath as string | undefined)?.trim() || "data/timestone/timestone_events.sqlite3";
  const dbPath = await resolvePath(dbPathInput);
  const args: string[] = [path.join(process.cwd(), "scripts", "timestone_record_segments.py"), "--db", dbPath];

  if (body?.sessionId) {
    args.push("--session-id", String(body.sessionId));
  }
  if (body?.startMs != null) {
    args.push("--start-ms", String(body.startMs));
  }
  if (body?.endMs != null) {
    args.push("--end-ms", String(body.endMs));
  }
  if (body?.obsPath) {
    args.push("--obs-path", String(body.obsPath));
  }

  const { stdout, stderr, code } = await runPython(args);
  if (code !== 0) {
    const message = stderr || stdout || "Failed to load record segments";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    JSON.parse(stdout);
  } catch {
    return new Response(JSON.stringify({ error: "record segments script did not return valid JSON" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(stdout, { headers: { "Content-Type": "application/json" } });
}
