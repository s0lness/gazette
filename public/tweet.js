// Shared tweet-card rendering + interaction for gazette. Dependency-free.
// A card = handle + status dot + relative time, a prominent HEADLINE, an optional
// image, an action bar (3 reactions + comment toggle), and a collapsed "details"
// disclosure holding the structured body_md. Comments expand a flat thread with a
// reply box. Reactions and comments are optimistic and reconcile on the next poll.
//
// Exposes: window.gzTweet.cardHTML(e), window.gzTweet.wire(container), and helpers.
(function () {
  var REACTIONS = [
    { kind: "ship", label: "ship", glyph: "\u{1F6A2}" },
    { kind: "fire", label: "fire", glyph: "\u{1F525}" },
    { kind: "eyes", label: "eyes", glyph: "\u{1F440}" },
  ];

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

  function reactionBarHTML(e) {
    var mine = e.my_reactions || [];
    var counts = e.reactions || {};
    var btns = REACTIONS.map(function (r) {
      var on = mine.indexOf(r.kind) !== -1;
      var n = counts[r.kind] || 0;
      return (
        '<button type="button" class="tw-react' + (on ? " on" : "") + '" data-kind="' + r.kind +
        '" title="' + r.label + '" aria-pressed="' + (on ? "true" : "false") + '">' +
        '<span class="tw-glyph">' + r.glyph + "</span>" +
        '<span class="tw-count"' + (n ? "" : ' hidden') + ">" + n + "</span>" +
        "</button>"
      );
    }).join("");
    var cc = e.comment_count || 0;
    btns +=
      '<button type="button" class="tw-comment-btn" title="comments">' +
      '<span class="tw-glyph">\u{1F4AC}</span>' +
      '<span class="tw-count"' + (cc ? "" : ' hidden') + ">" + cc + "</span>" +
      "</button>";
    return '<div class="tw-actions">' + btns + "</div>";
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
      '<div class="tw-head">' +
      '<span class="dot ' + dot + '" title="' + escAttr(e.status) + '"></span>' +
      '<a class="tw-who" href="/a/' + encodeURIComponent(e.handle) + '">' + escText(name) + "</a>" +
      '<span class="tw-when">' + window.gzTime(e.created_at, e.date) + "</span>" +
      "</div>" +
      '<div class="tw-headline">' + escText(e.headline) + "</div>" +
      img +
      reactionBarHTML(e) +
      commentsHTML(e) +
      details +
      "</article>"
    );
  }

  // ---- interaction --------------------------------------------------------

  function findCard(el) {
    while (el && el !== document && !(el.classList && el.classList.contains("tweet"))) el = el.parentNode;
    return el && el.classList && el.classList.contains("tweet") ? el : null;
  }

  function bumpCount(span, delta) {
    var n = parseInt(span.textContent || "0", 10) || 0;
    n = Math.max(0, n + delta);
    span.textContent = n;
    span.hidden = n === 0;
  }

  // Optimistic reaction toggle, POST /api/react, reconcile from the response.
  function toggleReaction(card, btn) {
    var id = card.getAttribute("data-id");
    var kind = btn.getAttribute("data-kind");
    var on = btn.classList.contains("on");
    btn.classList.toggle("on");
    btn.setAttribute("aria-pressed", on ? "false" : "true");
    bumpCount(btn.querySelector(".tw-count"), on ? -1 : 1);
    window
      .gzFetch("/api/react", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ daily_id: Number(id), kind: kind }),
      })
      .then(function (r) { return r.json(); })
      .then(function (data) { reconcileReactions(card, data); })
      .catch(function () {});
  }

  // Apply authoritative counts + mine from a react response.
  function reconcileReactions(card, data) {
    if (!data || !data.reactions) return;
    var mine = data.my_reactions || [];
    REACTIONS.forEach(function (r) {
      var b = card.querySelector('.tw-react[data-kind="' + r.kind + '"]');
      if (!b) return;
      var on = mine.indexOf(r.kind) !== -1;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
      var span = b.querySelector(".tw-count");
      var n = data.reactions[r.kind] || 0;
      span.textContent = n;
      span.hidden = n === 0;
    });
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
        thread.innerHTML = list.length ? list.map(commentHTML).join("") : '<p class="tw-c-empty">No comments yet.</p>';
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
    var cbtn = card.querySelector(".tw-comment-btn .tw-count");
    if (cbtn) bumpCount(cbtn, 1);
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
          if (cbtn) bumpCount(cbtn, -1);
          if (note) {
            note.hidden = false;
            note.textContent = (res.data.errors && res.data.errors[0] && res.data.errors[0].message) ||
              res.data.message || "Could not post the comment.";
          }
        }
      })
      .catch(function (err) {
        if (err && err.gzGated) return;
        node.remove();
        if (cbtn) bumpCount(cbtn, -1);
        if (note) { note.hidden = false; note.textContent = "Could not reach the server."; }
      });
  }

  // Event delegation on a container that holds tweet cards. Idempotent per container.
  function wire(container) {
    if (!container || container.getAttribute("data-tw-wired") === "1") return;
    container.setAttribute("data-tw-wired", "1");
    container.addEventListener("click", function (ev) {
      var card = findCard(ev.target);
      if (!card) return;
      var react = ev.target.closest ? ev.target.closest(".tw-react") : null;
      if (react && card.contains(react)) { toggleReaction(card, react); return; }
      var cbtn = ev.target.closest ? ev.target.closest(".tw-comment-btn") : null;
      if (cbtn && card.contains(cbtn)) { toggleComments(card); return; }
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
    var boxes = container.querySelectorAll(".tw-comments");
    for (var i = 0; i < boxes.length; i++) {
      if (!boxes[i].hidden) {
        var ta = boxes[i].querySelector(".tw-reply-in");
        if (ta && (ta.value.trim() || document.activeElement === ta)) return true;
      }
    }
    return false;
  }

  window.gzTweet = { cardHTML: cardHTML, wire: wire, busy: busy, cardKey: cardKey };
})();
