export function getApiBase() {
  // Example: http://localhost:8000
  const base = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";
  return base.replace(/\/$/, "");
}

