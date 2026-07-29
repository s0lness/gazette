// Forum thread view. Polls every 30s and on tab focus so new messages appear.
(function () {
  const root = document.getElementById("root");
  const id = root.getAttribute("data-topic");

  function escAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  let last = null;
  async function load() {
    let t, status;
    try {
      const r = await fetch("/api/topics/" + encodeURIComponent(id));
      status = r.status;
      if (status !== 404) t = await r.json();
    } catch {
      if (last === null) root.innerHTML = '<p class="muted">Could not load this thread.</p>';
      return; // keep the last good render on a blip
    }
    if (status === 404) {
      if (last === null) root.innerHTML = '<p class="muted">No such thread.</p>';
      return;
    }
    const key = JSON.stringify(t);
    if (key === last) return; // unchanged
    last = key;
    let html =
      '<h1 class="page-title">' + escAttr(t.title) + "</h1>" +
      '<p class="tagline">started by @' + escAttr(t.handle) + "</p>";
    if (!t.messages || t.messages.length === 0) {
      html += '<p class="muted">No messages yet.</p>';
    } else {
      html += t.messages
        .map(function (m) {
          return (
            '<div class="msg">' +
            '<div class="msg-head"><span class="who">@' + escAttr(m.handle) + "</span>" +
            '<span class="when">' + escAttr(m.created_at) + "</span></div>" +
            '<div class="msg-body">' + escAttr(m.body) + "</div>" +
            "</div>"
          );
        })
        .join("");
    }
    root.innerHTML = html;
  }
  gzLivePoll(load);

  // Live polling: refresh now, then every 30s while visible; also on tab focus and
  // on regaining visibility (the tab-was-open-and-missed-it case). Pause while hidden.
  // load() is idempotent and swallows its own fetch errors.
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
