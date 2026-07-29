// Forum thread view. Polls every 12s (shared gzLivePoll) and on tab focus so new
// messages appear. New messages fade+slide in; existing ones are left untouched.
// The "when" stamp ticks locally via gz.js.
(function () {
  const root = document.getElementById("root");
  const id = root.getAttribute("data-topic");

  function escAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // Stable identity for a message: sender + its creation instant.
  function msgKey(m) {
    return m.handle + "|" + m.created_at;
  }

  function markNew(prevKeys) {
    if (window.gzReduceMotion()) return;
    const rows = root.querySelectorAll(".msg[data-key]");
    for (let i = 0; i < rows.length; i++) {
      if (!prevKeys.has(rows[i].getAttribute("data-key"))) rows[i].classList.add("gz-new");
    }
  }

  function keySet() {
    const set = new Set();
    const rows = root.querySelectorAll(".msg[data-key]");
    for (let i = 0; i < rows.length; i++) set.add(rows[i].getAttribute("data-key"));
    return set;
  }

  let last = null;
  async function load() {
    let t, status;
    try {
      const r = await window.gzFetch("/api/topics/" + encodeURIComponent(id));
      status = r.status;
      if (status !== 404) t = await r.json();
    } catch (err) {
      if (err && err.gzGated) return; // wall raised
      if (last === null) root.innerHTML = '<p class="muted">Could not load this thread.</p>';
      return; // keep the last good render on a blip
    }
    if (status === 404) {
      if (last === null) root.innerHTML = '<p class="muted">No such thread.</p>';
      return;
    }
    const key = JSON.stringify(t);
    if (key === last) return; // unchanged
    const first = last === null;
    const prevKeys = keySet();
    last = key;
    let html =
      '<p class="backlink"><a href="/">&larr; feed</a></p>' +
      '<h1 class="page-title">' + escAttr(t.title) + "</h1>" +
      '<p class="tagline">started by @' + escAttr(t.handle) + "</p>";
    if (!t.messages || t.messages.length === 0) {
      html += '<p class="muted">No messages yet.</p>';
    } else {
      html += t.messages
        .map(function (m) {
          return (
            '<div class="msg" data-key="' + escAttr(msgKey(m)) + '">' +
            '<div class="msg-head"><span class="who">@' + escAttr(m.handle) + "</span>" +
            '<span class="when">' + window.gzTime(m.created_at, m.created_at) + "</span></div>" +
            '<div class="msg-body">' + escAttr(m.body) + "</div>" +
            "</div>"
          );
        })
        .join("");
    }
    root.innerHTML = html;
    if (!first) markNew(prevKeys);
  }

  if (!window.gzToken()) {
    window.gzShowWall({ mode: "login" });
    return;
  }
  window.gzLivePoll(load);
})();
