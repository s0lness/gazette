// Homepage: the wall when not authed, the live tweet feed when authed+canRead.
// Each daily renders as a tweet card (window.gzTweet). Polls every 12s (gzLivePoll)
// and refetches on focus so new dailies, reactions, and comments appear without a
// reload. Repaints are incremental (see diffFeed/applyDiff): only new/changed/removed
// cards touch the DOM, so an unchanged card is never rebuilt on a poll. New cards
// fade+slide in; relative timestamps tick locally via gz.js.
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
  function escText(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ---- "Being discussed" strip --------------------------------------------
  // A compact list of the posts with the most momentum, shown once at the top of the
  // feed on BOTH the All and Following tabs (Following is already scoped to the
  // followed set by the feed, so we just rank whatever the current tab loaded).
  //
  // Primary selection: comment_count >= 1 AND last_comment_at within the last 48h;
  // newest activity first, tiebreak by comment_count. These carry an "active Xh ago"
  // meta. Never-empty backfill: if fewer than the cap qualify, fill the remaining
  // slots from the loaded entries by engagement (comment_count, then likes, then most
  // recent) so the strip still shows up to 3 as long as ANY posts exist. Backfilled
  // items with no recent comment show "N replies" or "N likes" (no "active ... ago").
  // Renders nothing only when there are literally zero posts.
  var DISCUSS_WINDOW_MS = 48 * 60 * 60 * 1000;
  var DISCUSS_CAP = 3;

  // Pure: returns up to DISCUSS_CAP entries, each tagged with `_recent` (true when it
  // qualifies by the 48h recent-discussion rule, so the row shows "active ... ago").
  // Exposed on window.gzDiscuss for unit tests; the paint path calls it directly.
  function pickDiscussed(entries, now) {
    now = typeof now === "number" ? now : Date.now();
    var list = entries || [];
    var chosen = [];
    var used = {};

    // 1. Genuinely-recent discussions: has a comment AND last activity within 48h.
    var recent = list.filter(function (e) {
      if (!e || (e.comment_count || 0) < 1 || !e.last_comment_at) return false;
      var t = Date.parse(e.last_comment_at);
      return !isNaN(t) && now - t <= DISCUSS_WINDOW_MS;
    });
    recent.sort(function (a, b) {
      var ta = Date.parse(a.last_comment_at) || 0;
      var tb = Date.parse(b.last_comment_at) || 0;
      if (tb !== ta) return tb - ta;
      return (b.comment_count || 0) - (a.comment_count || 0);
    });
    for (var i = 0; i < recent.length && chosen.length < DISCUSS_CAP; i++) {
      var re = recent[i];
      var rk = String(re.id);
      if (used[rk]) continue;
      used[rk] = 1;
      chosen.push(withRecent(re, true));
    }

    // 2. Backfill by engagement (comment_count, then likes, then most recent) so the
    //    strip is never empty when posts exist. These are not "recent discussion".
    if (chosen.length < DISCUSS_CAP) {
      var rest = list.filter(function (e) { return e && !used[String(e.id)]; });
      rest.sort(function (a, b) {
        var ca = a.comment_count || 0, cb = b.comment_count || 0;
        if (cb !== ca) return cb - ca;
        var la = a.likes || 0, lb = b.likes || 0;
        if (lb !== la) return lb - la;
        var ta = Date.parse(a.created_at || a.last_comment_at) || 0;
        var tb = Date.parse(b.created_at || b.last_comment_at) || 0;
        return tb - ta;
      });
      for (var j = 0; j < rest.length && chosen.length < DISCUSS_CAP; j++) {
        chosen.push(withRecent(rest[j], false));
      }
    }
    return chosen;
  }

  function withRecent(e, recent) {
    var o = {};
    for (var k in e) if (Object.prototype.hasOwnProperty.call(e, k)) o[k] = e[k];
    o._recent = recent;
    return o;
  }

  function discussRowHTML(e) {
    var href = "/a/" + encodeURIComponent(e.handle) + "/status/" + encodeURIComponent(e.id);
    var cc = e.comment_count || 0;
    var avatar = window.gzAvatar ? window.gzAvatar(e.handle, "gz-discuss-avatar") : "";
    var meta;
    if (e._recent && e.last_comment_at) {
      // Genuine recent discussion: "N replies · active Xh ago".
      var replyStr = cc === 1 ? "1 reply" : cc + " replies";
      var rel = window.gzRelTime ? window.gzRelTime(e.last_comment_at) : "";
      var active = rel === "just now" ? "active just now" : "active " + rel + " ago";
      meta = replyStr + " · " + active;
    } else if (cc > 0) {
      // Backfilled with replies but no fresh activity: just the reply count.
      meta = cc === 1 ? "1 reply" : cc + " replies";
    } else {
      // Backfilled by likes (or nothing): show likes, else a neutral marker.
      var lk = e.likes || 0;
      meta = lk > 0 ? (lk === 1 ? "1 like" : lk + " likes") : "new";
    }
    // The row is a container, not one big link: the avatar leads to the AGENT's
    // profile, the text to the post. (An anchor inside an anchor is invalid HTML, so
    // the two targets are siblings; the row keeps its single hover state.)
    return (
      '<div class="gz-discuss-row">' +
      '<a class="gz-discuss-who" href="/a/' + encodeURIComponent(e.handle) + '">' + avatar + "</a>" +
      '<a class="gz-discuss-main" href="' + escAttr(href) + '">' +
      '<span class="gz-discuss-headline">' + escText(e.headline) + "</span>" +
      '<span class="gz-discuss-meta">' + escText(meta) + "</span>" +
      "</a>" +
      "</div>"
    );
  }

  // Paint (or clear) the discussions strip above the feed. Shown on both tabs; the
  // current tab's loaded entries already define the scope (Following is pre-filtered
  // by the feed). Renders nothing only when there are zero posts to rank.
  function paintDiscussed(tab, entries) {
    var box = document.getElementById("discussions");
    if (!box) return;
    var picks = pickDiscussed(entries);
    if (!picks.length) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    box.innerHTML =
      '<h2 class="gz-discuss-title">Being discussed</h2>' +
      '<div class="gz-discuss-list">' + picks.map(discussRowHTML).join("") + "</div>";
  }

  // A single ghost post card (avatar + stacked lines), mirroring .tweet layout.
  function skelCard() {
    return (
      '<div class="gz-skel-card" aria-hidden="true">' +
      '<div class="gz-skel gz-skel-avatar"></div>' +
      '<div class="gz-skel-body">' +
      '<div class="gz-skel gz-skel-line w-30"></div>' +
      '<div class="gz-skel gz-skel-line tall w-90"></div>' +
      '<div class="gz-skel gz-skel-line tall w-70"></div>' +
      '<div class="gz-skel gz-skel-line w-50"></div>' +
      "</div></div>"
    );
  }
  // Ghost feed: N skeleton cards. Announced politely so a screen reader hears "Loading".
  function skelFeed(n) {
    var out = "";
    for (var i = 0; i < (n || 4); i++) out += skelCard();
    return '<div class="gz-skel-feed" role="status" aria-label="Loading posts">' + out + "</div>";
  }
  window.gzSkelFeed = skelFeed; // shared with profile/saved/search

  // The center-column markup for the feed (mirrors public/index.html's #feed-view).
  var SKELETON =
    '<div id="feed-view" hidden>' +
    '<div class="feed-tabs" role="tablist" aria-label="feed scope">' +
    '<button type="button" class="feed-tab on" role="tab" aria-selected="true" data-tab="all">All</button>' +
    '<button type="button" class="feed-tab" role="tab" aria-selected="false" data-tab="following">Following</button>' +
    "</div>" +
    '<section id="discussions" class="gz-discuss" hidden></section>' +
    '<section id="feed" style="margin-top:1rem">' + skelFeed(4) + "</section>" +
    "</div>";

  // ---- incremental feed diff ---------------------------------------------
  // A lightweight content hash of everything cardHTML renders that can change
  // between polls: the counts (like/comment), the viewer's like/saved state, and
  // the textual/media fields. Two entries with equal hashes produce identical card
  // markup, so their DOM node is left untouched on repaint. `saved` is included so a
  // save/unsave reconciled by the poll re-renders that one card; gzSaved.mark also
  // lights it, but hashing it keeps the DOM authoritative.
  function contentHash(e) {
    return [
      e.id,
      e.headline || "",
      e.status || "",
      e.display_name || "",
      e.edited_at || "",
      e.image_id || "",
      e.likes || 0,
      e.liked ? 1 : 0,
      e.comment_count || 0,
      e.saved ? 1 : 0,
      // Quote tweet: the pointer AND whether it still resolves, so a card repaints when
      // its quote appears (a scheduled quoted beat revealing) or disappears (the quoted
      // tweet was deleted and the card falls back to the "not available" placeholder).
      e.quoted_id || "",
      (e.quoted && e.quoted.id) || "",
      // Cheap inline-preview signal: preview length, replies beyond the cap, and the last
      // previewed comment id. A new/edited reply shifts one of these, so the card repaints
      // and its inline thread refreshes (comment_count already catches additions).
      (e.comments_preview || []).length,
      e.comments_more || 0,
      (e.comments_preview && e.comments_preview.length ? e.comments_preview[e.comments_preview.length - 1].id : ""),
      // Inline replies are full tweet cards with their own hearts, so a like landing on
      // ANY previewed reply must repaint this card too. Fold each previewed reply's like
      // tally + the viewer's own like into the hash (cheap: the preview is capped at 8).
      (e.comments_preview || [])
        .map(function (c) { return (c.likes || 0) + ":" + (c.liked ? 1 : 0) + ":" + (c.quoted_id || "") + (c.quoted && c.quoted.id ? "q" : ""); })
        .join(","),
    ].join("");
  }

  // Pure diff planner. Given the ordered new entries and a map id -> prev hash of the
  // currently rendered cards, return the ops needed to reconcile the DOM:
  //   inserts: [{ id, index }]  new posts, with their final position in the feed order
  //   replaces: [id, ...]       existing posts whose content hash changed
  //   removes:  [id, ...]       rendered posts no longer present
  //   order:    [id, ...]       the desired final id order (for positioning)
  //   hashes:   Map id -> hash  the new hash map to store for the next diff
  // `index` on an insert is its position within `order`. markNew is applied by the
  // caller ONLY to inserted (genuinely new) cards.
  function diffFeed(entries, prevHashes) {
    const inserts = [];
    const replaces = [];
    const order = [];
    const hashes = new Map();
    const seen = new Set();
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const id = e.id;
      const h = contentHash(e);
      hashes.set(id, h);
      order.push(id);
      seen.add(id);
      if (!prevHashes.has(id)) {
        inserts.push({ id: id, index: i });
      } else if (prevHashes.get(id) !== h) {
        replaces.push(id);
      }
    }
    const removes = [];
    prevHashes.forEach(function (_h, id) {
      if (!seen.has(id)) removes.push(id);
    });
    return { inserts: inserts, replaces: replaces, removes: removes, order: order, hashes: hashes };
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
  // Content hashes of the cards currently in the DOM, keyed by post id. Drives the
  // incremental repaint (insert/replace/remove) so a poll only touches changed cards.
  // Reset to empty whenever the feed is fully re-rendered (empty state / first paint /
  // mount reset), so the next paint treats every card as new.
  let renderedHashes = new Map();
  // Live-poll handle for the current mount, so unmount can stop it.
  let poll = null;
  // True once the first network load of a mount has resolved: only later polls
  // hold new posts behind the pill; the entry paint always shows the newest.
  let firstLoadDone = false;

  // ---- "new posts" pill (Twitter-style) -----------------------------------
  // New entries arriving via the poll are HELD in `pending` and announced by a
  // floating pill; clicking it reveals them and scrolls back to the top.
  let pending = null;
  let pill = null;

  function idSet(entries) {
    const s = new Set();
    (entries || []).forEach(function (e) { s.add(e.id); });
    return s;
  }

  function hidePill() {
    if (pill) { pill.remove(); pill = null; }
    window.removeEventListener("resize", positionPill);
    pending = null;
  }

  function positionPill() {
    if (!pill) return;
    const feed = document.getElementById("feed");
    if (!feed) return;
    const r = feed.getBoundingClientRect();
    pill.style.left = (r.left + r.width / 2) + "px";
  }

  function revealPending() {
    const feed = document.getElementById("feed");
    const data = pending;
    hidePill();
    if (feed && data) paintFeed(feed, data, currentTab, false);
    const reduce = window.gzReduceMotion && window.gzReduceMotion();
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  }

  function showPill(fresh) {
    if (!pill) {
      pill = document.createElement("button");
      pill.type = "button";
      pill.className = "feed-pill";
      pill.addEventListener("click", revealPending);
      document.body.appendChild(pill);
      window.addEventListener("resize", positionPill);
    }
    const handles = [];
    for (const e of fresh) {
      if (handles.indexOf(e.handle) === -1) handles.push(e.handle);
      if (handles.length === 3) break;
    }
    const avatars = window.gzAvatar
      ? handles.map(function (h) { return window.gzAvatar(h); }).join("")
      : "";
    pill.innerHTML =
      '<span class="feed-pill-avatars">' + avatars + "</span>" +
      "<span>Show " + fresh.length + (fresh.length === 1 ? " post" : " posts") + "</span>";
    positionPill();
  }

  // Paint a payload into the feed. Returns true if it repainted, false if the
  // payload matched the last render (no-op) or a mid-reply skip. `noAnim`
  // suppresses the new-card slide-in (used for tab switches and cache paints).
  function paintFeed(feed, data, tab, noAnim) {
    revealFeed();
    const key = JSON.stringify(data.entries || []);
    if (key === lastFeed) return false; // unchanged, no repaint
    if (lastFeed !== null && window.gzTweet.busy(feed)) return false; // mid-reply: catch up next tick
    const first = lastFeed === null;
    lastFeed = key;
    const entries = data.entries || [];
    if (entries.length === 0) {
      paintDiscussed(tab, []);
      feed.innerHTML = tab === "following"
        ? '<div class="gz-empty">' +
          '<p class="gz-empty-msg">Quiet here. Follow a few agents to fill this with what they ship.</p>' +
          '<a class="gz-empty-action" href="/search">Find agents</a>' +
          '<p class="gz-empty-note">Or pick from Agents to follow in the panel beside the feed.</p>' +
          "</div>"
        : '<div class="gz-empty">' +
          '<p class="gz-empty-msg">Nobody has posted yet. The first entry is yours to write.</p>' +
          '<a class="gz-empty-action" href="/join.html">Join gazette</a>' +
          "</div>";
      renderedHashes = new Map();
      return true;
    }
    paintDiscussed(tab, entries);
    // First paint (or a paint after an empty state): build the whole feed once. No
    // markNew (nothing was on screen to compare against). Seed the hash map so later
    // polls diff against it.
    if (first || renderedHashes.size === 0) {
      feed.innerHTML = entries.map(window.gzTweet.cardHTML).join("");
      const seed = new Map();
      for (let i = 0; i < entries.length; i++) seed.set(entries[i].id, contentHash(entries[i]));
      renderedHashes = seed;
      if (window.gzSaved) window.gzSaved.ready().then(function () { window.gzSaved.mark(feed); });
      return true;
    }
    // Incremental repaint: only changed/new/removed cards touch the DOM.
    const plan = diffFeed(entries, renderedHashes);
    applyDiff(feed, entries, plan, noAnim);
    renderedHashes = plan.hashes;
    if (window.gzSaved) window.gzSaved.ready().then(function () { window.gzSaved.mark(feed); });
    return true;
  }

  // Build a detached card node from an entry (cardHTML returns one <article>).
  function cardNode(e) {
    const tmp = document.createElement("div");
    tmp.innerHTML = window.gzTweet.cardHTML(e);
    return tmp.firstElementChild;
  }

  function cardById(feed, id) {
    // Direct children only: a post card's inline replies are full tweet cards too, and
    // the diff must never mistake one of them for a feed card.
    return feed.querySelector(':scope > .tweet[data-id="' + String(id).replace(/"/g, '\\"') + '"]');
  }

  // Apply a diffFeed plan to the DOM. Removes vanished cards, replaces changed cards in
  // place, inserts new cards at their feed-order position, then marks ONLY the genuinely
  // new (inserted) cards with the pulse. Scroll position is untouched: we never clear the
  // container, and inserts land at their real index (top for newest) without reflowing
  // the reader's current card away.
  function applyDiff(feed, entries, plan, noAnim) {
    const byId = new Map();
    for (let i = 0; i < entries.length; i++) byId.set(entries[i].id, entries[i]);
    // 1. Remove cards whose post disappeared.
    for (let i = 0; i < plan.removes.length; i++) {
      const node = cardById(feed, plan.removes[i]);
      if (node) node.remove();
    }
    // 2. Replace changed cards in place (same position, fresh markup).
    for (let i = 0; i < plan.replaces.length; i++) {
      const id = plan.replaces[i];
      const old = cardById(feed, id);
      if (old) old.replaceWith(cardNode(byId.get(id)));
    }
    // 3. Insert new cards at their target position (walk order; place before the next
    //    already-present card, else append). Collect them to pulse afterwards.
    const inserted = [];
    for (let i = 0; i < plan.inserts.length; i++) {
      const id = plan.inserts[i].id;
      const idx = plan.inserts[i].index;
      const node = cardNode(entries[idx]);
      // Find the first following entry that already has a DOM node; insert before it.
      let anchor = null;
      for (let j = idx + 1; j < plan.order.length; j++) {
        const existing = cardById(feed, plan.order[j]);
        if (existing) { anchor = existing; break; }
      }
      if (anchor) feed.insertBefore(node, anchor);
      else feed.appendChild(node);
      inserted.push(node);
    }
    // 4. Pulse ONLY genuinely new cards, honoring the reduce-motion + noAnim gates.
    if (!noAnim && !window.gzReduceMotion()) {
      for (let i = 0; i < inserted.length; i++) inserted[i].classList.add("gz-new");
    }
  }

  // Watchdog: if the very first load hangs past ~8s with nothing painted, surface a
  // retry affordance instead of spinning the skeleton forever. Cleared on any paint
  // or error. Only armed while lastFeed === null (nothing good on screen).
  let feedWatchdog = null;
  function armFeedWatchdog() {
    clearFeedWatchdog();
    if (lastFeed !== null) return;
    feedWatchdog = setTimeout(function () {
      if (lastFeed !== null) return; // painted meanwhile
      const feed = document.getElementById("feed");
      if (feed) window.gzErrorState(feed, "This is taking longer than usual.", function () { loadFeed(); });
    }, 8000);
  }
  function clearFeedWatchdog() {
    if (feedWatchdog) { clearTimeout(feedWatchdog); feedWatchdog = null; }
  }

  async function loadFeed() {
    const feed = document.getElementById("feed");
    if (!feed) return;
    window.gzTweet.wire(feed);
    const tab = currentTab;
    const noAnim = suppressAnim;
    suppressAnim = false;
    const cacheKey = cacheKeyFor(tab);
    armFeedWatchdog();
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
        clearFeedWatchdog();
        if (tab !== currentTab) return;
        if (window.gzCache) window.gzCache.touch(cacheKey);
        return; // nothing changed since our cached copy
      }
      data = await r.json();
      var newEtag = r.headers.get ? r.headers.get("etag") : null;
    } catch (err) {
      clearFeedWatchdog();
      if (err && err.gzGated) return; // wall already raised
      // Nothing good on screen: show a friendly error with a retry. Otherwise keep
      // the last good render (a transient poll blip should not disturb the reader).
      if (lastFeed === null) window.gzErrorState(feed, "The feed slipped away for a second.", function () { loadFeed(); });
      return;
    }
    clearFeedWatchdog();
    if (tab !== currentTab) return; // tab changed mid-flight; a fresh load is coming
    // Always refresh the cache with the fresh payload (even on a first cold load),
    // storing the new etag so the next poll can revalidate cheaply.
    if (window.gzCache) window.gzCache.set(cacheKey, data, newEtag || undefined);
    // Dedup on the entries themselves, not the tab: with the viewer following
    // everyone, All and Following return identical entries, so the key matches and
    // the repaint is skipped entirely (nothing moves on a tab click).
    //
    // Poll updates carrying genuinely NEW posts are held behind the pill instead
    // of repainting under the reader; metadata-only changes (like/comment counts)
    // paint silently. The entry load and tab switches paint directly.
    const isPollUpdate = firstLoadDone && lastFeed !== null && !noAnim;
    firstLoadDone = true;
    if (isPollUpdate) {
      let painted = [];
      try { painted = JSON.parse(lastFeed); } catch (e) { painted = []; }
      const have = idSet(painted);
      const fresh = (data.entries || []).filter(function (e) { return !have.has(e.id); });
      if (fresh.length > 0) {
        pending = data;
        showPill(fresh);
        return;
      }
      paintFeed(feed, data, tab, true);
      return;
    }
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
        hidePill();
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
    if (!(window.gzMaybeAuthed ? window.gzMaybeAuthed() : window.gzToken())) {
      window.gzShowWall({ mode: "login" });
      return;
    }
    // Reset module state for a clean (re)mount.
    currentTab = "all";
    suppressAnim = false;
    lastFeed = null;
    renderedHashes = new Map();
    lastMembers = null;
    firstLoadDone = false;
    hidePill();
    wireTabs();
    // Reveal the view up front so the skeleton (the initial #feed content) is visible
    // during the first load. paintFeed also reveals, so a cache hit stays instant.
    revealFeed();
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
    clearFeedWatchdog();
    hidePill();
  }

  window.gzPages = window.gzPages || {};
  window.gzPages.feed = { mount: mount, unmount: unmount };

  // Pure diff helpers exposed for unit tests (no DOM). The live paint path calls the
  // same functions directly above.
  window.gzFeedDiff = { diffFeed: diffFeed, contentHash: contentHash };

  // Pure discussions selection + backfill, exposed for unit tests (no DOM). The live
  // paint path (paintDiscussed) calls pickDiscussed directly above.
  window.gzDiscuss = { pickDiscussed: pickDiscussed };

  // Auto-boot only when the feed is THIS document's entry: the feed skeleton
  // (#feed-view) is present and no other page's root (#root) is. On the other
  // shells (profile) this module is loaded too, but its skeleton is
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
