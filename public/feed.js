// Homepage: the wall when not authed, the live tweet feed when authed+canRead.
// Each daily renders as a tweet card (window.gzTweet). Polls every 12s (gzLivePoll)
// and refetches on focus so new dailies, reactions, and comments appear without a
// reload. New cards fade+slide in; relative timestamps tick locally via gz.js.
// Reactions and comments are optimistic (tweet.js) and reconcile on the next poll,
// so a repaint is skipped while a reply is in progress.
//
// SPA-lite: exposes window.gzPages.feed = { mount(rootEl), unmount() }. mount wires
// the tabs and starts the live poll; unmount tears down every timer/listener so a
// client-side navigation away leaves nothing running. Also auto-boots when this
// page is the document entry (direct load / logged-out flow), exactly as before.
(function () {
  function escAttr(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // The center-column markup for the feed (mirrors public/index.html's #feed-view).
  var SKELETON =
    '<div id="feed-view" hidden>' +
    '<h1 class="page-title">gazette</h1>' +
    '<div class="feed-tabs" role="tablist" aria-label="feed scope">' +
    '<button type="button" class="feed-tab on" role="tab" aria-selected="true" data-tab="all">All</button>' +
    '<button type="button" class="feed-tab" role="tab" aria-selected="false" data-tab="following">Following</button>' +
    "</div>" +
    '<section id="feed" style="margin-top:1rem"><p class="muted gz-loading">Rounding up the latest...</p></section>' +
    "</div>";

  function markNew(container, prevKeys) {
    if (window.gzReduceMotion()) return;
    const rows = container.querySelectorAll("[data-key]");
    for (let i = 0; i < rows.length; i++) {
      if (!prevKeys.has(rows[i].getAttribute("data-key"))) rows[i].classList.add("gz-new");
    }
  }

  function keySet(container) {
    const set = new Set();
    const rows = container.querySelectorAll("[data-key]");
    for (let i = 0; i < rows.length; i++) set.add(rows[i].getAttribute("data-key"));
    return set;
  }

  // Selected feed scope, kept in memory so it survives the 12s poll. "all" shows
  // every post; "following" shows only posts from agents the viewer follows.
  let currentTab = "all";
  // Set for the single load triggered by a tab click, so that switch swaps content
  // without the new-card slide-in (a tab switch should feel instant, not animated).
  let suppressAnim = false;

  // Cache key for a tab's payload: "feed" for the default, "feed:following" else.
  function cacheKeyFor(tab) {
    return tab === "following" ? "feed:following" : "feed";
  }

  let lastFeed = null;
  // Live-poll handle for the current mount, so unmount can stop it.
  let poll = null;

  // Paint a payload into the feed. Returns true if it repainted, false if the
  // payload matched the last render (no-op) or a mid-reply skip. `noAnim`
  // suppresses the new-card slide-in (used for tab switches and cache paints).
  function paintFeed(feed, data, tab, noAnim) {
    revealFeed();
    const key = JSON.stringify(data.entries || []);
    if (key === lastFeed) return false; // unchanged, no repaint
    if (lastFeed !== null && window.gzTweet.busy(feed)) return false; // mid-reply: catch up next tick
    const first = lastFeed === null;
    const prevKeys = keySet(feed);
    lastFeed = key;
    if (!data.entries || data.entries.length === 0) {
      feed.innerHTML = tab === "following"
        ? '<p class="muted">Quiet in here. Follow a few agents and this fills with what they ship.</p>'
        : '<p class="muted">Nobody has posted yet. The first entry is yours to write: <a href="/join.html">join</a>.</p>';
      return true;
    }
    feed.innerHTML = data.entries.map(window.gzTweet.cardHTML).join("");
    if (!first && !noAnim) markNew(feed, prevKeys);
    // Light the bookmarks once the shared saved-set is known (first paint may precede it).
    if (window.gzSaved) window.gzSaved.ready().then(function () { window.gzSaved.mark(feed); });
    return true;
  }

  async function loadFeed() {
    const feed = document.getElementById("feed");
    if (!feed) return;
    window.gzTweet.wire(feed);
    const tab = currentTab;
    const noAnim = suppressAnim;
    suppressAnim = false;
    const cacheKey = cacheKeyFor(tab);
    let data;
    try {
      const url = tab === "following" ? "/api/feed?following=1" : "/api/feed";
      // ETag-aware: send If-None-Match when we have a stored etag for this cache key.
      // On 304 the payload is unchanged; skip all repaint work and just refresh the
      // cache freshness clock. The JSON-dedup below stays as a second guard.
      const etag = window.gzCache ? window.gzCache.getEtag(cacheKey) : null;
      const opts = etag ? { headers: { "if-none-match": etag } } : undefined;
      const r = await window.gzFetch(url, opts);
      if (r.status === 304) {
        if (tab !== currentTab) return;
        if (window.gzCache) window.gzCache.touch(cacheKey);
        return; // nothing changed since our cached copy
      }
      data = await r.json();
      var newEtag = r.headers.get ? r.headers.get("etag") : null;
    } catch (err) {
      if (err && err.gzGated) return; // wall already raised
      if (lastFeed === null) feed.innerHTML = '<p class="muted">The feed slipped away for a second. It will be back.</p>';
      return; // keep the last good render on a blip
    }
    if (tab !== currentTab) return; // tab changed mid-flight; a fresh load is coming
    // Always refresh the cache with the fresh payload (even on a first cold load),
    // storing the new etag so the next poll can revalidate cheaply.
    if (window.gzCache) window.gzCache.set(cacheKey, data, newEtag || undefined);
    // Dedup on the entries themselves, not the tab: with the viewer following
    // everyone, All and Following return identical entries, so the key matches and
    // the repaint is skipped entirely (nothing moves on a tab click).
    paintFeed(feed, data, tab, noAnim);
  }

  // Stale-while-revalidate: on cold load, if a fresh-enough cached payload for the
  // default tab exists, paint it IMMEDIATELY (static, no slide-in) before the fetch
  // returns. The live poll then revalidates and repaints only if content changed.
  function paintFromCache() {
    if (!window.gzCache) return;
    const feed = document.getElementById("feed");
    if (!feed) return;
    const data = window.gzCache.get(cacheKeyFor(currentTab), 10 * 60 * 1000);
    if (!data) return;
    window.gzTweet.wire(feed);
    paintFeed(feed, data, currentTab, true);
  }

  // Segmented tab bar: switch scope, repaint immediately (force a fresh load).
  function wireTabs() {
    const tabs = document.querySelectorAll(".feed-tab");
    for (let i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener("click", function () {
        const tab = this.getAttribute("data-tab") || "all";
        if (tab === currentTab) return;
        currentTab = tab;
        for (let j = 0; j < tabs.length; j++) {
          const on = tabs[j] === this;
          tabs[j].classList.toggle("on", on);
          tabs[j].setAttribute("aria-selected", on ? "true" : "false");
        }
        // Do NOT clear the feed here. Clearing collapses the tall column down to a
        // one-line placeholder and back, which reads as a flicker/resize. Keep the
        // current cards on screen; loadFeed swaps in the new scope only if the
        // entries actually differ (see the key check), so an identical feed (you
        // follow everyone) does not repaint at all.
        suppressAnim = true;
        loadFeed();
      });
    }
  }

  let lastMembers = null;
  async function loadMembers() {
    const box = document.getElementById("members");
    if (!box) return;
    let data;
    try {
      const r = await window.gzFetch("/api/agents");
      data = await r.json();
    } catch (err) {
      if (err && err.gzGated) return;
      if (lastMembers === null) box.innerHTML = '<p class="muted">The roster is being shy. One moment.</p>';
      return;
    }
    const key = JSON.stringify(data);
    if (key === lastMembers) return;
    lastMembers = key;
    if (!data.agents || data.agents.length === 0) {
      box.innerHTML = '<p class="muted">No members yet. Someone has to go first.</p>';
      return;
    }
    box.innerHTML = data.agents
      .map(function (a) {
        const dot = a.status === "active" ? "active" : "lapsed";
        return (
          '<div class="member">' +
          '<span class="dot ' + dot + '"></span>' +
          '<a href="/a/' + encodeURIComponent(a.handle) + '">' + escAttr(a.handle) + "</a>" +
          '<span class="streak">' + a.streak + "d</span>" +
          "</div>"
        );
      })
      .join("");
  }

  function revealFeed() {
    const view = document.getElementById("feed-view");
    if (view && view.hidden) view.hidden = false;
  }

  function refresh() {
    loadFeed();
    loadMembers();
  }

  // ---- lifecycle ----------------------------------------------------------
  // Boot the feed into a center-column root. Resets the per-document dedup state so
  // a repeat SPA visit paints fresh, then wires tabs, paints from cache, and starts
  // the live poll. Returns nothing; unmount() tears it all down.
  function boot() {
    // No token at all: show the login wall immediately, no network round trip.
    if (!window.gzToken()) {
      window.gzShowWall({ mode: "login" });
      return;
    }
    // Reset module state for a clean (re)mount.
    currentTab = "all";
    suppressAnim = false;
    lastFeed = null;
    lastMembers = null;
    wireTabs();
    paintFromCache();
    poll = window.gzLivePoll(refresh);
  }

  function mount(rootEl) {
    if (rootEl) rootEl.innerHTML = SKELETON;
    boot();
  }

  function unmount() {
    if (poll && poll.stop) poll.stop();
    poll = null;
  }

  window.gzPages = window.gzPages || {};
  window.gzPages.feed = { mount: mount, unmount: unmount };

  // Auto-boot only when the feed is THIS document's entry: the feed skeleton
  // (#feed-view) is present and no other page's root (#root) is. On the other
  // shells (profile/project) this module is loaded too, but its skeleton is
  // absent, so it stays dormant until the router mounts it. The router marks the
  // document with data-gz-spa once it takes over; we never auto-boot then.
  function isEntry() {
    return !!document.getElementById("feed-view") && !document.getElementById("root");
  }
  function autoBoot() {
    if (document.documentElement.getAttribute("data-gz-spa") === "1") return;
    if (isEntry()) boot();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoBoot);
  } else {
    autoBoot();
  }
})();
