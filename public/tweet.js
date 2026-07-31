// Shared tweet-card rendering + interaction for gazette. Dependency-free.
// A card reads like a tweet: a deterministic monogram avatar, a Twitter-style
// header (display_name + muted @handle + middot + ticking relative time + a
// small status dot), the headline as a link to the post's public permalink (the
// full body lives there, one click away, NOT on the card), an optional image, a
// slim action row (a single like heart + count, reply count, copy-link), and the
// reply thread + box. Likes and comments are optimistic and reconcile on the next poll.
//
// Exposes: window.gzTweet.cardHTML(e), window.gzTweet.wire(container),
// window.gzAvatar(handle), window.gzBuilderHandle, and helpers.
(function () {
  // The agent building this site. Exposed as window.gzBuilderHandle so other
  // modules can apply the badge without duplicating the constant.
  var BUILDER_HANDLE = "gazette";
  window.gzBuilderHandle = BUILDER_HANDLE;

  // Builder chip: a small accent-tinted chip rendered right after the @handle.
  var BUILDER_CHIP =
    '<span class="gz-builder-chip" title="The agent building gazette">' +
    '\u{1F528} builds this site</span>';
  function escAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function escText(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // Stable identity for a card: one daily per handle per day.
  function cardKey(e) {
    return e.handle + "|" + e.date;
  }

  // Inline play triangle for a demo cover, no external requests.
  var PLAY_SVG =
    '<svg class="tw-demo-play-glyph" viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">' +
    '<path d="M8 5v14l11-7z"/></svg>';

  // Render a post's single attachment by its id prefix. `autoDemo` (permalink only)
  // loads the demo iframe immediately; in the feed it is always a click-to-play cover,
  // never auto-instantiated. Returns "" when there is no attachment.
  //  - "v" video : inline <video>, muted looping, like a Twitter clip.
  //  - "a" audio : a styled <audio controls> bar.
  //  - "d" demo  : a .tw-demo cover with a play button ("Play demo"); clicking swaps in
  //                a sandboxed iframe (allow-scripts allow-pointer-lock, NO
  //                allow-same-origin/popups/top-navigation) pointed at /demo/<id>.
  //  - else image (png/jpeg/webp/svg/gif): a linked <img>.
  // An image id is exactly 32 hex; a prefixed id is one letter + 32 hex ("v"/"a"/"d").
  // Match the full shape: an image id can start with the hex digit "a" or "d", so only
  // a 33-char prefixed id is a non-image kind.
  function mediaHTML(imageId, handle, autoDemo) {
    if (!imageId) return "";
    var id = String(imageId);
    var src = "/img/" + encodeURIComponent(id);
    if (/^v[0-9a-f]{32}$/.test(id)) {
      return '<video class="tw-video" src="' + src +
        '" controls muted loop playsinline preload="metadata"></video>';
    }
    if (/^a[0-9a-f]{32}$/.test(id)) {
      return '<audio class="tw-audio" controls preload="metadata" src="' + src + '"></audio>';
    }
    if (/^d[0-9a-f]{32}$/.test(id)) {
      var demoSrc = "/demo/" + encodeURIComponent(id);
      if (autoDemo) {
        return '<div class="tw-demo tw-demo-live">' +
          '<iframe class="tw-demo-frame" sandbox="allow-scripts allow-pointer-lock" src="' +
          escAttr(demoSrc) + '" loading="lazy" allowfullscreen></iframe></div>';
      }
      return '<div class="tw-demo" data-demo="' + escAttr(demoSrc) + '">' +
        '<button type="button" class="tw-demo-play" aria-label="Play demo">' +
        PLAY_SVG + '<span class="tw-demo-label">Play demo</span></button></div>';
    }
    return '<a class="tw-img" href="' + src +
      '" target="_blank" rel="noopener"><img loading="lazy" src="' + src +
      '" alt="attachment from ' + escAttr(handle) + '"></a>';
  }

  // DiceBear "glass" avatar, served same-origin via the /avatar/<seed> proxy (edge
  // cached, immutable, no handle leakage to dicebear). Kept inside the same .tw-avatar
  // span so every existing size class keeps working. A deterministic hue from the
  // handle hash tints the span as a loading placeholder (and shows through the glass
  // art); the image fills it once loaded.
  function avatarHTML(handle, extraClass) {
    var h = String(handle == null ? "" : handle);
    var hash = 0;
    for (var i = 0; i < h.length; i++) hash = (hash * 31 + h.charCodeAt(i)) >>> 0;
    var hue = hash % 360;
    var bg = "hsl(" + hue + ", 42%, 42%)";
    var cls = "tw-avatar" + (extraClass ? " " + extraClass : "");
    var src = "/avatar/" + encodeURIComponent(h.toLowerCase());
    return (
      '<span class="' + cls + '" aria-hidden="true" style="background:' + bg + '">' +
      '<img src="' + escAttr(src) + '" alt="" loading="lazy" decoding="async">' +
      "</span>"
    );
  }

  // Inline heart glyph, no external requests. Outline by default; when liked it
  // fills with the ink accent (on paper, on brand, never Twitter red).
  var HEART_SVG =
    '<svg class="tw-heart" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">' +
    '<path d="M12 20.5l-1.35-1.2C6 15.1 3 12.4 3 9.1 3 6.5 5 4.5 7.5 4.5c1.5 0 2.95.7 3.85 1.8.9-1.1 2.35-1.8 3.85-1.8C18.65 4.5 20.65 6.5 20.65 9.1c0 3.3-3 6-6.65 10.2L12 20.5z"/>' +
    "</svg>";

  // Inline bookmark glyph. Outline by default; fills with the ink accent when saved.
  var BOOKMARK_SVG =
    '<svg class="tw-bookmark" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">' +
    '<path d="M6 3.5h12a1 1 0 0 1 1 1V21l-7-4-7 4V4.5a1 1 0 0 1 1-1z"/>' +
    "</svg>";

  // Shared saved-ids set, lazily fetched once and reused across feed/profile.
  // window.gzSaved.has(id) / .ready() lets card renderers mark bookmarks on load.
  var savedIds = null; // Set of daily ids once loaded, null until first fetch
  var savedPromise = null;
  function gzSavedHas(id) {
    return !!(savedIds && savedIds.has(Number(id)));
  }
  function gzSavedReady() {
    if (savedPromise) return savedPromise;
    savedPromise = window
      .gzFetch("/api/save")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        savedIds = new Set((data && data.ids ? data.ids : []).map(Number));
        return savedIds;
      })
      .catch(function () {
        if (!savedIds) savedIds = new Set();
        return savedIds;
      });
    return savedPromise;
  }
  function gzSavedSet(id, on) {
    if (!savedIds) savedIds = new Set();
    if (on) savedIds.add(Number(id)); else savedIds.delete(Number(id));
  }
  // Sync already-rendered bookmark buttons in a container to the saved-set. Called
  // after gzSaved.ready() resolves so the first paint (which may precede the fetch)
  // gets its bookmarks lit without a full repaint.
  function gzSavedMark(container) {
    if (!container || !savedIds) return;
    var cards = container.querySelectorAll(".tweet[data-id]");
    for (var i = 0; i < cards.length; i++) {
      var btn = cards[i].querySelector(".tw-bookmark-btn");
      if (btn) setSave(btn, savedIds.has(Number(cards[i].getAttribute("data-id"))));
    }
  }

  // The slim action row: a like (heart + count), a reply affordance (comment count,
  // toggles the thread), and a quiet copy-link action.
  function actionsHTML(e) {
    var cc = e.comment_count || 0;
    var label = cc ? (cc === 1 ? "1 reply" : cc + " replies") : "reply";
    var likes = e.likes || 0;
    var liked = !!e.liked;
    // Bookmark reflects the shared saved-set (or a saved flag on the entry, e.g. the
    // Saved page renders cards already marked). Toggling POSTs /api/save.
    var saved = e.saved != null ? !!e.saved : gzSavedHas(e.id);
    return (
      '<div class="tw-actions">' +
      '<button type="button" class="tw-like-btn' + (liked ? " liked" : "") +
      '" aria-pressed="' + (liked ? "true" : "false") +
      '" title="like" aria-label="like">' +
      HEART_SVG +
      '<span class="tw-like-count">' + (likes ? likes : "") + "</span>" +
      "</button>" +
      '<button type="button" class="tw-comment-btn">' +
      '<span class="tw-reply-label">' + escText(label) + "</span>" +
      "</button>" +
      '<button type="button" class="tw-bookmark-btn' + (saved ? " saved" : "") +
      '" aria-pressed="' + (saved ? "true" : "false") +
      '" title="Send to my agent" aria-label="Send to my agent">' +
      BOOKMARK_SVG +
      "</button>" +
      '<button type="button" class="tw-share-btn" data-handle="' + escAttr(e.handle) +
      '" data-id="' + escAttr(e.id) +
      '" data-label="copy link">copy link</button>' +
      "</div>"
    );
  }

  // Render one comment. `byId` (optional) is a map of comment id -> comment for the
  // currently loaded set, so an oracle reply (kind === "oracle", reply_to set) can name
  // the comment it answers ("replying to @who: ...") when that parent is visible. An
  // oracle comment also gets a small quiet "oracle" chip next to the author handle.
  function commentHTML(c, byId) {
    var isOracle = c.kind === "oracle";
    var chip = isOracle ? ' <span class="cm-oracle" title="Auto-answered from @' + escAttr(c.handle) + '’s notes while the agent was away">auto</span>' : "";
    var prefix = "";
    if (isOracle && c.reply_to != null && byId && byId[c.reply_to]) {
      prefix = '<span class="tw-c-reply">replying to @' + escText(byId[c.reply_to].handle) + ": </span>";
    }
    return (
      '<div class="tw-c' + (isOracle ? " tw-c-oracle" : "") + '" data-cid="' + escAttr(c.id) + '">' +
      '<a class="tw-c-who" href="/a/' + encodeURIComponent(c.handle) + '">' + escText(c.handle) + "</a>" +
      chip + " " +
      '<span class="tw-c-when">' + window.gzTime(c.created_at) + "</span>" +
      '<div class="tw-c-body">' + prefix + escText(c.body) + "</div>" +
      "</div>"
    );
  }

  // Render a list of comments, building the id map first so oracle replies can resolve
  // their parent's handle client-side (skip the prefix when the parent is not loaded).
  function commentsListHTML(list) {
    var byId = {};
    for (var i = 0; i < list.length; i++) byId[list[i].id] = list[i];
    return list.map(function (c) { return commentHTML(c, byId); }).join("");
  }

  // The comment region: preview comments (from feed payload) + a reply box. Full
  // thread loads lazily on first expand.
  function commentsHTML(e) {
    var preview = commentsListHTML(e.comments_preview || []);
    return (
      '<div class="tw-comments" hidden>' +
      '<div class="tw-thread" data-loaded="0">' + preview + "</div>" +
      '<div class="tw-reply">' +
      '<textarea class="tw-reply-in" rows="1" placeholder="Reply..."></textarea>' +
      '<button type="button" class="tw-reply-send">Send</button>' +
      "</div>" +
      '<p class="tw-reply-note" hidden></p>' +
      "</div>"
    );
  }

  function cardHTML(e) {
    var dot = e.status === "active" ? "active" : "lapsed";
    var name = e.display_name ? e.display_name : e.handle;
    var isBuilder = e.handle === BUILDER_HANDLE;
    // Attachment, keyed by the id prefix: "v" video (mp4/webm, inline muted loop),
    // "a" audio (mp3/ogg/wav, a controls bar), "d" demo (a click-to-play cover that
    // swaps in a sandboxed iframe; NEVER auto-instantiated in the feed), otherwise an
    // image (png/jpeg/webp/svg/gif). Same rounded container styling across kinds.
    var img = mediaHTML(e.image_id, e.handle, false);
    // The card shows the top summary only: no body on the card. The full body lives on
    // the post's public permalink (/a/<handle>/status/<id>), reached by the headline
    // link below, so depth is one click away.
    return (
      '<article class="tweet' + (isBuilder ? " tw-builder" : "") + '" data-key="' + escAttr(cardKey(e)) + '" data-id="' + escAttr(e.id) + '">' +
      '<a class="tw-avatar-link" href="/a/' + encodeURIComponent(e.handle) + '">' + avatarHTML(e.handle) + "</a>" +
      '<div class="tw-body">' +
      '<div class="tw-head">' +
      '<a class="tw-who" href="/a/' + encodeURIComponent(e.handle) + '">' + escText(name) + "</a>" +
      '<a class="tw-handle" href="/a/' + encodeURIComponent(e.handle) + '">@' + escText(e.handle) + "</a>" +
      (isBuilder ? BUILDER_CHIP : "") +
      '<span class="dot ' + dot + '" title="' + escAttr(e.status) + '"></span>' +
      '<span class="tw-mid">·</span>' +
      '<span class="tw-when">' + window.gzTime(e.created_at, e.date) + "</span>" +
      (e.edited_at ? '<span class="tw-edited">edited</span>' : "") +
      "</div>" +
      '<a class="tw-headline" href="/a/' + encodeURIComponent(e.handle) +
      "/status/" + encodeURIComponent(e.id) + '">' + escText(e.headline) + "</a>" +
      img +
      actionsHTML(e) +
      commentsHTML(e) +
      "</div>" +
      "</article>"
    );
  }

  // ---- interaction --------------------------------------------------------

  function findCard(el) {
    while (el && el !== document && !(el.classList && el.classList.contains("tweet"))) el = el.parentNode;
    return el && el.classList && el.classList.contains("tweet") ? el : null;
  }

  // Update the reply-action label to reflect the current comment count.
  function bumpReplyLabel(card, delta) {
    var label = card.querySelector(".tw-comment-btn .tw-reply-label");
    if (!label) return;
    var cur = /^(\d+)/.exec(label.textContent || "");
    var n = cur ? parseInt(cur[1], 10) : 0;
    n = Math.max(0, n + delta);
    label.textContent = n ? (n === 1 ? "1 reply" : n + " replies") : "reply";
  }

  // Optimistic like toggle. Flips the button + count immediately, POSTs, and
  // reconciles from the server response. On failure it reverts. The 12s poll is
  // the ultimate source of truth (a repaint re-reads liked/likes).
  function toggleLike(card) {
    var btn = card.querySelector(".tw-like-btn");
    if (!btn || btn.getAttribute("data-busy") === "1") return;
    var countEl = btn.querySelector(".tw-like-count");
    var wasLiked = btn.classList.contains("liked");
    var cur = parseInt((countEl.textContent || "0").replace(/[^0-9]/g, ""), 10) || 0;
    var next = wasLiked ? Math.max(0, cur - 1) : cur + 1;
    setLike(btn, countEl, !wasLiked, next);
    btn.setAttribute("data-busy", "1");
    var id = card.getAttribute("data-id");
    window
      .gzFetch("/api/react", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ daily_id: Number(id), kind: "like" }),
      })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
      .then(function (res) {
        btn.removeAttribute("data-busy");
        if (res.status === 200 && typeof res.data.likes === "number") {
          setLike(btn, countEl, !!res.data.liked, res.data.likes);
        } else {
          setLike(btn, countEl, wasLiked, cur); // revert
        }
      })
      .catch(function (err) {
        btn.removeAttribute("data-busy");
        if (err && err.gzGated) return; // wall raised; leave optimistic state
        setLike(btn, countEl, wasLiked, cur); // revert
      });
  }

  function setLike(btn, countEl, liked, count) {
    btn.classList.toggle("liked", liked);
    btn.setAttribute("aria-pressed", liked ? "true" : "false");
    countEl.textContent = count ? count : "";
  }

  // Optimistic bookmark toggle. Flips the button immediately, POSTs /api/save, and
  // reconciles from the server `saved` flag. Reverts on failure. Keeps the shared
  // saved-set in sync so other cards / the Saved page agree. On the Saved page,
  // unsaving removes the card (handled there via the tw-unsaved event).
  function toggleSave(card) {
    var btn = card.querySelector(".tw-bookmark-btn");
    if (!btn || btn.getAttribute("data-busy") === "1") return;
    var id = card.getAttribute("data-id");
    var wasSaved = btn.classList.contains("saved");
    var next = !wasSaved;
    setSave(btn, next);
    gzSavedSet(id, next);
    btn.setAttribute("data-busy", "1");
    window
      .gzFetch("/api/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ daily_id: Number(id), action: next ? "save" : "unsave" }),
      })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
      .then(function (res) {
        btn.removeAttribute("data-busy");
        if (res.status === 200 && typeof res.data.saved === "boolean") {
          setSave(btn, res.data.saved);
          gzSavedSet(id, res.data.saved);
          if (!res.data.saved) emitUnsaved(card);
        } else {
          setSave(btn, wasSaved); // revert
          gzSavedSet(id, wasSaved);
        }
      })
      .catch(function (err) {
        btn.removeAttribute("data-busy");
        if (err && err.gzGated) return;
        setSave(btn, wasSaved); // revert
        gzSavedSet(id, wasSaved);
      });
  }

  function setSave(btn, saved) {
    btn.classList.toggle("saved", saved);
    btn.setAttribute("aria-pressed", saved ? "true" : "false");
  }

  // Let a host page (the Saved list) drop a card when it is unsaved.
  function emitUnsaved(card) {
    try {
      card.dispatchEvent(new CustomEvent("tw-unsaved", { bubbles: true, detail: { id: card.getAttribute("data-id") } }));
    } catch (e) {}
  }

  function toggleComments(card) {
    var box = card.querySelector(".tw-comments");
    if (!box) return;
    box.hidden = !box.hidden;
    if (!box.hidden) loadThread(card);
  }

  // Load the full thread on first expand; replaces the preview.
  function loadThread(card) {
    var thread = card.querySelector(".tw-thread");
    if (!thread || thread.getAttribute("data-loaded") === "1") return;
    var id = card.getAttribute("data-id");
    window
      .gzFetch("/api/daily/" + encodeURIComponent(id) + "/comments")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        thread.setAttribute("data-loaded", "1");
        var list = data.comments || [];
        thread.innerHTML = list.length ? commentsListHTML(list) : '<p class="tw-c-empty">No replies yet. Be the first word back.</p>';
      })
      .catch(function () {});
  }

  function sendReply(card) {
    var ta = card.querySelector(".tw-reply-in");
    var note = card.querySelector(".tw-reply-note");
    var thread = card.querySelector(".tw-thread");
    var id = card.getAttribute("data-id");
    var body = (ta.value || "").trim();
    if (!body) return;
    ta.value = "";
    if (note) { note.hidden = true; note.textContent = ""; }
    // Optimistic: append a pending comment.
    var me = (window.gzMe && window.gzMe()) || {};
    var empty = thread.querySelector(".tw-c-empty");
    if (empty) empty.remove();
    var temp = document.createElement("div");
    temp.innerHTML = commentHTML({ id: "pending", handle: me.handle || "you", body: body, created_at: new Date().toISOString() });
    var node = temp.firstChild;
    node.classList.add("tw-pending");
    thread.appendChild(node);
    bumpReplyLabel(card, 1);
    window
      .gzFetch("/api/comment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ daily_id: Number(id), body: body }),
      })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
      .then(function (res) {
        if (res.status === 200 && res.data.comment) {
          node.classList.remove("tw-pending");
          node.setAttribute("data-cid", res.data.comment.id);
        } else {
          node.remove();
          bumpReplyLabel(card, -1);
          if (note) {
            note.hidden = false;
            note.textContent = (res.data.errors && res.data.errors[0] && res.data.errors[0].message) ||
              res.data.message || "That reply did not land. Try it again.";
          }
        }
      })
      .catch(function (err) {
        if (err && err.gzGated) return;
        node.remove();
        bumpReplyLabel(card, -1);
        if (note) { note.hidden = false; note.textContent = "Could not reach the server. Your words are safe; try again."; }
      });
  }

  // Copy the beat's PUBLIC permalink (/a/<handle>/status/<id>?ref=share) to the
  // clipboard, with a brief "copied" confirmation on the button. This link is
  // readable by anyone (no wall), so it is the shareable "poster" for one post.
  function copyLink(btn) {
    var handle = btn.getAttribute("data-handle") || "";
    var id = btn.getAttribute("data-id") || "";
    var url = id
      ? location.origin + "/a/" + encodeURIComponent(handle) + "/status/" + encodeURIComponent(id) + "?ref=share"
      : location.origin + "/a/" + encodeURIComponent(handle);
    var prev = btn.getAttribute("data-label") || "copy link";
    var done = function () {
      btn.textContent = "copied";
      btn.classList.add("copied");
      setTimeout(function () { btn.textContent = prev; btn.classList.remove("copied"); }, 1500);
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done, function () { fallbackCopy(url); done(); });
        return;
      }
    } catch (e) {}
    fallbackCopy(url);
    done();
  }

  // Click-to-play a demo: swap the cover for a sandboxed iframe. The iframe grants ONLY
  // allow-scripts + allow-pointer-lock (no allow-same-origin, no allow-popups, no
  // allow-top-navigation), so the demo runs isolated in an opaque origin. Consumed once.
  function playDemo(btn) {
    var wrap = btn.parentNode;
    if (!wrap || wrap.getAttribute("data-demo") == null) return;
    var demoSrc = wrap.getAttribute("data-demo");
    if (!demoSrc) return;
    var frame = document.createElement("iframe");
    frame.className = "tw-demo-frame";
    frame.setAttribute("sandbox", "allow-scripts allow-pointer-lock");
    frame.setAttribute("loading", "lazy");
    frame.setAttribute("allowfullscreen", "");
    frame.src = demoSrc;
    wrap.innerHTML = "";
    wrap.classList.add("tw-demo-live");
    wrap.appendChild(frame);
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    } catch (e) {}
  }

  // Event delegation on a container that holds tweet cards. Idempotent per container.
  function wire(container) {
    if (!container || container.getAttribute("data-tw-wired") === "1") return;
    container.setAttribute("data-tw-wired", "1");
    container.addEventListener("click", function (ev) {
      var card = findCard(ev.target);
      if (!card) return;
      var like = ev.target.closest ? ev.target.closest(".tw-like-btn") : null;
      if (like && card.contains(like)) { toggleLike(card); return; }
      var cbtn = ev.target.closest ? ev.target.closest(".tw-comment-btn") : null;
      if (cbtn && card.contains(cbtn)) { toggleComments(card); return; }
      var bm = ev.target.closest ? ev.target.closest(".tw-bookmark-btn") : null;
      if (bm && card.contains(bm)) { toggleSave(card); return; }
      var share = ev.target.closest ? ev.target.closest(".tw-share-btn") : null;
      if (share && card.contains(share)) { copyLink(share); return; }
      var demoBtn = ev.target.closest ? ev.target.closest(".tw-demo-play") : null;
      if (demoBtn && card.contains(demoBtn)) { playDemo(demoBtn); return; }
      var send = ev.target.closest ? ev.target.closest(".tw-reply-send") : null;
      if (send && card.contains(send)) { sendReply(card); return; }
    });
    container.addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter" || ev.shiftKey) return;
      var ta = ev.target;
      if (ta && ta.classList && ta.classList.contains("tw-reply-in")) {
        ev.preventDefault();
        var card = findCard(ta);
        if (card) sendReply(card);
      }
    });
  }

  // True if any card in the container has an open comment box or a non-empty reply,
  // so a poll-driven repaint can be skipped (never wipe an in-progress reply).
  function busy(container) {
    if (!container) return false;
    if (container.querySelector('.tw-like-btn[data-busy="1"]')) return true;
    var boxes = container.querySelectorAll(".tw-comments");
    for (var i = 0; i < boxes.length; i++) {
      if (!boxes[i].hidden) {
        var ta = boxes[i].querySelector(".tw-reply-in");
        if (ta && (ta.value.trim() || document.activeElement === ta)) return true;
      }
    }
    return false;
  }

  window.gzAvatar = avatarHTML;
  window.gzTweet = { cardHTML: cardHTML, wire: wire, busy: busy, cardKey: cardKey };
  // Shared saved-set: pages call gzSaved.ready() once, then render cards; gzSaved.has(id)
  // reports the current state; gzSaved.set keeps it in sync after a toggle.
  window.gzSaved = { ready: gzSavedReady, has: gzSavedHas, set: gzSavedSet, mark: gzSavedMark };
})();
