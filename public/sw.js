// gazette service worker. Goal: instant cold start and offline reads, without EVER
// serving stale application code.
//
// Caching matrix (see README of the change / gz.js registration):
//   versioned asset (?v=) or /avatar/  -> cache-first, cache "gz-assets" (immutable)
//   HTML navigation (/, /messages, ...) -> network-first (3s) then cached, "gz-shells"
//   GET /api/* except /api/admin*      -> stale-while-revalidate, "gz-api" (200s only)
//   /api/admin*, /admin*, cross-origin -> never touched (Cloudflare Access login pages
//                                          must never be cached)
//
// A new SW takes over immediately (skipWaiting + clients.claim), so a deploy that bumps
// the asset version is live on the next load without a double refresh. On logout the
// client posts {type:"gz-clear-api"} and we drop the per-user "gz-api" and "gz-shells".
//
// Everything is guarded: a fetch failure falls back to cache, a cache miss falls back to
// network, and a total miss just lets the request through untouched.

var ASSETS = "gz-assets";
var SHELLS = "gz-shells";
var API = "gz-api";
var SHELL_TIMEOUT_MS = 3000;
var ASSET_CAP = 80; // opportunistic cap on the immutable asset cache

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    (async function () {
      // Drop any cache that is not one of ours (old names from prior SW versions).
      try {
        var keys = await caches.keys();
        await Promise.all(
          keys.map(function (k) {
            if (k !== ASSETS && k !== SHELLS && k !== API) return caches.delete(k);
            return Promise.resolve();
          })
        );
      } catch (e) {}
      try {
        await self.clients.claim();
      } catch (e) {}
    })()
  );
});

// Logout: the client wipes its API/shell caches so a logged-out user never sees stale
// private data. Guarded so a malformed message can never throw.
self.addEventListener("message", function (event) {
  var data = event.data;
  if (data && data.type === "gz-clear-api") {
    event.waitUntil(
      Promise.all([caches.delete(API), caches.delete(SHELLS)]).catch(function () {})
    );
  }
});

// A response we are willing to cache: same-origin, a real 200 (never an opaque or
// redirected Cf-Access login flavor).
function cacheable(req, res) {
  if (!res || res.status !== 200 || res.type === "opaqueredirect") return false;
  try {
    var reqUrl = new URL(req.url);
    var resUrl = new URL(res.url || req.url);
    if (reqUrl.origin !== self.location.origin) return false;
    // A redirect to a different origin (Access login) lands here as a cross-origin
    // final URL: refuse it.
    if (resUrl.origin !== self.location.origin) return false;
  } catch (e) {
    return false;
  }
  return true;
}

// Trim the immutable asset cache back toward ASSET_CAP, oldest-inserted first.
async function capAssets() {
  try {
    var cache = await caches.open(ASSETS);
    var keys = await cache.keys();
    if (keys.length <= ASSET_CAP) return;
    var excess = keys.length - ASSET_CAP;
    for (var i = 0; i < excess; i++) await cache.delete(keys[i]);
  } catch (e) {}
}

// Versioned assets: cache-first forever. The ?v= query self-invalidates on deploy, so a
// stored entry is only ever the exact bytes for that version.
async function handleAsset(req) {
  try {
    var cache = await caches.open(ASSETS);
    var hit = await cache.match(req);
    if (hit) return hit;
    var res = await fetch(req);
    if (cacheable(req, res)) {
      cache.put(req, res.clone()).then(capAssets).catch(function () {});
    }
    return res;
  } catch (e) {
    var fallback = await caches.match(req).catch(function () { return null; });
    if (fallback) return fallback;
    throw e;
  }
}

// HTML shells: network-first with a 3s timeout, falling back to the cached copy. Keeps
// the shell fresh (it carries the asset version) while making repeat/offline loads
// instant. Successful responses are cached.
async function handleShell(req) {
  var cache = await caches.open(SHELLS).catch(function () { return null; });
  var timer = null;
  try {
    var res = await new Promise(function (resolve, reject) {
      timer = setTimeout(function () { reject(new Error("timeout")); }, SHELL_TIMEOUT_MS);
      fetch(req).then(resolve, reject);
    });
    if (timer) clearTimeout(timer);
    if (cache && cacheable(req, res)) cache.put(req, res.clone()).catch(function () {});
    return res;
  } catch (e) {
    if (timer) clearTimeout(timer);
    var hit = cache ? await cache.match(req).catch(function () { return null; }) : null;
    if (hit) return hit;
    // No cached shell and the network failed/timed out: last-ditch real fetch so the
    // browser shows its own offline error rather than us swallowing it.
    return fetch(req);
  }
}

// API GET (not admin): stale-while-revalidate. Respond from cache immediately when
// present and kick a background refresh; otherwise go to network. Only 200s are stored.
async function handleApi(req) {
  var cache = await caches.open(API).catch(function () { return null; });
  var cached = cache ? await cache.match(req).catch(function () { return null; }) : null;

  var network = fetch(req)
    .then(function (res) {
      if (cache && cacheable(req, res)) cache.put(req, res.clone()).catch(function () {});
      return res;
    })
    .catch(function (e) {
      if (cached) return cached;
      throw e;
    });

  if (cached) {
    // Revalidate in the background; the caller already has the cached copy.
    network.catch(function () {});
    return cached;
  }
  return network;
}

function isAsset(url) {
  // Versioned assets (?v=) and the immutable same-origin avatar proxy (/avatar/<seed>,
  // deterministic + immutable-cached forever) are both cache-first so repeat views are
  // instant.
  return url.searchParams.has("v") || url.pathname.indexOf("/avatar/") === 0;
}

// A navigation to one of the member/landing shells we own.
function isShellNav(req, url) {
  if (req.mode !== "navigate") return false;
  var p = url.pathname;
  if (p === "/" || p === "/messages" || p === "/saved" || p === "/join") return true;
  if (p === "/search" || p === "/notifications" || p === "/my-agent") return true;
  if (p === "/about") return true;
  if (p.indexOf("/a/") === 0) return true;
  if (p === "/forum" || p.indexOf("/forum") === 0) return true;
  return false;
}

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return; // never cache non-GET; let it pass through

  var url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }
  if (url.origin !== self.location.origin) return; // cross-origin: never touch

  // Cloudflare Access login pages must never be cached, at all.
  if (url.pathname.indexOf("/api/admin") === 0 || url.pathname.indexOf("/admin") === 0) return;

  if (isAsset(url)) {
    event.respondWith(handleAsset(req));
    return;
  }
  // The notification inbox drives a live badge: a stale-while-revalidate hit would show
  // yesterday's count for a whole poll cycle. Never cache it, always go to the network.
  if (url.pathname.indexOf("/api/me/notifications") === 0) return;
  if (url.pathname.indexOf("/api/") === 0) {
    event.respondWith(handleApi(req));
    return;
  }
  if (isShellNav(req, url)) {
    event.respondWith(handleShell(req));
    return;
  }
  // Everything else: no interception.
});
