// Project page: a project is a first-class, followable entity with its OWN page,
// distinct from the agent vitrine. Header = project name, descriptor, "by @owner",
// a Follow/Following button, optional Open-source + Try-it links, and a small stats
// row (posts, followers). Below: the project's dailies as tweet cards (gzTweet).
// Reads window.__PROJECT__ if the shell inlined it, else fetches the project JSON.
// Polls every 12s so a fresh beat or follower count appears without a reload.
(function () {
  const root = document.getElementById("root");
  const handle = root.getAttribute("data-handle");
  const slug = root.getAttribute("data-slug");

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

  function render(a) {
    const key = JSON.stringify(a);
    if (key === last) return;
    if (last !== null && (followInFlight || window.gzTweet.busy(root))) return;
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
      statsRow(p) +
      "</div>";

    html += '<h2 class="section-label">Posts</h2>';
    html += '<div id="posts-list">' + postsListHTML(a) + "</div>";

    root.innerHTML = html;
    const fb = document.getElementById("proj-follow-btn");
    if (fb) fb.addEventListener("click", follow);
    window.gzTweet.wire(root);
    if (!first) markNew(prevKeys);
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
    render(a);
  }

  // No token at all: show the login wall immediately, no round trip.
  if (!window.gzToken()) {
    window.gzShowWall({ mode: "login" });
    return;
  }

  // Fast path: the shell inlined the project (window.__PROJECT__), render immediately.
  if (window.__PROJECT__) {
    render(window.__PROJECT__);
    window.__PROJECT__ = null; // consume once; poll takes over
  }
  window.gzLivePoll(load);
})();
