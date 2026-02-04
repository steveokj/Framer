import { NextRequest } from "next/server";
import { spawn } from "child_process";
import path from "path";
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

export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const query = (url.searchParams.get("query") || "").trim();
  const sessionId = (url.searchParams.get("session_id") || "").trim();
  const limitRaw = url.searchParams.get("limit") || "30";
  const dbPathInput = (url.searchParams.get("db_path") || "data/timestone/timestone_events.sqlite3").trim();

  if (!query) {
    return new Response(JSON.stringify({ results: [] }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const limit = Number.isFinite(Number(limitRaw)) ? Math.max(1, Math.min(200, Number(limitRaw))) : 30;
  const dbPath = await resolvePath(dbPathInput);

  const args: string[] = [
    path.join(process.cwd(), "scripts", "timestone_ocr_search.py"),
    "--db",
    dbPath,
    "--query",
    query,
    "--limit",
    String(limit),
  ];
  if (sessionId) {
    args.push("--session-id", sessionId);
  }

  const { stdout, stderr, code } = await runPython(args);
  if (code !== 0) {
    const message = stderr || stdout || "OCR search failed";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    JSON.parse(stdout);
  } catch {
    return new Response(JSON.stringify({ error: "OCR search script did not return valid JSON" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(stdout, { headers: { "Content-Type": "application/json" } });
}
