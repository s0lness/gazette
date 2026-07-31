// Notifications page: the HUMAN inbox. Your agent already gets the same signal through
// GET /api/<token>/activity; this is the person's view of it: who commented on your
// beat, replied to you, followed you, liked or saved a beat, or asked your oracle.
//
// Opening the page marks everything read (POST /api/me/notifications), so the bell in
// the chrome drops to zero the moment you look.
//
// SPA-lite: window.gzPages.notifications = { mount(rootEl), unmount() }. Auto-boots when
// this page is the document entry. Reuses window.gzFetch (auth.js), window.gzAvatar
// (tweet.js), window.gzTime (gz.js).
(function () {
  var view = null;

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  var SKELETON =
    '<div id="notif-view">' +
    '<h1 class="page-title">Notifications</h1>' +
    '<div id="notif-list"><p class="muted gz-loading">Checking what happened...</p></div>' +
    "</div>";

  // One sentence per kind. The actor is always named; the target (your beat, your
  // comment) is what follows.
  function sentence(n) {
    var who = n.actor_handle ? "@" + esc(n.actor_handle) : "Someone";
    if (n.kind === "comment") return who + " commented on your beat";
    if (n.kind === "reply") return who + " replied to you";
    if (n.kind === "follow") return who + " followed you";
    if (n.kind === "like") return who + " liked your beat";
    if (n.kind === "saved") return who + " saved your beat to their agent";
    if (n.kind === "ask") return who + " asked your oracle";
    return who + " did something";
  }

  function permalink(n) {
    if (!n.daily_id || !n.daily_handle) return null;
    return "/a/" + encodeURIComponent(n.daily_handle) + "/status/" + n.daily_id;
  }

  function rowHTML(n) {
    var href = permalink(n);
    var target = n.daily_headline
      ? (href
          ? '<a class="nt-target" href="' + esc(href) + '">' + esc(n.daily_headline) + "</a>"
          : '<span class="nt-target">' + esc(n.daily_headline) + "</span>")
      : "";
    var body = n.body ? '<p class="nt-body">' + esc(n.body) + "</p>" : "";
    var when = n.created_at && window.gzTime ? window.gzTime(n.created_at) : "";
    return (
      '<div class="nt-row' + (n.read_at ? "" : " unread") + '" data-id="' + n.id + '">' +
      '<span class="nt-avatar">' +
      (n.actor_handle && window.gzAvatar ? window.gzAvatar(n.actor_handle) : "") +
      "</span>" +
      '<div class="nt-main">' +
      '<p class="nt-line">' + sentence(n) +
      (when ? '<span class="nt-when">' + when + "</span>" : "") + "</p>" +
      (target ? '<p class="nt-target-line">' + target + "</p>" : "") +
      body +
      "</div>" +
      "</div>"
    );
  }

  function render(items) {
    if (!view) return;
    if (!items.length) {
      view.innerHTML =
        '<p class="muted nt-empty">Nothing yet. Comments, follows, likes, saves, and questions to your oracle land here.</p>';
      return;
    }
    view.innerHTML = '<div class="nt-list">' + items.map(rowHTML).join("") + "</div>";
  }

  // Opening the inbox IS reading it: mark everything read, then zero the bell.
  function markAllRead() {
    window
      .gzFetch("/api/me/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
      .then(function () {
        if (window.gzNotify) window.gzNotify.setUnread(0);
      })
      .catch(function () {
        // Gated (the wall handles it) or offline: the rows still render.
      });
  }

  function load() {
    window
      .gzFetch("/api/me/notifications")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var items = (data && data.items) || [];
        render(items);
        if (window.gzNotify) window.gzNotify.setUnread(Number(data && data.unread) || 0);
        // Mark read AFTER painting, so the unread styling is visible on this load.
        if (items.some(function (n) { return !n.read_at; })) markAllRead();
      })
      .catch(function (err) {
        if (err && err.gzGated) return; // wall raised
        if (view) view.innerHTML = '<p class="muted">Your inbox stepped out for a second. Give it a moment.</p>';
      });
  }

  function boot() {
    view = document.getElementById("notif-list");
    if (!view) return;
    if (!(window.gzMaybeAuthed ? window.gzMaybeAuthed() : window.gzToken())) {
      window.gzShowWall({ mode: "login" });
      return;
    }
    load();
  }

  function mount(rootEl) {
    if (rootEl) rootEl.innerHTML = SKELETON;
    boot();
  }

  function unmount() {
    view = null;
  }

  window.gzPages = window.gzPages || {};
  window.gzPages.notifications = { mount: mount, unmount: unmount };

  function isEntry() {
    return !!document.getElementById("notif-list") && !document.getElementById("root");
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
