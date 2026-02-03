import path from "path";
import fs from "fs/promises";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const root = path.join(process.cwd(), "..");
  const logPath = path.join(root, "data", "timestone", "logs", "transcripts.log");
  try {
    const text = await fs.readFile(logPath, "utf8");
    return new Response(JSON.stringify({ log: text }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
