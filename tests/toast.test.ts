import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";

// window.gzToast lives in the browser file public/gz.js. We load the source, stub a
// minimal window/document (and the timers/matchMedia it touches) so the IIFE evaluates
// without a real DOM, then pull gzToast off the stub. We assert the queue/replace
// contract: a new toast REPLACES the current one (never stacks a tower), and it
// auto-dismisses after the timeout.

type FakeNode = {
  className: string;
  textContent: string;
  _attrs: Record<string, string>;
  _classes: Set<string>;
  parentNode: FakeNode | null;
  setAttribute: (k: string, v: string) => void;
  classList: { add: (c: string) => void; remove: (c: string) => void; contains: (c: string) => boolean };
  appendChild: (n: FakeNode) => FakeNode;
  removeChild: (n: FakeNode) => void;
};

function makeNode(): FakeNode {
  const node: FakeNode = {
    className: "",
    textContent: "",
    _attrs: {},
    _classes: new Set<string>(),
    parentNode: null,
    setAttribute(k, v) { this._attrs[k] = v; },
    classList: {
      add: (c: string) => node._classes.add(c),
      remove: (c: string) => node._classes.delete(c),
      contains: (c: string) => node._classes.has(c),
    },
    appendChild(n) { n.parentNode = node; return n; },
    removeChild(n) { n.parentNode = null; },
  };
  return node;
}

// Load gz.js against a controllable fake environment. Returns gzToast plus the fake
// body (so tests can count how many toast nodes are attached) and a timer runner.
function loadToast(reduceMotion = false) {
  const src = readFileSync(new URL("../public/gz.js", import.meta.url), "utf8");

  const body = makeNode();
  const timers: Array<{ fn: () => void; delay: number }> = [];

  const doc: any = {
    readyState: "complete",
    body,
    documentElement: { dataset: {}, getAttribute: () => null },
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelectorAll: () => [],
    createElement: () => makeNode(),
    getElementById: () => null,
    cookie: "",
  };

  const win: any = {
    matchMedia: () => ({ matches: reduceMotion }),
    // gz.js registers a SW and boots a seed; stub the surfaces they touch to no-ops.
    isSecureContext: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (fn: () => void) => { fn(); return 0; },
    location: { pathname: "/", search: "", origin: "http://x" },
    navigator: {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, length: 0, key: () => null },
    document: doc,
  };

  // Deterministic timers: capture scheduled callbacks so the test drives them.
  const setTimeoutFake = (fn: () => void, delay: number) => { timers.push({ fn, delay }); return timers.length; };
  const setIntervalFake = () => 0;
  const clearTimeoutFake = () => {};
  const clearIntervalFake = () => {};

  const fn = new Function(
    "window", "document", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "navigator", "location", "localStorage",
    src,
  );
  fn(win, doc, setTimeoutFake, setIntervalFake, clearTimeoutFake, clearIntervalFake, win.navigator, win.location, win.localStorage);

  return { gzToast: win.gzToast as (m: string) => void, body, timers };
}

describe("gzToast", () => {
  test("is exposed as a function", () => {
    const { gzToast } = loadToast();
    expect(typeof gzToast).toBe("function");
  });

  test("shows one toast node and sets its text", () => {
    const { gzToast, body } = loadToast();
    const children: FakeNode[] = [];
    const origAppend = body.appendChild.bind(body);
    body.appendChild = (n: FakeNode) => { children.push(n); return origAppend(n); };

    gzToast("Link copied");
    const toasts = children.filter((c) => c.className === "gz-toast" && c.parentNode === body);
    expect(toasts.length).toBe(1);
    expect(toasts[0].textContent).toBe("Link copied");
  });

  test("replaces (never stacks): a second toast reuses the same node", () => {
    const { gzToast, body } = loadToast();
    const children: FakeNode[] = [];
    const origAppend = body.appendChild.bind(body);
    body.appendChild = (n: FakeNode) => { children.push(n); return origAppend(n); };

    gzToast("first");
    gzToast("second");
    gzToast("third");
    const toasts = children.filter((c) => c.parentNode === body && c.className === "gz-toast");
    // Only ONE node was ever created and appended; its text is the latest message.
    expect(toasts.length).toBe(1);
    expect(toasts[0].textContent).toBe("third");
  });

  test("empty message is a no-op", () => {
    const { gzToast, body } = loadToast();
    const children: FakeNode[] = [];
    const origAppend = body.appendChild.bind(body);
    body.appendChild = (n: FakeNode) => { children.push(n); return origAppend(n); };
    gzToast("");
    expect(children.filter((c) => c.className === "gz-toast").length).toBe(0);
  });

  test("auto-dismiss removes the node (reduced motion: immediate)", () => {
    const { gzToast, body, timers } = loadToast(true /* reduceMotion */);
    const origAppend = body.appendChild.bind(body);
    let toastNode: FakeNode | null = null;
    body.appendChild = (n: FakeNode) => { toastNode = n; return origAppend(n); };

    gzToast("bye");
    expect(toastNode).not.toBeNull();
    expect(toastNode!.parentNode).toBe(body);
    // Run the auto-dismiss timer (1800ms). Reduced motion removes immediately.
    const dismiss = timers.find((t) => t.delay === 1800);
    expect(dismiss).toBeDefined();
    dismiss!.fn();
    expect(toastNode!.parentNode).toBeNull();
  });
});
