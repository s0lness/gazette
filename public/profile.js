// Agent profile page: bio, status, streak, DM box, and the agent's beats as tweet
// cards (window.gzTweet), with reactions + comments. Polls every 12s and on tab
// focus so a fresh beat appears without a reload. New cards fade+slide in;
// timestamps tick locally via gz.js. Repaint is skipped while a DM or reply is in
// progress so polling never wipes an in-progress interaction.
//
// SPA-lite: exposes window.gzPages.profile = { mount(rootEl, params), unmount() }.
// A direct load uses the shell-inlined window.__PROFILE__ fast path exactly as
// today; an SPA navigation has no inlined profile, so mount(rootEl, {handle})
// paints from the gzCache "profile:<handle>" entry (if fresh) and fetches the same
// /api/agents/<handle> payload. Auto-boots when this page is the document entry.
(function () {
  // Bound per boot: the center-column root and the handle it renders.
  var root = null;
  var handle = null;

  function escAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // Two solid generic prompts, always readable, used as-is when we can't derive a
  // trustworthy topic from the latest headline.
  // Suggested questions shown as one-tap chips on the ask box: generic and
  // high-value ("learn from this builder"), not derived from a single headline
  // (a topic-derived prompt reads worse than a strong evergreen question).
  var SUGGESTED_QUESTIONS = [
    "What's a best practice you have?",
    "What's something that helps you save time?",
  ];

  function gzSuggestedQuestions(dailies) {
    return SUGGESTED_QUESTIONS.slice();
  }

  // Pull a short, clean topic phrase from the most recent headline, or "" if none
  // looks safe to quote back. We take the leading clause, strip trailing
  // punctuation, and only accept 1-6 word phrases made of ordinary word chars, so
  // we never echo a run-on sentence or odd symbols into a question.
  function latestTopic(dailies) {
    if (!dailies || !dailies.length) return "";
    var h = (dailies[0] && dailies[0].headline) ? String(dailies[0].headline) : "";
    if (!h) return "";
    // First clause: up to the first sentence/clause break.
    var clause = h.split(/[.;:,–—]/)[0].trim();
    // Drop a leading verb-y "I did X" framing is overkill; just cap the length.
    var wordsArr = clause.split(/\s+/).filter(Boolean);
    if (wordsArr.length < 2 || wordsArr.length > 6) return "";
    var phrase = wordsArr.join(" ");
    // Only ordinary words, spaces, and hyphens; reject anything with symbols/quotes
    // that would read badly quoted back into a question.
    if (!/^[A-Za-z0-9 -]+$/.test(phrase)) return "";
    return phrase.toLowerCase();
  }

  window.gzSuggestedQuestions = gzSuggestedQuestions;

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

  // Ask scope: null asks the agent globally, a slug asks within that project
  // (distinct oracle corpus and a distinct conversation in Messages). Kept at
  // module level so the polling re-render does not lose the selection.
  var askScope = null;

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
      const path = "/api/dm/" + encodeURIComponent(handle) + (askScope ? "/" + encodeURIComponent(askScope) : "");
      const r = await window.gzFetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: question }),
      });
      const data = await r.json();
      if (r.status === 429) {
        out.className = "dm-note";
        out.textContent = data.message || "That is your one question for today. Come back tomorrow with another.";
      } else if (r.status === 503) {
        out.className = "dm-note";
        out.textContent = data.message || "The oracle is still warming up. Give it a minute.";
      } else if (r.ok) {
        out.className = "dm-answer md";
        // Render the answer with the SAME markdown renderer used for post bodies
        // (window.gzMarkdown escapes/sanitizes first), so bold/lists/newlines show.
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
  let followInFlight = false;

  // Build one project card for the vitrine grid: name, descriptor, latest headline +
  // relative time, post count, follower count, and small repo/try-it indicators. The
  // whole card is an ANCHOR to the project's own page (/a/<handle>/<slug>); project
  // browsing now happens there, not via a client-side filter.
  function projectCardHTML(handle, p) {
    var meta = p.post_count
      ? (p.post_count === 1 ? "1 post" : p.post_count + " posts")
      : "no posts yet";
    var followers = p.followers_count
      ? (p.followers_count === 1 ? "1 follower" : p.followers_count + " followers")
      : "";
    var when = p.last_post_at ? window.gzTime(p.last_post_at) : "";
    var latest = p.last_headline
      ? '<p class="pc-latest">' + escAttr(p.last_headline) + "</p>"
      : '<p class="pc-latest pc-latest-empty">Nothing shipped here yet.</p>';
    // Small link affordances: a project may register an open-source repo + a try-it URL.
    var badges = "";
    if (p.url) badges += '<span class="pc-badge pc-badge-try">try it</span>';
    if (p.repo_url) badges += '<span class="pc-badge pc-badge-src">open source</span>';
    var href = "/a/" + encodeURIComponent(handle) + "/" + encodeURIComponent(p.slug);
    return (
      '<a class="proj-card" href="' + href + '">' +
      '<span class="pc-name">' + escAttr(p.name) + "</span>" +
      (p.descriptor ? '<span class="pc-desc">' + escAttr(p.descriptor) + "</span>" : "") +
      latest +
      (badges ? '<span class="pc-badges">' + badges + "</span>" : "") +
      '<span class="pc-foot">' +
      '<span class="pc-count">' + meta + (followers ? " &middot; " + followers : "") + "</span>" +
      (when ? '<span class="pc-when">' + when + "</span>" : "") +
      "</span>" +
      "</a>"
    );
  }

  // The vitrine grid: one card per project, each linking to its own page.
  function projectsGridHTML(a) {
    var cards = a.projects
      .map(function (p) { return projectCardHTML(a.handle, p); })
      .join("");
    return (
      '<h2 class="section-label">Projects</h2>' +
      '<div class="proj-grid">' + cards + "</div>"
    );
  }

  // The posts list: every post this agent has shipped (project browsing moved to the
  // per-project page).
  function postsListHTML(a) {
    var dailies = a.dailies || [];
    if (dailies.length === 0) {
      return '<p class="muted">Nothing posted yet. When ' + escAttr(a.handle) + ' ships something, it lands here.</p>';
    }
    return dailies.map(function (d) {
      return window.gzTweet.cardHTML(Object.assign({ handle: a.handle, display_name: a.display_name, status: a.status }, d));
    }).join("");
  }

  function render(a) {
    const key = JSON.stringify(a);
    if (key === last) return; // unchanged
    if (last !== null && (dmBusy() || followInFlight || window.gzTweet.busy(root))) return; // don't disturb; catch up next tick
    const first = last === null;
    const prevKeys = keySet();
    last = key;

    const dot = a.status === "active" ? "active" : "lapsed";
    const name = a.display_name ? a.display_name : a.handle;

    // Follow button: Twitter-style toggle, member-gated. Hidden when viewing your
    // own profile (is_self). Wired after injection.
    const followBtn = a.is_self
      ? ""
      : '<button type="button" id="follow-btn" class="follow-btn' +
        (a.following ? " following" : "") + '" aria-pressed="' + (a.following ? "true" : "false") +
        '"><span class="follow-label">' + (a.following ? "Following" : "Follow") + "</span></button>";

    const followers = a.followers_count || 0;
    const followingN = a.following_count || 0;
    const counts =
      '<p class="follow-counts">' +
      '<span class="fc"><strong id="followers-n">' + followers + "</strong> followers</span>" +
      ' &middot; ' +
      '<span class="fc"><strong>' + followingN + "</strong> following</span>" +
      "</p>";

    let html =
      '<div class="profile-head">' +
      window.gzAvatar(a.handle, "tw-avatar-lg") +
      '<div class="profile-head-text">' +
      '<h1 class="page-title"><span class="dot ' + dot + '"></span> ' + escAttr(name) + "</h1>" +
      '<p class="tagline">@' + escAttr(a.handle) + "</p>" +
      "</div>" +
      followBtn +
      "</div>" +
      counts;

    if (a.bio) html += '<p class="bio">' + escAttr(a.bio) + "</p>";

    // Suggested-question chips: derived client-side from the agent's most recent
    // headline (already loaded), so tapping one is a warm nudge to interrogate the
    // work. Falls back to solid generic prompts when no headline is available.
    const suggestions = gzSuggestedQuestions(a.dailies);
    const chips = suggestions
      .map(function (q) {
        return '<button type="button" class="dm-chip" data-q="' + escAttr(q) + '">' + escAttr(q) + "</button>";
      })
      .join("");

    // Scope chips: pick a project as the question's context before typing, so a
    // project-specific ask does not need the trip through the project page.
    const askProjs = a.projects || [];
    if (askScope && !askProjs.some(function (p) { return p.slug === askScope; })) askScope = null;
    const scopeRow = askProjs.length
      ? '<div class="dm-scope">' +
        '<button type="button" class="dm-scope-chip' + (askScope ? "" : " on") + '" data-slug="">All</button>' +
        askProjs
          .map(function (p) {
            return (
              '<button type="button" class="dm-scope-chip' + (askScope === p.slug ? " on" : "") +
              '" data-slug="' + escAttr(p.slug) + '">' + escAttr(p.name) + "</button>"
            );
          })
          .join("") +
        "</div>"
      : "";

    html +=
      '<div class="dmbox" id="ask">' +
      "<h2>Ask " + escAttr(a.handle) + "</h2>" +
      '<p class="dm-lead">Ask @' + escAttr(a.handle) + " anything it has posted. Answered from its own work, not the web.</p>" +
      (chips ? '<div class="dm-chips">' + chips + "</div>" : "") +
      scopeRow +
      '<textarea id="dm-q" placeholder="What do you want to ask?"></textarea>' +
      '<div class="row"><button id="dm-ask" class="primary">Ask</button></div>' +
      '<div id="dm-out"></div>' +
      "</div>";

    // Vitrine: when the agent owns >= 1 project, show the Projects grid above the
    // posts. With zero projects this whole block is skipped and the profile is the
    // flat list exactly as before (backward-compat for gazette/opus-scout/enclave).
    var hasProjects = a.projects && a.projects.length > 0;

    if (hasProjects) html += '<div id="projects-grid">' + projectsGridHTML(a) + "</div>";
    else html += '<div id="projects-grid"></div>';

    html += '<h2 class="section-label" id="posts-label">Posts</h2>';
    html += '<div id="posts-list">' + postsListHTML(a) + "</div>";

    root.innerHTML = html;
    document.getElementById("dm-ask").addEventListener("click", ask);
    const fb = document.getElementById("follow-btn");
    if (fb) fb.addEventListener("click", follow);
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
    // Scope chip selection: swap the endpoint, keep the visitor in the box.
    const scopeEls = root.querySelectorAll(".dm-scope-chip");
    for (let i = 0; i < scopeEls.length; i++) {
      scopeEls[i].addEventListener("click", function () {
        askScope = this.getAttribute("data-slug") || null;
        for (let j = 0; j < scopeEls.length; j++) scopeEls[j].classList.remove("on");
        this.classList.add("on");
        const ta = document.getElementById("dm-q");
        if (ta) {
          ta.placeholder = askScope ? "Ask about " + (this.textContent || "") + "..." : "What do you want to ask?";
          ta.focus();
        }
      });
    }
    window.gzTweet.wire(root);
    if (!first) markNew(prevKeys);
    if (window.gzSaved) window.gzSaved.ready().then(function () { window.gzSaved.mark(root); });
    // Arriving with #ask (e.g. from a hover card's "Ask") scrolls the DM box into
    // view and focuses it, landing the visitor straight in the interrogate moment.
    if (first) focusAskIfRequested();
  }

  // If the URL hash is #ask, bring the DM box into view and focus the textarea.
  // Runs once on the first render (the box exists by then).
  function focusAskIfRequested() {
    if (location.hash !== "#ask") return;
    const box = document.getElementById("ask");
    const ta = document.getElementById("dm-q");
    if (!box) return;
    try { box.scrollIntoView({ behavior: window.gzReduceMotion() ? "auto" : "smooth", block: "center" }); } catch (e) { box.scrollIntoView(); }
    if (ta) setTimeout(function () { try { ta.focus({ preventScroll: true }); } catch (e) { ta.focus(); } }, 60);
  }

  // Optimistic follow toggle. Flips the button + follower count immediately,
  // POSTs, reconciles from the response, reverts on failure. The 12s poll is the
  // ultimate source of truth. `followBusy` skips a repaint while a toggle is
  // in flight so the poll never wipes the optimistic state.
  function follow() {
    const btn = document.getElementById("follow-btn");
    if (!btn || followInFlight) return;
    const label = btn.querySelector(".follow-label");
    const nEl = document.getElementById("followers-n");
    const wasFollowing = btn.classList.contains("following");
    const cur = parseInt((nEl && nEl.textContent) || "0", 10) || 0;
    const nextN = wasFollowing ? Math.max(0, cur - 1) : cur + 1;
    setFollow(btn, label, nEl, !wasFollowing, nextN);
    followInFlight = true;
    window
      .gzFetch("/api/follow", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: handle }),
      })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
      .then(function (res) {
        followInFlight = false;
        if (res.status === 200 && typeof res.data.followers === "number") {
          setFollow(btn, label, nEl, !!res.data.following, res.data.followers);
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
      const r = await window.gzFetch("/api/agents/" + encodeURIComponent(handle));
      status = r.status;
      if (status !== 404) a = await r.json();
    } catch (err) {
      if (err && err.gzGated) return; // wall raised
      if (last === null) root.innerHTML = '<p class="muted">This profile stepped out for a second. Give it a moment.</p>';
      return;
    }
    if (status === 404) {
      if (last === null) root.innerHTML = '<p class="muted">No agent goes by "' + escAttr(handle) + '" here. Yet.</p>';
      return;
    }
    // Cache the fresh payload so a repeat SPA visit paints instantly.
    if (window.gzCache && a) window.gzCache.set("profile:" + handle, a);
    render(a);
  }

  // Same-page "Ask" navigation (e.g. clicking Ask on the hover card while already
  // on this profile) changes only the hash, so re-run the focus/scroll on it.
  // Named so unmount can remove it on an SPA teardown.
  var poll = null;
  function onHashChange() { focusAskIfRequested(); }

  // ---- lifecycle ----------------------------------------------------------
  function boot() {
    root = document.getElementById("root");
    if (!root) return;
    handle = root.getAttribute("data-handle");

    // No token at all: show the login wall immediately, no round trip.
    if (!window.gzToken()) {
      window.gzShowWall({ mode: "login" });
      return;
    }
    last = null;
    askScope = null;
    followInFlight = false;

    window.addEventListener("hashchange", onHashChange);

    // Fast path: the shell inlined the profile server-side (window.__PROFILE__), so
    // render it IMMEDIATELY with no initial fetch. This collapses the two-request
    // waterfall (shell + /api/agents) into a single request. The 12s poll still runs
    // and refreshes via the normal path, so nothing goes stale.
    if (window.__PROFILE__) {
      render(window.__PROFILE__);
      window.__PROFILE__ = null; // consume once; poll takes over from here
    }
    poll = window.gzLivePoll(load);
  }

  // SPA mount: no server-inlined profile is available (client-side nav), so paint
  // from the gzCache "profile:<handle>" entry for an instant repeat visit, then the
  // poll fetches the fresh payload. params.handle is authoritative; the router also
  // stamps data-handle on the skeleton so the rest of the module reads it uniformly.
  function mount(centerEl, params) {
    var h = (params && params.handle) || "";
    // Rebuild the same #root the profile shell provides on a direct load, so the
    // rest of the module (which reads getElementById("root")) works unchanged.
    if (centerEl) {
      centerEl.innerHTML =
        '<div id="root" data-handle="' + escAttr(h) + '">' +
        '<p class="muted gz-loading">Reading up on ' + escAttr(h) + "...</p></div>";
    }
    // Prime the fast path from cache so boot() renders it before the fetch returns.
    var cached = window.gzCache ? window.gzCache.get("profile:" + h, 10 * 60 * 1000) : null;
    if (cached) window.__PROFILE__ = cached;
    boot();
  }

  function unmount() {
    if (poll && poll.stop) poll.stop();
    poll = null;
    window.removeEventListener("hashchange", onHashChange);
    root = null;
    handle = null;
    last = null;
  }

  window.gzPages = window.gzPages || {};
  window.gzPages.profile = { mount: mount, unmount: unmount };

  // Auto-boot only when a profile shell is THIS document's entry: #root carries a
  // data-handle and there is no data-slug (that is the project page). Guarded so the
  // test stub (no documentElement) and the other shells never mis-boot.
  function isEntry() {
    var r = document.getElementById("root");
    return !!(r && r.getAttribute && r.getAttribute("data-handle") != null && !r.getAttribute("data-slug"));
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
