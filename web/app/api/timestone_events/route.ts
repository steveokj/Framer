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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function buildArgs({
  sessionId,
  dbPathInput,
  startMs,
  endMs,
  eventTypes,
  search,
  limit,
}: {
  sessionId: string;
  dbPathInput: string;
  startMs: number | null;
  endMs: number | null;
  eventTypes: string[] | null;
  search: string | undefined;
  limit: number | null;
}): Promise<string[]> {
  const dbPath = await resolvePath(dbPathInput);
  const args: string[] = [path.join(process.cwd(), "scripts", "timestone_events.py"), "--db", dbPath, "--session-id", sessionId];

  if (startMs != null) {
    args.push("--start-ms", String(startMs));
  }
  if (endMs != null) {
    args.push("--end-ms", String(endMs));
  }
  if (eventTypes && eventTypes.length > 0) {
    args.push("--event-types", eventTypes.join(","));
  }
  if (search) {
    args.push("--search", search);
  }
  if (limit != null && limit > 0) {
    args.push("--limit", String(limit));
  }
  return args;
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

  const sessionId = (body?.sessionId as string | undefined)?.trim();
  if (!sessionId) {
    return new Response(JSON.stringify({ error: "sessionId is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const startMs = Number.isFinite(body?.startMs) ? Number(body.startMs) : null;
  const endMs = Number.isFinite(body?.endMs) ? Number(body.endMs) : null;
  const eventTypes = Array.isArray(body?.eventTypes) ? body.eventTypes.filter(Boolean) : null;
  const search = (body?.search as string | undefined)?.trim();
  const limit = Number.isFinite(body?.limit) ? Number(body.limit) : null;
  const waitMs = Number.isFinite(body?.waitMs) ? Number(body.waitMs) : 0;
  const pollMs = Number.isFinite(body?.pollMs) ? Number(body.pollMs) : 250;
  const dbPathInput = (body?.dbPath as string | undefined)?.trim() || "data/timestone/timestone_events.sqlite3";
  const args = await buildArgs({
    sessionId,
    dbPathInput,
    startMs,
    endMs,
    eventTypes,
    search,
    limit,
  });

  if (startMs != null) {
    args.push("--start-ms", String(startMs));
  }
  if (endMs != null) {
    args.push("--end-ms", String(endMs));
  }
  if (eventTypes && eventTypes.length > 0) {
    args.push("--event-types", eventTypes.join(","));
  }
  if (search) {
    args.push("--search", search);
  }
  if (limit != null && limit > 0) {
    args.push("--limit", String(limit));
  }

  const deadline = waitMs > 0 ? Date.now() + waitMs : null;
  while (true) {
    const { stdout, stderr, code } = await runPython(args);
    if (code !== 0) {
      const message = stderr || stdout || "Failed to load timestone events";
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    let payload: any;
    try {
      payload = JSON.parse(stdout);
    } catch {
      return new Response(JSON.stringify({ error: "timestone events script did not return valid JSON" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const events = Array.isArray(payload?.events) ? payload.events : [];
    if (!deadline || events.length > 0 || Date.now() >= deadline) {
      return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
    }
    await sleep(Math.min(pollMs, remaining));
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  const { searchParams } = req.nextUrl;
  const sessionId = (searchParams.get("sessionId") || "").trim();
  if (!sessionId) {
    return new Response("sessionId is required", { status: 400 });
  }

  const startMsParam = searchParams.get("startMs");
  const startMs = startMsParam ? Number(startMsParam) : null;
  const endMsParam = searchParams.get("endMs");
  const endMs = endMsParam ? Number(endMsParam) : null;
  const eventTypesParam = searchParams.get("eventTypes");
  const eventTypes =
    eventTypesParam?.split(",").map((value) => value.trim()).filter(Boolean) || null;
  const search = searchParams.get("search")?.trim();
  const limitParam = searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : null;
  const dbPathInput = (searchParams.get("dbPath") || "").trim() || "data/timestone/timestone_events.sqlite3";
  const pollMsParam = searchParams.get("pollMs");
  const pollMs = pollMsParam ? Math.max(200, Number(pollMsParam)) : 500;
  const heartbeatMsParam = searchParams.get("heartbeatMs");
  const heartbeatMs = heartbeatMsParam ? Math.max(5000, Number(heartbeatMsParam)) : 15000;

  let nextStartMs = Number.isFinite(startMs as number) ? Number(startMs) : null;
  let lastHeartbeat = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      while (!req.signal.aborted) {
        const args = await buildArgs({
          sessionId,
          dbPathInput,
          startMs: nextStartMs,
          endMs: Number.isFinite(endMs as number) ? Number(endMs) : null,
          eventTypes,
          search,
          limit,
        });
        const { stdout, stderr, code } = await runPython(args);
        if (code !== 0) {
          const message = (stderr || stdout || "Failed to load timestone events").replace(/\s+/g, " ").trim();
          controller.enqueue(encoder.encode(`event: error\ndata: ${message}\n\n`));
          break;
        }

        let payload: any;
        try {
          payload = JSON.parse(stdout);
        } catch {
          controller.enqueue(encoder.encode("event: error\ndata: Invalid JSON\n\n"));
          break;
        }
        const events = Array.isArray(payload?.events) ? payload.events : [];
        if (events.length > 0) {
          const lastEvent = events[events.length - 1];
          if (Number.isFinite(lastEvent?.ts_wall_ms)) {
            nextStartMs = Number(lastEvent.ts_wall_ms) + 1;
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
          lastHeartbeat = Date.now();
        } else if (Date.now() - lastHeartbeat >= heartbeatMs) {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
          lastHeartbeat = Date.now();
        }
        await sleep(pollMs);
      }
      controller.close();
    },
    cancel() {},
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
