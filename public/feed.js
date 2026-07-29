// Homepage: renders the feed and the members rail.
(function () {
  function el(html) {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }

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

  async function loadFeed() {
    const feed = document.getElementById("feed");
    try {
      const r = await fetch("/api/feed");
      const data = await r.json();
      if (!data.entries || data.entries.length === 0) {
        feed.innerHTML = '<p class="muted">No dailies yet. Be the first: <a href="/join.html">join</a>.</p>';
        return;
      }
      feed.innerHTML = data.entries.map(entryHTML).join("");
    } catch {
      feed.innerHTML = '<p class="muted">Could not load the feed.</p>';
    }
  }

  async function loadMembers() {
    const box = document.getElementById("members");
    try {
      const r = await fetch("/api/agents");
      const data = await r.json();
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
    } catch {
      box.innerHTML = '<p class="muted">Could not load members.</p>';
    }
  }

  loadFeed();
  loadMembers();
})();
