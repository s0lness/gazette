// The "Instagram filter" for gazette: compose a 1200x630 poster SVG for a single
// post in the house identity (paper / ink / oxblood), then rasterize it to PNG at the
// edge with @resvg/resvg-wasm. Pure composition (buildPosterSvg) is separated from
// rasterization (svgToPng) so the SVG string is unit-testable without the wasm.

import { INTER_BOLD_B64 } from "./font-bold";
import { INTER_REGULAR_B64 } from "./font-regular";

// House palette (same family as the landing; see the task brief).
const PAPER = "#f2ede4";
const INK = "#1d1a16";
const INK_MUTED = "#8a847b";
const OXBLOOD = "#7a1f1f";

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

// ---- text escaping -------------------------------------------------------
// Everything user-authored (headline, display name, handle) is escaped for an SVG/XML
// text node before it touches the document.
export function escXml(s: string): string {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// A deterministic avatar hue from a seed, mirroring functions/avatar/[seed].ts and
// tweet.js (h*31 + charCode, 42% sat, 42% light). Used for the flat-square fallback.
export function avatarHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 360;
}

// ---- headline wrapping ---------------------------------------------------
// A cheap width estimator: average glyph advance for the poster's bold headline size
// so we can greedily wrap into <= maxLines lines and ellipsize the overflow. Not
// pixel-perfect (resvg does the real layout), but close enough to avoid overflow with
// a comfortable safety margin baked into charsPerLine.
export function wrapHeadline(text: string, charsPerLine: number, maxLines: number): string[] {
  const words = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    // A single word longer than a line is hard-split so it never overflows.
    if (w.length > charsPerLine) {
      if (cur) {
        lines.push(cur);
        cur = "";
      }
      let rest = w;
      while (rest.length > charsPerLine) {
        lines.push(rest.slice(0, charsPerLine - 1) + "-");
        rest = rest.slice(charsPerLine - 1);
        if (lines.length >= maxLines) break;
      }
      cur = rest;
      if (lines.length >= maxLines) break;
      continue;
    }
    const next = cur ? cur + " " + w : w;
    if (next.length > charsPerLine && cur) {
      lines.push(cur);
      cur = w;
      if (lines.length >= maxLines) break;
    } else {
      cur = next;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);

  // Overflow: if we truncated, ellipsize the last kept line.
  if (lines.length > maxLines) lines.length = maxLines;
  const consumed = lines.join(" ").replace(/-\s/g, "").length;
  const total = words.join(" ").length;
  if (total > consumed && lines.length > 0) {
    let last = lines[maxLines - 1] ?? lines[lines.length - 1];
    last = last.replace(/[\s\-]+$/, "");
    if (last.length > charsPerLine - 1) last = last.slice(0, charsPerLine - 1);
    lines[lines.length - 1] = last + "…";
  }
  return lines.length ? lines : [""];
}

// The little gazette masthead mark (same shapes as the site favicon), drawn as a
// nested group so it reads as a wordmark logo next to "gazette".
function mastheadMark(x: number, y: number, scale: number): string {
  // The favicon is a 40x40 viewBox; translate+scale it into place.
  return (
    `<g transform="translate(${x},${y}) scale(${scale})">` +
    `<rect x="5" y="7" width="30" height="26" rx="3" fill="${PAPER}" stroke="${INK}" stroke-width="3.5"/>` +
    `<rect x="10" y="12" width="20" height="4" rx="1" fill="${INK}"/>` +
    `<rect x="10" y="19" width="9" height="9" rx="1.5" fill="${OXBLOOD}"/>` +
    `<rect x="22" y="20" width="8" height="3" rx="1.5" fill="${INK}"/>` +
    `<rect x="22" y="25.5" width="8" height="3" rx="1.5" fill="${INK}"/>` +
    `</g>`
  );
}

// The author avatar tile at (x,y), size px, rendered crisply. Three cases:
//  - authored SVG: inline its inner markup into a nested, clipped <svg> that maps the
//    avatar's own viewBox into the tile (crisp pixels via shape-rendering=crispEdges);
//  - authored raster (png/jpeg/webp/gif): a clipped <image> from a data URI;
//  - none / miss: a flat hued square with the uppercased initial (avatar fallback).
export interface AvatarInput {
  // The R2 object's content-type, when an authored avatar exists.
  contentType?: string | null;
  // For an SVG avatar: its raw source text. For a raster avatar: a base64 data body.
  svgSource?: string | null;
  rasterBase64?: string | null;
  // The seed (handle) for the deterministic fallback hue + initial.
  seed: string;
}

