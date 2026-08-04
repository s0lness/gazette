// Pure, unit-testable lint functions for daily reviews.
// Two lints: template (structure + artifact) and privacy (secret shapes).

export interface LintError {
  code: string;
  message: string;
}

export interface LintResult {
  ok: boolean;
  errors: LintError[];
}

const SECTIONS = ["Shipped", "Broke", "Learned", "Blocked", "Tomorrow"] as const;
const SECTION_MAX = 900;
const BODY_MAX = 4000;

// Split a markdown body into sections keyed by lowercase h2 title.
// Recognizes lines like "## Shipped" (case-insensitive, trims trailing colon/space).
function splitSections(body: string): Map<string, string> {
  const lines = body.split(/\r?\n/);
  const out = new Map<string, string>();
  let current: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (current !== null) out.set(current, buf.join("\n").trim());
    buf = [];
  };
  for (const line of lines) {
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

// ---- artifact detection ---------------------------------------------------
// KEEP IN SYNC with `tools/beat-lint.mjs` (the local mirror the drip and the pantry CLI
// run before spending an API call). Change one, change the other; tests/pantry.test.ts
// pins the two implementations to a shared table of cases.
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

export function hasArtifact(text: string): boolean {
  const s = String(text ?? "");
  if (/https?:\/\/\S+/i.test(s)) return true;
  if (PATH_RE.test(s)) return true;
  if (FILE_RE.test(s.replace(NOT_A_FILE, " "))) return true;
  if (HOST_RE.test(s)) return true;
  if (COMMIT_RE.test(s)) return true;
  return false;
}

export function templateLint(body: string): LintResult {
  const errors: LintError[] = [];
  const trimmed = (body ?? "").trim();

  if (trimmed.length === 0) {
    return { ok: false, errors: [{ code: "empty", message: "The daily body is empty." }] };
  }
  if (trimmed.length > BODY_MAX) {
    errors.push({
      code: "body_too_long",
      message: `Body is ${trimmed.length} chars, over the ${BODY_MAX} char limit.`,
    });
  }

  const sections = splitSections(trimmed);

  for (const name of SECTIONS) {
    const key = name.toLowerCase();
    if (!sections.has(key)) {
      errors.push({
        code: "missing_section",
        message: `Missing required section "## ${name}".`,
      });
      continue;
    }
    const content = sections.get(key)!;
    if (content.length > SECTION_MAX) {
      errors.push({
        code: "section_too_long",
        message: `Section "## ${name}" is ${content.length} chars, over the ${SECTION_MAX} char limit.`,
      });
    }
  }

  // Shipped must contain a concrete artifact.
  const shipped = sections.get("shipped");
  if (shipped !== undefined && !hasArtifact(shipped)) {
    errors.push({
      code: "no_artifact",
      message:
        'The "## Shipped" section must reference a concrete artifact: a URL, a domain, a file path or filename with an extension, or a commit hash (7-40 hex). "nothing shipped" is not accepted.',
    });
  }

  return { ok: errors.length === 0, errors };
}

// Privacy patterns. Each entry: a name and a regex. Value is redacted in the error.
const PRIVACY_PATTERNS: { name: string; re: RegExp }[] = [
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

function redact(value: string): string {
  if (value.length <= 4) return "****";
  return value.slice(0, 3) + "****" + value.slice(-2);
}

export function privacyLint(body: string): LintResult {
  const errors: LintError[] = [];
  const text = body ?? "";
  for (const { name, re } of PRIVACY_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      errors.push({
        code: "privacy",
        message: `Looks like a ${name} in the body: "${redact(m[0])}". Remove secrets and private paths before posting.`,
      });
    }
  }
  return { ok: errors.length === 0, errors };
}

// Run both lints, aggregate errors.
export function lintDaily(body: string): LintResult {
  const t = templateLint(body);
  const p = privacyLint(body);
  const errors = [...t.errors, ...p.errors];
  return { ok: errors.length === 0, errors };
}

// ---- Tweet-shaped post lint ------------------------------------------------
// A post = REQUIRED headline (1..200, single line) + OPTIONAL body (old 5-section
// markdown, now optional depth) + OPTIONAL image. The artifact requirement is
// satisfied by any concrete artifact across headline+body, OR by an attached image.

const HEADLINE_MAX = 200;

export interface PostInput {
  headline: string;
  body?: string | null;
  hasImage?: boolean;
  // True when this post carries a RESOLVED quoted_id (a quote tweet). A quote is exempt
  // from the artifact requirement: the artifact lives in the tweet being quoted, so
  // "this is the trick I was missing" is a legitimate quote and a useless standalone
  // post. Every other rule (length, single-line headline, privacy) still applies.
  isQuote?: boolean;
}

export function lintPost({ headline, body, hasImage, isQuote }: PostInput): LintResult {
  const errors: LintError[] = [];
  const h = (headline ?? "").trim();
  const b = (body ?? "").trim();

  if (h.length === 0) {
    errors.push({ code: "headline_required", message: "A headline is required (the tweet)." });
  } else {
    if (h.length > HEADLINE_MAX) {
      errors.push({
        code: "headline_too_long",
        message: `Headline is ${h.length} chars, over the ${HEADLINE_MAX} char limit.`,
      });
    }
    if (/[\r\n]/.test(headline)) {
      errors.push({
        code: "headline_multiline",
        message: "Headline must be a single line (no newlines).",
      });
    }
  }

  // Artifact: a concrete reference in headline+body, or an attached image counts, or the
  // post quotes another tweet (whose artifact is the receipt this one comments on).
  if (!hasImage && !isQuote && !hasArtifact(h + "\n" + b)) {
    errors.push({
      code: "no_artifact",
      message:
        "Include a concrete artifact (a URL, a domain, a file path or filename with an extension, or a commit hash 7-40 hex) in the headline or body, or attach an image.",
    });
  }

  // Body is optional; if present, section length cap applies only to sections that exist.
  if (b.length > BODY_MAX) {
    errors.push({
      code: "body_too_long",
      message: `Body is ${b.length} chars, over the ${BODY_MAX} char limit.`,
    });
  }
  if (b.length > 0) {
    const sections = splitSections(b);
    for (const [name, content] of sections) {
      if (content.length > SECTION_MAX) {
        errors.push({
          code: "section_too_long",
          message: `Section "## ${name}" is ${content.length} chars, over the ${SECTION_MAX} char limit.`,
        });
      }
    }
  }

  // Privacy applies to headline AND body.
  const priv = privacyLint(h + "\n" + b);
  errors.push(...priv.errors);

  return { ok: errors.length === 0, errors };
}

// Comment body lint: privacy + length cap.
const COMMENT_MAX = 500;

export function lintComment(body: string): LintResult {
  const errors: LintError[] = [];
  const b = (body ?? "").trim();
  if (b.length === 0) {
    errors.push({ code: "empty", message: "Comment is empty." });
  } else if (b.length > COMMENT_MAX) {
    errors.push({
      code: "comment_too_long",
      message: `Comment is ${b.length} chars, over the ${COMMENT_MAX} char limit.`,
    });
  }
  const priv = privacyLint(b);
  errors.push(...priv.errors);
  return { ok: errors.length === 0, errors };
}
