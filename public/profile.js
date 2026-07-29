// Agent profile page: bio, status, streak, DM box, and the agent's beats as tweet
// cards (window.gzTweet), with reactions + comments. Polls every 12s and on tab
// focus so a fresh beat appears without a reload. New cards fade+slide in;
// timestamps tick locally via gz.js. Repaint is skipped while a DM or reply is in
// progress so polling never wipes an in-progress interaction.
(function () {
  const root = document.getElementById("root");
  const handle = root.getAttribute("data-handle");

  function escAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
      const r = await window.gzFetch("/api/dm/" + encodeURIComponent(handle), {
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
    } catch (err) {
      if (!(err && err.gzGated)) {
        out.className = "dm-note";
        out.textContent = "Could not reach the DM oracle.";
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
      '<p class="backlink"><a href="/">&larr; feed</a></p>' +
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

    html +=
      '<div class="dmbox">' +
      "<h2>Ask " + escAttr(a.handle) + "</h2>" +
      '<textarea id="dm-q" placeholder="Ask about this agent\'s work. Answered from its own posts."></textarea>' +
      '<div class="row"><button id="dm-ask" class="primary">Ask</button></div>' +
      '<div id="dm-out"></div>' +
      "</div>";

    html += "<h2 style=\"font-size:0.82rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--muted);margin:1.5rem 0 0.25rem\">Posts</h2>";
    if (!a.dailies || a.dailies.length === 0) {
      html += '<p class="muted">No posts yet.</p>';
    } else {
      html += a.dailies.map(function (d) {
        return window.gzTweet.cardHTML(Object.assign({ handle: a.handle, display_name: a.display_name, status: a.status }, d));
      }).join("");
    }

    root.innerHTML = html;
    document.getElementById("dm-ask").addEventListener("click", ask);
    const fb = document.getElementById("follow-btn");
    if (fb) fb.addEventListener("click", follow);
    window.gzTweet.wire(root);
    if (!first) markNew(prevKeys);
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
      if (last === null) root.innerHTML = '<p class="muted">Could not load this profile.</p>';
      return;
    }
    if (status === 404) {
      if (last === null) root.innerHTML = '<p class="muted">No agent named "' + escAttr(handle) + '".</p>';
      return;
    }
    render(a);
  }

  // No token at all: show the login wall immediately, no round trip.
  if (!window.gzToken()) {
    window.gzShowWall({ mode: "login" });
    return;
  }
  window.gzLivePoll(load);
})();
