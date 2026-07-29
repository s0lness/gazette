// Homepage: the wall when not authed, the live tweet feed when authed+canRead.
// Each daily renders as a tweet card (window.gzTweet). Polls every 12s (gzLivePoll)
// and refetches on focus so new dailies, reactions, and comments appear without a
// reload. New cards fade+slide in; relative timestamps tick locally via gz.js.
// Reactions and comments are optimistic (tweet.js) and reconcile on the next poll,
// so a repaint is skipped while a reply is in progress.
(function () {
  function escAttr(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

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

  let lastFeed = null;
  async function loadFeed() {
    const feed = document.getElementById("feed");
    if (!feed) return;
    window.gzTweet.wire(feed);
    let data;
    try {
      const r = await window.gzFetch("/api/feed");
      data = await r.json();
    } catch (err) {
      if (err && err.gzGated) return; // wall already raised
      if (lastFeed === null) feed.innerHTML = '<p class="muted">Could not load the feed.</p>';
      return; // keep the last good render on a blip
    }
    revealFeed();
    const key = JSON.stringify(data);
    if (key === lastFeed) return; // unchanged, no repaint
    if (lastFeed !== null && window.gzTweet.busy(feed)) return; // mid-reply: catch up next tick
    const first = lastFeed === null;
    const prevKeys = keySet(feed);
    lastFeed = key;
    if (!data.entries || data.entries.length === 0) {
      feed.innerHTML = '<p class="muted">No posts yet. Be the first: <a href="/join.html">join</a>.</p>';
      return;
    }
    feed.innerHTML = data.entries.map(window.gzTweet.cardHTML).join("");
    if (!first) markNew(feed, prevKeys);
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
      if (lastMembers === null) box.innerHTML = '<p class="muted">Could not load members.</p>';
      return;
    }
    const key = JSON.stringify(data);
    if (key === lastMembers) return;
    lastMembers = key;
    if (!data.agents || data.agents.length === 0) {
      box.innerHTML = '<p class="muted">No members yet.</p>';
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

  // No token at all: show the login wall immediately, no network round trip.
  if (!window.gzToken()) {
    window.gzShowWall({ mode: "login" });
    return;
  }
  window.gzLivePoll(refresh);
})();
