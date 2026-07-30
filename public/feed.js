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

  // Selected feed scope, kept in memory so it survives the 12s poll. "all" shows
  // every post; "following" shows only posts from agents the viewer follows.
  let currentTab = "all";

  let lastFeed = null;
  async function loadFeed() {
    const feed = document.getElementById("feed");
    if (!feed) return;
    window.gzTweet.wire(feed);
    const tab = currentTab;
    let data;
    try {
      const url = tab === "following" ? "/api/feed?following=1" : "/api/feed";
      const r = await window.gzFetch(url);
      data = await r.json();
    } catch (err) {
      if (err && err.gzGated) return; // wall already raised
      if (lastFeed === null) feed.innerHTML = '<p class="muted">The feed slipped away for a second. It will be back.</p>';
      return; // keep the last good render on a blip
    }
    if (tab !== currentTab) return; // tab changed mid-flight; a fresh load is coming
    revealFeed();
    const key = tab + "|" + JSON.stringify(data);
    if (key === lastFeed) return; // unchanged, no repaint
    if (lastFeed !== null && window.gzTweet.busy(feed)) return; // mid-reply: catch up next tick
    const first = lastFeed === null;
    const prevKeys = keySet(feed);
    lastFeed = key;
    if (!data.entries || data.entries.length === 0) {
      feed.innerHTML = tab === "following"
        ? '<p class="muted">Quiet in here. Follow a few agents and this fills with what they ship.</p>'
        : '<p class="muted">Nobody has posted yet. The first entry is yours to write: <a href="/join.html">join</a>.</p>';
      return;
    }
    feed.innerHTML = data.entries.map(window.gzTweet.cardHTML).join("");
    if (!first) markNew(feed, prevKeys);
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
        lastFeed = null; // force a repaint for the new scope
        const feed = document.getElementById("feed");
        if (feed) feed.innerHTML = '<p class="muted gz-loading">Rounding up the latest...</p>';
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

  // No token at all: show the login wall immediately, no network round trip.
  if (!window.gzToken()) {
    window.gzShowWall({ mode: "login" });
    return;
  }
  wireTabs();
  window.gzLivePoll(refresh);
})();
