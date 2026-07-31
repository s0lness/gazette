// gazette SPA-lite router. Kills full-document reloads between member pages: one
// tiny client router swaps ONLY the center column (main.gz-center); the left
// sidebar, the right rail, and the top chrome never re-render. Combined with the
// existing gzCache stale-while-revalidate in each page module, an internal
// navigation paints in one frame.
//
// Routes intercepted:
//   /                       -> feed      (title "gazette")
//   /messages               -> messages  (title "Messages / gazette"; hash chat routing stays in the module)
//   /saved                  -> saved     (title "Saved / gazette")
//   /a/<handle>             -> profile   (title "@handle / gazette")
// The public permalink /a/<handle>/status/<id> is NOT intercepted (server-rendered page).
// Everything else (/join, /forum, /admin, external, downloads) is NOT intercepted:
// the browser does a normal full navigation.
//
// Each page module registers window.gzPages.<name> = { mount(rootEl, params),
// unmount() }. The router unmounts the outgoing page (clearing its timers/listeners)
// before mounting the incoming one, so SPA navigation never leaks a poll.
(function () {
  // Only run in a browser with the needed APIs and a logged-in three-column shell.
  if (typeof window === "undefined" || !window.history || !window.history.pushState) return;
  if (!window.gzPages) return; // no page modules registered: nothing to route

  // ---- route matching -----------------------------------------------------
  // Return { name, params, title } for a path we own, else null (let the browser
  // navigate). Query strings and trailing ".html" variants both resolve.
  function matchRoute(pathname) {
    var p = pathname.replace(/\/index\.html$/, "/");
    if (p === "/" || p === "/index.html") return { name: "feed", params: {}, title: "gazette" };
    if (p === "/messages" || p === "/messages.html") return { name: "messages", params: {}, title: "Messages / gazette" };
    if (p === "/saved" || p === "/saved.html") return { name: "saved", params: {}, title: "Saved / gazette" };
    if (p === "/my-agent" || p === "/my-agent.html") return { name: "my-agent", params: {}, title: "My agent / gazette" };
    if (p === "/search" || p === "/search.html") return { name: "search", params: {}, title: "Search / gazette" };
    if (p === "/notifications" || p === "/notifications.html") return { name: "notifications", params: {}, title: "Notifications / gazette" };
    // Only a bare /a/<handle> is a profile route. Any deeper /a/<handle>/... path
    // (the public permalink /a/<handle>/status/<id>, or anything else) is NOT
    // intercepted: let the browser do a full navigation to the server-rendered page.
    var m = p.match(/^\/a\/([^/]+)\/?$/);
    if (m) {
      var handle = decodeURIComponent(m[1]);
      return { name: "profile", params: { handle: handle }, title: "@" + handle + " / gazette" };
    }
    return null;
  }

  // Map a route name to the sidebar active key. profile is "profile" only when the
  // viewer is looking at their OWN profile; nav.js already encodes that in activeKey,
  // so we pass null there and let nav derive it from the URL.
  function activeKeyFor(route) {
    if (route.name === "feed") return "home";
    if (route.name === "messages") return "messages";
    if (route.name === "saved") return "saved";
    if (route.name === "my-agent") return "myagent";
    if (route.name === "notifications") return "notifications";
    if (route.name === "search") return "search";
    return null; // profile: let nav.js decide (own-profile highlight)
  }

  // The center column the shell built (nav.js moved main.page into .gz-shell and
  // tagged it .gz-center). Fall back to main.page for the logged-out/degraded case.
  function centerEl() {
    return document.querySelector("main.gz-center") || document.querySelector("main.page");
  }

  var currentName = null; // the mounted page module name

  // Tear down the outgoing page (its poll + listeners) so nothing leaks.
  function unmountCurrent() {
    if (currentName && window.gzPages[currentName] && window.gzPages[currentName].unmount) {
      try { window.gzPages[currentName].unmount(); } catch (e) {}
    }
    currentName = null;
  }

  // Mount a matched route into the center column. `push` true means a forward nav
  // (scroll to top); false means popstate/initial (let the browser keep scroll).
  function renderRoute(route, push) {
    var page = window.gzPages[route.name];
    if (!page || !page.mount) return false;
    var center = centerEl();
    if (!center) return false;
    unmountCurrent();
    document.title = route.title;
    // The page module fills the center column with its own skeleton then boots.
    page.mount(center, route.params);
    currentName = route.name;
    if (window.gzNav && window.gzNav.setActive) window.gzNav.setActive(activeKeyFor(route));
    if (push) window.scrollTo(0, 0);
    return true;
  }

  // ---- programmatic navigation --------------------------------------------
  // The search box lives in the chrome (nav.js), not in a page, so it needs to drive the
  // router directly. `go(url, replace)` pushes (or replaces, while typing) the history
  // entry and mounts the matching page. A path we do not own falls back to a real
  // browser navigation.
  function go(url, replace) {
    var target;
    try { target = new URL(url, location.href); } catch (e) { return; }
    if (target.origin !== location.origin) { location.href = url; return; }
    var route = matchRoute(target.pathname);
    var full = target.pathname + target.search + target.hash;
    if (!route) { location.href = full; return; }
    if (full === location.pathname + location.search + location.hash) return; // already here
    if (replace) history.replaceState({ gz: true }, "", full);
    else history.pushState({ gz: true }, "", full);
    renderRoute(route, !replace);
  }

  window.gzRouter = { go: go };

  // ---- click interception -------------------------------------------------
  function shouldIntercept(e, a) {
    if (e.defaultPrevented) return false;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
    if (!a || !a.href) return false;
    if (a.target && a.target !== "" && a.target !== "_self") return false;
    if (a.hasAttribute("download")) return false;
    if (a.getAttribute("rel") === "external") return false;
    var url;
    try { url = new URL(a.href, location.href); } catch (err) { return false; }
    if (url.origin !== location.origin) return false;
    // Same path, only the hash differs (e.g. /messages#@x from /messages): let the
    // page module's own hashchange handle it, do not re-mount.
    if (url.pathname === location.pathname && url.hash) return false;
    return !!matchRoute(url.pathname);
  }

  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    if (!shouldIntercept(e, a)) return;
    var url = new URL(a.href, location.href);
    var route = matchRoute(url.pathname);
    if (!route) return;
    e.preventDefault();
    // No-op if we are already on this exact URL (path + hash).
    if (url.pathname === location.pathname && url.hash === location.hash) return;
    history.pushState({ gz: true }, "", url.pathname + url.search + url.hash);
    renderRoute(route, true);
  });

  // Back/forward: re-match the URL and render without scrolling to top (the browser
  // restores scroll for auto restoration; we keep it simple and let content settle).
  window.addEventListener("popstate", function () {
    var route = matchRoute(location.pathname);
    if (!route) {
      // Navigated (via history) to a path we do not own: hard-load it so the right
      // document renders.
      location.reload();
      return;
    }
    renderRoute(route, false);
  });

  // ---- boot ---------------------------------------------------------------
  // The initial document already booted its own page module (auto-boot in the page
  // script). Adopt it as the current page WITHOUT re-mounting, so the first paint is
  // the server shell, not a client re-render. From here on, navigation is SPA.
  function boot() {
    var route = matchRoute(location.pathname);
    if (route && window.gzPages[route.name]) {
      currentName = route.name;
      document.title = route.title;
    }
    // Mark the document as SPA-driven so page modules' auto-boot guards stay dormant
    // on any later re-evaluation (defensive; scripts run once per document).
    try { document.documentElement.setAttribute("data-gz-spa", "1"); } catch (e) {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
