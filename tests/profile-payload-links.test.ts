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
