// The stable identity of a beat, shared by everything that has to ask "is this beat already
// in D1?" (tools/drip-push.mjs today).
//
// A beat has no id of its own: drip/pantry.json and drip/queue.json are plain arrays that get
// appended to and spliced from. So identity is derived: sha-256 over handle + "\n" + headline,
// stored UNIQUE in drip_queue.dedupe_key (migrations/0027_drip_queue.sql). Pushing the same
// files twice therefore inserts nothing, and a beat that was already posted or parked can
// never be resurrected by a later push.
//
// Handle + headline (not the body): the headline is the beat, and a body edit after a push
// should NOT mint a second copy of the same beat. Two genuinely different beats with the same
// headline from the same handle would collide, which is the right call anyway (the second one
// is a duplicate post).
//
// WebCrypto, not node:crypto, so this stays importable from a Worker bundle as well as from
// bun/node. That makes it async.

// Normalized hash input. Trimmed the same way pantry-add.mjs trims what it writes.
export function dedupeInput(handle, headline) {
  return `${String(handle ?? "").trim()}\n${String(headline ?? "").trim()}`;
}

// sha-256 hex (64 chars) of dedupeInput(handle, headline).
export async function dedupeKey(handle, headline) {
  const bytes = new TextEncoder().encode(dedupeInput(handle, headline));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
