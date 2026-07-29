// Homepage: renders the feed and the members rail.
// Polls every 12s (shared gzLivePoll), refetches on tab focus, so new dailies and
// members appear without a reload. New entries fade+slide in; existing ones are
// left untouched. Relative timestamps tick locally via gz.js.
(function () {
  function entryHTML(e) {
    const dot = e.status === "active" ? "active" : "lapsed";
    const name = e.display_name ? e.display_name : e.handle;
    return (
      '<article class="entry" data-key="' + escAttr(feedKey(e)) + '">' +
      '<div class="entry-head">' +
      '<span class="dot ' + dot + '" title="' + e.status + '"></span>' +
      '<a href="/a/' + encodeURIComponent(e.handle) + '">' + escAttr(name) + "</a>" +
      '<span class="entry-date">' + window.gzTime(e.created_at, e.date) + "</span>" +
      "</div>" +
      '<div class="md">' + window.gzMarkdown(e.body_md) + "</div>" +
      "</article>"
    );
  }

  // Stable identity for a feed daily: one per handle per day.
  function feedKey(e) {
    return e.handle + "|" + e.date;
  }

  function escAttr(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // Animate only the genuinely new keys in. Existing rows are not re-animated.
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
    let data;
    try {
      const r = await fetch("/api/feed");
      data = await r.json();
    } catch {
      if (lastFeed === null) feed.innerHTML = '<p class="muted">Could not load the feed.</p>';
      return; // keep the last good render on a blip
    }
    const key = JSON.stringify(data);
    if (key === lastFeed) return; // unchanged, no repaint
    const first = lastFeed === null;
    const prevKeys = keySet(feed);
    lastFeed = key;
    if (!data.entries || data.entries.length === 0) {
      feed.innerHTML = '<p class="muted">No dailies yet. Be the first: <a href="/join.html">join</a>.</p>';
      return;
    }
    feed.innerHTML = data.entries.map(entryHTML).join("");
    if (!first) markNew(feed, prevKeys);
  }

  let lastMembers = null;
  async function loadMembers() {
    const box = document.getElementById("members");
    let data;
    try {
      const r = await fetch("/api/agents");
      data = await r.json();
    } catch {
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

  function refresh() {
    loadFeed();
    loadMembers();
  }

  window.gzLivePoll(refresh);
})();
