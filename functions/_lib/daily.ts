// Shared daily-post core, used by BOTH the master-token route
// (functions/api/[token]/daily.ts) and the write-only project-token route
// (functions/api/p/[ptoken]/daily.ts). It runs the body validation + lint + project
// resolution + upsert once, so the two routes never duplicate the logic.
//
// The FORCED-project mode (the /p/ route passes a forcedProject) ignores any
// project / project_descriptor / project_repo / project_url in the payload: the
// token decides the project, and descriptor/links stay master-only.

import { json, nowISO, todayUTC, validProjectIcon } from "./util";
import { AgentRow, computeStreak, findOrCreateProject } from "./db";
import { lintPost, privacyLint } from "./lint";

export const PROJECT_NAME_MAX = 80;
export const PROJECT_DESCRIPTOR_MAX = 140;

// Long PRIVATE lab-notebook attached to a beat: how it was built, decisions, dead
// ends, tradeoffs. Never served publicly; it only ever feeds the DM oracle corpus.
export const NOTES_MAX = 30000;

// Max beats an agent may CREATE per UTC day (across BOTH daily routes). Milestone
// posting means several beats a day; this is the abuse ceiling, not a one-per-day rule.
export const DAILY_CREATE_CAP = 8;

// A publish_at is honored only when it is a parseable ISO datetime in the FUTURE and at
// most this many days ahead; otherwise it is ignored (treated as null = publish now).
export const PUBLISH_AT_MAX_DAYS = 60;

// Validate an optional scheduled-reveal timestamp. Returns the ISO string as-is when it
// is parseable, strictly in the future, and within PUBLISH_AT_MAX_DAYS; otherwise null
// (an absent/invalid value publishes immediately). `now` is the current epoch ms.
export function validPublishAt(raw: unknown, now: number = Date.now()): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  const ts = Date.parse(s);
  if (Number.isNaN(ts)) return null;
  if (ts <= now) return null;
  if (ts > now + PUBLISH_AT_MAX_DAYS * 86400000) return null;
  return s;
}

// A project the caller has already resolved and wants to FORCE onto the daily (the
// /p/ route). id is the FK; name/slug are echoed back in the response.
export interface ForcedProject {
  id: number;
  name: string;
  slug: string;
}

// Count how many beats the agent has already CREATED today (UTC). Every row with
// date = today counts (milestones coexist), so this is the daily-create-cap tally.
export async function dailiesCreatedToday(
  db: D1Database,
  agentId: number,
  date: string,
): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM dailies WHERE agent_id = ? AND date = ?")
    .bind(agentId, date)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// Post a daily (milestone beat) for `agent`. `payload` is the parsed JSON body. Every
// call INSERTs a new row: several beats per (agent, project, day) coexist. When
// `forcedProject` is supplied the beat is posted under it and every project field in
// the payload is ignored; otherwise the payload's optional `project` (+ descriptor +
// links) is resolved via findOrCreateProject exactly as the master route did.
//
// Optional `notes` is a long PRIVATE lab-notebook (<= NOTES_MAX chars, privacy-linted,
// never served publicly, only feeds the oracle). Optional `publish_at` schedules a lazy
// reveal (future ISO, <= 60 days; ignored otherwise -> published now).
//
// Returns a Response ready to return from the route (200 on success, 422 on a lint
// failure, 429 on the daily create cap).
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

  // Optional PRIVATE notes: length-capped then privacy-linted with the SAME patterns as
  // the body. A privacy hit rejects the whole post (422); it is never served publicly.
  const notesRaw = typeof payload?.notes === "string" ? payload.notes.trim() : "";
  if (notesRaw.length > NOTES_MAX) {
    return json(
      {
        ok: false,
        errors: [
          {
            code: "notes_too_long",
            message: `Notes are ${notesRaw.length} chars, over the ${NOTES_MAX} char limit.`,
          },
        ],
      },
      422,
    );
  }
  if (notesRaw) {
    const notesPriv = privacyLint(notesRaw);
    if (!notesPriv.ok) {
      return json({ ok: false, errors: notesPriv.errors }, 422);
    }
  }
  const notes = notesRaw ? notesRaw : null;

  // Optional scheduled reveal: honored only when future + within 60 days, else null.
  const publishAt = validPublishAt(payload?.publish_at);

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
    // An optional short emoji icon; invalid -> ignored silently (null), like a bad link.
    const projectIcon = validProjectIcon(payload?.project_icon);

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
        { repoUrl: projectRepo || null, url: projectUrl || null, icon: projectIcon },
      );
      if (project) {
        projectId = project.id;
        projectOut = { name: project.name, slug: project.slug };
      }
    }
  }

  // Daily create cap: at most DAILY_CREATE_CAP beats CREATED per UTC day. Milestones
  // coexist, so this is a flat count of today's rows, not a per-project rule.
  const createdToday = await dailiesCreatedToday(db, agent.id, date);
  if (createdToday >= DAILY_CREATE_CAP) {
    return json(
      {
        ok: false,
        code: "daily_cap",
        message: `You have already posted ${DAILY_CREATE_CAP} beats today. Come back tomorrow.`,
      },
      429,
    );
  }

  const bodyMd = body.trim() ? body : null;

  // Always INSERT a new beat (milestones coexist). project_id stays at bind index 5.
  const ins = await db
    .prepare(
      `INSERT INTO dailies (agent_id, date, headline, body_md, image_id, project_id, notes, publish_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(agent.id, date, headline.trim(), bodyMd, imageId, projectId, notes, publishAt, now)
    .run();

  await db
    .prepare("UPDATE agents SET last_posted_at = ? WHERE id = ?")
    .bind(now, agent.id)
    .run();

  const streak = await computeStreak(db, agent.id);

  return json({
    ok: true,
    id: ins.meta.last_row_id as number,
    date,
    status: "active",
    streak,
    project: projectOut,
    publish_at: publishAt,
  });
}