// Pull the inner content and viewBox out of an authored SVG so it can be re-hosted in
// a nested <svg>. We do NOT trust arbitrary SVG here for security (uploads are already
// sanitized by svgIsSafe), we only normalize geometry: strip the XML prolog/doctype
// and the outer <svg ...> wrapper, keeping its viewBox (default 0 0 16 16 for the pixel
// avatars) so the art maps into the tile.
export function parseAvatarSvg(src: string): { viewBox: string; inner: string } {
  let s = String(src || "");
  s = s.replace(/<\?xml[\s\S]*?\?>/gi, "").replace(/<!DOCTYPE[\s\S]*?>/gi, "");
  const open = s.match(/<svg\b([^>]*)>/i);
  let viewBox = "0 0 16 16";
  if (open) {
    const vb = open[1].match(/viewBox\s*=\s*["']([^"']+)["']/i);
    if (vb) {
      viewBox = vb[1];
    } else {
      // No viewBox: fall back to width/height if present.
      const w = open[1].match(/\bwidth\s*=\s*["']?([\d.]+)/i);
      const h = open[1].match(/\bheight\s*=\s*["']?([\d.]+)/i);
      if (w && h) viewBox = `0 0 ${w[1]} ${h[1]}`;
    }
  }
  const inner = s
    .replace(/^[\s\S]*?<svg\b[^>]*>/i, "")
    .replace(/<\/svg>\s*$/i, "");
  return { viewBox, inner };
}

function avatarTile(a: AvatarInput, x: number, y: number, size: number): string {
  const r = 10; // rounded corners on the tile
  const clipId = "avclip";
  const clip = `<clipPath id="${clipId}"><rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${r}"/></clipPath>`;

  // Authored SVG -> nested, clipped <svg> that maps the avatar viewBox into the tile.
  if (a.contentType === "image/svg+xml" && a.svgSource) {
    const { viewBox, inner } = parseAvatarSvg(a.svgSource);
    return (
      clip +
      `<g clip-path="url(#${clipId})">` +
      `<rect x="${x}" y="${y}" width="${size}" height="${size}" fill="${PAPER}"/>` +
      `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="${escXml(viewBox)}" ` +
      `preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges">${inner}</svg>` +
      `</g>` +
      `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${r}" fill="none" stroke="${INK}" stroke-opacity="0.12" stroke-width="2"/>`
    );
  }

  // Authored raster -> a clipped <image> from a data URI.
  if (a.rasterBase64 && a.contentType) {
    const href = `data:${a.contentType};base64,${a.rasterBase64}`;
    return (
      clip +
      `<image x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid slice" ` +
      `clip-path="url(#${clipId})" href="${escXml(href)}"/>` +
      `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${r}" fill="none" stroke="${INK}" stroke-opacity="0.12" stroke-width="2"/>`
    );
  }

  // Fallback: a flat hued square + the uppercased initial (mirrors the avatar route).
  const hue = avatarHue(a.seed);
  const mono = (a.seed.replace(/[^a-z0-9]/gi, "").slice(0, 1) || "?").toUpperCase();
  return (
    `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${r}" fill="hsl(${hue}, 42%, 42%)"/>` +
    `<text x="${x + size / 2}" y="${y + size / 2}" fill="#fff" font-family="Inter" font-weight="700" ` +
    `font-size="${Math.round(size * 0.5)}" text-anchor="middle" dominant-baseline="central">${escXml(mono)}</text>`
  );
}

// ---- the poster ----------------------------------------------------------
export interface PosterInput {
  id: number;
  handle: string;
  displayName?: string | null;
  headline: string;
  avatar: AvatarInput;
}

export function buildPosterSvg(p: PosterInput): string {
  const W = OG_WIDTH;
  const H = OG_HEIGHT;
  const M = 72; // outer margin

  const name = (p.displayName && p.displayName.trim()) || p.handle;
  const handleAt = "@" + p.handle;

  // Masthead row: gazette mark + wordmark on the left, the author identity block.
  const wordmarkY = M;
  const avatarSize = 72;

  // The identity row sits under the wordmark.
  const idY = M + 78;
  const avX = M;
  const avY = idY;
  const avatarSvg = avatarTile(p.avatar, avX, avY, avatarSize);

  // Name + handle text, to the right of the avatar.
  const textX = avX + avatarSize + 22;
  const nameY = avY + 30;
  const handleY = avY + 58;

  // The HEADLINE hero: large bold, wrapped to <= 3 lines.
  const headlineSize = 76;
  const headlineLead = 90;
  const lines = wrapHeadline(p.headline, 26, 3);
  const heroTop = 300;
  const headlineSvg = lines
    .map(
      (ln, i) =>
        `<text x="${M}" y="${heroTop + i * headlineLead}" fill="${INK}" font-family="Inter" ` +
        `font-weight="700" font-size="${headlineSize}">${escXml(ln)}</text>`,
    )
    .join("");

  // Footer: the canonical permalink URL, small and muted.
  const footerY = H - M;
  const footerUrl = `gazette.sylve.org/a/${p.handle}/status/${p.id}`;
  const footer =
    `<text x="${M}" y="${footerY}" fill="${INK_MUTED}" font-family="Inter" font-weight="400" ` +
    `font-size="26">${escXml(footerUrl)}</text>`;

  // A subtle oxblood glow in the bottom-right corner.
  const glow =
    `<radialGradient id="glow" cx="100%" cy="100%" r="70%">` +
    `<stop offset="0%" stop-color="${OXBLOOD}" stop-opacity="0.16"/>` +
    `<stop offset="100%" stop-color="${OXBLOOD}" stop-opacity="0"/></radialGradient>`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<defs>${glow}</defs>` +
    `<rect width="${W}" height="${H}" fill="${PAPER}"/>` +
    `<rect width="${W}" height="${H}" fill="url(#glow)"/>` +
    // top hairline rule under the masthead
    `<rect x="${M}" y="${M + 132}" width="${W - 2 * M}" height="2" fill="${INK}" fill-opacity="0.10"/>` +
    // masthead wordmark
    mastheadMark(M, wordmarkY - 6, 1.05) +
    `<text x="${M + 52}" y="${wordmarkY + 30}" fill="${INK}" font-family="Inter" font-weight="700" ` +
    `font-size="40" letter-spacing="0.5">gazette</text>` +
    // identity row
    avatarSvg +
    `<text x="${textX}" y="${nameY}" fill="${INK}" font-family="Inter" font-weight="700" ` +
    `font-size="30">${escXml(name)}</text>` +
    `<text x="${textX}" y="${handleY}" fill="${INK_MUTED}" font-family="Inter" font-weight="400" ` +
    `font-size="26">${escXml(handleAt)}</text>` +
    // hero headline
    headlineSvg +
    // footer
    footer +
    `</svg>`
  );
}

// ---- rasterization -------------------------------------------------------
// Init the wasm ONCE per isolate. On Cloudflare Pages the `resvg.wasm` import resolves
// to a WebAssembly.Module (passed straight to initWasm). Under bun/node the same import
// resolves to a FILE PATH string, which we read + compile. Both feed initWasm a
// WebAssembly.Module, so the real rasterizer runs identically in tests and in prod.
import { initWasm, Resvg } from "./vendor/resvg-wasm.mjs";
// @ts-ignore - on Pages this is a WebAssembly.Module; under bun it is a path string.
import resvgWasm from "./resvg.wasm";

let wasmReady: Promise<void> | null = null;

async function ensureWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = (async () => {
      // WebAssembly.compile exists in both runtimes; it is just missing from the
      // workers-types lib, so reach it dynamically to keep tsc clean.
      const WA = WebAssembly as unknown as { compile(b: BufferSource): Promise<WebAssembly.Module> };
      let mod: WebAssembly.Module;
      if (resvgWasm instanceof WebAssembly.Module) {
        mod = resvgWasm as unknown as WebAssembly.Module;
      } else if (typeof resvgWasm === "string") {
        // bun/node path: read the file and compile it. The specifier is built at
        // runtime so tsc does not try to resolve the node builtin's types.
        const nodeFs = "node:fs" + "/promises";
        const { readFile } = (await import(/* @vite-ignore */ nodeFs)) as { readFile(p: string): Promise<Uint8Array> };
        const bytes = await readFile(resvgWasm as unknown as string);
        mod = await WA.compile(bytes);
      } else {
        // Some bundlers hand back the raw bytes.
        mod = await WA.compile(resvgWasm as unknown as BufferSource);
      }
      await initWasm(mod);
    })();
  }
  return wasmReady;
}

// Decode a base64 string to bytes (works in the Workers runtime and under bun).
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let fontBuffers: Uint8Array[] | null = null;
function fonts(): Uint8Array[] {
  if (!fontBuffers) fontBuffers = [b64ToBytes(INTER_BOLD_B64), b64ToBytes(INTER_REGULAR_B64)];
  return fontBuffers;
}

// Rasterize a composed poster SVG to PNG bytes. Throws if the wasm/font path fails,
// so the route can decide to fall back to serving the SVG.
export async function svgToPng(svg: string): Promise<Uint8Array> {
  await ensureWasm();
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: OG_WIDTH },
    font: {
      fontBuffers: fonts(),
      loadSystemFonts: false,
      defaultFontFamily: "Inter",
      sansSerifFamily: "Inter",
    },
    background: PAPER,
  });
  return resvg.render().asPng();
}
