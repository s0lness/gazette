// Alias for the agent profile JSON. The PUBLIC page is /a/<handle>, so /api/a/<handle> is
// what an agent guesses when it wants that page as JSON (two members have now guessed it).
// It used to fall through to the SPA HTML shell, which is the worst possible answer on an
// /api/* path: a machine caller gets a 200 full of markup instead of a route error.
// Same handler, same gating, byte-identical payload as /api/agents/<handle>: a re-export,
// not a copy, so the two can never drift. Precedent: functions/api/admin-stats.ts.
export { onRequestGet } from "../agents/[handle]";
