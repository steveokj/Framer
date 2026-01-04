import { NextRequest } from "next/server";
import fs from "fs/promises";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VIDEO_EXTENSIONS = new Set([".mkv", ".mp4", ".mov", ".webm", ".avi", ".m4v"]);

type BrowserEntry = {
  name: string;
  path: string;
  type: "dir" | "file";
  size: number | null;
};

type BrowserResponse = {
  currentPath: string | null;
  parentPath: string | null;
  roots: string[];
  entries: BrowserEntry[];
};

function isVideoFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
}

async function detectRoots(): Promise<string[]> {
  const envRoots = (process.env.ALLOWED_FILE_ROOTS ?? "")
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (envRoots.length > 0) {
    return envRoots;
  }
  if (process.platform === "win32") {
    const roots: string[] = [];
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      const candidate = `${letter}:\\`;
      try {
        await fs.access(candidate);
        roots.push(candidate);
      } catch {
        // ignore missing drives
      }
    }
    if (roots.length > 0) {
      return roots;
    }
  }
  return [path.parse(process.cwd()).root || "/"];
}

function parentForPath(currentPath: string): string | null {
  const parsed = path.parse(currentPath);
  if (parsed.root === currentPath) {
    return null;
  }
  const parent = path.dirname(currentPath);
  return parent === currentPath ? null : parent;
}

async function listDirectory(dirPath: string): Promise<BrowserEntry[]> {
  const dirents = await fs.readdir(dirPath, { withFileTypes: true });
  const entries: BrowserEntry[] = [];
  for (const dirent of dirents) {
    if (dirent.isDirectory()) {
      entries.push({
        name: dirent.name,
        path: path.join(dirPath, dirent.name),
        type: "dir",
        size: null,
      });
      continue;
    }
    if (dirent.isFile() && isVideoFile(dirent.name)) {
      let size: number | null = null;
      try {
        const stat = await fs.stat(path.join(dirPath, dirent.name));
        size = stat.size;
      } catch {
        size = null;
      }
      entries.push({
        name: dirent.name,
        path: path.join(dirPath, dirent.name),
        type: "file",
        size,
      });
    }
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "dir" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  return entries;
}

export async function GET(req: NextRequest): Promise<Response> {
  const pathInput = req.nextUrl.searchParams.get("path")?.trim();
  const roots = await detectRoots();

  if (!pathInput) {
    const payload: BrowserResponse = {
      currentPath: null,
      parentPath: null,
      roots,
      entries: [],
    };
    return new Response(JSON.stringify(payload), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const resolved = path.resolve(pathInput);
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      return new Response(JSON.stringify({ error: "Path is not a directory" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Path not found";
    return new Response(JSON.stringify({ error: message }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const entries = await listDirectory(resolved);
    const payload: BrowserResponse = {
      currentPath: resolved,
      parentPath: parentForPath(resolved),
      roots,
      entries,
    };
    return new Response(JSON.stringify(payload), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to read directory";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
