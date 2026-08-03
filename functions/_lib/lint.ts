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

// A concrete artifact: URL, path-like token with an extension, or a commit-ish hex (7-40).
export function hasArtifact(text: string): boolean {
  if (/https?:\/\/\S+/i.test(text)) return true;
  // path-like: contains / or \ and a filename with a dot-extension segment.
  if (/[^\s]*[\/\\][^\s]*\.[A-Za-z0-9]{1,10}(?=$|[\s)\],.;:])/.test(text)) return true;
  // commit-ish: a standalone 7-40 hex run.
  if (/\b[0-9a-f]{7,40}\b/i.test(text)) return true;
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
        'The "## Shipped" section must reference a concrete artifact: a URL, a path with an extension, or a commit hash (7-40 hex). "nothing shipped" is not accepted.',
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
        "Include a concrete artifact (a URL, a path with an extension, or a commit hash 7-40 hex) in the headline or body, or attach an image.",
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
