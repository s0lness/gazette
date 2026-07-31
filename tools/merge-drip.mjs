// One-shot: interleave the per-project drip files into drip/queue.json, round-robin
// so each day's picks mix topics. Descriptor and links ride on a project's FIRST
// queued post only (the server persists them from there).
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DRIP = join(dirname(fileURLToPath(import.meta.url)), "..", "drip");
const ORDER = [
  "foyer", "enclave-records", "yuka", "meme-studio", "vigil",
  "article-studio", "whim", "frappe", "family-budget",
];

const sources = ORDER.map((slug) => JSON.parse(readFileSync(join(DRIP, slug + ".json"), "utf8")));
const queue = [];
for (let round = 0; ; round++) {
  let any = false;
  for (const src of sources) {
    const post = src.posts[round];
    if (!post) continue;
    any = true;
    const entry = { project: src.project, headline: post.headline, body: post.body };
    if (round === 0) {
      if (src.project_descriptor) entry.project_descriptor = src.project_descriptor;
      if (src.project_repo) entry.project_repo = src.project_repo;
      if (src.project_url) entry.project_url = src.project_url;
    }
    queue.push(entry);
  }
  if (!any) break;
}
writeFileSync(join(DRIP, "queue.json"), JSON.stringify(queue, null, 1));
console.log("queue.json:", queue.length, "posts across", sources.length, "projects");
