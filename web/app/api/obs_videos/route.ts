import { NextRequest } from "next/server";
import { spawn } from "child_process";
import path from "path";
import fs from "fs/promises";
import fsSync from "fs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type VideoEntry = {
  path: string;
  name: string;
  start_ms: number | null;
  duration_s: number | null;
  end_ms: number | null;
  created_ms: number | null;
  modified_ms: number | null;
  start_source: "filename" | "filetime" | "unknown";
};

const VIDEO_EXTS = new Set([".mkv", ".mp4", ".mov", ".webm"]);
const CACHE_PATH = path.join(process.cwd(), "..", "data", "timestone", "obs_video_cache.json");
const CACHE_VERSION = 1;

type CacheEntry = {
  size: number;
  mtime_ms: number;
  duration_s: number | null;
  updated_ms: number;
};

type CacheFile = {
  version: number;
  items: Record<string, CacheEntry>;
};

function resolveFfprobe(): string {
  if (process.env.FFPROBE && process.env.FFPROBE.trim().length > 0) {
    return process.env.FFPROBE.trim();
  }
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  return ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => m.replace(/ffmpeg/i, "ffprobe"));
}

function parseObsStartMsFromName(name: string): number | null {
  const match = name.match(/(\d{4}-\d{2}-\d{2})[ _T](\d{2})[-.](\d{2})[-.](\d{2})/);
  if (!match) {
    return null;
  }
  const iso = `${match[1]}T${match[2]}:${match[3]}:${match[4]}`;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
}

function readCache(): CacheFile {
  try {
    if (!fsSync.existsSync(CACHE_PATH)) {
      return { version: CACHE_VERSION, items: {} };
    }
    const raw = fsSync.readFileSync(CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw) as CacheFile;
    if (!parsed || parsed.version !== CACHE_VERSION || !parsed.items) {
      return { version: CACHE_VERSION, items: {} };
    }
    return parsed;
  } catch {
    return { version: CACHE_VERSION, items: {} };
  }
}

async function writeCache(cache: CacheFile): Promise<void> {
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, JSON.stringify(cache));
}

async function ffprobeDuration(filePath: string): Promise<number | null> {
  const ffprobe = resolveFfprobe();
  return new Promise((resolve) => {
    const args = [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ];
    const child = spawn(ffprobe, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const value = Number.parseFloat(stdout.trim());
      resolve(Number.isFinite(value) ? value : null);
    });
    child.on("error", () => resolve(null));
  });
}

function resolveFolderPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }
  if (path.isAbsolute(trimmed)) {
    return trimmed;
  }
  return path.join(process.cwd(), trimmed);
}

export async function POST(req: NextRequest) {
  let body: any = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }

  const folderInput = typeof body?.folderPath === "string" ? body.folderPath : "";
  const folderPath = resolveFolderPath(folderInput);
  const maxFilesRaw = Number(body?.maxFiles);
  const maxFiles = Number.isFinite(maxFilesRaw) ? Math.max(1, Math.floor(maxFilesRaw)) : null;
  const rangeStartMs = Number.isFinite(body?.startMs) ? Number(body.startMs) : null;
  const rangeEndMs = Number.isFinite(body?.endMs) ? Number(body.endMs) : null;
  const fastScan = body?.fastScan === true;
  const hydrate = body?.hydrate === true;

  if (!folderPath) {
    return new Response(JSON.stringify({ error: "folderPath is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  let entries: Awaited<ReturnType<typeof fs.readdir>>;
  try {
    entries = await fs.readdir(folderPath, { withFileTypes: true });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Failed to read folder", detail: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => VIDEO_EXTS.has(path.extname(name).toLowerCase()));

  const totalCount = files.length;
  const limited = maxFiles ? files.slice(0, maxFiles) : files;
  const results: VideoEntry[] = [];
  const cache = readCache();
  let cacheDirty = false;
  let missingDurations = 0;

  for (const name of limited) {
    const fullPath = path.join(folderPath, name);
    let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      stat = null;
    }
    const createdMs = stat ? stat.birthtimeMs || stat.ctimeMs : null;
    const modifiedMs = stat ? stat.mtimeMs : null;
    const parsedStart = parseObsStartMsFromName(name);
    const fileStartMs = parsedStart ?? (createdMs && Number.isFinite(createdMs) ? createdMs : null);
    const startSource: VideoEntry["start_source"] = parsedStart
      ? "filename"
      : fileStartMs
      ? "filetime"
      : "unknown";
    if (rangeStartMs != null || rangeEndMs != null) {
      if (fileStartMs == null) {
        continue;
      }
      if (rangeEndMs != null && fileStartMs > rangeEndMs) {
        continue;
      }
    }
    const statSize = stat ? stat.size : 0;
    const statMtime = stat ? stat.mtimeMs : 0;
    const cached = cache.items[fullPath];
    let duration: number | null = null;
    if (cached && cached.size === statSize && cached.mtime_ms === statMtime) {
      duration = cached.duration_s;
    } else if (!fastScan) {
      duration = await ffprobeDuration(fullPath);
      cache.items[fullPath] = {
        size: statSize,
        mtime_ms: statMtime,
        duration_s: duration,
        updated_ms: Date.now(),
      };
      cacheDirty = true;
    } else {
      missingDurations += 1;
    }
    const fileEndMs = fileStartMs && duration ? fileStartMs + duration * 1000 : null;
    if (rangeStartMs != null && fileEndMs != null && fileEndMs < rangeStartMs) {
      continue;
    }
    if (rangeStartMs != null && fileStartMs != null && fileStartMs < rangeStartMs && duration == null) {
      continue;
    }
    results.push({
      path: fullPath,
      name,
      start_ms: fileStartMs,
      duration_s: duration,
      end_ms: fileEndMs,
      created_ms: createdMs,
      modified_ms: modifiedMs,
      start_source: startSource,
    });
  }

  results.sort((a, b) => {
    const aStart = a.start_ms ?? 0;
    const bStart = b.start_ms ?? 0;
    return aStart - bStart;
  });

  if (cacheDirty) {
    await writeCache(cache);
  }

  if (hydrate && fastScan && missingDurations > 0) {
    const repoRoot = path.join(process.cwd(), "..");
    const scriptPath = path.join(repoRoot, "tools", "scripts", "obs_video_probe.py");
    const py = process.env.PYTHON || "python";
    const args = [scriptPath, "--folder", folderPath, "--cache", CACHE_PATH];
    const child = spawn(py, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  }

  return new Response(
    JSON.stringify({
      videos: results,
      folder: folderPath,
      total_count: totalCount,
      filtered_count: results.length,
      missing_durations: missingDurations,
    }),
    {
      headers: { "Content-Type": "application/json" },
    },
  );
}
