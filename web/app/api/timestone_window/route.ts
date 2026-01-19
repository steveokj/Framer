import { NextRequest } from "next/server";
import path from "path";
import { spawn } from "child_process";
import fs from "fs/promises";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROJECT_ROOT = path.join(process.cwd(), "..");
const DEFAULT_EXE = path.join(PROJECT_ROOT, "tools", "timestone_window", "target", "debug", "timestone_window.exe");

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function resolveExePath(): string {
  const override = process.env.TIMESTONE_WINDOW_EXE;
  if (override && override.trim().length > 0) {
    return override.trim();
  }
  return DEFAULT_EXE;
}

type Rect = { left: number; top: number; right: number; bottom: number };

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

  const rect = body?.rect as Rect | undefined;
  if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.top) || !Number.isFinite(rect.right) || !Number.isFinite(rect.bottom)) {
    return new Response(JSON.stringify({ error: "rect requires left/top/right/bottom" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const exe = resolveExePath();
  if (!(await fileExists(exe))) {
    return new Response(JSON.stringify({ error: `Window exe not found: ${exe}` }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const width = Math.max(1, Math.round(rect.right - rect.left));
  const height = Math.max(1, Math.round(rect.bottom - rect.top));
  const title = typeof body?.title === "string" && body.title.trim().length > 0 ? body.title.trim() : "Timestone Test Window";
  const color = typeof body?.color === "string" && body.color.trim().length > 0 ? body.color.trim() : undefined;

  const args = [
    "--x",
    String(Math.round(rect.left)),
    "--y",
    String(Math.round(rect.top)),
    "--w",
    String(width),
    "--h",
    String(height),
    "--title",
    title,
  ];
  if (color) {
    args.push("--color", color);
  }

  const child = spawn(exe, args, { stdio: "ignore", windowsHide: true, detached: true });
  child.unref();

  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
}
