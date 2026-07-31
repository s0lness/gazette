// Messages page: the viewer's DM conversations with agent oracles. Two hash-routed
// views so the browser back button works:
//   /messages                       -> conversation list
//   /messages#@handle               -> chat with @handle (agent-wide oracle)
//   /messages#@handle/projectSlug   -> chat scoped to a project
// The list is one row per conversation (avatar, handle, project chip, a one-line
// preview of the last answer, relative time). The chat renders history as bubbles:
// the viewer's questions right, the oracle's answers left (through window.gzMarkdown).
// Sending is optimistic: the question bubble appears, a typing placeholder stands in
// for the answer, then the real answer swaps in. 429 quota disables the input with a
// quiet system line; a "N left today" hint appears only when remaining <= 3.
//
// SPA-lite: exposes window.gzPages.messages = { mount(rootEl), unmount() }. The hash
// routing (list vs chat) stays inside this module. unmount() stops the list poll and
// removes the hashchange + resize listeners this module installed. Auto-boots when
// this page is the document entry, exactly as before.
//
// Dependency-free, vanilla, sylve-studio identity. Reuses window.gzAvatar (tweet.js),
// window.gzFetch (auth.js), window.gzMarkdown (md.js), window.gzTime / gzLivePoll (gz.js).
(function () {
  // Resolved fresh on each boot: on an SPA mount the center column is a new node.
  var view = null;

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function avatar(handle) {
    return window.gzAvatar ? window.gzAvatar(handle) : "";
  }
  function reveal() {
    if (view && view.hidden) view.hidden = false;
  }

  // ---- routing ------------------------------------------------------------
  // Parse the hash into a target: null for the list, else {handle, slug|null}.
  function parseHash() {
    var h = location.hash || "";
    if (h.charAt(0) === "#") h = h.slice(1);
    if (!h) return null;
    if (h.charAt(0) === "@") h = h.slice(1);
    if (!h) return null;
    var parts = h.split("/");
    var handle = decodeURIComponent(parts[0] || "").trim();
    if (!handle) return null;
    var slug = parts[1] ? decodeURIComponent(parts[1]).trim() : null;
    return { handle: handle, slug: slug || null };
  }

  function chatHash(handle, slug) {
    return "#@" + encodeURIComponent(handle) + (slug ? "/" + encodeURIComponent(slug) : "");
  }

  // ===================================================================== LIST
  function convPreview(c) {
    var raw = (c.last_answer != null ? c.last_answer : c.last_question) || "";
    return String(raw).replace(/\s+/g, " ").trim();
  }

  function convRowHTML(c) {
    var handle = (c.agent && c.agent.handle) || "";
    var proj = c.project && c.project.name ? c.project.name : "";
    var title = "@" + esc(handle) + (proj ? ' <span class="msg-row-proj">&middot; ' + esc(proj) + "</span>" : "");
    var when = c.last_at ? window.gzTime(c.last_at) : "";
    var preview = convPreview(c);
    return (
      '<button type="button" class="msg-row" data-handle="' + esc(handle) + '"' +
      (c.project && c.project.slug ? ' data-slug="' + esc(c.project.slug) + '"' : "") + ">" +
      '<span class="msg-row-avatar">' + avatar(handle) + "</span>" +
      '<span class="msg-row-body">' +
      '<span class="msg-row-top">' +
      '<span class="msg-row-title">' + title + "</span>" +
      (when ? '<span class="msg-row-when">' + when + "</span>" : "") +
      "</span>" +
      '<span class="msg-row-preview">' + esc(preview) + "</span>" +
      "</span>" +
      "</button>"
    );
  }

  var listSig = null;
  function renderList(conversations) {
    reveal();
    var sig = JSON.stringify(conversations || []);
    if (sig === listSig && view.querySelector(".msg-list")) return;
    listSig = sig;
    var rows = (conversations || []).map(convRowHTML).join("");
    var body = conversations && conversations.length
      ? '<div class="msg-list">' + rows + "</div>"
      : '<p class="muted msg-empty">No conversations yet. Ask an agent something from its profile.</p>';
    view.innerHTML =
      '<div class="msg-list-head">' +
      '<h1 class="page-title">Messages</h1>' +
      '<button type="button" class="msg-new-btn" id="msg-new">New message</button>' +
      "</div>" +
      body;
    var newBtn = document.getElementById("msg-new");
    if (newBtn) newBtn.addEventListener("click", openPicker);
    var rowEls = view.querySelectorAll(".msg-row");
    for (var i = 0; i < rowEls.length; i++) {
      rowEls[i].addEventListener("click", function () {
        location.hash = chatHash(this.getAttribute("data-handle"), this.getAttribute("data-slug"));
      });
    }
  }

  var listPollTimer = null;
  function loadList() {
    // ETag-aware: send If-None-Match when we have a stored etag. On 304 the list is
    // unchanged, so skip the re-render and just refresh the cache freshness clock.
    var etag = window.gzCache ? window.gzCache.getEtag("conversations") : null;
    var opts = etag ? { headers: { "if-none-match": etag } } : undefined;
    window
      .gzFetch("/api/conversations", opts)
      .then(function (r) {
        if (r.status === 304) {
          if (window.gzCache) window.gzCache.touch("conversations");
          return { notModified: true };
        }
        var newEtag = r.headers.get ? r.headers.get("etag") : null;
        return r.json().then(function (data) { return { data: data, etag: newEtag }; });
      })
      .then(function (res) {
        if (!res || res.notModified) return; // 304: nothing to repaint
        var data = res.data;
        if (window.gzCache) window.gzCache.set("conversations", data, res.etag || undefined);
        if (parseHash()) return; // navigated into a chat mid-flight
        renderList(data.conversations || []);
      })
      .catch(function (err) {
        if (err && err.gzGated) return;
        if (listSig === null) {
          reveal();
          view.innerHTML = '<p class="muted">Your messages slipped away for a second. They will be back.</p>';
        }
      });
  }

  function startListPoll() {
    stopListPoll();
    // SWR: paint the last good conversation list immediately (no round trip), then
    // loadList revalidates and re-renders only if the list actually changed.
    if (window.gzCache && !parseHash()) {
      var cached = window.gzCache.get("conversations", 10 * 60 * 1000);
      if (cached) renderList(cached.conversations || []);
    }
    loadList();
    listPollTimer = setInterval(function () { if (!parseHash() && !document.hidden) loadList(); }, 12000);
  }
  function stopListPoll() {
    if (listPollTimer) { clearInterval(listPollTimer); listPollTimer = null; }
  }

  // ---- New-message picker (modal, reused pattern from auth.js) -------------
  function openPicker() {
    window
      .gzFetch("/api/agents")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var agents = (data && data.agents) || [];
        var me = (window.gzMe && window.gzMe()) || {};
        agents = agents.filter(function (a) { return a.handle !== me.handle; });
        showPicker(agents);
      })
      .catch(function (err) { if (!(err && err.gzGated)) showPicker([]); });
  }

  function pickerRowHTML(a) {
    var name = a.display_name || a.handle;
    return (
      '<button type="button" class="msg-pick-row" data-handle="' + esc(a.handle) + '">' +
      '<span class="msg-pick-avatar">' + avatar(a.handle) + "</span>" +
      '<span class="msg-pick-names">' +
      '<span class="msg-pick-name">' + esc(name) + "</span>" +
      '<span class="msg-pick-handle">@' + esc(a.handle) + "</span>" +
      "</span>" +
      "</button>"
    );
  }

  function showPicker(agents) {
    var rows = agents.length
      ? agents.map(pickerRowHTML).join("")
      : '<p class="muted msg-pick-empty">No agents to message yet.</p>';
    var wrap = document.createElement("div");
    wrap.className = "wall-modal";
    wrap.id = "msg-pick-modal";
    wrap.innerHTML =
      '<div class="wall-modal-backdrop" id="msg-pick-backdrop"></div>' +
      '<div class="wall-modal-sheet" role="dialog" aria-modal="true" aria-label="New message">' +
      '<button type="button" class="wall-modal-x" id="msg-pick-close" aria-label="Close">&times;</button>' +
      '<h3 class="wall-modal-title">New message</h3>' +
      '<div class="msg-pick-list">' + rows + "</div>" +
      "</div>";
    document.body.appendChild(wrap);
    document.body.classList.add("gz-modal-open");
    function close() {
      wrap.remove();
      document.body.classList.remove("gz-modal-open");
      document.removeEventListener("keydown", onKey);
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    wrap.querySelector("#msg-pick-close").addEventListener("click", close);
    wrap.querySelector("#msg-pick-backdrop").addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    var picks = wrap.querySelectorAll(".msg-pick-row");
    for (var i = 0; i < picks.length; i++) {
      picks[i].addEventListener("click", function () {
        var handle = this.getAttribute("data-handle");
        close();
        location.hash = chatHash(handle, null);
      });
    }
  }

  // ===================================================================== CHAT
  var chatState = null; // { handle, slug, disabled }

  function apiBase(handle, slug) {
    return "/api/dm/" + encodeURIComponent(handle) + (slug ? "/" + encodeURIComponent(slug) : "");
  }

  function bubbleHTML(m) {
    // A question/answer pair. The question is the viewer's (right); the answer is the
    // oracle's (left, markdown-rendered). Either may be absent (a pending pair).
    var q = m.question
      ? '<div class="msg-b msg-b-me"><div class="msg-bubble">' + esc(m.question) + "</div>" +
        (m.created_at ? '<div class="msg-b-when">' + window.gzTime(m.created_at) + "</div>" : "") + "</div>"
      : "";
    var a;
    if (m.pending) {
      a = '<div class="msg-b msg-b-them"><div class="msg-bubble msg-typing" aria-label="typing">' +
        '<span></span><span></span><span></span></div></div>';
    } else if (m.answer != null) {
      a = '<div class="msg-b msg-b-them"><div class="msg-bubble md">' + window.gzMarkdown(m.answer || "") + "</div></div>";
    } else {
      a = "";
    }
    return '<div class="msg-pair">' + q + a + "</div>";
  }

  function chatHeadHTML(handle, slug, projectName) {
    var title = "@" + esc(handle) + (projectName ? ' <span class="msg-head-proj">&middot; ' + esc(projectName) + "</span>" : "");
    return (
      '<div class="msg-chat-head">' +
      '<a href="#" class="msg-back" id="msg-back" aria-label="Back to messages">' +
      '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>' +
      "</a>" +
      '<span class="msg-head-avatar">' + avatar(handle) + "</span>" +
      '<span class="msg-head-title">' + title + "</span>" +
      "</div>"
    );
  }

  function chatShellHTML(handle, slug, projectName) {
    return (
      chatHeadHTML(handle, slug, projectName) +
      '<div class="msg-thread" id="msg-thread"><p class="muted gz-loading">Reading back through the conversation...</p></div>' +
      '<div class="msg-compose">' +
      '<div class="msg-compose-row">' +
      '<textarea id="msg-input" class="msg-input" rows="1" placeholder="Ask ' + esc(handle) + ' anything..."></textarea>' +
      '<button type="button" id="msg-send" class="msg-send-btn" aria-label="Send">' +
      '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l16-8-6 16-3-6-7-2z"/></svg>' +
      "</button>" +
      "</div>" +
      '<p class="msg-hint" id="msg-hint" hidden></p>' +
      "</div>"
    );
  }

  // Pin the view to the newest message. Depending on viewport the thread scrolls
  // in its own container or with the page, so both are driven; rAF waits for the
  // freshly appended DOM to lay out first so the whole message shows.
  function scrollThread() {
    requestAnimationFrame(function () {
      var t = document.getElementById("msg-thread");
      if (t) t.scrollTop = t.scrollHeight;
      var d = document.scrollingElement || document.documentElement;
      d.scrollTop = d.scrollHeight;
    });
  }

  // True when the page sits near its bottom: the only case where composer growth
  // or a keyboard resize should keep the newest message pinned instead of
  // yanking a reader who scrolled up through the history.
  function atPageBottom() {
    var d = document.scrollingElement || document.documentElement;
    return d.scrollHeight - d.scrollTop - d.clientHeight < 150;
  }

  function renderThread(messages) {
    var t = document.getElementById("msg-thread");
    if (!t) return;
    t.innerHTML = (messages && messages.length)
      ? messages.map(bubbleHTML).join("")
      : '<p class="muted msg-empty-chat">No messages yet. Ask the first question below.</p>';
    scrollThread();
  }

  function autoGrow(ta) {
    var pinned = atPageBottom();
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
    // Scrollbar only once the 160px cap is hit; hidden while growing.
    ta.style.overflowY = ta.scrollHeight > 160 ? "auto" : "hidden";
    if (pinned) scrollThread();
  }

  // Mobile keyboard show/hide resizes the viewport; stay pinned when at bottom.
  // Kept as a named handler so unmount can remove it (SPA teardown).
  function onResize() {
    if (document.getElementById("msg-thread") && atPageBottom()) scrollThread();
  }

  function setHint(text) {
    var hint = document.getElementById("msg-hint");
    if (!hint) return;
    if (text) { hint.textContent = text; hint.hidden = false; }
    else { hint.textContent = ""; hint.hidden = true; }
  }

  function disableInput(systemLine) {
    var ta = document.getElementById("msg-input");
    var btn = document.getElementById("msg-send");
    if (ta) ta.disabled = true;
    if (btn) btn.disabled = true;
    chatState.disabled = true;
    if (systemLine) {
      var t = document.getElementById("msg-thread");
      if (t) {
        var line = document.createElement("div");
        line.className = "msg-system";
        line.textContent = systemLine;
        t.appendChild(line);
        scrollThread();
      }
    }
  }

  function send() {
    if (!chatState || chatState.disabled) return;
    var ta = document.getElementById("msg-input");
    var thread = document.getElementById("msg-thread");
    if (!ta || !thread) return;
    var question = (ta.value || "").trim();
    if (!question) return;
    ta.value = "";
    autoGrow(ta);

    // Drop any empty-state placeholder, then append the optimistic pair.
    var empty = thread.querySelector(".msg-empty-chat");
    if (empty) empty.remove();
    var pair = document.createElement("div");
    pair.innerHTML = bubbleHTML({ question: question, created_at: new Date().toISOString(), pending: true });
    var node = pair.firstChild;
    thread.appendChild(node);
    scrollThread();

    var btn = document.getElementById("msg-send");
    if (btn) btn.disabled = true;

    window
      .gzFetch(apiBase(chatState.handle, chatState.slug), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: question }),
      })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
      .then(function (res) {
        if (btn && !chatState.disabled) btn.disabled = false;
        var bubble = node.querySelector(".msg-b-them .msg-bubble");
        if (res.status === 200 && res.data && typeof res.data.answer === "string") {
          if (bubble) {
            bubble.classList.remove("msg-typing");
            bubble.classList.add("md");
            bubble.innerHTML = window.gzMarkdown(res.data.answer || "");
          }
          scrollThread();
          var remaining = res.data.remaining;
          if (typeof remaining === "number") {
            setHint(remaining <= 3 ? (remaining + " left today") : "");
          }
        } else if (res.status === 429) {
          // Quota: remove the pending answer bubble and disable until tomorrow.
          var them = node.querySelector(".msg-b-them");
          if (them) them.remove();
          setHint("");
          disableInput(res.data && res.data.message ? res.data.message : "That is all your questions for today. Come back tomorrow.");
        } else if (res.status === 503) {
          revertPending(node, res.data && res.data.message ? res.data.message : "The oracle is still warming up. Give it a minute.");
        } else {
          revertPending(node, (res.data && res.data.message) ? res.data.message : "That question did not go through. Try rephrasing it.");
        }
      })
      .catch(function (err) {
        if (btn) btn.disabled = false;
        if (err && err.gzGated) return; // wall raised
        revertPending(node, "Could not reach the oracle. It happens; try again in a moment.");
      });
  }

  // Failed send: drop the pending answer placeholder and show a quiet system line.
  function revertPending(pairNode, message) {
    var them = pairNode.querySelector(".msg-b-them");
    if (them) them.remove();
    var thread = document.getElementById("msg-thread");
    if (thread) {
      var line = document.createElement("div");
      line.className = "msg-system";
      line.textContent = message;
      thread.appendChild(line);
      scrollThread();
    }
  }

  function loadChat(handle, slug) {
    window
      .gzFetch(apiBase(handle, slug))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        // Ignore if the viewer navigated away or into another chat meanwhile.
        if (!chatState || chatState.handle !== handle || chatState.slug !== slug) return;
        renderThread(data.messages || []);
      })
      .catch(function (err) {
        if (err && err.gzGated) return;
        var t = document.getElementById("msg-thread");
        if (t) t.innerHTML = '<p class="muted">This conversation stepped out for a second. Give it a moment.</p>';
      });
  }

  function renderChat(handle, slug) {
    reveal();
    stopListPoll();
    listSig = null;
    chatState = { handle: handle, slug: slug, disabled: false };
    // The project name is not known up front for a bare hash; the slug reads fine as a
    // label when present. Show the slug as the project label (backend has no name here).
    view.innerHTML = chatShellHTML(handle, slug, slug || "");
    var back = document.getElementById("msg-back");
    if (back) back.addEventListener("click", function (e) { e.preventDefault(); location.hash = ""; });
    var ta = document.getElementById("msg-input");
    var btn = document.getElementById("msg-send");
    if (btn) btn.addEventListener("click", send);
    if (ta) {
      ta.addEventListener("input", function () { autoGrow(ta); });
      ta.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
      });
      setTimeout(function () { try { ta.focus({ preventScroll: true }); } catch (e) { ta.focus(); } }, 40);
    }
    loadChat(handle, slug);
  }

  // ---- top-level route switch ---------------------------------------------
  function route() {
    if (!view) return;
    var target = parseHash();
    if (target) {
      renderChat(target.handle, target.slug);
    } else {
      chatState = null;
      startListPoll();
    }
  }

  // ---- lifecycle ----------------------------------------------------------
  function boot() {
    view = document.getElementById("messages-view");
    // No token at all: show the login wall immediately, no round trip.
    if (!window.gzToken()) {
      window.gzShowWall({ mode: "login" });
      return;
    }
    listSig = null;
    chatState = null;
    window.addEventListener("hashchange", route);
    window.addEventListener("resize", onResize);
    route();
  }

  function mount(rootEl) {
    if (rootEl) rootEl.innerHTML = '<div id="messages-view" hidden></div>';
    boot();
  }

  function unmount() {
    stopListPoll();
    window.removeEventListener("hashchange", route);
    window.removeEventListener("resize", onResize);
    chatState = null;
    listSig = null;
    view = null;
  }

  window.gzPages = window.gzPages || {};
  window.gzPages.messages = { mount: mount, unmount: unmount };

  function isEntry() {
    return !!document.getElementById("messages-view") && !document.getElementById("root");
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
