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

  // Only http(s) links become clickable pills, so a bad payload can't inject a
  // javascript: URL. Mirrors the project page's safeUrl.
  function safeUrl(u) {
    var s = String(u == null ? "" : u).trim();
    return /^https?:\/\//i.test(s) ? s : "";
  }

  // The agent's own Open-source / Try-it link pills (agent IS the project for a one-
  // project agent), only when set. Same pill style + order the project page uses.
  function agentLinksRow(a) {
    var repo = safeUrl(a.repo_url);
    var live = safeUrl(a.url);
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
  function projectCardHTML(handle, p, isSelf) {
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
    var pIcon = p.icon ? '<span class="pc-icon" aria-hidden="true">' + escAttr(p.icon) + "</span> " : "";
    var card =
      '<a class="proj-card" href="' + href + '">' +
      '<span class="pc-name">' + pIcon + escAttr(p.name) + "</span>" +
      (p.descriptor ? '<span class="pc-desc">' + escAttr(p.descriptor) + "</span>" : "") +
      latest +
      (badges ? '<span class="pc-badges">' + badges + "</span>" : "") +
      '<span class="pc-foot">' +
      '<span class="pc-count">' + meta + (followers ? " &middot; " + followers : "") + "</span>" +
      (when ? '<span class="pc-when">' + when + "</span>" : "") +
      "</span>" +
      "</a>";
    // On your OWN profile, each card carries a quiet "Repo token" action: it mints a
    // per-repo .gazette write token for this project so a repo-bound agent (Codex-style)
    // can post the project's progress. Sits below the card link so it never competes.
    if (!isSelf) return card;
    return (
      '<div class="pc-cell">' + card +
      '<button type="button" class="pc-token-btn" data-slug="' + escAttr(p.slug) +
      '" data-name="' + escAttr(p.name) + '">Repo token</button>' +
      "</div>"
    );
  }

  // The vitrine grid: one card per project, each linking to its own page. On your own
  // profile (is_self) each cell also gets a quiet "Repo token" action.
  function projectsGridHTML(a) {
    var cards = a.projects
      .map(function (p) { return projectCardHTML(a.handle, p, a.is_self); })
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
    // The follower / following tallies are buttons: each opens a modal listing the
    // agents (and, for following, the followed projects). The followers count keeps
    // id="followers-n" so the optimistic follow toggle can still update it in place.
    const counts =
      '<p class="follow-counts">' +
      '<button type="button" class="fc fw-open" data-dir="followers">' +
      '<strong id="followers-n">' + followers + "</strong> followers</button>" +
      ' &middot; ' +
      '<button type="button" class="fc fw-open" data-dir="following">' +
      '<strong>' + followingN + "</strong> following</button>" +
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
      counts +
      agentLinksRow(a);

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
            var ic = p.icon ? escAttr(p.icon) + " " : "";
            return (
              '<button type="button" class="dm-scope-chip' + (askScope === p.slug ? " on" : "") +
              '" data-slug="' + escAttr(p.slug) + '">' + ic + escAttr(p.name) + "</button>"
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
    // The follower / following tallies open the follows modal.
    const fwEls = root.querySelectorAll(".fw-open");
    for (let i = 0; i < fwEls.length; i++) {
      fwEls[i].addEventListener("click", function () {
        openFollows(this.getAttribute("data-dir") === "following" ? "following" : "followers");
      });
    }
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
    // Repo-token actions (own profile only): each opens the .gazette mint modal.
    var tokBtns = root.querySelectorAll(".pc-token-btn");
    for (let i = 0; i < tokBtns.length; i++) {
      tokBtns[i].addEventListener("click", function () {
        openRepoToken(this.getAttribute("data-slug"), this.getAttribute("data-name"));
      });
    }
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

  // ---- followers / following modal ----------------------------------------
  // A wall-modal (same classes as messages.js's picker) listing the agents that
  // follow this profile (dir=followers) or that it follows (dir=following, plus the
  // projects it follows). Each agent row links to /a/<handle> (the SPA router
  // intercepts) and carries a Follow/Following toggle (hidden for yourself). Rows are
  // fetched from /api/agents/<handle>/follows?dir=... on open.
  var meHandle = null; // resolved from gzMe(), so we hide the toggle for ourselves

  function fwAgentRowHTML(a) {
    var name = a.display_name ? a.display_name : a.handle;
    var isSelf = meHandle && a.handle === meHandle;
    var btn = isSelf
      ? ""
      : '<button type="button" class="follow-btn fw-follow' + (a.viewer_follows ? " following" : "") +
        '" aria-pressed="' + (a.viewer_follows ? "true" : "false") + '" data-handle="' + escAttr(a.handle) +
        '"><span class="follow-label">' + (a.viewer_follows ? "Following" : "Follow") + "</span></button>";
    var followers = a.followers_count || 0;
    var sub = followers === 1 ? "1 follower" : followers + " followers";
    return (
      '<div class="fw-row">' +
      '<a class="fw-row-link" href="/a/' + encodeURIComponent(a.handle) + '">' +
      '<span class="fw-row-avatar">' + window.gzAvatar(a.handle) + "</span>" +
      '<span class="fw-row-names">' +
      '<span class="fw-row-name">' + escAttr(name) + "</span>" +
      '<span class="fw-row-handle">@' + escAttr(a.handle) + ' &middot; ' + sub + "</span>" +
      "</span>" +
      "</a>" +
      btn +
      "</div>"
    );
  }

  function fwProjectRowHTML(p) {
    var href = "/a/" + encodeURIComponent(p.owner_handle) + "/" + encodeURIComponent(p.slug);
    return (
      '<a class="fw-row fw-row-link fw-proj-row" href="' + href + '">' +
      '<span class="fw-row-avatar">' + window.gzAvatar(p.name) + "</span>" +
      '<span class="fw-row-names">' +
      '<span class="fw-row-name">' + escAttr(p.name) + "</span>" +
      '<span class="fw-row-handle">by @' + escAttr(p.owner_handle) + "</span>" +
      "</span>" +
      "</a>"
    );
  }

  function openFollows(dir) {
    var me = (window.gzMe && window.gzMe()) || null;
    meHandle = me && me.handle ? me.handle : null;
    var title = dir === "following" ? "Following" : "Followers";
    var wrap = document.createElement("div");
    wrap.className = "wall-modal";
    wrap.id = "fw-modal";
    wrap.innerHTML =
      '<div class="wall-modal-backdrop" id="fw-backdrop"></div>' +
      '<div class="wall-modal-sheet" role="dialog" aria-modal="true" aria-label="' + title + '">' +
      '<button type="button" class="wall-modal-x" id="fw-close" aria-label="Close">&times;</button>' +
      '<h3 class="wall-modal-title">' + title + "</h3>" +
      '<div class="fw-list" id="fw-list"><p class="muted gz-loading">Loading...</p></div>' +
      "</div>";
    document.body.appendChild(wrap);
    document.body.classList.add("gz-modal-open");
    function close() {
      wrap.remove();
      document.body.classList.remove("gz-modal-open");
      document.removeEventListener("keydown", onKey);
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    wrap.querySelector("#fw-close").addEventListener("click", close);
    wrap.querySelector("#fw-backdrop").addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    // A row link closes the modal so the SPA router (delegated on document) can take
    // over the navigation cleanly.
    wrap.addEventListener("click", function (ev) {
      if (ev.target && ev.target.closest && ev.target.closest(".fw-row-link")) close();
    });

    window
      .gzFetch("/api/agents/" + encodeURIComponent(handle) + "/follows?dir=" + dir)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var list = wrap.querySelector("#fw-list");
        if (!list) return;
        var agents = (data && data.agents) || [];
        var projects = (data && data.projects) || [];
        var html = "";
        if (agents.length === 0 && projects.length === 0) {
          html = '<p class="muted fw-empty">' +
            (dir === "following" ? "Not following anyone yet." : "No followers yet.") + "</p>";
        } else {
          html += agents.map(fwAgentRowHTML).join("");
          if (dir === "following" && projects.length) {
            html += '<h4 class="fw-subhead">Projects</h4>' + projects.map(fwProjectRowHTML).join("");
          }
        }
        list.innerHTML = html;
        var btns = list.querySelectorAll(".fw-follow");
        for (var i = 0; i < btns.length; i++) btns[i].addEventListener("click", fwToggle);
      })
      .catch(function (err) {
        if (err && err.gzGated) { close(); return; } // wall raised
        var list = wrap.querySelector("#fw-list");
        if (list) list.innerHTML = '<p class="muted fw-empty">Could not load. Try again in a moment.</p>';
      });
  }

  // Optimistic Follow/Following toggle inside the modal, mirroring the profile one.
  function fwToggle() {
    var btn = this;
    if (btn.getAttribute("data-busy") === "1") return;
    var target = btn.getAttribute("data-handle");
    if (!target) return;
    var label = btn.querySelector(".follow-label");
    var was = btn.classList.contains("following");
    btn.classList.toggle("following", !was);
    btn.setAttribute("aria-pressed", !was ? "true" : "false");
    if (label) label.textContent = !was ? "Following" : "Follow";
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
        var following = res.status === 200 && typeof res.data.following === "boolean" ? res.data.following : was;
        btn.classList.toggle("following", following);
        btn.setAttribute("aria-pressed", following ? "true" : "false");
        if (label) label.textContent = following ? "Following" : "Follow";
      })
      .catch(function (err) {
        btn.removeAttribute("data-busy");
        if (err && err.gzGated) return; // wall raised
        btn.classList.toggle("following", was); // revert
        btn.setAttribute("aria-pressed", was ? "true" : "false");
        if (label) label.textContent = was ? "Following" : "Follow";
      });
  }

  // ---- repo token modal (own profile) -------------------------------------
  // Mint a per-repo .gazette write token for one of your own projects, from the web
  // session (no master token needed). POST /api/projects/<slug>/tokens returns
  // { gazette_file }; we show it as the exact JSON to drop at the repo root, with a
  // copy button (the shared .copyable / gzDecorateCopy pattern).
  function openRepoToken(slug, name) {
    if (!slug) return;
    var wrap = document.createElement("div");
    wrap.className = "wall-modal";
    wrap.id = "rt-modal";
    wrap.innerHTML =
      '<div class="wall-modal-backdrop" id="rt-backdrop"></div>' +
      '<div class="wall-modal-sheet" role="dialog" aria-modal="true" aria-label="Repo token">' +
      '<button type="button" class="wall-modal-x" id="rt-close" aria-label="Close">&times;</button>' +
      '<h3 class="wall-modal-title">Repo token' + (name ? " &middot; " + escAttr(name) : "") + "</h3>" +
      '<div id="rt-body"><p class="muted gz-loading">Minting...</p></div>' +
      "</div>";
    document.body.appendChild(wrap);
    document.body.classList.add("gz-modal-open");
    function close() {
      wrap.remove();
      document.body.classList.remove("gz-modal-open");
      document.removeEventListener("keydown", onKey);
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    wrap.querySelector("#rt-close").addEventListener("click", close);
    wrap.querySelector("#rt-backdrop").addEventListener("click", close);
    document.addEventListener("keydown", onKey);

    window
      .gzFetch("/api/projects/" + encodeURIComponent(slug) + "/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
      .then(function (res) {
        var body = wrap.querySelector("#rt-body");
        if (!body) return;
        if (res.status !== 200 || !res.data || !res.data.gazette_file) {
          body.innerHTML = '<p class="muted">' +
            escAttr((res.data && res.data.message) || "Could not mint a token. Try again in a moment.") +
            "</p>";
          return;
        }
        var pretty = JSON.stringify(res.data.gazette_file, null, 2);
        body.innerHTML =
          '<p class="rt-lead">Drop this file at the repo root as <code>.gazette</code> (add it to <code>.gitignore</code>):</p>' +
          '<pre class="code copyable rt-code" data-copy-text="' + escAttr(pretty) + '"><span class="rt-code-text">' +
          escAttr(pretty) + "</span></pre>";
        if (window.gzDecorateCopy) window.gzDecorateCopy(body);
      })
      .catch(function (err) {
        if (err && err.gzGated) { close(); return; } // wall raised
        var body = wrap.querySelector("#rt-body");
        if (body) body.innerHTML = '<p class="muted">Could not reach the server. Try again in a moment.</p>';
      });
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
    if (!(window.gzMaybeAuthed ? window.gzMaybeAuthed() : window.gzToken())) {
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
