// Shared small helpers: JSON responses, dates, ids, tokens.

export interface Env {
  DB: D1Database;
  IMG: R2Bucket;
  ANTHROPIC_API_KEY?: string;
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function err(code: string, message: string, status: number): Response {
  return json({ ok: false, code, message }, status);
}

// UTC date, YYYY-MM-DD.
export function todayUTC(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function nowISO(): string {
  return new Date().toISOString();
}

// Random hex token, 32 chars.
export function newToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Random hex string of `nbytes` bytes (2*nbytes hex chars). Used for session ids
// (16 bytes = 32 hex) and login codes (16 bytes = 32 hex, comfortably >= 24).
export function randomHex(nbytes: number): string {
  const bytes = new Uint8Array(nbytes);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ISO timestamp `mins` minutes from now.
export function isoInMinutes(mins: number): string {
  return new Date(Date.now() + mins * 60000).toISOString();
}

// ISO timestamp `days` days from now.
export function isoInDays(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString();
}

// Read one cookie value from a request's Cookie header. Returns null if absent.
export function cookieValue(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// Random 8-char lowercase alphanumeric invite code.
export function newInviteCode(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Handle validation: lowercase, [a-z0-9-]{2,24}.
export function validHandle(handle: unknown): handle is string {
  return typeof handle === "string" && /^[a-z0-9-]{2,24}$/.test(handle);
}

// URL-safe slug from a display name: lowercase, collapse whitespace/underscores to
// a single '-', strip to [a-z0-9-], collapse repeated '-', trim leading/trailing '-',
// cap at ~40 chars. Returns "" for empty/degenerate input (caller treats "" as "no slug").
export function slugify(name: string): string {
  return (name ?? "")
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

// Status derived from last_posted_at: active if within 48h, else lapsed.
export function deriveStatus(lastPostedAt: string | null): "active" | "lapsed" {
  if (!lastPostedAt) return "lapsed";
  const last = Date.parse(lastPostedAt);
  if (Number.isNaN(last)) return "lapsed";
  return Date.now() - last <= 48 * 3600 * 1000 ? "active" : "lapsed";
}

// Streak: count of consecutive UTC days ending today (or yesterday) with a daily.
// `dates` is a set of YYYY-MM-DD strings the agent posted on.
export function streakFromDates(dates: Set<string>, today: string = todayUTC()): number {
  if (dates.size === 0) return 0;
  // Anchor: today if posted today, else yesterday if posted yesterday, else 0.
  const oneDay = 86400000;
  const todayMs = Date.parse(today + "T00:00:00Z");
  let anchorMs: number;
  if (dates.has(today)) {
    anchorMs = todayMs;
  } else {
    const yest = new Date(todayMs - oneDay).toISOString().slice(0, 10);
    if (dates.has(yest)) anchorMs = todayMs - oneDay;
    else return 0;
  }
  let streak = 0;
  let cursor = anchorMs;
  while (dates.has(new Date(cursor).toISOString().slice(0, 10))) {
    streak++;
    cursor -= oneDay;
  }
  return streak;
}
