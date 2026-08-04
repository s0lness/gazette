import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";

// The auto-grow helper lives in the browser file public/gz.js. As in toast.test.ts we
// load the source against a minimal window/document stub so the IIFE evaluates without
// a real DOM, then pull the helpers off the stub.
//
// gzGrowHeight is the pure part: given the content height a textarea reports, its cap
// and the window height, it decides the height to apply and whether the box scrolls.
// gzAutoGrow is that decision written onto an element, which is what a send (value
// cleared by code, no input event) relies on to snap the box back.

function loadGrow(innerHeight = 900) {
  const src = readFileSync(new URL("../public/gz.js", import.meta.url), "utf8");

  const doc: any = {
    readyState: "complete",
    body: { appendChild: () => {}, removeChild: () => {}, classList: { add: () => {}, remove: () => {} } },
    documentElement: { dataset: {}, getAttribute: () => null },
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, setAttribute: () => {}, select: () => {} }),
    getElementById: () => null,
    cookie: "",
  };
  const win: any = {
    matchMedia: () => ({ matches: false }),
    isSecureContext: false,
    innerHeight,
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (fn: () => void) => { fn(); return 0; },
    location: { pathname: "/", search: "", origin: "http://x" },
    navigator: {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, length: 0, key: () => null },
    document: doc,
  };

  const fn = new Function(
    "window", "document", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "navigator", "location", "localStorage",
    src,
  );
  fn(win, doc, () => 0, () => 0, () => {}, () => {}, win.navigator, win.location, win.localStorage);

  return {
    gzGrowHeight: win.gzGrowHeight as (sh: number, cap: unknown, vp?: number) => { height: number; scroll: boolean },
    gzAutoGrow: win.gzAutoGrow as (ta: unknown, max?: unknown) => void,
  };
}

// A textarea stand-in whose scrollHeight follows the value the way a browser's does:
// one line per line of text, floored at the resting height the `rows` attribute gives,
// and never smaller than the height currently set (unless that height is "auto").
function fakeTextarea(attrs: Record<string, string>, restingPx = 40, linePx = 20) {
  const el: any = {
    tagName: "TEXTAREA",
    value: "",
    style: { height: "", overflowY: "" },
    getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
    setAttribute: (k: string, v: string) => { attrs[k] = v; },
    get scrollHeight() {
      const lines = el.value === "" ? 1 : el.value.split("\n").length;
      const content = Math.max(restingPx, restingPx + (lines - 1) * linePx);
      if (el.style.height && el.style.height !== "auto") {
        return Math.max(content, parseFloat(el.style.height) || 0);
      }
      return content;
    },
  };
  return el;
}

describe("gzGrowHeight (pure)", () => {
  test("under the cap, the box takes the content height and does not scroll", () => {
    const { gzGrowHeight } = loadGrow();
    expect(gzGrowHeight(84, 200, 900)).toEqual({ height: 84, scroll: false });
  });

  test("at the cap exactly, it stops growing and still does not scroll", () => {
    const { gzGrowHeight } = loadGrow();
    expect(gzGrowHeight(200, 200, 900)).toEqual({ height: 200, scroll: false });
  });

  test("past the cap, the height is clamped and the box scrolls", () => {
    const { gzGrowHeight } = loadGrow();
    expect(gzGrowHeight(640, 200, 900)).toEqual({ height: 200, scroll: true });
  });

  test("a short window lowers the cap, so a sheet never outgrows the screen", () => {
    const { gzGrowHeight } = loadGrow();
    // 60% of a 300px window is 180, below the 260 cap.
    expect(gzGrowHeight(400, 260, 300)).toEqual({ height: 180, scroll: true });
    // A tall window leaves the cap alone.
    expect(gzGrowHeight(400, 260, 900)).toEqual({ height: 260, scroll: true });
  });

  test("a missing or nonsense cap falls back instead of collapsing the box", () => {
    const { gzGrowHeight } = loadGrow();
    expect(gzGrowHeight(500, undefined, 0).height).toBe(200);
    expect(gzGrowHeight(500, 0, 0).height).toBe(200);
    expect(gzGrowHeight(500, -10, 0).height).toBe(200);
    expect(gzGrowHeight(NaN, 200, 0)).toEqual({ height: 0, scroll: false });
  });
});

