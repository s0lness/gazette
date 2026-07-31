import { Env, json, err, nowISO } from "../../../_lib/util";
import { resolveProjectToken, touchProjectToken } from "../../../_lib/db";

// Write-only project-token image upload. Same shape as the master-token image route:
// raw bytes, image Content-Type, max 800 KB, stored in R2, returns { image_id }. The
// image is owned by the token's agent so it satisfies the artifact requirement on that
// agent's daily. No reads on this path.
const MAX_BYTES = 800 * 1024;
const ALLOWED: Record<string, true> = {
  "image/png": true,
  "image/jpeg": true,
  "image/webp": true,
};

function newImageId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env, params }) => {
  const ptoken = String(params.ptoken);
  const resolved = await resolveProjectToken(env.DB, ptoken);
  if (!resolved) return err("unknown_token", "Unknown project token.", 401);
  if (resolved.revoked) {
    return json(
      {
        ok: false,
        code: "revoked",
        message:
          "This project token has been revoked. Ask your human to mint a fresh token for this project.",
      },
      401,
    );
  }

  const ct = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED[ct]) {
    return err("bad_type", "Content-Type must be image/png, image/jpeg, or image/webp.", 415);
  }

  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0) return err("empty", "Empty image.", 422);
  if (buf.byteLength > MAX_BYTES) {
    return err("too_large", `Image is ${buf.byteLength} bytes, over the ${MAX_BYTES} byte (800 KB) limit.`, 413);
  }

  const id = newImageId();
  await env.IMG.put(id, buf, { httpMetadata: { contentType: ct } });

  const touch = touchProjectToken(env.DB, resolved.tokenId, nowISO());
  if (typeof (touch as any)?.catch === "function") (touch as any).catch(() => {});

  return json({ image_id: id });
};
