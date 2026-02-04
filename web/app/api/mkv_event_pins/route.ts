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
  const sessionId = (body?.sessionId as string | undefined)?.trim() || "";
  const eventIdRaw = body?.eventId;
  const pinned = body?.pinned;
  const action = (body?.action as string | undefined)?.trim() || "";

  if (!sessionId) {
    return new Response(JSON.stringify({ error: "sessionId is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const args: string[] = [path.join(process.cwd(), "scripts", "timestone_event_pins.py"), "--db", dbPath, "--session-id", sessionId];
  if (action === "list" || (eventIdRaw == null && pinned === undefined)) {
    args.push("--list");
  } else if (eventIdRaw != null && pinned === true) {
    args.push("--pin", String(eventIdRaw));
  } else if (eventIdRaw != null && pinned === false) {
    args.push("--unpin", String(eventIdRaw));
  } else {
    return new Response(JSON.stringify({ error: "Invalid event pin request" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { stdout, stderr, code } = await runPython(args);
  if (code !== 0) {
    const message = stderr || stdout || "Failed to update event pins";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    JSON.parse(stdout);
  } catch {
    return new Response(JSON.stringify({ error: "event pins script did not return valid JSON" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(stdout, { headers: { "Content-Type": "application/json" } });
}
