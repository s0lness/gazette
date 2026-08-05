// Theme toggle. The no-flash head script already applied any saved theme before
// paint; this wires the visible control. Cycles system -> light -> dark -> system.
// "system" clears the key so the page follows the OS via prefers-color-scheme.
//
// The control is a single fixed, circular button pinned bottom-right, injected
// here so it lives on every page (including the logged-out wall) without markup.
// Each state shows a distinct inline SVG (sun / moon / auto), stroke=currentColor.
(function () {
  const KEY = "app:theme";

  // Inline SVGs, ~20px, stroke = currentColor, no fill. One per state.
  const ICONS = {
    // Sun: center disc + rays.
    light:
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="4"></circle>' +
      '<path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path>' +
      "</svg>",
    // Moon: crescent.
    dark:
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"></path>' +
      "</svg>",
    // Auto: half sun / half moon, split down the middle. Distinct from both.
    system:
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="7"></circle>' +
      '<path d="M12 5v14"></path>' +
      '<path d="M12 5a7 7 0 0 1 0 14z" fill="currentColor" stroke="none"></path>' +
      "</svg>",
  };

  function current() {
    try {
      const t = localStorage.getItem(KEY);
      return t === "light" || t === "dark" ? t : "system";
    } catch {
      return "system";
    }
  }

  // Keep the browser / iOS status-bar tint in step with the theme actually applied.
  //
  // Each shell carries two <meta name="theme-color"> tags with prefers-color-scheme media
  // queries. That is right for "system" but wrong as soon as the page pins a theme — and
  // index.html's head script pins dark for logged-out visitors regardless of the OS setting.
  // Adding a third tag would not help: the browser takes the FIRST tag whose media matches,
  // and one of the two always does. So flip the media attributes instead — the winning tag
  // gets "all", the loser "not all". Reading dataset.theme rather than the stored key means
  // we follow whatever the head script decided, logged-out dark included.
  function syncMeta() {
    const pinned = document.documentElement.dataset.theme; // "light" | "dark" | undefined
    document.querySelectorAll('meta[name="theme-color"]').forEach(function (m) {
      const scheme = m.content.trim().toLowerCase() === "#16130f" ? "dark" : "light";
      if (pinned !== "light" && pinned !== "dark") {
        m.media = "(prefers-color-scheme: " + scheme + ")";
      } else {
        m.media = scheme === pinned ? "all" : "not all";
      }
    });
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
  syncMeta();
  }

  function label(btn, state) {
    btn.innerHTML = ICONS[state];
    btn.setAttribute("aria-label", "Theme: " + state + ". Click to change.");
    btn.setAttribute("title", "Theme: " + state);
  }

  function next(state) {
    return state === "system" ? "light" : state === "light" ? "dark" : "system";
  }

  function ensureButton() {
    let btn = document.getElementById("theme-toggle");
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "theme-toggle";
      btn.type = "button";
      document.body.appendChild(btn);
    }
    btn.className = "theme-fab";
    return btn;
  }

  function init() {
    syncMeta();   // the head script already pinned (or not) a theme before paint
    const btn = ensureButton();
    let state = current();
    label(btn, state);
    btn.addEventListener("click", function () {
      state = next(state);
      apply(state);
      // Gentle cross-fade unless reduced motion is requested.
      let reduce = false;
      try {
        reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      } catch {}
      if (reduce) {
        label(btn, state);
      } else {
        btn.classList.add("swapping");
        setTimeout(function () {
          label(btn, state);
          btn.classList.remove("swapping");
        }, 110);
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
