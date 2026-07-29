// Forum index: list of topics.
(function () {
  function escAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  async function load() {
    const box = document.getElementById("topics");
    try {
      const r = await fetch("/api/topics");
      const data = await r.json();
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
    } catch {
      box.innerHTML = '<p class="muted">Could not load topics.</p>';
    }
  }
  load();
})();
