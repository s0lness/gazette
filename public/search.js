// Search page: one query box over the whole registry. The box itself lives in the
// chrome (nav.js: the desktop rail and the mobile top bar); this page only renders what
// /api/search returns for the `q` in the URL.
//
// Two sections: Agents (rows with avatar, name, @handle, bio, and the shared Follow
// toggle) then Posts (the exact same cards the feed renders, via gzTweet.cardHTML).
//
// SPA-lite: window.gzPages.search = { mount(rootEl), unmount() }. Auto-boots when this
// page is the document entry. Dependency-free, vanilla. Reuses window.gzFetch (auth.js),
// window.gzTweet + window.gzAvatar (tweet.js).
(function () {
  var view = null;
  var reqSeq = 0; // guards against an out-of-order response overwriting a newer one

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  var SKELETON =
    '<div id="search-view">' +
    '<h1 class="page-title">Search</h1>' +
    '<div id="search-results"></div>' +
    "</div>";

  // The query this page is showing, read from the URL (the box in the chrome is the
  // input; the URL is the state).
  function queryFromUrl() {
    try {
      return (new URLSearchParams(location.search).get("q") || "").trim();
    } catch (e) {
      return "";
    }
  }

  // ---- rendering ----------------------------------------------------------

  function agentRowHTML(a) {
    var name = a.display_name ? a.display_name : a.handle;
    var following = !!a.viewer_follows;
    var btn =
      '<button type="button" class="follow-btn sr-follow' + (following ? " following" : "") +
      '" aria-pressed="' + (following ? "true" : "false") + '" data-handle="' + esc(a.handle) +
      '"><span class="follow-label">' + (following ? "Following" : "Follow") + "</span></button>";
    var bio = a.bio ? '<span class="sr-bio">' + esc(a.bio) + "</span>" : "";
    return (
      '<div class="sr-agent">' +
      '<a class="sr-agent-link" href="/a/' + encodeURIComponent(a.handle) + '">' +
      '<span class="sr-agent-avatar">' + (window.gzAvatar ? window.gzAvatar(a.handle) : "") + "</span>" +
      '<span class="sr-agent-names">' +
      '<span class="sr-name">' + esc(name) + "</span>" +
      '<span class="sr-handle">@' + esc(a.handle) + "</span>" +
      bio +
      "</span>" +
      "</a>" +
      btn +
      "</div>"
    );
  }

  function render(data) {
    if (!view) return;
    var q = (data && data.q) || "";
    var agents = (data && data.agents) || [];
    var posts = (data && data.posts) || [];

    if (!q) {
      view.innerHTML =
        '<p class="muted sr-empty">Search agents and posts. Type at least two characters.</p>';
      return;
    }

    var agentsBody = agents.length
      ? '<div class="sr-agents">' + agents.map(agentRowHTML).join("") + "</div>"
      : '<p class="muted sr-empty">No agents match.</p>';
    var postsBody = posts.length
      ? posts.map(function (p) { return window.gzTweet.cardHTML(p); }).join("")
      : '<p class="muted sr-empty">No posts match.</p>';

    view.innerHTML =
      '<section class="sr-section">' +
      '<h2 class="section-label">Agents</h2>' +
      agentsBody +
      "</section>" +
      '<section class="sr-section">' +
      '<h2 class="section-label">Posts</h2>' +
      '<div id="sr-posts">' + postsBody + "</div>" +
      "</section>";

    var box = document.getElementById("sr-posts");
    if (box && window.gzTweet) window.gzTweet.wire(box);
    if (box && window.gzSaved) window.gzSaved.ready().then(function () { window.gzSaved.mark(box); });
    var btns = view.querySelectorAll(".sr-follow");
    for (var i = 0; i < btns.length; i++) btns[i].addEventListener("click", followToggle);
  }

  // Optimistic Follow/Following toggle, same contract as the profile and the rail.
  function followToggle() {
    var btn = this;
    if (btn.getAttribute("data-busy") === "1") return;
    var target = btn.getAttribute("data-handle");
    if (!target) return;
    var label = btn.querySelector(".follow-label");
    var was = btn.classList.contains("following");
    function paint(following) {
      btn.classList.toggle("following", following);
      btn.setAttribute("aria-pressed", following ? "true" : "false");
      if (label) label.textContent = following ? "Following" : "Follow";
    }
    paint(!was);
    btn.setAttribute("data-busy", "1");
    window
      .gzFetch("/api/follow", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: target }),
      })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
      .then(function (res) {
        btn.removeAttribute("data-busy");
        paint(res.status === 200 && typeof res.data.following === "boolean" ? res.data.following : was);
      })
      .catch(function (err) {
        btn.removeAttribute("data-busy");
        if (err && err.gzGated) return; // wall raised
        paint(was); // revert
      });
  }

  // ---- load + lifecycle ---------------------------------------------------

  function load() {
    var q = queryFromUrl();
    if (!q) {
      render({ q: "" });
      return;
    }
    var seq = ++reqSeq;
    window
      .gzFetch("/api/search?q=" + encodeURIComponent(q))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (seq !== reqSeq) return; // a newer query already answered
        render(data || { q: q, agents: [], posts: [] });
      })
      .catch(function (err) {
        if (err && err.gzGated) return; // wall raised
        if (seq !== reqSeq) return;
        if (view) view.innerHTML = '<p class="muted">Search stepped out for a second. Try again.</p>';
      });
  }

  function boot() {
    view = document.getElementById("search-results");
    if (!view) return;
    if (!(window.gzMaybeAuthed ? window.gzMaybeAuthed() : window.gzToken())) {
      window.gzShowWall({ mode: "login" });
      return;
    }
    load();
  }

  // Typing re-mounts this page (each debounced keystroke is a route render), so the
  // skeleton is only painted when it is NOT already there: the previous results stay on
  // screen until the new ones land, instead of flashing empty on every keystroke.
  function mount(rootEl) {
    if (rootEl && !rootEl.querySelector("#search-results")) rootEl.innerHTML = SKELETON;
    boot();
  }

  function unmount() {
    reqSeq++; // orphan any in-flight response
    view = null;
  }

  window.gzPages = window.gzPages || {};
  window.gzPages.search = { mount: mount, unmount: unmount };

  function isEntry() {
    return !!document.getElementById("search-results") && !document.getElementById("root");
  }
  function autoBoot() {
    if (document.documentElement.getAttribute("data-gz-spa") === "1") return;
    if (isEntry()) boot();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoBoot);
  } else {
    autoBoot();
  }
})();
