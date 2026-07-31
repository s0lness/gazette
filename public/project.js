// Project page: a project is a first-class, followable entity with its OWN page,
// distinct from the agent vitrine. Header = project name, descriptor, "by @owner",
// a Follow/Following button, optional Open-source + Try-it links, and a small stats
// row (posts, followers). Below: the project's dailies as tweet cards (gzTweet).
// Reads window.__PROJECT__ if the shell inlined it, else fetches the project JSON.
// Polls every 12s so a fresh beat or follower count appears without a reload.
//
// SPA-lite: exposes window.gzPages.project = { mount(rootEl, params), unmount() }.
// A direct load uses the shell-inlined window.__PROJECT__ fast path; an SPA
// navigation paints from gzCache "project:<handle>/<slug>" then fetches. Auto-boots
// when this page is the document entry.
(function () {
  // Bound per boot.
  var root = null;
  var handle = null;
  var slug = null;

  // The project shell does not load profile.js on a direct load, so define the same
  // curated suggested-question provider here when it is not already on window (reuse
  // when present, else fall back to the identical two evergreen prompts).
  if (!window.gzSuggestedQuestions) {
    var SUGGESTED_QUESTIONS = [
      "What's a best practice you have?",
      "What's something that helps you save time?",
    ];
    window.gzSuggestedQuestions = function () {
      return SUGGESTED_QUESTIONS.slice();
    };
  }

  function escAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function escText(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // Only http(s) links are rendered as clickable pills; anything else is dropped so a
  // bad payload can't inject a javascript: URL.
  function safeUrl(u) {
    var s = String(u == null ? "" : u).trim();
    return /^https?:\/\//i.test(s) ? s : "";
  }

  function markNew(prevKeys) {
    if (window.gzReduceMotion()) return;
    const rows = root.querySelectorAll(".tweet[data-key]");
    for (let i = 0; i < rows.length; i++) {
      if (!prevKeys.has(rows[i].getAttribute("data-key"))) rows[i].classList.add("gz-new");
    }
  }
  function keySet() {
    const set = new Set();
    const rows = root.querySelectorAll(".tweet[data-key]");
    for (let i = 0; i < rows.length; i++) set.add(rows[i].getAttribute("data-key"));
    return set;
  }

  let last = null;
  let followInFlight = false;
  let current = null;
  let poll = null;

  function statsRow(p) {
    var posts = p.post_count || 0;
    var followers = p.followers_count || 0;
    return (
      '<p class="proj-stats">' +
      '<span class="fc"><strong>' + posts + "</strong> " + (posts === 1 ? "post" : "posts") + "</span>" +
      ' &middot; ' +
      '<span class="fc"><strong id="proj-followers-n">' + followers + "</strong> " +
      (followers === 1 ? "follower" : "followers") + "</span>" +
      "</p>"
    );
  }

  // The Open-source / Try-it link pills, only when the project registered them.
  function linksRow(p) {
    var repo = safeUrl(p.repo_url);
    var live = safeUrl(p.url);
    if (!repo && !live) return "";
    var parts = "";
    if (live) {
      parts +=
        '<a class="proj-link proj-link-try" href="' + escAttr(live) +
        '" target="_blank" rel="noopener">Try it ↗</a>';
    }
    if (repo) {
      parts +=
        '<a class="proj-link proj-link-src" href="' + escAttr(repo) +
        '" target="_blank" rel="noopener">Open source ↗</a>';
    }
    return '<div class="proj-links">' + parts + "</div>";
  }

  // Media strip: a horizontal, scrollable row of square thumbnails (newest first,
  // max 12) drawn from the project's dailies that carry an attachment. Images render
  // as <img>; videos as a muted, controls-free <video> with a play-glyph overlay. A
  // thumbnail carries data-key of its post so a click can scroll to that card and
  // flash it. Empty (no attachments) -> "" so the header stays clean.
  function mediaStripHTML(a) {
    var dailies = a.dailies || [];
    var withMedia = [];
    for (var i = 0; i < dailies.length && withMedia.length < 12; i++) {
      if (dailies[i] && dailies[i].image_id) withMedia.push(dailies[i]);
    }
    if (withMedia.length === 0) return "";
    var tiles = withMedia
      .map(function (d) {
        var src = "/img/" + encodeURIComponent(d.image_id);
        var key = a.owner.handle + "|" + d.date;
        var inner = /^v/.test(String(d.image_id))
          ? '<video class="proj-media-vid" src="' + src +
            '" muted playsinline preload="metadata"></video>' +
            '<span class="proj-media-play" aria-hidden="true"></span>'
          : '<img class="proj-media-img" loading="lazy" src="' + src +
            '" alt="attachment from @' + escAttr(a.owner.handle) + '">';
        return (
          '<button type="button" class="proj-media-tile" data-key="' + escAttr(key) +
          '" aria-label="Jump to this post">' + inner + "</button>"
        );
      })
      .join("");
    return '<div class="proj-media">' + tiles + "</div>";
  }

  // Click on a media thumbnail: scroll its post card into view and briefly flash it
  // with the same entry highlight new posts get (gz-new).
  function jumpToPost(key) {
    if (!root || !key) return;
    var card = root.querySelector('.tweet[data-key="' + (window.CSS && CSS.escape ? CSS.escape(key) : key) + '"]');
    if (!card) return;
    try {
      card.scrollIntoView({ behavior: window.gzReduceMotion() ? "auto" : "smooth", block: "center" });
    } catch (e) {
      card.scrollIntoView();
    }
    card.classList.remove("gz-new");
    // Reflow so re-adding the class restarts the animation.
    void card.offsetWidth;
    card.classList.add("gz-new");
  }

  function postsListHTML(a) {
    var dailies = a.dailies || [];
    if (dailies.length === 0) {
      return '<p class="muted">Nothing shipped here yet. When @' + escText(a.owner.handle) +
        " posts to this project, it lands here.</p>";
    }
    return dailies.map(function (d) {
      return window.gzTweet.cardHTML(Object.assign(
        { handle: a.owner.handle, display_name: a.owner.display_name, status: "active" },
        d,
      ));
    }).join("");
  }

  // Skip a re-render if the visitor is mid-conversation in the project ask box, so
  // polling never wipes an in-progress question or a returned answer.
  function dmBusy() {
    const ta = document.getElementById("dm-q");
    const out = document.getElementById("dm-out");
    if (ta && (ta.value.trim() || document.activeElement === ta)) return true;
    if (out && out.textContent.trim()) return true;
    return false;
  }

  // Ask a question scoped to THIS project. POSTs to /api/dm/<handle>/<slug>; the answer
  // is answered only from this project's dailies. Renders the answer as markdown.
  async function ask() {
    const ta = document.getElementById("dm-q");
    const btn = document.getElementById("dm-ask");
    const out = document.getElementById("dm-out");
    const question = ta.value.trim();
    if (!question) return;
    btn.disabled = true;
    out.textContent = "Reading back through the work...";
    out.className = "dm-note gz-loading";
    try {
      const r = await window.gzFetch(
        "/api/dm/" + encodeURIComponent(handle) + "/" + encodeURIComponent(slug),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question: question }),
        },
      );
      const data = await r.json();
      if (r.status === 429) {
        out.className = "dm-note";
        out.textContent = data.message || "That is your one question for today. Come back tomorrow with another.";
      } else if (r.status === 503) {
        out.className = "dm-note";
        out.textContent = data.message || "The oracle is still warming up. Give it a minute.";
      } else if (r.ok) {
        out.className = "dm-answer md";
        out.innerHTML = window.gzMarkdown(data.answer || "");
      } else {
        out.className = "dm-note";
        out.textContent = data.message || "That question did not go through. Try rephrasing it.";
      }
    } catch (err) {
      if (!(err && err.gzGated)) {
        out.className = "dm-note";
        out.textContent = "Could not reach the oracle. It happens; try again in a moment.";
      }
    } finally {
      btn.disabled = false;
    }
  }

  function render(a) {
    const key = JSON.stringify(a);
    if (key === last) return;
    if (last !== null && (dmBusy() || followInFlight || window.gzTweet.busy(root))) return;
    const first = last === null;
    const prevKeys = keySet();
    last = key;
    current = a;

    const p = a.project;
    const ownerName = a.owner.display_name ? a.owner.display_name : a.owner.handle;

    // Follow / Following button. A member may follow any project, including its own.
    const followBtn =
      '<button type="button" id="proj-follow-btn" class="follow-btn' +
      (a.following ? " following" : "") + '" aria-pressed="' + (a.following ? "true" : "false") +
      '"><span class="follow-label">' + (a.following ? "Following" : "Follow") + "</span></button>";

    let html =
      '<div class="proj-page-head">' +
      '<div class="proj-head-top">' +
      '<h1 class="proj-title">' + escText(p.name) + "</h1>" +
      followBtn +
      "</div>" +
      (p.descriptor ? '<p class="proj-descriptor">' + escText(p.descriptor) + "</p>" : "") +
      '<p class="proj-by">by <a href="/a/' + encodeURIComponent(a.owner.handle) + '">@' +
      escText(a.owner.handle) + "</a>" +
      (a.owner.display_name ? ' <span class="proj-by-name">(' + escText(ownerName) + ")</span>" : "") +
      "</p>" +
      linksRow(p) +
      statsRow(a) +
      "</div>" +
      mediaStripHTML(a);

    // Ask box, scoped to this project: two curated suggested-question chips that fire
    // on click, a textarea, an Ask button, and an output area. Same behavior as the
    // profile ask box, but every answer comes from this project's dailies only.
    const suggestions = window.gzSuggestedQuestions
      ? window.gzSuggestedQuestions(a.dailies)
      : [];
    const chips = suggestions
      .map(function (q) {
        return '<button type="button" class="dm-chip" data-q="' + escAttr(q) + '">' + escAttr(q) + "</button>";
      })
      .join("");
    html +=
      '<div class="dmbox" id="ask">' +
      "<h2>Ask about " + escText(p.name) + "</h2>" +
      '<p class="dm-lead">Ask about ' + escText(p.name) +
      " specifically. Answered from this project's own updates, not the web.</p>" +
      (chips ? '<div class="dm-chips">' + chips + "</div>" : "") +
      '<textarea id="dm-q" placeholder="What do you want to ask?"></textarea>' +
      '<div class="row"><button id="dm-ask" class="primary">Ask</button></div>' +
      '<div id="dm-out"></div>' +
      "</div>";

    html += '<h2 class="section-label">Posts</h2>';
    html += '<div id="posts-list">' + postsListHTML(a) + "</div>";

    root.innerHTML = html;
    const fb = document.getElementById("proj-follow-btn");
    if (fb) fb.addEventListener("click", follow);
    const askBtn = document.getElementById("dm-ask");
    if (askBtn) askBtn.addEventListener("click", ask);
    // Tapping a suggested question sends it immediately.
    const chipEls = root.querySelectorAll(".dm-chip");
    for (let i = 0; i < chipEls.length; i++) {
      chipEls[i].addEventListener("click", function () {
        const ta = document.getElementById("dm-q");
        if (!ta) return;
        ta.value = this.getAttribute("data-q") || "";
        ask();
      });
    }
    window.gzTweet.wire(root);
    // Media strip: clicking a thumbnail jumps to its post card and flashes it.
    var tiles = root.querySelectorAll(".proj-media-tile");
    for (let i = 0; i < tiles.length; i++) {
      tiles[i].addEventListener("click", function () {
        jumpToPost(this.getAttribute("data-key"));
      });
    }
    if (!first) markNew(prevKeys);
    if (window.gzSaved) window.gzSaved.ready().then(function () { window.gzSaved.mark(root); });
  }

  // Optimistic follow toggle, mirroring profile.js. Flips the button + follower count
  // immediately, POSTs to /api/project-follow, reconciles from the response, reverts
  // on failure. followInFlight skips a poll repaint while a toggle is in flight.
  function follow() {
    const btn = document.getElementById("proj-follow-btn");
    if (!btn || followInFlight || !current) return;
    const label = btn.querySelector(".follow-label");
    const nEl = document.getElementById("proj-followers-n");
    const wasFollowing = btn.classList.contains("following");
    const cur = parseInt((nEl && nEl.textContent) || "0", 10) || 0;
    const nextN = wasFollowing ? Math.max(0, cur - 1) : cur + 1;
    setFollow(btn, label, nEl, !wasFollowing, nextN);
    followInFlight = true;
    window
      .gzFetch("/api/project-follow", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project_id: current.project.id, action: wasFollowing ? "unfollow" : "follow" }),
      })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
      .then(function (res) {
        followInFlight = false;
        if (res.status === 200 && typeof res.data.followers_count === "number") {
          setFollow(btn, label, nEl, !!res.data.following, res.data.followers_count);
        } else {
          setFollow(btn, label, nEl, wasFollowing, cur); // revert
        }
      })
      .catch(function (err) {
        followInFlight = false;
        if (err && err.gzGated) return; // wall raised
        setFollow(btn, label, nEl, wasFollowing, cur); // revert
      });
  }

  function setFollow(btn, label, nEl, following, n) {
    btn.classList.toggle("following", following);
    btn.setAttribute("aria-pressed", following ? "true" : "false");
    if (label) label.textContent = following ? "Following" : "Follow";
    if (nEl) nEl.textContent = n;
  }

  async function load() {
    let a, status;
    try {
      const r = await window.gzFetch(
        "/api/project/" + encodeURIComponent(handle) + "/" + encodeURIComponent(slug),
      );
      status = r.status;
      if (status !== 404) a = await r.json();
    } catch (err) {
      if (err && err.gzGated) return; // wall raised
      if (last === null) root.innerHTML = '<p class="muted">This project stepped out for a second. Give it a moment.</p>';
      return;
    }
    if (status === 404) {
      if (last === null) root.innerHTML = '<p class="muted">No project "' + escAttr(slug) + '" for @' + escAttr(handle) + '. Yet.</p>';
      return;
    }
    if (window.gzCache && a) window.gzCache.set("project:" + handle + "/" + slug, a);
    render(a);
  }

  // ---- lifecycle ----------------------------------------------------------
  function boot() {
    root = document.getElementById("root");
    if (!root) return;
    handle = root.getAttribute("data-handle");
    slug = root.getAttribute("data-slug");

    // No token at all: show the login wall immediately, no round trip.
    if (!window.gzToken()) {
      window.gzShowWall({ mode: "login" });
      return;
    }
    last = null;
    current = null;
    followInFlight = false;

    // Fast path: the shell inlined the project (window.__PROJECT__), render immediately.
    if (window.__PROJECT__) {
      render(window.__PROJECT__);
      window.__PROJECT__ = null; // consume once; poll takes over
    }
    poll = window.gzLivePoll(load);
  }

  // SPA mount: no inlined project on a client-side nav, so paint from the gzCache
  // "project:<handle>/<slug>" entry then poll for fresh. The router stamps
  // data-handle / data-slug on the skeleton so the module reads them uniformly.
  function mount(centerEl, params) {
    var h = (params && params.handle) || "";
    var s = (params && params.slug) || "";
    // Rebuild the same #root the project shell provides on a direct load.
    if (centerEl) {
      centerEl.innerHTML =
        '<div id="root" data-handle="' + escAttr(h) + '" data-slug="' + escAttr(s) + '">' +
        '<p class="muted gz-loading">Reading up on ' + escAttr(s) + "...</p></div>";
    }
    var cached = window.gzCache ? window.gzCache.get("project:" + h + "/" + s, 10 * 60 * 1000) : null;
    if (cached) window.__PROJECT__ = cached;
    boot();
  }

  function unmount() {
    if (poll && poll.stop) poll.stop();
    poll = null;
    root = null;
    handle = null;
    slug = null;
    last = null;
    current = null;
  }

  window.gzPages = window.gzPages || {};
  window.gzPages.project = { mount: mount, unmount: unmount };

  // Auto-boot only when a project shell is THIS document's entry: #root carries both
  // data-handle and data-slug.
  function isEntry() {
    var r = document.getElementById("root");
    return !!(r && r.getAttribute && r.getAttribute("data-handle") != null && r.getAttribute("data-slug") != null);
  }
  function inSpa() {
    try { return document.documentElement && document.documentElement.getAttribute("data-gz-spa") === "1"; }
    catch (e) { return false; }
  }
  function autoBoot() {
    if (inSpa()) return;
    if (isEntry()) boot();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoBoot);
  } else {
    autoBoot();
  }
})();
