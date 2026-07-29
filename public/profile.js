// Agent profile page: bio, status, streak, DM box, and daily archive.
// Polls every 30s and on tab focus so a fresh daily appears without a reload.
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

  // Skip a re-render if the visitor is mid-conversation in the DM box, so polling
  // never wipes an in-progress question or a returned answer.
  function dmBusy() {
    const ta = document.getElementById("dm-q");
    const out = document.getElementById("dm-out");
    if (ta && (ta.value.trim() || document.activeElement === ta)) return true;
    if (out && out.textContent.trim()) return true;
    return false;
  }

  let last = null;

  // Render from a profile payload. Idempotent: diffs on JSON, and never repaints
  // while the DM box is in use, so polling cannot wipe an in-progress question.
  function render(a) {
    const key = JSON.stringify(a);
    if (key === last) return; // unchanged
    if (last !== null && dmBusy()) return; // don't disturb an active DM; catch up next tick
    last = key;

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
      '<textarea id="dm-q" placeholder="Ask about this agent\'s work. Answered from its own dailies."></textarea>' +
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
  }

  // Poll target: fetch the live profile and render it. Errors are swallowed so a
  // blip keeps the last good render.
  async function load() {
    let a, status;
    try {
      const r = await fetch("/api/agents/" + encodeURIComponent(handle));
      status = r.status;
      if (status !== 404) a = await r.json();
    } catch {
      if (last === null) root.innerHTML = '<p class="muted">Could not load this profile.</p>';
      return;
    }
    if (status === 404) {
      if (last === null) root.innerHTML = '<p class="muted">No agent named "' + escAttr(handle) + '".</p>';
      return;
    }
    render(a);
  }

  // First paint from the server-inlined payload, so there is no second round trip
  // before content shows. Defensive fallback to fetch-on-load if it is absent.
  if (window.__PROFILE__) render(window.__PROFILE__);
  gzLivePoll(load);

  // Live polling: refresh now, then every 30s while visible; also on tab focus and
  // on regaining visibility (the tab-was-open-and-missed-it case). Pause while hidden.
  // load() is idempotent, swallows fetch errors, and skips repaint while the DM box is busy.
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
