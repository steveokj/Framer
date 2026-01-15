"use client";

type SampleEvent = {
  id: number;
  ts_wall_ms: number;
  event_type: string;
  window_title: string | null;
  process_name: string | null;
  window_class: string | null;
  payload?: Record<string, unknown>;
  mouse?: { x: number; y: number };
};

type WindowSegment = {
  id: string;
  window_label: string;
  events: SampleEvent[];
};

type SampleRow =
  | { kind: "single"; event: SampleEvent }
  | { kind: "group"; event_type: string; events: SampleEvent[] };

const sampleEvents: SampleEvent[] = [
  {
    id: 1,
    ts_wall_ms: Date.now() - 12000,
    event_type: "active_window_changed",
    window_title: "Notepad",
    process_name: "notepad.exe",
    window_class: "Notepad",
  },
  {
    id: 2,
    ts_wall_ms: Date.now() - 11000,
    event_type: "text_input",
    window_title: "Notepad",
    process_name: "notepad.exe",
    window_class: "Notepad",
    payload: { text: "hello" },
  },
  {
    id: 3,
    ts_wall_ms: Date.now() - 9500,
    event_type: "mouse_click",
    window_title: "Notepad",
    process_name: "notepad.exe",
    window_class: "Notepad",
    mouse: { x: 640, y: 420 },
  },
  {
    id: 4,
    ts_wall_ms: Date.now() - 9200,
    event_type: "mouse_click",
    window_title: "Notepad",
    process_name: "notepad.exe",
    window_class: "Notepad",
    mouse: { x: 648, y: 430 },
  },
  {
    id: 5,
    ts_wall_ms: Date.now() - 9000,
    event_type: "mouse_click",
    window_title: "Notepad",
    process_name: "notepad.exe",
    window_class: "Notepad",
    mouse: { x: 652, y: 435 },
  },
  {
    id: 6,
    ts_wall_ms: Date.now() - 8000,
    event_type: "active_window_changed",
    window_title: "Chrome",
    process_name: "chrome.exe",
    window_class: "Chrome_WidgetWin_1",
  },
  {
    id: 7,
    ts_wall_ms: Date.now() - 7000,
    event_type: "key_shortcut",
    window_title: "Chrome",
    process_name: "chrome.exe",
    window_class: "Chrome_WidgetWin_1",
    payload: { key: "L", modifiers: ["Ctrl"] },
  },
  {
    id: 8,
    ts_wall_ms: Date.now() - 6000,
    event_type: "clipboard_text",
    window_title: "Chrome",
    process_name: "chrome.exe",
    window_class: "Chrome_WidgetWin_1",
    payload: { text: "example.com" },
  },
  {
    id: 9,
    ts_wall_ms: Date.now() - 4500,
    event_type: "active_window_changed",
    window_title: "Cursor - Framer",
    process_name: "Cursor.exe",
    window_class: "Chrome_WidgetWin_1",
  },
  {
    id: 10,
    ts_wall_ms: Date.now() - 3500,
    event_type: "text_input",
    window_title: "Cursor - Framer",
    process_name: "Cursor.exe",
    window_class: "Chrome_WidgetWin_1",
    payload: { text: "git status" },
  },
  {
    id: 11,
    ts_wall_ms: Date.now() - 2000,
    event_type: "mouse_click",
    window_title: "Cursor - Framer",
    process_name: "Cursor.exe",
    window_class: "Chrome_WidgetWin_1",
    mouse: { x: 120, y: 980 },
  },
];

function formatWallTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function windowLabel(event: SampleEvent): string {
  return event.window_title || event.process_name || event.window_class || "Unknown window";
}

function segmentByActiveWindow(events: SampleEvent[]): WindowSegment[] {
  const sorted = [...events].sort((a, b) => a.ts_wall_ms - b.ts_wall_ms);
  const segments: WindowSegment[] = [];
  let current: WindowSegment | null = null;
  for (const event of sorted) {
    if (event.event_type === "active_window_changed" || !current) {
      current = {
        id: `${event.id}-${event.ts_wall_ms}`,
        window_label: windowLabel(event),
        events: [event],
      };
      segments.push(current);
    } else {
      current.events.push(event);
    }
  }
  return segments
    .reverse()
    .map((segment) => ({
      ...segment,
      events: [...segment.events].sort((a, b) => b.ts_wall_ms - a.ts_wall_ms),
    }));
}

