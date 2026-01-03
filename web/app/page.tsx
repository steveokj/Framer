// Home page component - displays list of all audio transcription sessions
// Server-side rendered using Next.js App Router
import Link from "next/link";
import { getApiBase } from "@/lib/api";

// Fetches all sessions from the FastAPI backend
// Uses no-store cache to always get fresh data on page load
async function fetchSessions() {
  const base = getApiBase();
  const res = await fetch(`${base}/sessions`, { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to fetch sessions");
  return res.json();
}

// Main home page component - Server Component that fetches and displays sessions
// Each session card shows title and file path with a link to the player page
export default async function Home() {
  const sessions = await fetchSessions();
  return (
    <main>
      <h1>Sessions</h1>
      <ul className="list">
        {sessions.map((s: any) => (
          <li key={s.id} className="card">
            <div className="grow">
              {/* Display session title or fallback to generic name */}
              <div className="title">{s.title ?? `Session ${s.id}`}</div>
              {/* Show file path as secondary info */}
              <div className="muted">{s.file_path}</div>
            </div>
            {/* Link to session player page */}
            <Link href={`/s/${s.id}`}>Open</Link>
          </li>
        ))}
      </ul>
    </main>
  );
}

