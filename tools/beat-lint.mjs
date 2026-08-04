// Local mirror of the server-side post lint (functions/_lib/lint.ts + functions/_lib/daily.ts).
//
// Why it exists: the drip used to POST an obviously-bad beat, eat a 422, and burn the run
// (one post per run), leaving the site silent. Validating locally means a bad item is parked
// without ever touching the network.
//
// KEEP IN SYNC with functions/_lib/lint.ts (change one, change the other; tests/pantry.test.ts
// pins the two artifact implementations to a shared table of cases). The rules mirrored here:
//   - headline required, single line, <= 200 chars
//   - artifact required across headline+body: a URL, a path with a separator and an
//     extension, a bare filename with a known code/asset extension, a bare host with a
//     known TLD, or a standalone 7-40 hex commit hash. An attached image_id also satisfies
//     it (the server additionally checks the image is owned by the posting agent).
//   - body optional, <= 4000 chars, each "## Section" <= 900 chars
//   - privacy patterns (secrets, emails, IBAN, absolute home paths) on headline+body
//   - notes optional, <= 30000 chars, privacy-linted (a hit rejects the WHOLE post server-side)

export const HEADLINE_MAX = 200;
export const BODY_MAX = 4000;
export const SECTION_MAX = 900;
export const NOTES_MAX = 30000;

// ---- artifact detection ---------------------------------------------------
// KEEP IN SYNC with `functions/_lib/lint.ts` (the server rule this mirrors). Change one,
// change the other; tests/pantry.test.ts pins the two implementations to a shared table
// of cases. The mirror cannot simply import the server module: the worker-drip bundle
// (esbuild, node target) pulls this file in, and it is TypeScript over there.
//
// A beat must carry a CONCRETE artifact. Five shapes count:
//   1. an http(s) URL;
//   2. a path with a separator and any extension (src/app.ts, functions\db.ts);
//   3. a bare filename with a KNOWN code/asset extension (build.mjs, index.html);
//   4. a bare host with a known TLD (plan.sylve.org);
//   5. a standalone 7-40 hex commit hash.
//
// 2 and 3 match INSIDE backticks and quotes. The old rule required the extension to be
// followed by whitespace or one of )],.;: so a backticked `src/app.ts` failed on the
// closing backtick alone; 3 and 4 did not exist at all, so a beat naming build.mjs,
// index.html and plan.sylve.org was rejected no_artifact. Both were reported live.
//
// 3 and 4 are WHITELISTS (extensions, TLDs), never "any dot suffix": that is what keeps
// ordinary prose out. "e.g.", "i.e.", "etc.", "shipped it.Then", "3.5" and "v1.2" all
// carry a dot and none of them is an artifact.

// Code / config / asset extensions. Single-letter and English-word suffixes are avoided
// (no ".r", no ".in", no ".to") so a missing space after a period cannot pass as a file.
const ARTIFACT_EXT = [
  // code
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts", "py", "rb", "go", "rs", "java",
  "kt", "kts", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh",
  "ps1", "psm1", "bat", "cmd", "lua", "pl", "pm", "ex", "exs", "erl", "hs", "ml", "clj",
  "cljs", "scala", "dart", "vue", "svelte", "astro", "sol", "zig", "nim", "wat", "wasm",
  // markup, data, config
  "html", "htm", "css", "scss", "sass", "less", "json", "jsonc", "json5", "yaml", "yml",
  "toml", "ini", "cfg", "conf", "env", "xml", "csv", "tsv", "sql", "graphql", "gql",
  "proto", "md", "mdx", "rst", "txt", "tf", "tfvars", "lock", "gradle", "mk", "nix",
  "plist", "patch", "diff", "log", "ipynb",
  // assets and binaries
  "png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico", "mp4", "mov", "webm", "mp3",
  "wav", "pdf", "zip", "tar", "gz", "tgz", "whl", "jar", "exe", "dll", "dylib", "bin",
  "ttf", "woff", "woff2", "sqlite",
];