function groupConsecutiveByType(events: SampleEvent[]): SampleRow[] {
  const rows: SampleRow[] = [];
  for (const event of events) {
    const last = rows[rows.length - 1];
    if (last && last.kind === "group" && last.event_type === event.event_type) {
      last.events.push(event);
      continue;
    }
    if (last && last.kind === "single" && last.event.event_type === event.event_type) {
      rows[rows.length - 1] = { kind: "group", event_type: event.event_type, events: [last.event, event] };
      continue;
    }
    rows.push({ kind: "single", event });
  }
  return rows;
}

export default function LiveEventsSamplePage() {
  const segments = segmentByActiveWindow(sampleEvents);

  return (
    <div className="container">
      <main
        style={{
          minHeight: "100vh",
          background: "linear-gradient(180deg, #070b16 0%, #0a1224 40%, #0b1120 100%)",
          color: "#e2e8f0",
          padding: "32px 24px 80px",
          fontFamily: '"Space Grotesk", "Segoe UI", system-ui',
        }}
      >
        <div style={{ maxWidth: 960, margin: "0 auto", display: "grid", gap: 20 }}>
          <header style={{ display: "grid", gap: 8 }}>
            <h1 style={{ fontSize: 28, margin: 0 }}>Live Events Grouping (Sample)</h1>
            <p style={{ margin: 0, color: "#94a3b8" }}>
              This page demonstrates grouping by “active window changed” sections. Events stay in a single card per
              window segment, ordered by most recent segment first.
            </p>
          </header>

          {segments.map((segment) => (
            <section
              key={segment.id}
              style={{
                borderRadius: 16,
                padding: 16,
                border: "1px solid rgba(30, 41, 59, 0.7)",
                background: "rgba(11, 17, 32, 0.9)",
                display: "grid",
                gap: 12,
              }}
            >
              <div style={{ display: "grid", gap: 10 }}>
                {groupConsecutiveByType(segment.events).map((row, index) => {
                  if (row.kind === "group") {
                    return (
                      <div
                        key={`group-${segment.id}-${index}`}
                        style={{
                          borderRadius: 12,
                          padding: "10px 12px",
                          border: "1px solid rgba(30, 41, 59, 0.6)",
                          background: "rgba(9, 14, 26, 0.9)",
                          display: "grid",
                          gap: 6,
                        }}
                      >
                        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                          <span style={{ color: "#cbd5f5", fontSize: 12 }}>
                            {formatWallTime(row.events[0].ts_wall_ms)}
                          </span>
                          <span style={{ color: "#64748b", fontSize: 12 }}>
                            {row.event_type.replace(/_/g, " ")} x{row.events.length}
                          </span>
                        </div>
                        {row.events[0].mouse ? (
                          <div style={{ color: "#cbd5f5" }}>
                            Click @ {row.events[0].mouse?.x},{row.events[0].mouse?.y}
                          </div>
                        ) : null}
                      </div>
                    );
                  }

                  const event = row.event;
                  const payloadText =
                    event.payload && typeof event.payload.text === "string" ? event.payload.text : null;
                  const shortcut =
                    event.payload && Array.isArray(event.payload.modifiers) && event.payload.key
                      ? `${event.payload.modifiers.join("+")}+${String(event.payload.key)}`
                      : null;
                  return (
                    <div
                      key={event.id}
                      style={{
                        borderRadius: 12,
                        padding: "10px 12px",
                        border: "1px solid rgba(30, 41, 59, 0.6)",
                        background: "rgba(9, 14, 26, 0.9)",
                        display: "grid",
                        gap: 6,
                      }}
                    >
                      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                        <span style={{ color: "#cbd5f5", fontSize: 12 }}>{formatWallTime(event.ts_wall_ms)}</span>
                        <span style={{ color: "#64748b", fontSize: 12 }}>
                          {event.event_type.replace(/_/g, " ")}
                        </span>
                      </div>
                      {payloadText ? <div style={{ color: "#cbd5f5" }}>Text: {payloadText}</div> : null}
                      {shortcut ? <div style={{ color: "#cbd5f5" }}>Shortcut: {shortcut}</div> : null}
                      {event.mouse ? (
                        <div style={{ color: "#cbd5f5" }}>
                          Click @ {event.mouse.x},{event.mouse.y}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}