describe("gzAutoGrow (applied)", () => {
  test("named surfaces resolve to their own cap", () => {
    const { gzAutoGrow } = loadGrow();
    const chat = fakeTextarea({ "data-gz-grow": "chat" });
    chat.value = new Array(40).join("x\n");
    gzAutoGrow(chat);
    expect(chat.style.height).toBe("160px"); // chat cap
    expect(chat.style.overflowY).toBe("auto");

    const prose = fakeTextarea({ "data-gz-grow": "prose" });
    prose.value = new Array(40).join("x\n");
    gzAutoGrow(prose);
    expect(prose.style.height).toBe("260px"); // prose cap, roomier than chat
  });

  test("grows line by line, then stops at the cap and scrolls", () => {
    const { gzAutoGrow } = loadGrow();
    const ta = fakeTextarea({ "data-gz-grow": "reply" }); // cap 200, resting 40, 20/line
    gzAutoGrow(ta);
    expect(ta.style.height).toBe("40px");
    expect(ta.style.overflowY).toBe("hidden");

    ta.value = "one\ntwo\nthree";
    gzAutoGrow(ta);
    expect(ta.style.height).toBe("80px");
    expect(ta.style.overflowY).toBe("hidden");

    ta.value = new Array(30).join("line\n");
    gzAutoGrow(ta);
    expect(ta.style.height).toBe("200px");
    expect(ta.style.overflowY).toBe("auto");
  });

  test("clearing the value by code returns it to the resting height", () => {
    const { gzAutoGrow } = loadGrow();
    const ta = fakeTextarea({ "data-gz-grow": "reply" });
    ta.value = new Array(30).join("line\n");
    gzAutoGrow(ta);
    expect(ta.style.height).toBe("200px");

    ta.value = ""; // what sendReply does
    gzAutoGrow(ta);
    expect(ta.style.height).toBe("40px");
    expect(ta.style.overflowY).toBe("hidden");
  });

  test("a raw px cap is honoured and stamped on the element", () => {
    const { gzAutoGrow } = loadGrow();
    const attrs: Record<string, string> = {};
    const ta = fakeTextarea(attrs);
    ta.value = new Array(30).join("line\n");
    gzAutoGrow(ta, 100);
    expect(ta.style.height).toBe("100px");
    expect(attrs["data-gz-grow"]).toBe("100");
  });

  test("no-ops on anything that is not a textarea", () => {
    const { gzAutoGrow } = loadGrow();
    expect(() => gzAutoGrow(null)).not.toThrow();
    const div: any = { tagName: "DIV", style: {} };
    gzAutoGrow(div);
    expect(div.style.height).toBeUndefined();
  });
});

describe("no textarea shows the native resize grip", () => {
  const css = readFileSync(new URL("../public/app.css", import.meta.url), "utf8");

  test("app.css turns resize off for every textarea and re-enables it nowhere", () => {
    expect(css).toContain("textarea { resize: none; }");
    expect(css).not.toContain("resize: vertical");
    expect(css).not.toContain("resize: both");
  });

  test("every textarea in the client opts into auto-grow", () => {
    const files = ["tweet.js", "messages.js", "nav.js", "profile.js", "profile-edit.js", "my-agent.js"];
    for (const f of files) {
      const src = readFileSync(new URL("../public/" + f, import.meta.url), "utf8");
      const tags = src.match(/<textarea[^>]*>/g) || [];
      for (const tag of tags) {
        expect(tag).toContain("data-gz-grow=");
      }
    }
  });
});
