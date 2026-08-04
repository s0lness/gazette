import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A stranger arriving from a shared link lands logged out, on a phone. On /about and
// /join the desktop sidebar is display:none, the mobile bottom nav only exists for
// members, and header.bar collapses (no account button), so the wordmark link was the
// only way home and it was invisible: the visitor was stuck. Both shells now carry the
// SAME .gz-backbar component the post permalink ships, tagged .gz-backbar-public and
// CSS-gated to "narrow viewport AND not a member".

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const about = read("public/about.html");
const joinPage = read("public/join.html");
const css = read("public/app.css");

describe("public pages: home affordance for a logged-out phone visitor", () => {
  for (const [name, html, label] of [
    ["about.html", about, "How it works"],
    ["join.html", joinPage, "Join gazette"],
  ] as const) {
    test(`${name} opens with the public back bar`, () => {
      expect(html).toContain('class="gz-backbar gz-backbar-public"');
      // A REAL anchor to "/", so it works with JS off and is what a crawler follows.
      expect(html).toContain('<a class="gz-backbar-btn" href="/" data-gz-back');
      expect(html).toContain(`<span class="gz-backbar-title">${label}</span>`);
      // First thing inside the center column: visible without scrolling.
      const main = html.indexOf('<main class="page">');
      const bar = html.indexOf('class="gz-backbar gz-backbar-public"');
      expect(main).toBeGreaterThan(-1);
      expect(bar).toBeGreaterThan(main);
      expect(html.slice(main, bar)).not.toContain("<h1");
    });

    test(`${name} stamps data-gz-authed before paint so a member never sees it`, () => {
      expect(html).toContain("dataset.gzAuthed='1'");
      expect(html).toContain("gz:token");
      expect(html).toContain("gz_web=1");
    });
  }

  test("app.css hides the public bar on desktop and for members", () => {
    expect(css).toContain(".gz-backbar-public { display: none; }");
    expect(css).toContain(
      'html:not([data-gz-authed="1"]) body:not([data-gz-nav="1"]) .gz-backbar-public { display: flex; }',
    );
    // The show rule lives inside a phone-only media query.
    const showAt = css.indexOf('.gz-backbar-public { display: flex; }');
    const mq = css.lastIndexOf("@media (max-width: 767px)", showAt);
    expect(mq).toBeGreaterThan(-1);
    expect(css.slice(mq, showAt)).not.toContain("}\n\n");
  });

  test("the bar reuses the shipped component, it does not fork it", () => {
    // The base .gz-backbar / -btn / -icon / -title rules are the permalink's.
    expect(css).toContain(".gz-backbar {");
    expect(css).toContain(".gz-backbar-btn {");
    // No second copy of the component under the public name.
    expect(css).not.toContain(".gz-backbar-public {\n  position: sticky");
  });
});
