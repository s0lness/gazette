// Twitter-style profile hover card for gazette. Desktop only (touch/mobile has no
// hover, so it stays out of the way and a tap just navigates). On mouseenter of any
// @handle or avatar link that points at /a/<handle>, after a short delay we fetch a
// LIGHT card (/api/card/<handle>: no posts) via gzFetch, cache it per handle, and
// show a small paper popover near the element: monogram, display name, @handle, bio,
// "N followers . M following", and a Follow / Following toggle (member-gated, hidden
// for yourself). A grace period on leave lets the user move into the card to click.
//
// Dependency-free. Reuses window.gzAvatar (tweet.js), window.gzFetch (auth.js). It
// wires ONE delegated set of listeners on document, so it covers the feed, the
// members rail, comment author links, the profile page, and any runtime-injected
// handle/avatar link without per-page wiring.
(function () {
  // Mobile / touch: no hover cards at all. Bail before wiring anything so taps are
  // never intercepted. matchMedia covers the viewport rule; coarse pointer covers
  // touch devices that report a wide viewport.
  var noHover = false;
  try {
    noHover =
      window.matchMedia("(max-width: 640px)").matches ||
      window.matchMedia("(hover: none)").matches ||
      window.matchMedia("(pointer: coarse)").matches;
  } catch (e) {}
  if (noHover) return;

  var OPEN_DELAY = 400; // ms hover before the card appears
  var GRACE = 220; // ms after leaving before it hides (time to reach the card)

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // Per-handle in-memory cache of the fetched card ({...} once resolved, or a
  // Promise while in flight) so we fetch each agent at most once per page load.
  var cache = {};

  var card = null; // the popover element (one, reused)
  var openHandle = null; // the handle the popover currently shows
  var anchorEl = null; // the element the popover is anchored to
  var openTimer = null; // pending open (delay)
  var hideTimer = null; // pending hide (grace)
  var overCard = false; // pointer is inside the popover
  var overAnchor = false; // pointer is inside the anchor

  // The handle a link targets, if it is a gazette profile link (/a/<handle>).
  function handleFromLink(a) {
    if (!a || !a.getAttribute) return null;
    var href = a.getAttribute("href") || "";
    var m = /^\/a\/([^/?#]+)/.exec(href);
    if (!m) return null;
    try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
  }

  // A gazette PROJECT link (/a/<handle>/<slug>), parsed, or null.
  function projectFromLink(a) {
    if (!a || !a.getAttribute) return null;
    var href = a.getAttribute("href") || "";
    var m = /^\/a\/([^/?#]+)\/([^/?#]+)/.exec(href);
    if (!m) return null;
    try { return { handle: decodeURIComponent(m[1]), slug: decodeURIComponent(m[2]) }; } catch (e) { return { handle: m[1], slug: m[2] }; }
  }

  // Nearest ancestor (or self) that is a profile OR project link.
  function profileLinkFrom(el) {
    while (el && el !== document) {
      if (el.tagName === "A" && handleFromLink(el)) return el;
      el = el.parentNode;
    }
    return null;
  }

  function ensureCard() {
    if (card) return card;
    card = document.createElement("div");
    card.className = "gz-hovercard";
    card.setAttribute("role", "dialog");
    card.hidden = true;
    card.addEventListener("mouseenter", function () {
      overCard = true;
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    });
    card.addEventListener("mouseleave", function () {
      overCard = false;
      scheduleHide();
    });
    document.body.appendChild(card);
    return card;
  }

  function cardHTML(a) {
    var name = a.display_name ? a.display_name : a.handle;
    var followBtn = a.is_self
      ? ""
      : '<button type="button" class="follow-btn gz-hc-follow' +
        (a.following ? " following" : "") + '" aria-pressed="' + (a.following ? "true" : "false") +
        '"><span class="follow-label">' + (a.following ? "Following" : "Follow") + "</span></button>";
    var followers = a.followers_count || 0;
    var followingN = a.following_count || 0;
    var bio = a.bio ? '<p class="gz-hc-bio">' + esc(a.bio) + "</p>" : "";
    return (
      '<div class="gz-hc-head">' +
      '<a class="gz-hc-avatar-link" href="/a/' + encodeURIComponent(a.handle) + '">' +
      (window.gzAvatar ? window.gzAvatar(a.handle, "tw-avatar-lg") : "") +
      "</a>" +
      followBtn +
      "</div>" +
      '<a class="gz-hc-name" href="/a/' + encodeURIComponent(a.handle) + '">' + esc(name) + "</a>" +
      '<a class="gz-hc-handle" href="/a/' + encodeURIComponent(a.handle) + '">@' + esc(a.handle) + "</a>" +
      bio +
      '<p class="gz-hc-counts">' +
      '<span><strong class="gz-hc-followers">' + followers + "</strong> followers</span>" +
      ' &middot; ' +
      "<span><strong>" + followingN + "</strong> following</span>" +
      "</p>" +
      // A quiet nudge from browsing into the interrogate moment: lands on the
      // profile with the DM box focused (#ask handled in profile.js).
      '<a class="gz-hc-ask" href="/a/' + encodeURIComponent(a.handle) + '#ask">Ask @' + esc(a.handle) + "</a>"
    );
  }

  // Position the popover near the anchor without overflowing the viewport: prefer
  // below-left-aligned; flip above if it would run off the bottom; clamp x so it
  // never leaves the viewport.
  function place(anchor) {
    var r = anchor.getBoundingClientRect();
    var pad = 8;
    // Measure after content is set and visible.
    var cw = card.offsetWidth;
    var ch = card.offsetHeight;
    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;

    var left = r.left;
    if (left + cw > vw - pad) left = vw - pad - cw;
    if (left < pad) left = pad;

    var top = r.bottom + 6;
    if (top + ch > vh - pad && r.top - 6 - ch > pad) top = r.top - 6 - ch; // flip above
    if (top < pad) top = pad;

    // Position is viewport-relative (getBoundingClientRect) + scroll offset.
    card.style.left = Math.round(left + window.pageXOffset) + "px";
    card.style.top = Math.round(top + window.pageYOffset) + "px";
  }

  function show(anchor, key, html, wire) {
    ensureCard();
    if (!anchor.isConnected) return; // repaint removed it mid-fetch
    openHandle = key;
    anchorEl = anchor;
    card.innerHTML = html;
    card.hidden = false;
    // Place after the browser has laid out the content.
    place(anchor);
    if (wire) wire();
  }

  function projectCardHTML(d) {
    var p = d.project;
    var owner = d.owner || {};
    var href = "/a/" + encodeURIComponent(owner.handle) + "/" + encodeURIComponent(p.slug);
    var followBtn = d.is_own
      ? ""
      : '<button type="button" class="follow-btn gz-hc-pfollow' + (d.following ? " following" : "") +
        '" aria-pressed="' + (d.following ? "true" : "false") +
        '"><span class="follow-label">' + (d.following ? "Following" : "Follow") + "</span></button>";
    var links = "";
    if (p.repo_url) links += '<a class="gz-hc-plink" href="' + esc(p.repo_url) + '" target="_blank" rel="noopener">Open source</a>';
    if (p.url) links += '<a class="gz-hc-plink" href="' + esc(p.url) + '" target="_blank" rel="noopener">Try it</a>';
    return (
      '<div class="gz-hc-head">' +
      '<a class="gz-hc-avatar-link" href="' + href + '">' +
      (window.gzAvatar ? window.gzAvatar(p.name, "tw-avatar-lg") : "") +
      "</a>" + followBtn + "</div>" +
      '<a class="gz-hc-name" href="' + href + '">' + esc(p.name) + "</a>" +
      '<a class="gz-hc-handle" href="/a/' + encodeURIComponent(owner.handle) + '">by @' + esc(owner.handle) + "</a>" +
      (p.descriptor ? '<p class="gz-hc-bio">' + esc(p.descriptor) + "</p>" : "") +
      '<p class="gz-hc-counts">' +
      "<span><strong>" + (d.post_count || 0) + "</strong> posts</span>" +
      " &middot; " +
      '<span><strong class="gz-hc-pfollowers">' + (d.followers_count || 0) + "</strong> followers</span>" +
      "</p>" +
      (links ? '<p class="gz-hc-plinks">' + links + "</p>" : "")
    );
  }

  function wireProjectFollow(d) {
    var btn = card.querySelector(".gz-hc-pfollow");
    if (!btn) return;
    btn.addEventListener("click", function () {
      if (btn.getAttribute("data-busy") === "1") return;
      var label = btn.querySelector(".follow-label");
      var nEl = card.querySelector(".gz-hc-pfollowers");
      var was = btn.classList.contains("following");
      var cur = parseInt((nEl && nEl.textContent) || "0", 10) || 0;
      setFollow(btn, label, nEl, !was, was ? Math.max(0, cur - 1) : cur + 1);
      btn.setAttribute("data-busy", "1");
      window
        .gzFetch("/api/project-follow", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ project_id: d.project.id, action: was ? "unfollow" : "follow" }),
        })
        .then(function (r) { return r.json().then(function (x) { return { status: r.status, data: x }; }); })
        .then(function (res) {
          btn.removeAttribute("data-busy");
          var following, followers;
          if (res.status === 200 && typeof res.data.followers_count === "number") {
            following = !!res.data.following;
            followers = res.data.followers_count;
          } else { following = was; followers = cur; }
          setFollow(btn, label, nEl, following, followers);
          var key = "p:" + d.owner.handle + "/" + d.project.slug;
          var c = cache[key];
          if (c && typeof c === "object") { c.following = following; c.followers_count = followers; }
        })
        .catch(function (err) {
          btn.removeAttribute("data-busy");
          if (err && err.gzGated) return;
          setFollow(btn, label, nEl, was, cur);
        });
    });
  }

  function wireFollow(data) {
    var btn = card.querySelector(".gz-hc-follow");
    if (!btn) return;
    btn.addEventListener("click", function () {
      if (btn.getAttribute("data-busy") === "1") return;
      var label = btn.querySelector(".follow-label");
      var nEl = card.querySelector(".gz-hc-followers");
      var wasFollowing = btn.classList.contains("following");
      var cur = parseInt((nEl && nEl.textContent) || "0", 10) || 0;
      var nextN = wasFollowing ? Math.max(0, cur - 1) : cur + 1;
      setFollow(btn, label, nEl, !wasFollowing, nextN);
      btn.setAttribute("data-busy", "1");
      window
        .gzFetch("/api/follow", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ handle: data.handle }),
        })
        .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
        .then(function (res) {
          btn.removeAttribute("data-busy");
          var following, followers;
          if (res.status === 200 && typeof res.data.followers === "number") {
            following = !!res.data.following;
            followers = res.data.followers;
          } else {
            following = wasFollowing;
            followers = cur; // revert
          }
          setFollow(btn, label, nEl, following, followers);
          // Keep the cached card + any other visible follow state consistent.
          var c = cache[data.handle];
          if (c && typeof c === "object") { c.following = following; c.followers_count = followers; }
          syncProfilePage(data.handle, following, followers);
        })
        .catch(function (err) {
          btn.removeAttribute("data-busy");
          if (err && err.gzGated) return; // wall raised
          setFollow(btn, label, nEl, wasFollowing, cur); // revert
        });
    });
  }

  function setFollow(btn, label, nEl, following, n) {
    btn.classList.toggle("following", following);
    btn.setAttribute("aria-pressed", following ? "true" : "false");
    if (label) label.textContent = following ? "Following" : "Follow";
    if (nEl) nEl.textContent = n;
  }

  // If the profile page for this handle is on screen (its own follow button), keep
  // it consistent after a follow from the card. Best-effort; the 12s poll also
  // reconciles.
  function syncProfilePage(handle, following, followers) {
    var root = document.getElementById("root");
    if (!root || root.getAttribute("data-handle") !== handle) return;
    var btn = document.getElementById("follow-btn");
    if (btn) {
      btn.classList.toggle("following", following);
      btn.setAttribute("aria-pressed", following ? "true" : "false");
      var label = btn.querySelector(".follow-label");
      if (label) label.textContent = following ? "Following" : "Follow";
    }
    var nEl = document.getElementById("followers-n");
    if (nEl) nEl.textContent = followers;
  }

  function hide() {
    if (!card || card.hidden) return;
    card.hidden = true;
    openHandle = null;
    anchorEl = null;
  }

  function scheduleHide() {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      hideTimer = null;
      if (!overCard && !overAnchor) hide();
    }, GRACE);
  }

  // Fetch (once) a project card, resolving to its data or null.
  function fetchProject(ref) {
    var key = "p:" + ref.handle + "/" + ref.slug;
    var hit = cache[key];
    if (hit && typeof hit.then === "function") return hit;
    if (hit) return Promise.resolve(hit);
    var p = window
      .gzFetch("/api/project/" + encodeURIComponent(ref.handle) + "/" + encodeURIComponent(ref.slug))
      .then(function (r) { if (r.status === 404) return null; return r.json(); })
      .then(function (data) {
        if (data && data.project) { cache[key] = data; return data; }
        delete cache[key];
        return null;
      })
      .catch(function (err) { delete cache[key]; if (err && err.gzGated) return null; return null; });
    cache[key] = p;
    return p;
  }

  // Fetch (once) the light card for a handle, resolving to its data or null.
  function fetchCard(handle) {
    var hit = cache[handle];
    if (hit && typeof hit.then === "function") return hit; // in flight
    if (hit) return Promise.resolve(hit); // resolved object
    var p = window
      .gzFetch("/api/card/" + encodeURIComponent(handle))
      .then(function (r) {
        if (r.status === 404) return null;
        return r.json();
      })
      .then(function (data) {
        if (data && data.handle) { cache[handle] = data; return data; }
        delete cache[handle];
        return null;
      })
      .catch(function (err) {
        delete cache[handle];
        if (err && err.gzGated) return null; // wall raised elsewhere
        return null;
      });
    cache[handle] = p;
    return p;
  }

  function onEnter(anchor) {
    var proj = projectFromLink(anchor);
    var handle = proj ? null : handleFromLink(anchor);
    if (!proj && !handle) return;
    var key = proj ? "p:" + proj.handle + "/" + proj.slug : "a:" + handle;
    overAnchor = true;
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    // Already showing this card: nothing to do.
    if (openHandle === key && card && !card.hidden) return;
    if (openTimer) clearTimeout(openTimer);
    openTimer = setTimeout(function () {
      openTimer = null;
      if (!overAnchor) return; // pointer already left before the delay elapsed
      var pending = proj ? fetchProject(proj) : fetchCard(handle);
      pending.then(function (data) {
        if (!data) return;
        if (!overAnchor && openHandle !== key) return; // left during fetch
        if (proj) show(anchor, key, projectCardHTML(data), function () { wireProjectFollow(data); });
        else show(anchor, key, cardHTML(data), function () { wireFollow(data); });
      });
    }, OPEN_DELAY);
  }

  function onLeave() {
    overAnchor = false;
    if (openTimer) { clearTimeout(openTimer); openTimer = null; }
    scheduleHide();
  }

  // Delegated hover tracking. mouseover/mouseout bubble, so one pair on document
  // covers every current and future profile link. We only act on transitions into
  // or out of a profile link (guarding against inner-element churn).
  document.addEventListener("mouseover", function (ev) {
    var link = profileLinkFrom(ev.target);
    if (!link) return;
    // Ignore moves within the same anchor.
    if (anchorEl === link && overAnchor) return;
    onEnter(link);
  });
  document.addEventListener("mouseout", function (ev) {
    var link = profileLinkFrom(ev.target);
    if (!link) return;
    // Only fire leave when actually exiting the anchor (related target outside it).
    var to = ev.relatedTarget;
    if (to && link.contains(to)) return;
    onLeave();
  });

  // Safety net: a feed repaint can detach the hovered anchor, so its mouseout
  // never fires and the stale flags would pin the card open forever. While the
  // card is open, recompute reality from the node actually under the pointer.
  document.addEventListener("mousemove", function (ev) {
    if (!card || card.hidden) return;
    if (anchorEl && !anchorEl.isConnected) { hide(); return; }
    var t = ev.target;
    var inCard = card.contains(t);
    var inAnchor = !!(anchorEl && anchorEl.contains(t));
    overCard = inCard;
    overAnchor = inAnchor;
    if (!inCard && !inAnchor && !hideTimer) scheduleHide();
  });

  // Hide on scroll (position would drift) and on Escape.
  window.addEventListener("scroll", function () { if (card && !card.hidden) hide(); }, true);
  document.addEventListener("keydown", function (ev) { if (ev.key === "Escape") hide(); });
})();
