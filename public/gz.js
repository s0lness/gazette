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

  // ---- auto-growing textareas ---------------------------------------------
  // No textarea in gazette shows the native resize grip (app.css turns it off for
  // every one of them: it reads as a rough edge on an otherwise clean card). So a
  // multi-line field has to follow its own text instead, or a long reply would be
  // written through a two-line slot. One helper does that for all of them, the DM
  // composer included: measure the content, take that height up to a cap, and only
  // past the cap let the box scroll.
  //
  // The caps live together, here, because they are a judgement about the SHAPE of
  // each surface rather than styling: a chat line, a reply and a bio are not the
  // same object. Values are px; a field opts in from its markup alone, with
  // data-gz-grow="<name>" (or a raw px number).
  var GZ_GROW_CAPS = {
    // The DM composer: a fast back-and-forth where the transcript above matters more
    // than the draft. Mirrors .msg-input's max-height in app.css; unchanged behaviour.
    chat: 160,
    // A reply (under a post, or under a comment) is a short paragraph, and its Reply
    // button has to stay on screen next to it.
    reply: 200,
    // The quote composer is capped at 200 characters anyway, and it sits in a modal
    // sheet that must not outgrow the viewport.
    quote: 160,
    // Free prose: the feedback box and a comment being edited. Roomier, because there
    // is nothing below them competing for the space.
    prose: 260,
    // A description is capped at 300 characters, so this is enough to never scroll.
    bio: 220,
  };
  var GZ_GROW_FALLBACK = 200;
  // Whatever the cap says, never take more than this share of the window height: the
  // feedback and quote sheets do not scroll past a point, so a tall box on a short
  // screen would push its own buttons out of reach.
  var GZ_GROW_VIEWPORT_SHARE = 0.6;

  // Pure: the height a textarea should take (px) and whether it must scroll, given the
  // content height it reports, its cap, and the window height. Exported for tests.
  function gzGrowHeight(scrollHeight, cap, viewportPx) {
    var sh = Number(scrollHeight);
    if (!isFinite(sh) || sh < 0) sh = 0;
    var c = Number(cap);
    if (!isFinite(c) || c <= 0) c = GZ_GROW_FALLBACK;
    var vp = Number(viewportPx);
    if (isFinite(vp) && vp > 0) c = Math.min(c, Math.round(vp * GZ_GROW_VIEWPORT_SHARE));
    return { height: Math.min(sh, c), scroll: sh > c };
  }

  // Resolve a cap from a named surface, a raw px number, or the fallback.
  function gzGrowCap(ta, maxPx) {
    var raw = maxPx;
    if (raw == null && ta && ta.getAttribute) raw = ta.getAttribute("data-gz-grow");
    if (raw == null || raw === "") return GZ_GROW_FALLBACK;
    if (Object.prototype.hasOwnProperty.call(GZ_GROW_CAPS, raw)) return GZ_GROW_CAPS[raw];
    var n = Number(raw);
    return isFinite(n) && n > 0 ? n : GZ_GROW_FALLBACK;
  }

  // The px to add to scrollHeight to get the height the element should be SET to:
  // the border on a border-box field, minus the padding on a content-box one.
  function gzBoxAdjust(ta) {
    try {
      var cs = window.getComputedStyle(ta);
      var f = function (v) { var n = parseFloat(v); return isFinite(n) ? n : 0; };
      if (cs.boxSizing === "border-box") return f(cs.borderTopWidth) + f(cs.borderBottomWidth);
      return -(f(cs.paddingTop) + f(cs.paddingBottom));
    } catch (e) {
      return 0;
    }
  }

  // Size one textarea to its content. Safe on any node (no-ops on everything else) and
  // safe to call repeatedly: on input, after a paste, and after code sets or clears
  // .value (a send empties the box, which must then snap back to one line).
  function gzAutoGrow(ta, maxPx) {
    if (!ta || ta.tagName !== "TEXTAREA") return;
    try {
      if (maxPx != null && ta.setAttribute && !ta.getAttribute("data-gz-grow")) {
        ta.setAttribute("data-gz-grow", String(maxPx));
      }
      // "auto" first, so a shrinking value can actually shrink the box: scrollHeight
      // on a fixed-height textarea never reports less than the height it already has.
      ta.style.height = "auto";
      // scrollHeight is content + padding, with no border. Every field here is
      // border-box, where `height` covers the border too, so add it back or the box
      // would lose 2px the moment it is first sized (a visible twitch on first keypress).
      var r = gzGrowHeight(ta.scrollHeight + gzBoxAdjust(ta), gzGrowCap(ta, maxPx), window.innerHeight || 0);
      ta.style.height = r.height + "px";
      ta.style.overflowY = r.scroll ? "auto" : "hidden";
    } catch (e) {}
  }

  // One delegated listener covers every grown field, including the ones the feed
  // re-renders from HTML strings: the attribute alone is the opt-in, no wiring. It
  // bubbles, so a field's own input handler (the chat composer) still runs first.
  document.addEventListener("input", function (e) {
    var t = e.target;
    if (!t || t.tagName !== "TEXTAREA") return;
    if (!t.hasAttribute || !t.hasAttribute("data-gz-grow")) return;
    gzAutoGrow(t);
  });

  // A width change (rotation, window resize, the mobile keyboard) re-wraps the text,
  // which makes the pinned pixel height stale. Recompute every mounted field, at most
  // once per frame.
  var gzGrowPending = false;
  try {
    window.addEventListener("resize", function () {
      if (gzGrowPending) return;
      gzGrowPending = true;
      var run = function () {
        gzGrowPending = false;
        var list = document.querySelectorAll("textarea[data-gz-grow]");
        for (var i = 0; i < list.length; i++) gzAutoGrow(list[i]);
      };
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
      else setTimeout(run, 16);
    });
  } catch (e) {}

  // ---- toast --------------------------------------------------------------
  // One brief, non-blocking confirmation pill, bottom-center (above the mobile
  // bottom nav via CSS). A new toast REPLACES the current one so rapid actions
  // never stack a tower. Auto-dismisses after ~1.8s (instant when reduced motion).
  // The queue/replace logic is pure enough to unit test via gzToast itself.
  var gzToastEl = null;
  var gzToastTimer = null;
  var gzToastOutTimer = null;
  function gzToast(msg) {
    msg = String(msg == null ? "" : msg);
    if (!msg) return;
    try {
      if (gzToastTimer) { clearTimeout(gzToastTimer); gzToastTimer = null; }
      if (gzToastOutTimer) { clearTimeout(gzToastOutTimer); gzToastOutTimer = null; }
      if (!gzToastEl) {
        gzToastEl = document.createElement("div");
        gzToastEl.className = "gz-toast";
        gzToastEl.setAttribute("role", "status");
        gzToastEl.setAttribute("aria-live", "polite");
        document.body.appendChild(gzToastEl);
      }
      // Re-trigger the in-animation on a replace.
      gzToastEl.classList.remove("gz-toast-out");
      gzToastEl.textContent = msg;
      var el = gzToastEl;
      gzToastTimer = setTimeout(function () {
        gzToastTimer = null;
        if (!el) return;
        var reduce = gzReduceMotion();
        if (reduce) {
          try { if (el.parentNode) el.parentNode.removeChild(el); } catch (e) {}
          if (gzToastEl === el) gzToastEl = null;
          return;
        }
        el.classList.add("gz-toast-out");
        gzToastOutTimer = setTimeout(function () {
          gzToastOutTimer = null;
          try { if (el.parentNode) el.parentNode.removeChild(el); } catch (e) {}
          if (gzToastEl === el) gzToastEl = null;
        }, 200);
      }, 1800);
    } catch (e) {}
  }

  // ---- shared error state (with retry) ------------------------------------
  // Render a compact, friendly error card into `container` with a Retry button
  // wired to `onRetry`. Keeps the copy tone but adds a recovery action. Used by
  // every view's fetch-failure path so the retry affordance is consistent.
  function gzErrorState(container, msg, onRetry) {
    if (!container) return;
    var m = String(msg == null ? "Something slipped for a second." : msg);
    container.innerHTML =
      '<div class="gz-error" role="alert">' +
      '<p class="gz-error-msg">' + escHtml(m) + "</p>" +
      '<button type="button" class="gz-retry">Try again</button>' +
      "</div>";
    var btn = container.querySelector(".gz-retry");
    if (btn && typeof onRetry === "function") {
      btn.addEventListener("click", function () { onRetry(); });
    }
  }
  function escHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

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

      sw.register("/sw.js?v=100").then(function (reg) {
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

  // ---- ask handoff --------------------------------------------------------
  // Hand a question to the Messages chat and navigate there. The chat view reads the
  // single-use "gz:ask" handoff on mount and sends it as the first message. Shared by
  // the profile's Ask box/chips and the "Ask how" action on a post card, so there is
  // exactly ONE handoff contract. SPA-navigates when the router is present.
  function gzLaunchAsk(targetHandle, question) {
    var handle = String(targetHandle == null ? "" : targetHandle).trim();
    if (!handle) return;
    var q = String(question == null ? "" : question).trim();
    var target = "/messages#@" + encodeURIComponent(handle);
    try {
      sessionStorage.setItem("gz:ask", JSON.stringify({ handle: handle, q: q }));
    } catch (e) {}
    if (window.gzRouter && window.gzRouter.go) { window.gzRouter.go(target); return; }
    try { location.assign(target); } catch (e) { location.hash = "#@" + encodeURIComponent(handle); }
  }

  // ---- back navigation (detail pages) --------------------------------------
  // A focused detail view (the public post permalink) carries a back control. It must
  // NEVER dead-end: the visitor who landed cold from a shared link has nothing useful
  // behind them, so "back" has to resolve to the site's main page instead of a blank
  // history step or the external site that referred them.
  //
  // Resolution, in order:
  //   1. the previous document was OURS (same-origin referrer) AND this tab actually
  //      has a step to go back to (history.length > 1) -> history.back(), which
  //      returns the visitor exactly where they came from (feed, profile, search...);
  //   2. anything else (no referrer, an external referrer, or a fresh tab opened by
  //      target=_blank where back() would be a no-op) -> a real navigation to `fallback`
  //      (always "/" here).
  // The permalink is NOT a router route (router.js does not intercept it), so there is
  // no in-app SPA history to consult: the referrer IS the record of the previous
  // in-app route. `fallback` is a hard navigation on purpose, so a cold landing gets
  // the real main-page document rather than a page module mounted into this shell.
  function gzBack(fallback) {
    var home = fallback || "/";
    var fromApp = false;
    try {
      fromApp = !!document.referrer && new URL(document.referrer).origin === location.origin;
    } catch (e) {}
    if (fromApp && window.history && window.history.length > 1) {
      try { window.history.back(); return; } catch (e) {}
    }
    location.href = home;
  }

  // Any element carrying [data-gz-back] becomes a back control. Rendered as a real
  // <a href="/"> so a no-JS visitor (or a crawler) still has a working way to the main
  // page; this listener upgrades the click into the resolution above. It runs BEFORE
  // router.js's own click interception (gz.js loads first) and calls preventDefault, so
  // the router leaves the click alone instead of mounting the feed into this shell.
  document.addEventListener("click", function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var el = e.target && e.target.closest ? e.target.closest("[data-gz-back]") : null;
    if (!el) return;
    e.preventDefault();
    gzBack(el.getAttribute("data-gz-back") || el.getAttribute("href") || "/");
  });

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
  window.gzToast = gzToast;
  window.gzAutoGrow = gzAutoGrow;
  window.gzGrowHeight = gzGrowHeight;
  window.gzLaunchAsk = gzLaunchAsk;
  window.gzErrorState = gzErrorState;
  window.gzBack = gzBack;
})();
