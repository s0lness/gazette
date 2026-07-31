// Shared liveness helpers for gazette. Dependency-free.
// - gzLivePoll(fn): poll every 12s while visible, refetch on focus/visibility,
//   pause while hidden. The edge cache (s-maxage=15) absorbs the extra polling.
// - gzRelTime(iso): "just now / 3m / 2h / 1d / 3d", falling back to the date for
//   anything older than a week.
// - gzTime(iso, fallback): a <span class="reltime" data-ts="..."> that a local
//   timer re-derives every 30s, no network fetch.
// - gzReduceMotion(): honours prefers-reduced-motion.
(function () {
  function gzReduceMotion() {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  }

  // Human relative time from an ISO timestamp. Ticks locally; no fetch.
  function gzRelTime(iso) {
    const t = Date.parse(iso);
    if (isNaN(t)) return "";
    const secs = Math.floor((Date.now() - t) / 1000);
    if (secs < 45) return "just now";
    const mins = Math.floor(secs / 60);
    if (mins < 60) return mins + "m";
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + "h";
    const days = Math.floor(hours / 24);
    if (days <= 7) return days + "d";
    // Older than a week: the calendar date reads better than "42d".
    const d = new Date(t);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  // A time chip that a local timer keeps fresh. `iso` drives the relative text;
  // `fallback` is shown when there is no usable timestamp (e.g. a bare date).
  function gzTime(iso, fallback) {
    if (!iso) return escAttr(fallback == null ? "" : fallback);
    return (
      '<span class="reltime" data-ts="' +
      escAttr(iso) +
      '" title="' +
      escAttr(iso) +
      '">' +
      escAttr(gzRelTime(iso)) +
      "</span>"
    );
  }

  function escAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Re-derive every visible relative timestamp from its data-ts. Runs on a 30s
  // local timer so the feed keeps ticking without any network traffic.
  function refreshTimes() {
    const nodes = document.querySelectorAll(".reltime[data-ts]");
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const txt = gzRelTime(el.getAttribute("data-ts"));
      if (el.textContent !== txt) el.textContent = txt;
    }
  }
  setInterval(refreshTimes, 30000);

  // Live polling: refresh now, then every 12s while visible; also on tab focus
  // and on regaining visibility. Pause while hidden. fn must be idempotent and
  // swallow its own fetch errors.
  function gzLivePoll(fn) {
    let timer = null;
    function start() {
      if (timer === null) timer = setInterval(fn, 12000);
    }
    function stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    }
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        stop();
      } else {
        fn();
        start();
      }
    });
    window.addEventListener("focus", fn);
    fn();
    if (!document.hidden) start();
  }

  // ---- copy buttons -------------------------------------------------------
  // Any <pre> (or block) marked with class "copyable" gets a small ghost "copy"
  // button in its top-right that copies the block's exact text. A single delegated
  // click handler covers static pages AND runtime-injected blocks (the wall). Call
  // gzDecorateCopy(root) after injecting HTML to add buttons to any new blocks.

  function copyText(text, btn) {
    var done = function () {
      var prev = btn.getAttribute("data-label") || "copy";
      btn.textContent = "copied";
      btn.classList.add("copied");
      setTimeout(function () {
        btn.textContent = prev;
        btn.classList.remove("copied");
      }, 1500);
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
        return;
      }
    } catch (e) {}
    fallbackCopy(text);
    done();
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    } catch (e) {}
  }

  // The exact text to copy for a block: explicit data-copy-text wins, else the
  // block's textContent minus any button label.
  function snippetText(block, btn) {
    var explicit = block.getAttribute("data-copy-text");
    if (explicit != null) return explicit;
    var clone = block.cloneNode(true);
    var b = clone.querySelector(".gz-copy");
    if (b) b.remove();
    return clone.textContent.replace(/\s+$/, "");
  }

  // Add a copy button to every .copyable block under root that lacks one.
  // The button is appended as the last child; CSS (flex-direction: column +
  // align-self: flex-end) places it below the code, right-aligned, never
  // overlapping the text.
  function gzDecorateCopy(root) {
    root = root || document;
    var blocks = root.querySelectorAll(".copyable");
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      if (block.querySelector(".gz-copy")) continue;
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "gz-copy";
      btn.textContent = "copy";
      btn.setAttribute("data-label", "copy");
      block.appendChild(btn);
    }
  }

  // One delegated handler for every copy button, static or injected.
  document.addEventListener("click", function (ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest(".gz-copy") : null;
    if (!btn) return;
    ev.preventDefault();
    var block = btn.closest ? btn.closest(".copyable") : null;
    if (!block) return;
    copyText(snippetText(block, btn), btn);
  });

  // Decorate any static copyable blocks on load.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { gzDecorateCopy(document); });
  } else {
    gzDecorateCopy(document);
  }

  // ---- stale-while-revalidate cache --------------------------------------
  // A tiny localStorage-backed cache so page-to-page navigation can paint
  // instantly from the last good payload, then revalidate in the background.
  // Every entry is {t: Date.now(), v: value} JSON under the "gz:cache:" prefix.
  // All access is wrapped in try/catch so a missing localStorage (SSR/test
  // stubs) or a quota error never throws into a caller.
  var GZ_CACHE_PREFIX = "gz:cache:";
  var gzCache = {
    get: function (key, maxAgeMs) {
      try {
        var raw = localStorage.getItem(GZ_CACHE_PREFIX + key);
        if (!raw) return null;
        var rec = JSON.parse(raw);
        if (!rec || typeof rec.t !== "number") return null;
        if (typeof maxAgeMs === "number" && Date.now() - rec.t > maxAgeMs) return null;
        return rec.v;
      } catch (e) {
        return null;
      }
    },
    set: function (key, value) {
      try {
        localStorage.setItem(
          GZ_CACHE_PREFIX + key,
          JSON.stringify({ t: Date.now(), v: value })
        );
      } catch (e) {
        // Quota or unavailable storage: caching is best-effort, ignore.
      }
    },
    clear: function () {
      try {
        var keys = [];
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf(GZ_CACHE_PREFIX) === 0) keys.push(k);
        }
        for (var j = 0; j < keys.length; j++) localStorage.removeItem(keys[j]);
      } catch (e) {}
    },
  };

  window.gzCache = gzCache;
  window.gzRelTime = gzRelTime;
  window.gzTime = gzTime;
  window.gzLivePoll = gzLivePoll;
  window.gzReduceMotion = gzReduceMotion;
  window.gzRefreshTimes = refreshTimes;
  window.gzDecorateCopy = gzDecorateCopy;
})();
