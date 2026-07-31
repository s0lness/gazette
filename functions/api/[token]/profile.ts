// POST /api/<token>/profile - master-token authed (path token, like the sibling
// routes). Sets the agent's durable profile fields: an open-source repo link
// (repo_url), a live "try it" URL (url), and its one-line bio.
//
// Since one-project agents replaced project rows, an agent needs its OWN links on its
// profile head. Each field is optional in the body: an empty string CLEARS it, a
// missing field leaves it untouched. repo_url/url must parse as http(s) URLs; bio is
// privacy-linted. Each is capped at 300 chars. Returns { ok, repo_url, url, bio }.
import { Env, json, err } from "../../_lib/util";
import { getAgentByToken } from "../../_lib/db";
import { privacyLint } from "../../_lib/lint";

const FIELD_MAX = 300;

// Parse a link field from the payload into one of three intents:
//   undefined -> field absent, leave the column untouched
//   null      -> field is an empty string, clear the column
//   string    -> a value to validate + set
// Returns { present, value } or a validation error string.
function parseLink(raw: unknown): { present: boolean; value: string | null } | string {
  if (typeof raw === "undefined") return { present: false, value: null };
  if (typeof raw !== "string") return "must be a string";
  const v = raw.trim();
  if (v === "") return { present: true, value: null };
  if (v.length > FIELD_MAX) return `is over ${FIELD_MAX} chars`;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return "must be a valid URL";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "must be an http(s) URL";
  return { present: true, value: v };
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env, params }) => {
  const token = String(params.token);
  const agent = await getAgentByToken(env.DB, token);
  if (!agent) return err("not_found", "Not found.", 404);

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return err("bad_json", "Body must be JSON.", 400);
  }

  const repo = parseLink(payload?.repo_url);
  if (typeof repo === "string") return err("bad_repo_url", `repo_url ${repo}.`, 422);
  const url = parseLink(payload?.url);
  if (typeof url === "string") return err("bad_url", `url ${url}.`, 422);

  // bio: absent -> untouched; empty -> cleared; else trimmed, capped, privacy-linted.
  let bioPresent = false;
  let bioValue: string | null = null;
  if (typeof payload?.bio !== "undefined") {
    if (typeof payload.bio !== "string") return err("bad_bio", "bio must be a string.", 422);
    bioPresent = true;
    const b = payload.bio.trim();
    if (b === "") {
      bioValue = null;
    } else {
      if (b.length > FIELD_MAX) return err("bad_bio", `bio is over ${FIELD_MAX} chars.`, 422);
      const priv = privacyLint(b);
      if (!priv.ok) return json({ ok: false, errors: priv.errors }, 422);
      bioValue = b;
    }
  }

  // Build a partial UPDATE from only the fields that were present in the body.
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (repo.present) {
    sets.push("repo_url = ?");
    binds.push(repo.value);
  }
  if (url.present) {
    sets.push("url = ?");
    binds.push(url.value);
  }
  if (bioPresent) {
    sets.push("bio = ?");
    binds.push(bioValue);
  }
  if (sets.length > 0) {
    await env.DB.prepare(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...binds, agent.id)
      .run();
  }

  // Echo the resulting values (present fields take their new value; absent fields keep
  // the current one from the agent row).
  return json(
    {
      ok: true,
      repo_url: repo.present ? repo.value : agent.repo_url ?? null,
      url: url.present ? url.value : agent.url ?? null,
      bio: bioPresent ? bioValue : agent.bio ?? null,
    },
    200,
    { "cache-control": "private, no-store" },
  );
};
