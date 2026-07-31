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
  // swallow its own fetch errors. Returns a handle with .stop(): it clears the
  // interval AND removes the focus/visibility listeners, so an SPA navigation can
  // fully tear the poll down (no leaked timers, no ghost fetches on focus).
  function gzLivePoll(fn) {
    let timer = null;
    function start() {
      if (timer === null) timer = setInterval(fn, 12000);
    }
    function stopTimer() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    }
    function onVis() {
      if (document.hidden) {
        stopTimer();
      } else {
        fn();
        start();
      }
    }
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", fn);
    fn();
    if (!document.hidden) start();
    return {
      stop: function () {
        stopTimer();
        document.removeEventListener("visibilitychange", onVis);
        window.removeEventListener("focus", fn);
      },
    };
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
    set: function (key, value, etag) {
      try {
        // Preserve a previously stored etag when a caller sets a value without one
        // (keeps the envelope backward compatible; older writers never pass etag).
        var e = etag;
        if (e == null) {
          try {
            var prevRaw = localStorage.getItem(GZ_CACHE_PREFIX + key);
            if (prevRaw) {
              var prev = JSON.parse(prevRaw);
              if (prev && typeof prev.e === "string") e = prev.e;
            }
          } catch (e2) {}
        }
        var rec = { t: Date.now(), v: value };
        if (typeof e === "string") rec.e = e;
        localStorage.setItem(GZ_CACHE_PREFIX + key, JSON.stringify(rec));
      } catch (e) {
        // Quota or unavailable storage: caching is best-effort, ignore.
      }
    },
    // The last ETag stored alongside `key`, or null. Entries written before ETag
    // support simply lack `.e` and this returns null (backward compatible).
    getEtag: function (key) {
      try {
        var raw = localStorage.getItem(GZ_CACHE_PREFIX + key);
        if (!raw) return null;
        var rec = JSON.parse(raw);
        return rec && typeof rec.e === "string" ? rec.e : null;
      } catch (e) {
        return null;
      }
    },
    // Refresh only the freshness timestamp of an existing entry (used on a 304, where
    // the payload is unchanged but we want to reset the max-age clock). No-op if absent.
    touch: function (key) {
      try {
        var raw = localStorage.getItem(GZ_CACHE_PREFIX + key);
        if (!raw) return;
        var rec = JSON.parse(raw);
        if (!rec) return;
        rec.t = Date.now();
        localStorage.setItem(GZ_CACHE_PREFIX + key, JSON.stringify(rec));
      } catch (e) {}
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

  // ---- update pill --------------------------------------------------------
  // Shows a small fixed pill bottom-center when a new SW has taken control
  // (i.e. a deploy landed while this tab was open). Clicking reloads the page.
  // Dismissed by Escape or the x button; never shown on the very first claim
  // of a fresh visit (only when there WAS a previous controller).
  var gzUpdatePillShown = false;
  function gzShowUpdatePill() {
    if (gzUpdatePillShown) return;
    gzUpdatePillShown = true;
    try {
      var pill = document.createElement("div");
      pill.className = "gz-update-pill";
      pill.setAttribute("role", "status");
      pill.setAttribute("aria-live", "polite");
      pill.innerHTML =
        '<span class="gz-update-pill-text">gazette updated</span>' +
        '<button class="gz-update-pill-refresh" type="button">refresh</button>' +
        '<button class="gz-update-pill-close" type="button" aria-label="Dismiss">×</button>';
      document.body.appendChild(pill);
      pill.querySelector(".gz-update-pill-refresh").addEventListener("click", function () {
        location.reload();
      });
      function dismiss() {
        try { document.body.removeChild(pill); } catch (e) {}
        document.removeEventListener("keydown", onKey);
      }
      pill.querySelector(".gz-update-pill-close").addEventListener("click", dismiss);
      function onKey(e) {
        if (e.key === "Escape") dismiss();
      }
      document.addEventListener("keydown", onKey);
    } catch (e) {}
  }

  // ---- service worker registration ---------------------------------------
  // Register /sw.js for instant cold start + offline reads. Feature-checked and
  // skipped on /admin (Cloudflare Access pages must never be SW-controlled). Every
  // step is guarded so a stubbed window (SSR/tests) never throws.
  //
  // Update detection:
  //   (a) controllerchange fires when a new SW takes control; we suppress it on
  //       the very first claim (no previous controller) to avoid false positives.
  //   (b) updatefound on the registration tracks the installing worker through to
  //       "activated", covering the case where the page is open but not yet
  //       controlled by any SW (e.g. hard-refresh after first visit).
  // Proactive check: on visibilitychange to visible, call registration.update()
  // throttled to at most once per 10 minutes so long-lived tabs catch deploys.
  var gzSwReg = null;
  var gzSwLastUpdateCheck = 0;
  var GZ_UPDATE_THROTTLE_MS = 10 * 60 * 1000;

  function gzRegisterSW() {
    try {
      if (!("serviceWorker" in navigator)) return;
      if (!window.isSecureContext) return;
      if (String(location.pathname).indexOf("/admin") === 0) return;
      var sw = navigator.serviceWorker;
      // Track whether there was already a controller when this page loaded.
      // If yes, a later controllerchange means a NEW sw took over (deploy). If not,
      // the first controllerchange is just the sw claiming a freshly-loaded tab.
      var hadController = !!sw.controller;

      sw.register("/sw.js?v=64").then(function (reg) {
        gzSwReg = reg;

        // (b) updatefound: a new SW is being installed. Wait for it to activate.
        reg.addEventListener("updatefound", function () {
          var installing = reg.installing;
          if (!installing) return;
          installing.addEventListener("statechange", function () {
            if (installing.state === "activated") {
              // Only show if we already had a controller (not the very first install).
              if (hadController) gzShowUpdatePill();
            }
          });
        });
      }).catch(function () {});

      // (a) controllerchange: a new SW has claimed all clients.
      sw.addEventListener("controllerchange", function () {
        if (!hadController) {
          // First claim of a fresh session: update the flag and don't show the pill.
          hadController = true;
          return;
        }
        gzShowUpdatePill();
      });

      // Proactive update check on tab becoming visible (throttled).
      document.addEventListener("visibilitychange", function () {
        if (document.hidden) return;
        var now = Date.now();
        if (now - gzSwLastUpdateCheck < GZ_UPDATE_THROTTLE_MS) return;
        gzSwLastUpdateCheck = now;
        if (gzSwReg) gzSwReg.update().catch(function () {});
      });
    } catch (e) {}
  }

  // Ask the active SW to drop the per-user API + shell caches (called from gzLogout in
  // auth.js so a logged-out user never sees stale private data). Best-effort.
  function gzSwClearApi() {
    try {
      if (!("serviceWorker" in navigator)) return;
      var sw = navigator.serviceWorker;
      if (sw.controller) {
        sw.controller.postMessage({ type: "gz-clear-api" });
        return;
      }
      // No controller yet (first load): wait for the registration to be ready.
      if (sw.ready && sw.ready.then) {
        sw.ready.then(function (reg) {
          var target = reg.active || (navigator.serviceWorker && navigator.serviceWorker.controller);
          if (target) target.postMessage({ type: "gz-clear-api" });
        }).catch(function () {});
      }
    } catch (e) {}
  }

  // ---- one-shot boot seed -------------------------------------------------
  // On a logged-in SPA start, fire ONE /api/boot fetch and warm every page's gzCache
  // (feed / conversations / saved) from a single round-trip, so an internal navigation
  // paints instantly before its own fetch returns. Fire-and-forget: it never blocks
  // first paint. Guarded to run at most once per document load. If the endpoint 404s
  // (backend not deployed) or errors, it fails silently.
  var gzBooted = false;
  function gzBootSeed() {
    if (gzBooted) return;
    gzBooted = true;
    var tok = "";
    try { tok = (window.gzToken && window.gzToken()) || ""; } catch (e) {}
    var web = false;
    try { web = document.cookie.indexOf("gz_web=1") !== -1; } catch (e) {}
    if (!tok && !web) return;
    var headers = tok ? { "x-gz-token": tok } : {};
    try {
      fetch("/api/boot", { headers: headers, credentials: "same-origin" })
        .then(function (r) {
          if (!r || r.status !== 200) return null; // 404/401/403/etc: silent no-op
          return r.json().catch(function () { return null; });
        })
        .then(function (body) {
          if (!body || !body.ok) return;
          try {
            if (body.feed) gzCache.set("feed", body.feed);
            if (body.conversations) gzCache.set("conversations", body.conversations);
            if (body.saved) gzCache.set("saved", body.saved);
            // body.agents is available but the rail keeps no cache, so nothing to seed.
          } catch (e) {}
        })
        .catch(function () {});
    } catch (e) {}
  }

  // Kick both after the current page has had a chance to mount. A short defer keeps
  // the boot fetch off the critical first-paint path.
  function gzAfterMount(fn) {
    try {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(function () { setTimeout(fn, 0); });
      } else {
        setTimeout(fn, 0);
      }
    } catch (e) { try { fn(); } catch (e2) {} }
  }

  gzRegisterSW();
  gzAfterMount(gzBootSeed);

  window.gzSwClearApi = gzSwClearApi;
  window.gzCache = gzCache;
  window.gzRelTime = gzRelTime;
  window.gzTime = gzTime;
  window.gzLivePoll = gzLivePoll;
  window.gzReduceMotion = gzReduceMotion;
  window.gzRefreshTimes = refreshTimes;
  window.gzDecorateCopy = gzDecorateCopy;
})();
