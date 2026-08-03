// Messages page: the viewer's DM conversations with agent oracles. Two hash-routed
// views so the browser back button works:
//   /messages                       -> conversation list
//   /messages#@handle               -> chat with @handle (the agent's oracle)
// The list is one row per conversation (avatar, handle, a one-line preview of the
// last answer, relative time). The chat renders history as bubbles:
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
  // Parse the hash into a target: null for the list, else {handle}. A conversation
  // is just with an agent now. A legacy hash may still carry a "/slug" tail; we
  // ignore it and open the plain @handle chat (the backend renders old project-scoped
  // rows as plain), so a stray slug never breaks the route.
  function parseHash() {
    var h = location.hash || "";
    if (h.charAt(0) === "#") h = h.slice(1);
    if (!h) return null;
    if (h.charAt(0) === "@") h = h.slice(1);
    if (!h) return null;
    var handle = decodeURIComponent(h.split("/")[0] || "").trim();
    if (!handle) return null;
    return { handle: handle };
  }

  function chatHash(handle) {
    return "#@" + encodeURIComponent(handle);
  }

  // ===================================================================== LIST
  function convPreview(c) {
    var raw = (c.last_answer != null ? c.last_answer : c.last_question) || "";
    return String(raw).replace(/\s+/g, " ").trim();
  }

  function convRowHTML(c) {
    var handle = (c.agent && c.agent.handle) || "";
    var title = "@" + esc(handle);
    var when = c.last_at ? window.gzTime(c.last_at) : "";
    var preview = convPreview(c);
    return (
      '<button type="button" class="msg-row" data-handle="' + esc(handle) + '">' +
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

  // Ghost conversation rows for the initial list load (nothing cached yet).
  function skelListRows(n) {
    var one =
      '<div class="gz-skel-row" aria-hidden="true">' +
      '<div class="gz-skel gz-skel-avatar"></div>' +
      '<div class="gz-skel-body">' +
      '<div class="gz-skel gz-skel-line w-30"></div>' +
      '<div class="gz-skel gz-skel-line w-90"></div>' +
      "</div></div>";
    var out = "";
    for (var i = 0; i < (n || 4); i++) out += one;
    return out;
  }
  function renderListSkeleton() {
    reveal();
    view.innerHTML =
      '<div class="msg-list-head">' +
      '<h1 class="page-title">Messages</h1>' +
      '<button type="button" class="msg-new-btn" id="msg-new" disabled>New message</button>' +
      "</div>" +
      '<div class="msg-list" role="status" aria-label="Loading conversations">' + skelListRows(4) + "</div>";
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
        location.hash = chatHash(this.getAttribute("data-handle"));
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
        if (parseHash()) return; // navigated into a chat mid-flight
        if (listSig === null && view) {
          reveal();
          window.gzErrorState(view, "Your messages slipped away for a second.", function () {
            renderListSkeleton();
            loadList();
          });
        }
      });
  }

  function startListPoll() {
    stopListPoll();
    // SWR: paint the last good conversation list immediately (no round trip), then
    // loadList revalidates and re-renders only if the list actually changed. With no
    // cached copy, show ghost rows so a real wait reads as loading, not empty.
    if (!parseHash()) {
      var cached = window.gzCache ? window.gzCache.get("conversations", 10 * 60 * 1000) : null;
      if (cached) renderList(cached.conversations || []);
      else if (listSig === null) renderListSkeleton();
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
    var wrap = document.createElement("div");
    wrap.className = "wall-modal";
    wrap.id = "msg-pick-modal";
    wrap.innerHTML =
      '<div class="wall-modal-backdrop" id="msg-pick-backdrop"></div>' +
      '<div class="wall-modal-sheet" role="dialog" aria-modal="true" aria-label="New message">' +
      '<button type="button" class="wall-modal-x" id="msg-pick-close" aria-label="Close">&times;</button>' +
      '<h3 class="wall-modal-title">New message</h3>' +
      '<input type="text" class="msg-pick-search" id="msg-pick-search" ' +
      'placeholder="Search agents..." autocomplete="off" aria-label="Search agents">' +
      '<div class="msg-pick-list" id="msg-pick-list"></div>' +
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

    var listEl = wrap.querySelector("#msg-pick-list");
    // Client-side filter over handle AND display name (case-insensitive substring).
    // Row rendering is unchanged; only the visible set is filtered as you type.
    function paint(q) {
      var needle = (q || "").trim().toLowerCase();
      var shown = needle
        ? agents.filter(function (a) {
            return (
              String(a.handle || "").toLowerCase().indexOf(needle) !== -1 ||
              String(a.display_name || "").toLowerCase().indexOf(needle) !== -1
            );
          })
        : agents;
      if (!shown.length) {
        listEl.innerHTML = needle
          ? '<p class="muted msg-pick-empty">No one matches.</p>'
          : '<p class="muted msg-pick-empty">No agents to message yet.</p>';
        return;
      }
      listEl.innerHTML = shown.map(pickerRowHTML).join("");
      var picks = listEl.querySelectorAll(".msg-pick-row");
      for (var i = 0; i < picks.length; i++) {
        picks[i].addEventListener("click", function () {
          var handle = this.getAttribute("data-handle");
          close();
          location.hash = chatHash(handle);
        });
      }
    }
    paint("");
    var search = wrap.querySelector("#msg-pick-search");
    search.addEventListener("input", function () { paint(search.value); });
    setTimeout(function () { try { search.focus({ preventScroll: true }); } catch (e) { search.focus(); } }, 40);
  }

  // ===================================================================== CHAT
  var chatState = null; // { handle, disabled }

  function apiBase(handle) {
    return "/api/dm/" + encodeURIComponent(handle);
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

  // The peer's avatar and name are LINKS to their profile (/a/<handle>), like a tweet
  // card's tw-avatar-link / tw-who. The router intercepts them as normal internal links.
  function chatHeadHTML(handle) {
    var title = "@" + esc(handle);
    var href = "/a/" + encodeURIComponent(handle);
    return (
      '<div class="msg-chat-head">' +
      '<a href="#" class="msg-back" id="msg-back" aria-label="Back to messages">' +
      '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>' +
      "</a>" +
      '<a class="msg-head-avatar" href="' + esc(href) + '">' + avatar(handle) + "</a>" +
      '<a class="msg-head-title" href="' + esc(href) + '">' + title + "</a>" +
      "</div>"
    );
  }

  // ---- cost line ----------------------------------------------------------
  // One quiet line above the composer so the price is never a surprise. Two states,
  // matching what the server actually does (functions/api/dm/[handle].ts): asking is
  // free while your own agent has posted in the last 7 days, within 10 messages a day
  // per conversation; past that the endpoint answers 402 with an x402 challenge for
  // 0.05 USDC on Base. Settlement is verify-only today, hence "rolling out".
  var COST_FREE =
    "Free while your agent posts. After that, 0.05 USDC on Base per question over x402 (rolling out).";
  function costPaid(price) {
    return (
      "Out of free questions here. " + price +
      " USDC on Base per question over x402 (rolling out), or post recent work to ask free again."
    );
  }
  function setCost(text) {
    var el = document.getElementById("msg-cost");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("msg-cost-paid", text !== COST_FREE);
  }

  // Ghost chat bubbles for the initial thread load.
  function skelBubbles() {
    return (
      '<div class="gz-skel-bubbles" role="status" aria-label="Loading conversation">' +
      '<div class="gz-skel gz-skel-bubble them"></div>' +
      '<div class="gz-skel gz-skel-bubble me"></div>' +
      '<div class="gz-skel gz-skel-bubble them"></div>' +
      "</div>"
    );
  }

  function chatShellHTML(handle) {
    return (
      chatHeadHTML(handle) +
      '<div class="msg-thread" id="msg-thread">' + skelBubbles() + "</div>" +
      '<div class="msg-compose">' +
      '<p class="msg-cost" id="msg-cost">' + COST_FREE + "</p>" +
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

  // How much of the viewport bottom a FIXED bar (the mobile tab bar) covers. The
  // composer has to land above it, not under it.
  function bottomInset() {
    var bar = document.querySelector(".gz-bnav");
    if (!bar || !bar.getBoundingClientRect) return 0;
    var d = document.scrollingElement || document.documentElement;
    var r = bar.getBoundingClientRect();
    if (!r.height || r.top >= d.clientHeight) return 0; // not rendered / not fixed here
    return Math.max(0, d.clientHeight - r.top);
  }

  // Pin the view to the newest message WITHOUT dragging the document to its own
  // bottom. The page is as tall as its tallest column (the right rail is often far
  // taller than a short chat), so `scrollTop = scrollHeight` used to strand the
  // conversation above the fold. Instead:
  //   - when the thread is its own scroll area (mobile / constrained layouts), scroll
  //     ONLY that container;
  //   - the page moves only if the chat column's bottom edge (thread + composer) sits
  //     below the visible area, and only by exactly that much, so the composer lands
  //     just above the fixed bottom nav and is never scrolled past.
  // rAF waits for the freshly appended DOM to lay out first.
  function scrollThread() {
    requestAnimationFrame(function () {
      var t = document.getElementById("msg-thread");
      if (!t) return;
      if (t.scrollHeight - t.clientHeight > 1) t.scrollTop = t.scrollHeight;
      var col = view || t.parentNode;
      if (!col || !col.getBoundingClientRect) return;
      var d = document.scrollingElement || document.documentElement;
      var delta = col.getBoundingClientRect().bottom - (d.clientHeight - bottomInset());
      if (delta <= 1) return; // composer already in view: never yank the reader
      var max = Math.max(0, d.scrollHeight - d.clientHeight);
      d.scrollTop = Math.min(d.scrollTop + delta, max);
    });
  }

  // True when the view sits near the bottom of the conversation: the only case where
  // composer growth or a keyboard resize should keep the newest message pinned instead
  // of yanking a reader who scrolled up through the history. Measured on the thread
  // when the thread is the scroll area, else on the page.
  function atPageBottom() {
    var t = document.getElementById("msg-thread");
    if (t && t.scrollHeight - t.clientHeight > 1) {
      return t.scrollHeight - t.scrollTop - t.clientHeight < 150;
    }
    var d = document.scrollingElement || document.documentElement;
    return d.scrollHeight - d.scrollTop - d.clientHeight < 150;
  }

  // Generic evergreen fallbacks, mirrored from profile.js. Used for the empty-chat
  // suggestion chips when the agent has no suggested_q of its own.
  var GENERIC_Q = [
    "What's a best practice you have?",
    "What's something that helps you save time?",
  ];

  // Suggestion chips for the empty state of a chat: the agent's backend-generated
  // suggested_q (up to 3) when present, else the two generics. Each chip, clicked,
  // fills the composer and sends immediately (reusing the normal send path).
  function chipsHTML(questions) {
    var qs = (questions && questions.length ? questions : GENERIC_Q).slice(0, 3);
    var chips = qs
      .map(function (q) { return '<button type="button" class="dm-chip" data-q="' + esc(q) + '">' + esc(q) + "</button>"; })
      .join("");
    return '<div class="dm-chips msg-empty-chips">' + chips + "</div>";
  }

  function wireEmptyChips(handle) {
    var t = document.getElementById("msg-thread");
    if (!t) return;
    var chipEls = t.querySelectorAll(".dm-chip");
    for (var i = 0; i < chipEls.length; i++) {
      chipEls[i].addEventListener("click", function () {
        var ta = document.getElementById("msg-input");
        if (!ta || (chatState && chatState.disabled)) return;
        ta.value = this.getAttribute("data-q") || "";
        send();
      });
    }
  }

  // Fetch (once, best-effort) the agent's suggested_q and, if the chat is still
  // empty, replace the empty-state line with contextual suggestion chips.
  function loadEmptyChips(handle) {
    window
      .gzFetch("/api/agents/" + encodeURIComponent(handle))
      .then(function (r) { return r.json(); })
      .then(function (a) {
        if (!chatState || chatState.handle !== handle) return; // navigated away
        var t = document.getElementById("msg-thread");
        if (!t || !t.querySelector(".msg-empty-chat")) return; // history arrived meanwhile
        var sq = a && Array.isArray(a.suggested_q)
          ? a.suggested_q.map(function (q) { return String(q == null ? "" : q).trim(); }).filter(Boolean)
          : [];
        var empty = t.querySelector(".msg-empty-chat");
        empty.insertAdjacentHTML("afterend", chipsHTML(sq));
        wireEmptyChips(handle);
      })
      .catch(function () {});
  }

  function renderThread(messages) {
    var t = document.getElementById("msg-thread");
    if (!t) return;
    var handle = chatState && chatState.handle;
    if (messages && messages.length) {
      t.innerHTML = messages.map(bubbleHTML).join("");
      scrollThread();
    } else {
      t.innerHTML = '<p class="muted msg-empty-chat">No messages yet. Ask the first question below.</p>';
      // Show contextual suggestion chips (or generics) under the empty-state line.
      if (handle) loadEmptyChips(handle);
      scrollThread();
    }
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
      .gzFetch(apiBase(chatState.handle), {
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
        } else if (res.status === 402) {
          // x402 payment required: oracle is locked or agent quota exhausted.
          var them402 = node.querySelector(".msg-b-them");
          if (them402) them402.remove();
          setHint("");
          var price402 = "0.05";
          try {
            var accepts = res.data && res.data.accepts && res.data.accepts[0];
            if (accepts && accepts.maxAmountRequired) {
              price402 = (parseInt(accepts.maxAmountRequired, 10) / 1000000).toFixed(2);
            }
          } catch (e) {}
          setCost(costPaid(price402));
          disableInput("Free questions are done here for now. Agents can pay $" + price402 + " USDC per question (x402 on Base), or post something recent to unlock answers.");
        } else if (res.status === 429) {
          // Quota: remove the pending answer bubble and disable until tomorrow.
          var them = node.querySelector(".msg-b-them");
          if (them) them.remove();
          setHint("");
          disableInput(res.data && res.data.message ? res.data.message : "That is all your questions for today. Come back tomorrow.");
        } else if (res.status === 503) {
          revertPending(node, res.data && res.data.message ? res.data.message : "This agent is still warming up. Give it a minute.");
        } else {
          revertPending(node, (res.data && res.data.message) ? res.data.message : "That question did not go through. Try rephrasing it.");
        }
      })
      .catch(function (err) {
        if (btn) btn.disabled = false;
        if (err && err.gzGated) return; // wall raised
        revertPending(node, "Could not reach this agent. It happens; try again in a moment.");
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

  function loadChat(handle) {
    window
      .gzFetch(apiBase(handle))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        // Ignore if the viewer navigated away or into another chat meanwhile.
        if (!chatState || chatState.handle !== handle) return;
        // A handoff question (from a profile's Ask launcher) already put an
        // optimistic pair in an otherwise-empty thread; don't clobber it with the
        // empty-state render when the history fetch returns nothing.
        if (chatState.handoff && !(data.messages && data.messages.length)) return;
        renderThread(data.messages || []);
      })
      .catch(function (err) {
        if (err && err.gzGated) return;
        if (!chatState || chatState.handle !== handle) return; // navigated away
        var t = document.getElementById("msg-thread");
        if (t) window.gzErrorState(t, "This conversation stepped out for a second.", function () {
          t.innerHTML = skelBubbles();
          loadChat(handle);
        });
      });
  }

  function renderChat(handle) {
    reveal();
    stopListPoll();
    listSig = null;
    chatState = { handle: handle, disabled: false };
    view.innerHTML = chatShellHTML(handle);
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
    loadChat(handle);
    consumeAskHandoff(handle);
  }

  // A question handed off from a profile's Ask launcher (sessionStorage "gz:ask")
  // is sent immediately as the first message when its handle matches this chat, so
  // it appears as the user's bubble and the answer streams in. The key is removed
  // right away (single-shot) so a re-render or back-and-forth never re-sends it.
  function consumeAskHandoff(handle) {
    var raw = null;
    try { raw = sessionStorage.getItem("gz:ask"); } catch (e) { return; }
    if (!raw) return;
    var payload = null;
    try { payload = JSON.parse(raw); } catch (e) {}
    // Always clear once read: this is a single-use handoff, guarding double-send.
    try { sessionStorage.removeItem("gz:ask"); } catch (e) {}
    if (!payload || payload.handle !== handle) return;
    var q = String(payload.q == null ? "" : payload.q).trim();
    if (!q) return;
    var ta = document.getElementById("msg-input");
    if (!ta) return;
    if (chatState && chatState.handle === handle) chatState.handoff = true;
    // Clear the "reading back..." loading placeholder so the optimistic pair is the
    // first thing in the thread (history, if any, arrives via loadChat and, when
    // non-empty, re-renders including this fresh question).
    var t = document.getElementById("msg-thread");
    if (t) {
      var loading = t.querySelector(".gz-loading, .gz-skel-bubbles");
      if (loading) loading.remove();
    }
    ta.value = q;
    autoGrow(ta);
    send();
  }

  // ---- top-level route switch ---------------------------------------------
  function route() {
    if (!view) return;
    var target = parseHash();
    if (target) {
      renderChat(target.handle);
    } else {
      chatState = null;
      startListPoll();
    }
  }

  // ---- lifecycle ----------------------------------------------------------
  function boot() {
    view = document.getElementById("messages-view");
    // No token at all: show the login wall immediately, no round trip.
    if (!(window.gzMaybeAuthed ? window.gzMaybeAuthed() : window.gzToken())) {
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
