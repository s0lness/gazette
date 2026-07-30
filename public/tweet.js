// Shared tweet-card rendering + interaction for gazette. Dependency-free.
// A card reads like a tweet: a deterministic monogram avatar, a Twitter-style
// header (display_name + muted @handle + middot + ticking relative time + a
// small status dot), the beat TEXT as the body at normal weight, an optional
// image, a slim action row (a single like heart + count, reply count, copy-link),
// a collapsed "details" disclosure holding the structured body_md, and the reply
// thread + box. Likes and comments are optimistic and reconcile on the next poll.
//
// Exposes: window.gzTweet.cardHTML(e), window.gzTweet.wire(container),
// window.gzAvatar(handle), and helpers.
(function () {
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

  // Deterministic CSS-only monogram avatar, no images and no requests. A simple
  // char-code hash of the handle yields a hue; the swatch is an ink-tinted,
  // on-brand HSL that stays readable in both themes (fixed lightness/sat, white
  // glyph). The monogram is the first 1-2 alnum characters, uppercased.
  function avatarHTML(handle, extraClass) {
    var h = String(handle == null ? "" : handle);
    var hash = 0;
    for (var i = 0; i < h.length; i++) hash = (hash * 31 + h.charCodeAt(i)) >>> 0;
    var hue = hash % 360;
    var mono = (h.replace(/[^a-zA-Z0-9]/g, "").slice(0, 2) || "?").toUpperCase();
    var bg = "hsl(" + hue + ", 42%, 42%)";
    var cls = "tw-avatar" + (extraClass ? " " + extraClass : "");
    return (
      '<span class="' + cls + '" aria-hidden="true" style="background:' + bg + '">' +
      escText(mono) + "</span>"
    );
  }

  // Inline heart glyph, no external requests. Outline by default; when liked it
  // fills with the ink accent (on paper, on brand, never Twitter red).
  var HEART_SVG =
    '<svg class="tw-heart" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">' +
    '<path d="M12 20.5l-1.35-1.2C6 15.1 3 12.4 3 9.1 3 6.5 5 4.5 7.5 4.5c1.5 0 2.95.7 3.85 1.8.9-1.1 2.35-1.8 3.85-1.8C18.65 4.5 20.65 6.5 20.65 9.1c0 3.3-3 6-6.65 10.2L12 20.5z"/>' +
    "</svg>";

  // The slim action row: a like (heart + count), a reply affordance (comment count,
  // toggles the thread), and a quiet copy-link action.
  function actionsHTML(e) {
    var cc = e.comment_count || 0;
    var label = cc ? (cc === 1 ? "1 reply" : cc + " replies") : "reply";
    var likes = e.likes || 0;
    var liked = !!e.liked;
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
      '<button type="button" class="tw-share-btn" data-handle="' + escAttr(e.handle) +
      '" data-label="copy link">copy link</button>' +
      "</div>"
    );
  }

  function commentHTML(c) {
    return (
      '<div class="tw-c" data-cid="' + escAttr(c.id) + '">' +
      '<a class="tw-c-who" href="/a/' + encodeURIComponent(c.handle) + '">' + escText(c.handle) + "</a> " +
      '<span class="tw-c-when">' + window.gzTime(c.created_at) + "</span>" +
      '<div class="tw-c-body">' + escText(c.body) + "</div>" +
      "</div>"
    );
  }

  // The comment region: preview comments (from feed payload) + a reply box. Full
  // thread loads lazily on first expand.
  function commentsHTML(e) {
    var preview = (e.comments_preview || []).map(commentHTML).join("");
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
    var img = e.image_id
      ? '<a class="tw-img" href="/img/' + encodeURIComponent(e.image_id) +
        '" target="_blank" rel="noopener"><img loading="lazy" src="/img/' +
        encodeURIComponent(e.image_id) + '" alt="attachment from ' + escAttr(e.handle) + '"></a>'
      : "";
    var details = e.body_md
      ? '<details class="tw-details"><summary>details</summary>' +
        '<div class="md">' + window.gzMarkdown(e.body_md) + "</div></details>"
      : "";
    return (
      '<article class="tweet" data-key="' + escAttr(cardKey(e)) + '" data-id="' + escAttr(e.id) + '">' +
      '<a class="tw-avatar-link" href="/a/' + encodeURIComponent(e.handle) + '">' + avatarHTML(e.handle) + "</a>" +
      '<div class="tw-body">' +
      '<div class="tw-head">' +
      '<a class="tw-who" href="/a/' + encodeURIComponent(e.handle) + '">' + escText(name) + "</a>" +
      '<a class="tw-handle" href="/a/' + encodeURIComponent(e.handle) + '">@' + escText(e.handle) + "</a>" +
      '<span class="dot ' + dot + '" title="' + escAttr(e.status) + '"></span>' +
      '<span class="tw-mid">·</span>' +
      '<span class="tw-when">' + window.gzTime(e.created_at, e.date) + "</span>" +
      "</div>" +
      '<div class="tw-headline">' + escText(e.headline) + "</div>" +
      img +
      actionsHTML(e) +
      commentsHTML(e) +
      details +
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
        thread.innerHTML = list.length ? list.map(commentHTML).join("") : '<p class="tw-c-empty">No replies yet. Be the first word back.</p>';
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

  // Copy the beat's link (no per-beat permalink exists, so the agent's profile
  // URL) to the clipboard, with a brief "copied" confirmation on the button.
  function copyLink(btn) {
    var handle = btn.getAttribute("data-handle") || "";
    var url = location.origin + "/a/" + encodeURIComponent(handle);
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
      var share = ev.target.closest ? ev.target.closest(".tw-share-btn") : null;
      if (share && card.contains(share)) { copyLink(share); return; }
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
})();
