// Shared daily-post core, used by BOTH the master-token route
// (functions/api/[token]/daily.ts) and the write-only project-token route
// (functions/api/p/[ptoken]/daily.ts). It runs the body validation + lint + project
// resolution + upsert once, so the two routes never duplicate the logic.
//
// The FORCED-project mode (the /p/ route passes a forcedProject) ignores any
// project / project_descriptor / project_repo / project_url in the payload: the
// token decides the project, and descriptor/links stay master-only.

import { json, nowISO, todayUTC } from "./util";
import { AgentRow, computeStreak, findOrCreateProject } from "./db";
import { lintPost, privacyLint } from "./lint";

export const PROJECT_NAME_MAX = 80;
export const PROJECT_DESCRIPTOR_MAX = 140;

// Max distinct projects an agent may post to in one UTC day (across BOTH daily
// routes). A NULL project (unprojected daily) counts as its own distinct bucket.
export const DAILY_PROJECT_CAP = 12;

// A project the caller has already resolved and wants to FORCE onto the daily (the
// /p/ route). id is the FK; name/slug are echoed back in the response.
export interface ForcedProject {
  id: number;
  name: string;
  slug: string;
}

// Count the distinct projects the agent has already posted to today (UTC). A NULL
// project_id folds to the sentinel -1 so an unprojected daily is one distinct bucket,
// matching the (agent, IFNULL(project_id,-1), date) uniqueness the upsert uses.
export async function distinctProjectsToday(
  db: D1Database,
  agentId: number,
  date: string,
): Promise<Set<number>> {
  const rs = await db
    .prepare("SELECT DISTINCT IFNULL(project_id, -1) AS pid FROM dailies WHERE agent_id = ? AND date = ?")
    .bind(agentId, date)
    .all<{ pid: number }>();
  return new Set((rs.results ?? []).map((r) => r.pid));
}

// Post (or upsert) a daily for `agent`. `payload` is the parsed JSON body. When
// `forcedProject` is supplied the daily is posted under it and every project field in
// the payload is ignored; otherwise the payload's optional `project` (+ descriptor +
// links) is resolved via findOrCreateProject exactly as the master route did.
//
// Returns a Response ready to return from the route (200 on success, 422 on a lint
// failure, 429 on the daily project cap).
export async function postDaily(
  db: D1Database,
  agent: AgentRow,
  payload: any,
  forcedProject?: ForcedProject,
): Promise<Response> {
  const headline = typeof payload?.headline === "string" ? payload.headline : "";
  const body = typeof payload?.body === "string" ? payload.body : "";
  const imageIdRaw = typeof payload?.image_id === "string" ? payload.image_id.trim() : "";
  const date =
    typeof payload?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(payload.date)
      ? payload.date
      : todayUTC();

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

  const now = nowISO();

  let projectId: number | null = null;
  let projectOut: { name: string; slug: string } | null = null;

  if (forcedProject) {
    // The token decides the project. Any project/descriptor/links in the payload are
    // ignored (descriptor + links stay master-only).
    projectId = forcedProject.id;
    projectOut = { name: forcedProject.name, slug: forcedProject.slug };
  } else {
    // Optional project: a display name (+ a first-use/refined one-line descriptor) and
    // optional durable links. Privacy-linted + length-capped, then resolved.
    const projectName = typeof payload?.project === "string" ? payload.project.trim() : "";
    const projectDescriptor =
      typeof payload?.project_descriptor === "string" ? payload.project_descriptor.trim() : "";
    const projectRepo = typeof payload?.project_repo === "string" ? payload.project_repo.trim() : "";
    const projectUrl = typeof payload?.project_url === "string" ? payload.project_url.trim() : "";

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
      const priv = privacyLint(
        [projectName, projectDescriptor, projectRepo, projectUrl].filter(Boolean).join("\n"),
      );
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
        { repoUrl: projectRepo || null, url: projectUrl || null },
      );
      if (project) {
        projectId = project.id;
        projectOut = { name: project.name, slug: project.slug };
      }
    }
  }

  // Daily project cap: at most DAILY_PROJECT_CAP distinct projects posted per UTC day.
  // Only enforced when this daily would introduce a NEW distinct project for the day
  // (re-posting an already-posted project the same day is an upsert, always allowed).
  const bucket = projectId ?? -1;
  const todaysProjects = await distinctProjectsToday(db, agent.id, date);
  if (!todaysProjects.has(bucket) && todaysProjects.size >= DAILY_PROJECT_CAP) {
    return json(
      {
        ok: false,
        code: "daily_cap",
        message: `You have already posted to ${DAILY_PROJECT_CAP} distinct projects today. Come back tomorrow.`,
      },
      429,
    );
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
}
