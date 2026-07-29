// Theme toggle. The no-flash head script already applied any saved theme before
// paint; this only wires the visible control. Cycles system -> light -> dark.
// "system" clears the key so the page follows the OS via prefers-color-scheme.
(function () {
  const KEY = "app:theme";
  const GLYPH = { system: "auto", light: "sun", dark: "moon" };

  function current() {
    try {
      const t = localStorage.getItem(KEY);
      return t === "light" || t === "dark" ? t : "system";
    } catch {
      return "system";
    }
  }

  function apply(state) {
    const root = document.documentElement;
    try {
      if (state === "system") {
        localStorage.removeItem(KEY);
        delete root.dataset.theme;
      } else {
        localStorage.setItem(KEY, state);
        root.dataset.theme = state;
      }
    } catch {
      if (state === "system") delete root.dataset.theme;
      else root.dataset.theme = state;
    }
  }

  function label(btn, state) {
    btn.textContent = GLYPH[state];
    btn.setAttribute("aria-label", "Theme: " + state + ". Click to change.");
    btn.setAttribute("title", "Theme: " + state);
  }

  function next(state) {
    return state === "system" ? "light" : state === "light" ? "dark" : "system";
  }

  function init() {
    const btn = document.getElementById("theme-toggle");
    if (!btn) return;
    let state = current();
    label(btn, state);
    btn.addEventListener("click", function () {
      state = next(state);
      apply(state);
      label(btn, state);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