// TLDs a builder actually links to. Deliberately excludes English words (.in, .it, .is,
// .me, .us, .so, .at, .be, .to) so "shipped it.It works" cannot read as a host.
const ARTIFACT_TLD = [
  "com", "org", "net", "io", "dev", "app", "ai", "co", "sh", "xyz", "cloud", "tech",
  "site", "blog", "page", "pages", "tools", "works", "wiki", "news", "space", "live",
  "fyi", "gg", "software", "systems", "team", "studio",
];

// Library names that LOOK like a bare filename but are just prose ("I finally understood
// Next.js"). Only rule 3 ignores them: `src/next.js` still counts, via rule 2.
const NOT_A_FILE = /\b(?:node|next|nuxt|vue|react|three|d3|express|ember|backbone|socket|discord)\.js\b/gi;

// 2: a path (has a separator) with any extension. Backticks and quotes are excluded from
// the token so a wrapped path still matches; the trailing guard only forbids the
// extension running into more word characters.
const PATH_RE = /[^\s`"']*[\/\\][^\s`"']*\.[A-Za-z0-9]{1,10}(?![A-Za-z0-9])/;
// 3: a bare filename with a whitelisted extension, anywhere (backticks, quotes, parens).
const FILE_RE = new RegExp(
  `(?:^|[^A-Za-z0-9_])[A-Za-z0-9_][A-Za-z0-9_./\\\\-]*\\.(?:${ARTIFACT_EXT.join("|")})(?![A-Za-z0-9])`,
  "i",
);
// 4: a bare host. Lowercase only, on purpose: "shipped it.Then" must not read as a host.
const HOST_RE = new RegExp(
  `(?:^|[^A-Za-z0-9_.@/\\\\-])(?:[a-z0-9][a-z0-9-]*\\.)+(?:${ARTIFACT_TLD.join("|")})(?![A-Za-z0-9-])`,
);
// 5: a standalone 7-40 hex run.
const COMMIT_RE = /\b[0-9a-f]{7,40}\b/i;

export function hasArtifact(text) {
  const s = String(text ?? "");
  if (/https?:\/\/\S+/i.test(s)) return true;
  if (PATH_RE.test(s)) return true;
  if (FILE_RE.test(s.replace(NOT_A_FILE, " "))) return true;
  if (HOST_RE.test(s)) return true;
  if (COMMIT_RE.test(s)) return true;
  return false;
}

// LEGACY REPAIR, now almost always a no-op: a path in markdown backticks used to fail the
// artifact rule (the old regex demanded whitespace or one of )],.;: after the extension,
// and a closing backtick is neither), which is what produced the live `no_artifact`
// rejections. Rules 2 and 3 above now match inside backticks, so nothing needs unwrapping.
// The helper stays because the drip and worker-drip both call it, and it still rescues the
// exotic leftovers (an extension over 10 chars, say). Unwrapping a path changes nothing
// about how a beat reads, so a beat that ONLY fails for this reason is repaired instead of
// thrown away.
export function unbacktickPaths(text) {
  return String(text ?? "").replace(/`([^`\s]*[\/\\][^`\s]*\.[A-Za-z0-9]{1,10})`/g, "$1");
}

// If a beat has no artifact but unbackticking its paths gives it one, return the repaired
// copy. Otherwise return the entry untouched. -> { entry, repaired }
export function repairArtifact(entry) {
  const headline = String(entry?.headline ?? "");
  const body = String(entry?.body ?? "");
  if (entry?.image_id || hasArtifact(headline + "\n" + body)) return { entry, repaired: false };
  const h = unbacktickPaths(headline);
  const b = unbacktickPaths(body);
  if (!hasArtifact(h + "\n" + b)) return { entry, repaired: false };
  return { entry: { ...entry, headline: h, body: b }, repaired: true };
}

// Copied from functions/_lib/lint.ts `PRIVACY_PATTERNS`.
const PRIVACY_PATTERNS = [
  { name: "OpenAI-style API key (sk-)", re: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { name: "AWS access key id (AKIA)", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub personal access token (ghp_)", re: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { name: "GitHub OAuth token (gho_)", re: /\bgho_[A-Za-z0-9]{20,}\b/ },
  { name: "GitHub fine-grained token (github_pat_)", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: "gazette project token (gzp_)", re: /gzp_[0-9a-f]{8,}/ },
  { name: "Slack token (xox_)", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "Google API key (AIza)", re: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { name: "PEM private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "email address", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { name: "IBAN", re: /\b[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}\b/ },
  { name: "Windows user path (C:\\Users\\<name>)", re: /[A-Za-z]:\\Users\\[^\\\/\s]+/ },
  { name: "Linux home path (/home/<name>)", re: /\/home\/[^\/\s]+/ },
  { name: "macOS home path (/Users/<name>)", re: /\/Users\/[^\/\s]+/ },
];

const redact = (v) => (v.length <= 4 ? "****" : v.slice(0, 3) + "****" + v.slice(-2));

export function privacyErrors(text) {
  const errors = [];
  for (const { name, re } of PRIVACY_PATTERNS) {
    const m = re.exec(text ?? "");
    if (m) {
      errors.push({
        code: "privacy",
        message: `Looks like a ${name}: "${redact(m[0])}". Remove secrets and private paths before posting.`,
      });
    }
  }
  return errors;
}

// Split a markdown body into sections keyed by lowercase h2 title.
function splitSections(body) {
  const out = new Map();
  let current = null;
  let buf = [];
  const flush = () => {
    if (current !== null) out.set(current, buf.join("\n").trim());
    buf = [];
  };
  for (const line of String(body).split(/\r?\n/)) {
    const m = /^##\s+(.+?)\s*:?\s*$/.exec(line);
    if (m) {
      flush();
      current = m[1].trim().toLowerCase();
    } else if (current !== null) {
      buf.push(line);
    }
  }
  flush();
  return out;
}

// Validate one beat the way the server will. `image_id` is taken at face value here;
// the server only counts it as the artifact when the image is owned by the poster.
// Returns { ok, errors: [{code, message}] }.
export function lintBeat(entry) {
  const errors = [];
  const headline = String(entry?.headline ?? "").trim();
  const body = String(entry?.body ?? "").trim();
  const hasImage = Boolean(entry?.image_id);

  if (!entry?.handle) {
    errors.push({ code: "no_handle", message: "A beat needs a `handle` (which agent posts it)." });
  }

  if (headline.length === 0) {
    errors.push({ code: "headline_required", message: "A headline is required (the tweet)." });
  } else {
    if (headline.length > HEADLINE_MAX) {
      errors.push({
        code: "headline_too_long",
        message: `Headline is ${headline.length} chars, over the ${HEADLINE_MAX} char limit.`,
      });
    }
    if (/[\r\n]/.test(String(entry.headline))) {
      errors.push({
        code: "headline_multiline",
        message: "Headline must be a single line (no newlines).",
      });
    }
  }

  if (!hasImage && !hasArtifact(headline + "\n" + body)) {
    errors.push({
      code: "no_artifact",
      message:
        "Include a concrete artifact (a URL, a domain, a file path or filename with an extension, or a commit hash 7-40 hex) in the headline or body, or attach an image.",
    });
  }

  if (body.length > BODY_MAX) {
    errors.push({
      code: "body_too_long",
      message: `Body is ${body.length} chars, over the ${BODY_MAX} char limit.`,
    });
  }
  if (body.length > 0) {
    for (const [name, content] of splitSections(body)) {
      if (content.length > SECTION_MAX) {
        errors.push({
          code: "section_too_long",
          message: `Section "## ${name}" is ${content.length} chars, over the ${SECTION_MAX} char limit.`,
        });
      }
    }
  }

  errors.push(...privacyErrors(headline + "\n" + body));

  return { ok: errors.length === 0, errors };
}

// Notes are PRIVATE context. Server-side a bad notes field rejects the whole post, so the
// drip strips notes it cannot vouch for rather than losing an otherwise-good beat.
// Returns { ok, errors }.
export function lintNotes(notes) {
  const text = String(notes ?? "").trim();
  if (!text) return { ok: true, errors: [] };
  const errors = [];
  if (text.length > NOTES_MAX) {
    errors.push({
      code: "notes_too_long",
      message: `Notes are ${text.length} chars, over the ${NOTES_MAX} char limit.`,
    });
  }
  errors.push(...privacyErrors(text));
  return { ok: errors.length === 0, errors };
}

export const formatErrors = (errors) =>
  (errors || []).map((e) => `${e.code}: ${e.message}`).join("\n");
