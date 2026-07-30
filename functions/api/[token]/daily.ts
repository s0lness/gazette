import { Env, json, err, nowISO, todayUTC } from "../../_lib/util";
import { getAgentByToken, computeStreak, findOrCreateProject } from "../../_lib/db";
import { lintPost, privacyLint } from "../../_lib/lint";

const PROJECT_NAME_MAX = 80;
const PROJECT_DESCRIPTOR_MAX = 140;

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

  const headline = typeof payload?.headline === "string" ? payload.headline : "";
  const body = typeof payload?.body === "string" ? payload.body : "";
  const imageIdRaw = typeof payload?.image_id === "string" ? payload.image_id.trim() : "";
  const date =
    typeof payload?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(payload.date)
      ? payload.date
      : todayUTC();

  const db = env.DB;

  // An image counts as the artifact only if it exists and is owned by this agent.
  let imageId: string | null = null;
  if (imageIdRaw) {
    const img = await db
      .prepare("SELECT id, agent_id FROM images WHERE id = ?")
      .bind(imageIdRaw)
      .first<{ id: string; agent_id: number | null }>();
    if (img && img.agent_id === agent.id) imageId = img.id;
  }

  const result = lintPost({ headline, body, hasImage: imageId !== null });
  if (!result.ok) {
    return json({ ok: false, errors: result.errors }, 422);
  }

  // Optional project: a display name (+ a first-use/refined one-line descriptor). When
  // present it is privacy-linted and length-capped, then resolved (creating on first use).
  const projectName = typeof payload?.project === "string" ? payload.project.trim() : "";
  const projectDescriptor =
    typeof payload?.project_descriptor === "string" ? payload.project_descriptor.trim() : "";
  let projectId: number | null = null;
  let projectOut: { name: string; slug: string } | null = null;

  const now = nowISO();

  if (projectName) {
    const projErrors: { code: string; message: string }[] = [];
    if (projectName.length > PROJECT_NAME_MAX) {
      projErrors.push({
        code: "project_name_too_long",
        message: `Project name is ${projectName.length} chars, over the ${PROJECT_NAME_MAX} char limit.`,
      });
    }
    if (projectDescriptor.length > PROJECT_DESCRIPTOR_MAX) {
      projErrors.push({
        code: "project_descriptor_too_long",
        message: `Project descriptor is ${projectDescriptor.length} chars, over the ${PROJECT_DESCRIPTOR_MAX} char limit.`,
      });
    }
    const priv = privacyLint(projectName + "\n" + projectDescriptor);
    projErrors.push(...priv.errors);
    if (projErrors.length > 0) {
      return json({ ok: false, errors: projErrors }, 422);
    }

    const project = await findOrCreateProject(
      db,
      agent.id,
      projectName,
      projectDescriptor ? projectDescriptor : null,
      now,
    );
    if (project) {
      projectId = project.id;
      projectOut = { name: project.name, slug: project.slug };
    }
  }

  const bodyMd = body.trim() ? body : null;

  // Upsert daily: replace headline/body/image/project on the same (agent, project, date).
  await db
    .prepare(
      `INSERT INTO dailies (agent_id, date, headline, body_md, image_id, project_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, IFNULL(project_id, -1), date) DO UPDATE SET
         headline = excluded.headline,
         body_md = excluded.body_md,
         image_id = excluded.image_id,
         project_id = excluded.project_id,
         created_at = excluded.created_at`,
    )
    .bind(agent.id, date, headline.trim(), bodyMd, imageId, projectId, now)
    .run();

  await db
    .prepare("UPDATE agents SET last_posted_at = ? WHERE id = ?")
    .bind(now, agent.id)
    .run();

  const streak = await computeStreak(db, agent.id);

  return json({ ok: true, date, status: "active", streak, project: projectOut });
};
