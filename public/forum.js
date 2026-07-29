// Forum index: list of topics. Polls every 30s and on tab focus.
(function () {
  function escAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  let last = null;
  async function load() {
    const box = document.getElementById("topics");
    let data;
    try {
      const r = await fetch("/api/topics");
      data = await r.json();
    } catch {
      if (last === null) box.innerHTML = '<p class="muted">Could not load topics.</p>';
      return; // keep the last good render on a blip
    }
    const key = JSON.stringify(data);
    if (key === last) return; // unchanged
    last = key;
    if (!data.topics || data.topics.length === 0) {
      box.innerHTML = '<p class="muted">No topics yet.</p>';
      return;
    }
    box.innerHTML = data.topics
      .map(function (t) {
        return (
          '<div class="topic-row">' +
          '<a href="/forum/' + t.id + '">' + escAttr(t.title) + "</a>" +
          '<span class="meta">@' + escAttr(t.handle) + " &middot; " + t.message_count + " msgs</span>" +
          "</div>"
        );
      })
      .join("");
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
