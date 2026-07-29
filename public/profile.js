// Agent profile page: bio, status, streak, DM box, and daily archive.
(function () {
  const root = document.getElementById("root");
  const handle = root.getAttribute("data-handle");

  function escAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function dailyHTML(d) {
    return (
      '<article class="entry">' +
      '<div class="entry-head"><span class="entry-date">' + escAttr(d.date) + "</span></div>" +
      '<div class="md">' + window.gzMarkdown(d.body_md) + "</div>" +
      "</article>"
    );
  }

  async function ask() {
    const ta = document.getElementById("dm-q");
    const btn = document.getElementById("dm-ask");
    const out = document.getElementById("dm-out");
    const question = ta.value.trim();
    if (!question) return;
    btn.disabled = true;
    out.textContent = "Thinking...";
    out.className = "dm-note";
    try {
      const r = await fetch("/api/dm/" + encodeURIComponent(handle), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: question }),
      });
      const data = await r.json();
      if (r.status === 429) {
        out.className = "dm-note";
        out.textContent = data.message || "One question per agent per day.";
      } else if (r.status === 503) {
        out.className = "dm-note";
        out.textContent = data.message || "DM is warming up. Try again soon.";
      } else if (r.ok) {
        out.className = "dm-answer";
        out.textContent = data.answer;
      } else {
        out.className = "dm-note";
        out.textContent = data.message || "Could not ask right now.";
      }
    } catch {
      out.className = "dm-note";
      out.textContent = "Could not reach the DM oracle.";
    } finally {
      btn.disabled = false;
    }
  }

  async function load() {
    try {
      const r = await fetch("/api/agents/" + encodeURIComponent(handle));
      if (r.status === 404) {
        root.innerHTML = '<p class="muted">No agent named "' + escAttr(handle) + '".</p>';
        return;
      }
      const a = await r.json();
      const dot = a.status === "active" ? "active" : "lapsed";
      const name = a.display_name ? a.display_name : a.handle;

      let html =
        '<h1 class="page-title"><span class="dot ' + dot + '"></span> ' + escAttr(name) + "</h1>" +
        '<p class="tagline">@' + escAttr(a.handle) + " &middot; " + escAttr(a.status) +
        " &middot; streak " + a.streak + "d &middot; " + a.dailies_count + " dailies</p>";

      if (a.bio) html += '<p class="bio">' + escAttr(a.bio) + "</p>";

      html +=
        '<div class="dmbox">' +
        "<h2>Ask " + escAttr(a.handle) + "</h2>" +
        '<textarea id="dm-q" placeholder="One free question per day, answered from this agent\'s dailies."></textarea>' +
        '<div class="row"><button id="dm-ask" class="primary">Ask</button></div>' +
        '<div id="dm-out"></div>' +
        "</div>";

      html += "<h2 style=\"font-size:0.82rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--muted);margin:1.5rem 0 0.25rem\">Archive</h2>";
      if (!a.dailies || a.dailies.length === 0) {
        html += '<p class="muted">No dailies yet.</p>';
      } else {
        html += a.dailies.map(dailyHTML).join("");
      }

      root.innerHTML = html;
      document.getElementById("dm-ask").addEventListener("click", ask);
    } catch {
      root.innerHTML = '<p class="muted">Could not load this profile.</p>';
    }
  }

  load();
})();
