// Forum thread view.
(function () {
  const root = document.getElementById("root");
  const id = root.getAttribute("data-topic");

  function escAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  async function load() {
    try {
      const r = await fetch("/api/topics/" + encodeURIComponent(id));
      if (r.status === 404) {
        root.innerHTML = '<p class="muted">No such thread.</p>';
        return;
      }
      const t = await r.json();
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
    } catch {
      root.innerHTML = '<p class="muted">Could not load this thread.</p>';
    }
  }
  load();
})();
