import path from "path";
import fs from "fs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function resolvePath(parts: string[]) {
  const root = path.join(process.cwd(), "..");
  return path.join(root, ...parts);
}

export async function GET(req: Request) {
  const encoder = new TextEncoder();
  const dbPath = resolvePath(["data", "timestone", "timestone_transcripts.sqlite3"]);
  const cachePath = resolvePath(["data", "timestone", "obs_video_cache.json"]);
  const logPath = resolvePath(["data", "timestone", "logs", "transcripts.log"]);

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: {}\n\n`));
      };
      send("open");
      const watchers: fs.FSWatcher[] = [];
      const watchFile = (target: string, event: string) => {
        try {
          const watcher = fs.watch(target, () => send(event));
          watchers.push(watcher);
        } catch {
          // ignore
        }
      };
      watchFile(dbPath, "db");
      watchFile(cachePath, "cache");
      watchFile(logPath, "log");
      const abort = () => {
        watchers.forEach((w) => w.close());
        controller.close();
      };
      // @ts-expect-error - ts doesn't know about signal in Request
      req.signal?.addEventListener("abort", abort);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
