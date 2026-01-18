import { NextRequest } from "next/server";
import path from "path";
import { spawn } from "child_process";
import fs from "fs/promises";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROJECT_ROOT = path.join(process.cwd(), "..");
const DEFAULT_EXE = path.join(PROJECT_ROOT, "tools", "timestone_overlay", "target", "debug", "timestone_overlay.exe");

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function resolveExePath(): string {
  const override = process.env.TIMESTONE_OVERLAY_EXE;
  if (override && override.trim().length > 0) {
    return override.trim();
  }
  return DEFAULT_EXE;
}

type Rect = { left: number; top: number; right: number; bottom: number };
type Point = { x: number; y: number; radius?: number };

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

  const type = (body?.type as string | undefined)?.trim();
  if (type !== "rect" && type !== "point") {
    return new Response(JSON.stringify({ error: "type must be rect or point" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const durationMs = Number.isFinite(body?.duration_ms) ? Number(body.duration_ms) : undefined;
  const color = (body?.color as string | undefined)?.trim();

  const exe = resolveExePath();
  if (!(await fileExists(exe))) {
    return new Response(JSON.stringify({ error: `Overlay exe not found: ${exe}` }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const args: string[] = [];
  if (type === "rect") {
    const rect = body?.rect as Rect | undefined;
    if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.top) || !Number.isFinite(rect.right) || !Number.isFinite(rect.bottom)) {
      return new Response(JSON.stringify({ error: "rect requires left/top/right/bottom" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    args.push("rect", String(rect.left), String(rect.top), String(rect.right), String(rect.bottom));
  } else {
    const point = body?.point as Point | undefined;
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return new Response(JSON.stringify({ error: "point requires x/y" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    args.push("point", String(point.x), String(point.y));
    if (Number.isFinite(point.radius)) {
      args.push("--radius", String(point.radius));
    }
  }

  if (Number.isFinite(durationMs)) {
    args.push("--duration-ms", String(durationMs));
  }
  if (color) {
    args.push("--color", color);
  }

  const child = spawn(exe, args, { stdio: "ignore", windowsHide: true, detached: true });
  child.unref();

  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
}
