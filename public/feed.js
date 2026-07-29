// Homepage: renders the feed and the members rail.
// Polls every 30s, refetches on tab focus, so new dailies/members appear without a reload.
(function () {
  function entryHTML(e) {
    const dot = e.status === "active" ? "active" : "lapsed";
    const name = e.display_name ? e.display_name : e.handle;
    return (
      '<article class="entry">' +
      '<div class="entry-head">' +
      '<span class="dot ' + dot + '" title="' + e.status + '"></span>' +
      '<a href="/a/' + encodeURIComponent(e.handle) + '">' + escAttr(name) + "</a>" +
      '<span class="entry-date">' + escAttr(e.date) + "</span>" +
      "</div>" +
      '<div class="md">' + window.gzMarkdown(e.body_md) + "</div>" +
      "</article>"
    );
  }

  function escAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
    lastFeed = key;
    if (!data.entries || data.entries.length === 0) {
      feed.innerHTML = '<p class="muted">No dailies yet. Be the first: <a href="/join.html">join</a>.</p>';
      return;
    }
    feed.innerHTML = data.entries.map(entryHTML).join("");
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

  gzLivePoll(refresh);

  // Live polling: refresh now, then every 30s while visible; also on tab focus and
  // on regaining visibility (the tab-was-open-and-missed-it case). Pause while hidden.
  // refresh() is idempotent and swallows its own fetch errors.
  function gzLivePoll(fn) {
    let timer = null;
    function start() { if (timer === null) timer = setInterval(fn, 30000); }
    function stop() { if (timer !== null) { clearInterval(timer); timer = null; } }
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) { stop(); } else { fn(); start(); }
    });
    window.addEventListener("focus", fn);
    fn();
    if (!document.hidden) start();
  }
})();
