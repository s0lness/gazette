// gazette left sidebar (logged-in chrome), rendered on every page once the viewer
// is authed. One shared module so the five shells stay markup-free: it injects a
// left nav rail and wraps the existing <main.page> content into a three-column
// layout (sidebar | center feed | right rail). The account (avatar +
// @handle + log out) is pinned at the BOTTOM of the rail, like Twitter's account
// button. On mobile there is NO persistent rail: a small avatar button top-left
// opens a tiny popover with Profile + Log out. Logged out (the wall) gets nothing.
//
// Reuses auth.js: window.gzMe() for {handle}, window.gzToken() for auth, and
// window.gzLogout() for the log-out flow (clears gz:token, hits /api/logout, shows
// the wall). Reuses window.gzAvatar(handle) from tweet.js for the monogram.
// Dependency-free, vanilla, sylve-studio identity (paper / ink / mono).
(function () {
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // Which nav item is the current page. "home" for the feed at /, "profile" when
  // the path is the viewer's own /a/<handle>, else none.
  function activeKey(myHandle) {
    var p = location.pathname;
    if (p === "/" || p === "/index.html") return "home";
    if (p === "/messages" || p === "/messages.html") return "messages";
    if (p === "/saved" || p === "/saved.html") return "saved";
    if (myHandle && (p === "/a/" + myHandle || p === "/a/" + encodeURIComponent(myHandle))) return "profile";
    return "";
  }

  function avatar(handle) {
    // gzAvatar (tweet.js) is present on every page that loads the sidebar.
    return window.gzAvatar ? window.gzAvatar(handle) : "";
  }

  // ---- desktop sidebar ----------------------------------------------------

  // Inline SVG icons: house outline for Home, person outline for Profile.
  // Drawn from scratch; no proprietary icon copied.
  var ICON_HOME = '<svg class="gz-nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path d="M3 10.5L12 3l9 7.5V21a1 1 0 0 1-1 1H15v-6h-6v6H4a1 1 0 0 1-1-1V10.5z"/>' +
    '</svg>';
  var ICON_HOME_FILLED = '<svg class="gz-nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path d="M3 10.5L12 3l9 7.5V21a1 1 0 0 1-1 1H15v-6h-6v6H4a1 1 0 0 1-1-1V10.5z"/>' +
    '</svg>';
  var ICON_PROFILE = '<svg class="gz-nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<circle cx="12" cy="8" r="4"/>' +
    '<path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>' +
    '</svg>';
  // Envelope outline for Messages.
  var ICON_MESSAGES = '<svg class="gz-nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<rect x="3" y="5" width="18" height="14" rx="2"/>' +
    '<path d="M3.5 6.5L12 13l8.5-6.5"/>' +
    '</svg>';
  // Bookmark outline for Saved.
  var ICON_SAVED = '<svg class="gz-nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path d="M6 3.5h12a1 1 0 0 1 1 1V21l-7-4-7 4V4.5a1 1 0 0 1 1-1z"/>' +
    '</svg>';
  // Speech-bubble outline for Feedback (drawn from scratch): a rounded rectangle with
  // a little tail dropping from the lower-left.
  var ICON_FEEDBACK = '<svg class="gz-nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path d="M4 5.5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-4 3.5V16.5H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z"/>' +
    '</svg>';

  function sidebarHTML(handle) {
    var active = activeKey(handle);
    var profileHref = "/a/" + encodeURIComponent(handle);
    var homeActive = active === "home";
    var messagesActive = active === "messages";
    var savedActive = active === "saved";
    var profileActive = active === "profile";
    return (
      '<nav class="gz-side" aria-label="primary">' +
      '<a href="/" class="gz-side-brand">🗞️ gazette</a>' +
      '<div class="gz-side-nav">' +
      '<a href="/" class="gz-side-link' + (homeActive ? " on" : "") + '"' +
      (homeActive ? ' aria-current="page"' : "") + ">" +
      (homeActive ? ICON_HOME_FILLED : ICON_HOME) +
      '<span class="gz-nav-label">Home</span>' +
      "</a>" +
      '<a href="/messages" class="gz-side-link' + (messagesActive ? " on" : "") + '"' +
      (messagesActive ? ' aria-current="page"' : "") + ">" +
      ICON_MESSAGES +
      '<span class="gz-nav-label">Messages</span>' +
      "</a>" +
      '<a href="/saved" class="gz-side-link' + (savedActive ? " on" : "") + '"' +
      (savedActive ? ' aria-current="page"' : "") + ">" +
      ICON_SAVED +
      '<span class="gz-nav-label">Saved</span>' +
      "</a>" +
      '<a href="' + profileHref + '" class="gz-side-link' + (profileActive ? " on" : "") + '"' +
      (profileActive ? ' aria-current="page"' : "") + ">" +
      ICON_PROFILE +
      '<span class="gz-nav-label">Profile</span>' +
      "</a>" +
      "</div>" +
      '<div class="gz-side-foot">' +
      '<button type="button" class="gz-side-feedback" aria-label="Send feedback to the builder">' +
      ICON_FEEDBACK +
      '<span class="gz-nav-label">Feedback</span>' +
      "</button>" +
      '<div class="gz-account" title="' + esc(handle) + '">' +
      '<a class="gz-account-id" href="' + profileHref + '">' +
      avatar(handle) +
      '<span class="gz-account-names">' +
      '<span class="gz-account-display">@' + esc(handle) + '</span>' +
      '<span class="gz-account-handle">@' + esc(handle) + "</span>" +
      '</span>' +
      "</a>" +
      '<button type="button" class="gz-account-logout" aria-label="Log out">log out</button>' +
      "</div>" +
      "</div>" +
      "</nav>"
    );
  }

  // ---- mobile account menu ------------------------------------------------

  function mobileHTML(handle) {
    return (
      '<div class="gz-mob-acct">' +
      '<button type="button" class="gz-mob-btn" aria-haspopup="menu" aria-expanded="false" aria-label="account">' +
      avatar(handle) +
      "</button>" +
      '<div class="gz-mob-menu" role="menu" hidden>' +
      '<span class="gz-mob-who">@' + esc(handle) + "</span>" +
      '<a href="/messages" class="gz-mob-item" role="menuitem">Messages</a>' +
      '<a href="/saved" class="gz-mob-item" role="menuitem">Saved</a>' +
      '<a href="/a/' + encodeURIComponent(handle) + '" class="gz-mob-item" role="menuitem">Profile</a>' +
      '<a href="#" class="gz-mob-item gz-mob-feedback" role="menuitem">Feedback</a>' +
      '<a href="#" class="gz-mob-item gz-mob-logout" role="menuitem">Log out</a>' +
      "</div>" +
      "</div>"
    );
  }

  function wireLogout(el) {
    if (!el) return;
    el.addEventListener("click", function (e) {
      e.preventDefault();
      if (window.gzLogout) window.gzLogout();
    });
  }

  // ---- feedback modal -----------------------------------------------------
  // A direct line to the builder. Reuses the wall-modal classes from auth.js so it
  // inherits the sheet/backdrop/close styling; the .fb- prefixed bits (see app.css)
  // supplement the textarea + actions. One textarea, one Send button. On success the
  // body swaps to a short thanks that auto-closes.

  function feedbackModalHTML() {
    return (
      '<div class="wall-modal" id="gz-fb-modal" hidden>' +
      '<div class="wall-modal-backdrop" id="gz-fb-backdrop"></div>' +
      '<div class="wall-modal-sheet" role="dialog" aria-modal="true" aria-label="Feedback">' +
      '<button type="button" class="wall-modal-x" id="gz-fb-close" aria-label="Close">&times;</button>' +
      '<div id="gz-fb-body">' +
      '<h3 class="wall-modal-title">Feedback</h3>' +
      '<p class="wall-modal-sub">A direct line to Sylve, who builds gazette. What is broken, missing, or great?</p>' +
      '<textarea id="gz-fb-text" class="fb-textarea" rows="4" placeholder="What\'s broken, missing, or great?" spellcheck="true"></textarea>' +
      '<div class="fb-actions">' +
      '<button id="gz-fb-send" class="primary" type="button">Send</button>' +
      "</div>" +
      '<p id="gz-fb-note" class="wall-note"></p>' +
      "</div>" +
      "</div>" +
      "</div>"
    );
  }

  // The single modal instance, mounted lazily on first open. Returns the modal node.
  var fbModal = null;
  function ensureFeedbackModal() {
    if (fbModal) return fbModal;
    var wrap = document.createElement("div");
    wrap.innerHTML = feedbackModalHTML();
    fbModal = wrap.firstChild;
    document.body.appendChild(fbModal);

    var backdrop = fbModal.querySelector("#gz-fb-backdrop");
    var closeBtn = fbModal.querySelector("#gz-fb-close");
    if (backdrop) backdrop.addEventListener("click", closeFeedback);
    if (closeBtn) closeBtn.addEventListener("click", closeFeedback);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !fbModal.hidden) closeFeedback();
    });
    return fbModal;
  }

  function closeFeedback() {
    if (!fbModal) return;
    fbModal.hidden = true;
    document.body.classList.remove("gz-modal-open");
  }

  function openFeedback() {
    var m = ensureFeedbackModal();
    // Reset the body every open (it may have swapped to the thanks state last time).
    var body = m.querySelector("#gz-fb-body");
    body.innerHTML =
      '<h3 class="wall-modal-title">Feedback</h3>' +
      '<p class="wall-modal-sub">A direct line to Sylve, who builds gazette. What is broken, missing, or great?</p>' +
      '<textarea id="gz-fb-text" class="fb-textarea" rows="4" placeholder="What\'s broken, missing, or great?" spellcheck="true"></textarea>' +
      '<div class="fb-actions"><button id="gz-fb-send" class="primary" type="button">Send</button></div>' +
      '<p id="gz-fb-note" class="wall-note"></p>';
    var text = body.querySelector("#gz-fb-text");
    var send = body.querySelector("#gz-fb-send");
    var note = body.querySelector("#gz-fb-note");
    if (send) send.addEventListener("click", function () { submitFeedback(text, send, note, body); });
    m.hidden = false;
    document.body.classList.add("gz-modal-open");
    if (text) text.focus();
  }

  function submitFeedback(text, send, note, body) {
    var msg = (text.value || "").trim();
    if (!msg) { note.textContent = "Write something first."; return; }
    note.textContent = "";
    send.disabled = true;
    var doFetch = window.gzFetch || fetch;
    doFetch("/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ message: msg }),
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (b) { return { r: r, b: b }; });
      })
      .then(function (res) {
        if (res.r.ok && res.b && res.b.ok) {
          body.innerHTML = '<h3 class="wall-modal-title">Thanks</h3>' +
            '<p class="wall-modal-sub">Sent. Sylve reads these.</p>';
          setTimeout(closeFeedback, 1200);
          return;
        }
        // 422 / 429 (and anything else): show the server message inline.
        send.disabled = false;
        note.textContent = (res.b && res.b.message) || "Could not send. Try again.";
      })
      .catch(function (e) {
        // gzFetch raises the wall on 401/403 and throws; nothing to add here.
        if (e && e.gzGated) return;
        send.disabled = false;
        note.textContent = "Could not send. Try again.";
      });
  }

  function wireFeedback(el) {
    if (!el) return;
    el.addEventListener("click", function (e) {
      e.preventDefault();
      openFeedback();
    });
  }

  function wireMobile(wrap) {
    var btn = wrap.querySelector(".gz-mob-btn");
    var menu = wrap.querySelector(".gz-mob-menu");
    if (!btn || !menu) return;
    function close() {
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
    }
    function open() {
      menu.hidden = false;
      btn.setAttribute("aria-expanded", "true");
    }
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (menu.hidden) open(); else close();
    });
    document.addEventListener("click", function (e) {
      if (menu.hidden) return;
      if (!wrap.contains(e.target)) close();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") close();
    });
    wireLogout(wrap.querySelector(".gz-mob-logout"));
    wireFeedback(wrap.querySelector(".gz-mob-feedback"));
  }

  // Remembered so setActive can recompute the highlighted link (SPA nav) without
  // rebuilding the rail. Set once the sidebar mounts.
  var mountedHandle = null;

  // Recompute which sidebar link is highlighted, in place. The router calls this on
  // every client-side navigation so the rail's active state tracks the URL without a
  // re-render. `key` is one of "home"/"messages"/"saved"/"profile"/"" (none). When
  // omitted, it is derived from the current location (used on popstate too).
  function setActive(key) {
    var active = key == null ? activeKey(mountedHandle) : key;
    var links = document.querySelectorAll(".gz-side-nav .gz-side-link");
    // Order in the DOM: home, messages, saved, profile.
    var keys = ["home", "messages", "saved", "profile"];
    for (var i = 0; i < links.length; i++) {
      var on = keys[i] === active;
      links[i].classList.toggle("on", on);
      if (on) links[i].setAttribute("aria-current", "page");
      else links[i].removeAttribute("aria-current");
    }
  }

  // Build the three-column shell: left sidebar | center feed | right rail. We move
  // the real <main.page> into the middle so the sidebar sits left and the rail sits
  // right. The right rail is filled by rail.js (window.gzRail) when present; below
  // 1100px CSS hides it. Idempotent.
  function mount() {
    if (document.body.getAttribute("data-gz-nav") === "1") return;
    var me = (window.gzMe && window.gzMe()) || null;
    var handle = me && me.handle;
    var authed = (window.gzMaybeAuthed ? window.gzMaybeAuthed() : (window.gzToken && window.gzToken())) && handle;
    if (!authed) return; // logged out: no sidebar, the wall stays full-width
    var main = document.querySelector("main.page");
    if (!main) return;
    document.body.setAttribute("data-gz-nav", "1");
    mountedHandle = handle;

    // Three-column wrapper inserted where main was; main becomes the center column.
    var shell = document.createElement("div");
    shell.className = "gz-shell";
    main.parentNode.insertBefore(shell, main);

    var sideWrap = document.createElement("div");
    sideWrap.className = "gz-side-col";
    sideWrap.innerHTML = sidebarHTML(handle);
    shell.appendChild(sideWrap);
    shell.appendChild(main); // move main into the shell as the center column
    main.classList.add("gz-center");

    // Right rail column. Content is owned by rail.js; we only provide the slot so
    // the grid reserves the third track. rail.js mounts into .gz-rail-col.
    var railWrap = document.createElement("div");
    railWrap.className = "gz-rail-col";
    shell.appendChild(railWrap);
    if (window.gzRail && window.gzRail.mount) window.gzRail.mount(railWrap, handle);

    wireLogout(sideWrap.querySelector(".gz-account-logout"));
    wireFeedback(sideWrap.querySelector(".gz-side-feedback"));

    // Mobile account button lives in the top bar (top-left). Independent of the
    // desktop rail; CSS shows exactly one at a time.
    var bar = document.querySelector("header.bar");
    if (bar) {
      var mob = document.createElement("div");
      mob.innerHTML = mobileHTML(handle);
      var node = mob.firstChild;
      bar.insertBefore(node, bar.firstChild);
      wireMobile(node);
    }
  }

  // The sidebar depends on gzMe() being populated. On a fresh page that is only
  // known after the first authed read echoes x-gz-handle (auth.js caches it). We
  // mount immediately if we already know the handle, and also re-try once the
  // handle lands, so the rail appears without a reload.
  function boot() {
    mount();
    if (document.body.getAttribute("data-gz-nav") !== "1") {
      // Handle not cached yet: retry a few times as the first authed read resolves.
      var tries = 0;
      var iv = setInterval(function () {
        tries++;
        mount();
        if (document.body.getAttribute("data-gz-nav") === "1" || tries > 40) clearInterval(iv);
      }, 250);
    }
  }

  // The router (router.js) drives the active-state refresh on client-side navs.
  window.gzNav = { setActive: setActive };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
