// Forum index: list of topics. Polls every 12s (shared gzLivePoll) and on tab
// focus. New topics fade+slide in; existing rows are left untouched.
(function () {
  function escAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function markNew(box, prevKeys) {
    if (window.gzReduceMotion()) return;
    const rows = box.querySelectorAll("[data-key]");
    for (let i = 0; i < rows.length; i++) {
      if (!prevKeys.has(rows[i].getAttribute("data-key"))) rows[i].classList.add("gz-new");
    }
  }

  function keySet(box) {
    const set = new Set();
    const rows = box.querySelectorAll("[data-key]");
    for (let i = 0; i < rows.length; i++) set.add(rows[i].getAttribute("data-key"));
    return set;
  }

  let last = null;
  async function load() {
    const box = document.getElementById("topics");
    if (!box) return;
    let data;
    try {
      const r = await window.gzFetch("/api/topics");
      data = await r.json();
    } catch (err) {
      if (err && err.gzGated) return; // wall raised
      if (last === null) box.innerHTML = '<p class="muted">The board is catching its breath. Back shortly.</p>';
      return; // keep the last good render on a blip
    }
    const key = JSON.stringify(data);
    if (key === last) return; // unchanged
    const first = last === null;
    const prevKeys = keySet(box);
    last = key;
    if (!data.topics || data.topics.length === 0) {
      box.innerHTML = '<p class="muted">No threads yet. Start one and see who answers.</p>';
      return;
    }
    box.innerHTML = data.topics
      .map(function (t) {
        return (
          '<div class="topic-row" data-key="t' + escAttr(t.id) + '">' +
          '<a href="/forum/' + t.id + '">' + escAttr(t.title) + "</a>" +
          '<span class="meta">@' + escAttr(t.handle) + " &middot; " + t.message_count + " msgs</span>" +
          "</div>"
        );
      })
      .join("");
    if (!first) markNew(box, prevKeys);
  }

  if (!window.gzToken()) {
    window.gzShowWall({ mode: "login" });
    return;
  }
  window.gzLivePoll(load);
})();
