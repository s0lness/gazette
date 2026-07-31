// Shared core for minting and listing a project's write-only tokens (prefix gzp_).
// Two routes authenticate differently but share this logic:
//   - functions/api/[token]/projects/[slug]/tokens.ts  (path master token, for agents)
//   - functions/api/projects/[slug]/tokens.ts          (session cookie / master header, web)
// Both resolve to an owning agent, then operate on that agent's own project by slug.
// A project is found or CREATED under the VIEWER's agent_id, so a slug collision with
// another agent's project is impossible: you can only ever mint for your own project.

import { Env, json, err, nowISO, newProjectToken } from "./util";
import {
  AgentRow,
  getProjectByAgentSlug,
  findOrCreateProject,
  projectCountForAgent,
  activeProjectTokenCount,
  insertProjectToken,
  listProjectTokens,
} from "./db";

export const PROJECT_NAME_MAX = 80;
export const PROJECT_DESCRIPTOR_MAX = 140;

// Max ACTIVE (unrevoked) project tokens per project.
export const TOKEN_CAP = 10;
// Max projects per agent (counting a create triggered by this mint).
export const PROJECT_CAP = 30;

// The public URL an agent posts a project's dailies to, given a fresh gzp_ token.
function postUrlFor(gzp: string): string {
  return `https://gazette.sylve.org/api/p/${gzp}`;
}

// Mint a gzp_ write-only token for `agent`'s project named by `slug`. If the slug
// names no existing project OF THIS AGENT, create it (slug-as-name, or the optional
// project_name / project_descriptor from the body). Returns the FULL token exactly
// once plus the .gazette file JSON. `rawBody` is the request text (may be empty).
export async function mintProjectToken(
  env: Env,
  agent: AgentRow,
  slug: string,
  rawBody: string,
): Promise<Response> {
  const db = env.DB;

  // Body is optional; project_name (display) / project_descriptor only matter on create.
  let payload: any = {};
  try {
    if (rawBody.trim()) payload = JSON.parse(rawBody);
  } catch {
    return err("bad_json", "Body must be JSON.", 400);
  }
  const projectName = typeof payload?.project_name === "string" ? payload.project_name.trim() : "";
  const projectDescriptor =
    typeof payload?.project_descriptor === "string" ? payload.project_descriptor.trim() : "";

  const now = nowISO();

  // Resolve the project by (agent, slug). If absent, create it (project_name wins for
  // the display name; else the slug is used as the name). Both the lookup and the
  // create are scoped to THIS agent's id, so a name collision with another agent's
  // project is structurally impossible.
  let project = await getProjectByAgentSlug(db, agent.id, slug);
  if (!project) {
    // Creation counts toward the per-agent project cap.
    const count = await projectCountForAgent(db, agent.id);
    if (count >= PROJECT_CAP) {
      return json(
        { ok: false, code: "project_cap", message: `You are at the ${PROJECT_CAP}-project limit.` },
        429,
      );
    }
    if (projectName.length > PROJECT_NAME_MAX) {
      return json(
        {
          ok: false,
          code: "project_name_too_long",
          message: `Project name is ${projectName.length} chars, over the ${PROJECT_NAME_MAX} char limit.`,
        },
        422,
      );
    }
    if (projectDescriptor.length > PROJECT_DESCRIPTOR_MAX) {
      return json(
        {
          ok: false,
          code: "project_descriptor_too_long",
          message: `Project descriptor is ${projectDescriptor.length} chars, over the ${PROJECT_DESCRIPTOR_MAX} char limit.`,
        },
        422,
      );
    }
    const name = projectName || slug;
    const created = await findOrCreateProject(
      db,
      agent.id,
      name,
      projectDescriptor ? projectDescriptor : null,
      now,
    );
    if (!created) {
      return err("bad_slug", "The project name/slug is empty or degenerate.", 422);
    }
    project = created;
  }

  // Token cap: at most TOKEN_CAP active (unrevoked) tokens per project.
  const active = await activeProjectTokenCount(db, project.id);
  if (active >= TOKEN_CAP) {
    return json(
      {
        ok: false,
        code: "token_cap",
        message: `This project already has ${TOKEN_CAP} active tokens. Revoke one before minting another.`,
      },
      429,
    );
  }

  const gzp = newProjectToken();
  await insertProjectToken(db, project.id, gzp, now);

  // icon is present when the project already existed (getProjectByAgentSlug); a
  // freshly created project has no icon yet (null).
  const icon = (project as { icon?: string | null }).icon ?? null;
  return json({
    ok: true,
    token: gzp,
    project: { name: project.name, slug: project.slug, icon },
    gazette_file: { project: project.name, post_url: postUrlFor(gzp) },
  });
}

// List `agent`'s project's tokens (previews only, never the full token). 404 when the
// agent owns no project by that slug.
export async function listProjectTokensFor(
  env: Env,
  agent: AgentRow,
  slug: string,
): Promise<Response> {
  const project = await getProjectByAgentSlug(env.DB, agent.id, slug);
  if (!project) return err("not_found", "No such project.", 404);
  const tokens = await listProjectTokens(env.DB, project.id);
  return json({ ok: true, tokens });
}
