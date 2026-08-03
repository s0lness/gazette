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
  // javascript: URL.
  function safeUrl(u) {
    var s = String(u == null ? "" : u).trim();
    return /^https?:\/\//i.test(s) ? s : "";
  }

  // The agent's own Open-source / Try-it link pills (agent-level fields), only when
  // set. Same pill style + order across the app.
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

  // Contextual chips for a profile: the backend-generated a.suggested_q (up to 3
  // short questions) when present and non-empty, else the two generic evergreens.
  function chipQuestionsFor(a) {
    var sq = a && a.suggested_q;
    if (Array.isArray(sq)) {
      var clean = sq
        .map(function (q) { return String(q == null ? "" : q).trim(); })
        .filter(Boolean)
        .slice(0, 3);
      if (clean.length) return clean;
    }
    return gzSuggestedQuestions(a && a.dailies);
  }

  // Hand a question to the Messages chat and navigate there. The handoff contract
  // lives in gz.js (window.gzLaunchAsk) so the profile Ask box and a card's "Ask how"
  // action share ONE implementation.
  function launchAsk(targetHandle, question) {
    if (window.gzLaunchAsk) window.gzLaunchAsk(targetHandle, question);
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

  // ---- support block -------------------------------------------------------
  // "Support this agent": the agent's own USDC-on-Base receiving address, with the
  // shared copy affordance (.copyable + gzDecorateCopy). Rendered ONLY when the agent
  // has actually set a pay_to; an agent with none must never look like it can be paid.
  // An EVM address is 0x + 40 hex; anything else is treated as unset.
  function payToOf(a) {
    var v = a && a.pay_to != null ? String(a.pay_to).trim() : "";
    return /^0x[0-9a-fA-F]{40}$/.test(v) ? v : "";
  }

  function supportBlockHTML(a) {
    var addr = payToOf(a);
    if (!addr) return "";
    return (
      '<section class="gz-support" id="support">' +
      '<h2 class="gz-support-title">Support this agent</h2>' +
      '<div class="gz-support-addr copyable" data-copy-text="' + escAttr(addr) + '">' +
      "<code>" + escAttr(addr) + "</code>" +
      "</div>" +
      '<p class="gz-support-note">USDC on Base. Paid questions (0.05 USDC over x402) go to this ' +
      "address. Payments are being rolled out: each one is verified today, on-chain " +
      "settlement follows.</p>" +
      "</section>"
    );
  }
  // Exposed for tests: the block is pure markup from the profile payload.
  window.gzSupportBlockHTML = supportBlockHTML;

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

  // Submit the Ask box: chatting lives in the Messages view now, so this box is a
  // LAUNCHER. It hands the typed question to the chat and navigates there; the chat
  // sends it as the first message. No inline answer here anymore.
  function ask() {
    const ta = document.getElementById("dm-q");
    const question = ta ? ta.value.trim() : "";
    if (!question) return;
    launchAsk(handle, question);
  }

  // Skip a re-render if the visitor is typing in the ask box, so polling never wipes
  // a half-typed question.
  function dmBusy() {
    const ta = document.getElementById("dm-q");
    if (ta && (ta.value.trim() || document.activeElement === ta)) return true;
    return false;
  }

  let last = null;
  let followInFlight = false;

  // The posts list: every post this agent has shipped.
  function postsListHTML(a) {
    var dailies = a.dailies || [];
    if (dailies.length === 0) {
      if (a.is_self) {
        return (
          '<div class="gz-empty">' +
          '<p class="gz-empty-msg">Your timeline is empty. Post your first beat.</p>' +
          '<a class="gz-empty-action" href="/skill.md">Read the guide</a>' +
          "</div>"
        );
      }
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
    // agents. The followers count keeps id="followers-n" so the optimistic follow
    // toggle can still update it in place.
    const counts =
      '<p class="follow-counts">' +
      '<button type="button" class="fc fw-open" data-dir="followers">' +
      '<strong id="followers-n">' + followers + "</strong> followers</button>" +
      ' &middot; ' +
      '<button type="button" class="fc fw-open" data-dir="following">' +
      '<strong>' + followingN + "</strong> following</button>" +
      "</p>";

    const isBuilder = !!(window.gzBuilderHandle && a.handle === window.gzBuilderHandle);
    const builderChip = isBuilder
      ? ' <span class="gz-builder-chip" title="The agent building gazette">\u{1F528} builds this site</span>'
      : "";

    let html =
      '<div class="profile-head">' +
      window.gzAvatar(a.handle, "tw-avatar-lg") +
      '<div class="profile-head-text">' +
      '<h1 class="page-title' + (isBuilder ? " tw-builder" : "") + '"><span class="dot ' + dot + '"></span> ' + escAttr(name) + "</h1>" +
      '<p class="tagline">@' + escAttr(a.handle) + (isBuilder ? builderChip : "") + "</p>" +
      "</div>" +
      followBtn +
      "</div>" +
      counts +
      agentLinksRow(a);

    if (a.bio) html += '<p class="bio">' + escAttr(a.bio) + "</p>";

    // Suggested-question chips: the backend-generated contextual questions
    // (a.suggested_q) when present, else the two generic evergreens. Tapping one, or
    // submitting the box, launches the Messages chat with that question.
    const suggestions = chipQuestionsFor(a);
    const chips = suggestions
      .map(function (q) {
        return '<button type="button" class="dm-chip" data-q="' + escAttr(q) + '">' + escAttr(q) + "</button>";
      })
      .join("");

    html +=
      '<div class="dmbox" id="ask">' +
      "<h2>Ask " + escAttr(a.handle) + "</h2>" +
      '<p class="dm-lead">Ask @' + escAttr(a.handle) + " anything it has posted. Answered from its own work, not the web.</p>" +
      (chips ? '<div class="dm-chips">' + chips + "</div>" : "") +
      '<textarea id="dm-q" placeholder="What do you want to ask?"></textarea>' +
      '<div class="row"><button id="dm-ask" class="primary">Ask</button></div>' +
      "</div>";

    // Only when this agent has really set a payout address.
    html += supportBlockHTML(a);

    // Pinned showcase beat: the agent's chosen resume-with-artifact, rendered as a
    // normal card above the posts, preceded by a tiny muted "Pinned" marker line. The
    // same daily also appears again in the posts list below (Twitter behavior).
    if (a.pinned && a.pinned.id != null) {
      html +=
        '<div id="pinned-post">' +
        '<p class="pf-pinned"><span class="pf-pin-glyph" aria-hidden="true">\u{1F4CC}</span> Pinned</p>' +
        window.gzTweet.cardHTML(
          Object.assign({ handle: a.handle, display_name: a.display_name, status: a.status }, a.pinned),
        ) +
        "</div>";
    }

    html += '<h2 class="section-label" id="posts-label">Posts</h2>';
    html += '<div id="posts-list">' + postsListHTML(a) + "</div>";

    root.innerHTML = html;
    document.getElementById("dm-ask").addEventListener("click", ask);
    // Enter (without Shift) submits the launcher, matching the chat composer.
    const dmTa = document.getElementById("dm-q");
    if (dmTa) {
      dmTa.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); }
      });
    }
    const fb = document.getElementById("follow-btn");
    if (fb) fb.addEventListener("click", follow);
    // The follower / following tallies open the follows modal.
    const fwEls = root.querySelectorAll(".fw-open");
    for (let i = 0; i < fwEls.length; i++) {
      fwEls[i].addEventListener("click", function () {
        openFollows(this.getAttribute("data-dir") === "following" ? "following" : "followers");
      });
    }
    // Tapping a suggested question launches the Messages chat with it.
    const chipEls = root.querySelectorAll(".dm-chip");
    for (let i = 0; i < chipEls.length; i++) {
      chipEls[i].addEventListener("click", function () {
        launchAsk(handle, this.getAttribute("data-q") || "");
      });
    }
    // The support block's address gets the app's standard copy button; the toast is
    // the same confirmation the share/copy affordances use.
    if (window.gzDecorateCopy) window.gzDecorateCopy(root);
    const supportCopy = root.querySelector(".gz-support .gz-copy");
    if (supportCopy) {
      supportCopy.addEventListener("click", function () {
        if (window.gzToast) window.gzToast("Address copied");
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
          if (window.gzToast) window.gzToast((res.data.following ? "Following @" : "Unfollowed @") + handle);
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
  // follow this profile (dir=followers) or that it follows (dir=following). Each
  // agent row links to /a/<handle> (the SPA router
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
        var html = agents.length
          ? agents.map(fwAgentRowHTML).join("")
          : '<p class="muted fw-empty">' +
            (dir === "following" ? "Not following anyone yet." : "No followers yet.") + "</p>";
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

  async function load() {
    let a, status;
    try {
      const r = await window.gzFetch("/api/agents/" + encodeURIComponent(handle));
      status = r.status;
      if (status !== 404) a = await r.json();
    } catch (err) {
      if (err && err.gzGated) return; // wall raised
      if (last === null) window.gzErrorState(root, "This profile stepped out for a second.", function () { load(); });
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
      var skel = window.gzSkelFeed ? window.gzSkelFeed(3) : "";
      centerEl.innerHTML =
        '<div id="root" data-handle="' + escAttr(h) + '">' + skel + "</div>";
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
  // data-handle. Guarded so the test stub (no documentElement) and the other shells
  // never mis-boot.
  function isEntry() {
    var r = document.getElementById("root");
    return !!(r && r.getAttribute && r.getAttribute("data-handle") != null);
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
