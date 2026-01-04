import { NextRequest } from "next/server";
import path from "path";
import fs from "fs/promises";
import { spawn } from "child_process";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROJECT_ROOT = path.join(process.cwd(), "..");
const UPLOAD_DIR = path.join(PROJECT_ROOT, "data", "uploads");
const INGEST_SCRIPT = path.join(PROJECT_ROOT, "cli", "mkv_ingest.py");

function safeBaseName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "video";
  }
  return trimmed.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "video";
}

function makeUploadName(original: string): string {
  const ext = path.extname(original || "").toLowerCase();
  const base = safeBaseName(path.basename(original, ext));
  const stamp = Date.now().toString(36);
  const token = crypto.randomBytes(3).toString("hex");
  const finalExt = ext || ".mkv";
  return `${base}-${stamp}-${token}${finalExt}`;
}

function runPython(args: string[]) {
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
    const py = process.env.PYTHON || "python";
    const child = spawn(py, args, { stdio: ["ignore", "pipe", "pipe"], cwd: PROJECT_ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
    child.on("error", () => resolve({ stdout: "", stderr: "spawn error", code: 1 }));
  });
}

async function runIngest(videoPath: string) {
  return runPython([INGEST_SCRIPT, "--video", videoPath]);
}

export async function POST(req: NextRequest): Promise<Response> {
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid multipart body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const file = formData.get("file");
  if (!file || typeof file === "string") {
    return new Response(JSON.stringify({ error: "file is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const ingestParam = (req.nextUrl.searchParams.get("ingest") || "").toLowerCase();
  const ingest = ["1", "true", "yes", "on"].includes(ingestParam);

  const uploadName = makeUploadName((file as File).name || "video");
  const destPath = path.join(UPLOAD_DIR, uploadName);

  try {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    const buffer = Buffer.from(await (file as File).arrayBuffer());
    await fs.writeFile(destPath, buffer);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save upload";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (ingest) {
    const { stdout, stderr, code } = await runIngest(destPath);
    if (code !== 0) {
      const message = stderr || stdout || "Ingest failed";
      return new Response(JSON.stringify({ error: message, path: destPath }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  return new Response(JSON.stringify({ path: destPath, ingested: ingest }), {
    headers: { "Content-Type": "application/json" },
  });
}
