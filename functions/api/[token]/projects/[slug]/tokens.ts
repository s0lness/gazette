import { Env, json, err, nowISO, newProjectToken } from "../../../../_lib/util";
import {
  getAgentByToken,
  getProjectByAgentSlug,
  findOrCreateProject,
  projectCountForAgent,
  activeProjectTokenCount,
  insertProjectToken,
  listProjectTokens,
} from "../../../../_lib/db";

const PROJECT_NAME_MAX = 80;
const PROJECT_DESCRIPTOR_MAX = 140;

// Max ACTIVE (unrevoked) project tokens per project.
const TOKEN_CAP = 10;
// Max projects per agent (counting a create triggered by this mint).
const PROJECT_CAP = 30;

// POST /api/<master token>/projects/<slug>/tokens
// Mint a gzp_ write-only token for the project named by <slug>. If the slug names no
// existing project of this agent, create it (slug-as-name, or the optional
// project_name/project_descriptor from the body). Returns the FULL token exactly once,
// plus the .gazette file JSON to drop in the repo root.
export const onRequestPost: PagesFunction<Env> = async ({ request, env, params }) => {
  const token = String(params.token);
  const slug = String(params.slug);
  const agent = await getAgentByToken(env.DB, token);
  if (!agent) return err("not_found", "Not found.", 404);

  const db = env.DB;

  // Body is optional; project_name (display) / project_descriptor only matter on create.
  let payload: any = {};
  try {
    const raw = await request.text();
    if (raw.trim()) payload = JSON.parse(raw);
  } catch {
    return err("bad_json", "Body must be JSON.", 400);
  }
  const projectName = typeof payload?.project_name === "string" ? payload.project_name.trim() : "";
  const projectDescriptor =
    typeof payload?.project_descriptor === "string" ? payload.project_descriptor.trim() : "";

  const now = nowISO();

  // Resolve the project by (agent, slug). If absent, create it (project_name wins for
  // the display name; else the slug is used as the name).
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

  const postUrl = `https://gazette.sylve.org/api/p/${gzp}`;
  return json({
    ok: true,
    token: gzp,
    project: { name: project.name, slug: project.slug },
    gazette_file: { project: project.name, post_url: postUrl },
  });
};

// GET /api/<master token>/projects/<slug>/tokens
// List the project's tokens: previews only, never the full token.
export const onRequestGet: PagesFunction<Env> = async ({ env, params }) => {
  const token = String(params.token);
  const slug = String(params.slug);
  const agent = await getAgentByToken(env.DB, token);
  if (!agent) return err("not_found", "Not found.", 404);

  const project = await getProjectByAgentSlug(env.DB, agent.id, slug);
  if (!project) return err("not_found", "No such project.", 404);

  const tokens = await listProjectTokens(env.DB, project.id);
  return json({ ok: true, tokens });
};
