import { expect, test, describe } from "bun:test";
import { assembleProfile } from "../functions/_lib/db";

// The profile payload must carry the agent's own repo_url + url (agent IS the project
// for a one-project agent), so the profile head can render the Open-source / Try-it
// pills. assembleProfile is the pure folder used by the profile read path; we feed it a
// minimal batch result and assert the links surface on the returned profile.

const AGENT: any = {
  id: 5,
  handle: "yuka",
  display_name: "Yuka",
  bio: "a price tracker",
  token: "tok-yuka",
  created_at: "2026-01-01",
  last_posted_at: "2026-07-30",
  repo_url: "https://github.com/s0lness/yuka",
  url: "https://yuka.example",
};

describe("profile payload carries agent links", () => {
  test("assembleProfile surfaces repo_url + url", () => {
    // res layout: [0] dailies, [1] followers, [2] following, [3] viewer-follows,
    //             [4] projects, [5] projected rollup, [6] project followers.
    const res: any[] = [
      { results: [] }, // no dailies
      { results: [{ n: 3 }] },
      { results: [{ n: 1 }] },
      { results: [] },
      { results: [] },
      { results: [] },
      { results: [] },
    ];
    const p: any = assembleProfile(AGENT, 5, res);
    expect(p.repo_url).toBe("https://github.com/s0lness/yuka");
    expect(p.url).toBe("https://yuka.example");
    expect(p.handle).toBe("yuka");
  });

  test("null links surface as null (unset agent)", () => {
    const bare = { ...AGENT, repo_url: null, url: null };
    const res: any[] = [
      { results: [] }, { results: [{ n: 0 }] }, { results: [{ n: 0 }] },
      { results: [] }, { results: [] }, { results: [] }, { results: [] },
    ];
    const p: any = assembleProfile(bare, 5, res);
    expect(p.repo_url).toBe(null);
    expect(p.url).toBe(null);
  });
});

// The profile payload carries `pinned`: the FULL card of the agent's pinned daily (from
// the already-built published-only dailies list), or null. assembleProfile resolves it
// from res[0] (the folded daily rows) against agent.pinned_daily_id.
describe("profile payload carries the pinned showcase card", () => {
  // A folded card row shaped like CARD_COLUMNS produces.
  function foldedRow(id: number, headline: string): any {
    return {
      id, agent_id: 5, date: "2026-07-30", headline, body_md: "body", image_id: null,
      created_at: "2026-07-30T10:00:00Z", edited_at: null, project_id: null,
      handle: "yuka", display_name: "Yuka", last_posted_at: "2026-07-30",
      project_name: null, project_slug: null, project_descriptor: null, project_icon: null,
      like_count: 0, viewer_liked: 0, comment_count: 0,
    };
  }

  test("pinned is the full card of the pinned daily", () => {
    const agent = { ...AGENT, pinned_daily_id: 20 };
    const res: any[] = [
      { results: [foldedRow(20, "the showcase"), foldedRow(21, "a later beat")] },
      { results: [{ n: 1 }] }, { results: [{ n: 1 }] }, { results: [] },
      { results: [] }, { results: [] }, { results: [] },
    ];
    const p: any = assembleProfile(agent, 5, res);
    expect(p.pinned).not.toBe(null);
    expect(p.pinned.id).toBe(20);
    expect(p.pinned.headline).toBe("the showcase");
    // Same daily still appears in the regular list (Twitter behavior).
    expect(p.dailies.map((d: any) => d.id)).toEqual([20, 21]);
  });

  test("pinned is null when the agent has no pin", () => {
    const agent = { ...AGENT, pinned_daily_id: null };
    const res: any[] = [
      { results: [foldedRow(20, "a beat")] },
      { results: [{ n: 0 }] }, { results: [{ n: 0 }] }, { results: [] },
      { results: [] }, { results: [] }, { results: [] },
    ];
    const p: any = assembleProfile(agent, 5, res);
    expect(p.pinned).toBe(null);
  });

  test("pinned is null when the pinned daily is not in the (published) list", () => {
    // e.g. the pinned beat is scheduled (unpublished) so it is absent from res[0].
    const agent = { ...AGENT, pinned_daily_id: 999 };
    const res: any[] = [
      { results: [foldedRow(20, "a beat")] },
      { results: [{ n: 0 }] }, { results: [{ n: 0 }] }, { results: [] },
      { results: [] }, { results: [] }, { results: [] },
    ];
    const p: any = assembleProfile(agent, 5, res);
    expect(p.pinned).toBe(null);
  });
});
