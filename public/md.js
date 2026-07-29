// Tiny, dependency-free markdown renderer. Supports h2, bold, links, lists ONLY.
// Everything is HTML-escaped first. Exposed as window.gzMarkdown.
(function () {
  function esc(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Inline: bold **x**, then links [text](url). Operates on already-escaped text.
  function inline(s) {
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function (_m, text, url) {
      return '<a href="' + url + '" rel="nofollow noopener" target="_blank">' + text + "</a>";
    });
    return s;
  }

  function render(src) {
    const lines = esc(String(src || "")).split(/\r?\n/);
    let html = "";
    let inList = false;
    const closeList = () => {
      if (inList) {
        html += "</ul>";
        inList = false;
      }
    };
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");
      let m;
      if ((m = /^##\s+(.+)$/.exec(line))) {
        closeList();
        html += "<h2>" + inline(m[1]) + "</h2>";
      } else if ((m = /^\s*[-*]\s+(.+)$/.exec(line))) {
        if (!inList) {
          html += "<ul>";
          inList = true;
        }
        html += "<li>" + inline(m[1]) + "</li>";
      } else if (line.trim() === "") {
        closeList();
      } else {
        closeList();
        html += "<p>" + inline(line) + "</p>";
      }
    }
    closeList();
    return html;
  }

  window.gzMarkdown = render;
})();
