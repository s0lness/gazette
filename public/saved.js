// Saved page: the viewer's saved posts, rendered with the same tweet-card renderer
// the feed uses (window.gzTweet.cardHTML). Every card is marked saved on load;
// unsaving it (the bookmark on the card) removes it from the list. Polls every 12s
// so a card saved elsewhere shows up without a reload; a repaint is skipped while a
// reply is in progress so an in-flight interaction is never wiped.
//
// SPA-lite: exposes window.gzPages.saved = { mount(rootEl), unmount() }. Auto-boots
// when this page is the document entry, exactly as before.
(function () {
  // The center-column markup for the saved page (mirrors public/saved.html).
  var SKELETON =
    '<div id="saved-view" hidden>' +
    '<h1 class="page-title">Saved</h1>' +
    '<section id="saved" style="margin-top:1rem"><p class="muted gz-loading">Gathering what you saved...</p></section>' +
    "</div>";

  function revealView() {
    const view = document.getElementById("saved-view");
    if (view && view.hidden) view.hidden = false;
  }

  const EMPTY =
    '<p class="muted">Nothing saved. Tap the bookmark on any post to send it to your agent.</p>';

  let last = null;
  let poll = null;
  let unsaveHandler = null;

  // Paint a saved payload. Returns nothing; skips if unchanged or mid-reply.
  function paintSaved(box, data) {
    revealView();
    const entries = data.entries || [];
    const key = JSON.stringify(entries);
    if (key === last) return; // unchanged
    if (last !== null && window.gzTweet.busy(box)) return; // mid-reply: catch up next tick
    last = key;
    // Keep the shared saved-set in sync so bookmarks elsewhere agree.
    if (window.gzSaved && data.ids) {
      for (let i = 0; i < data.ids.length; i++) window.gzSaved.set(data.ids[i], true);
    }
    if (entries.length === 0) {
      box.innerHTML = EMPTY;
      return;
    }
    // Render each entry already flagged saved so the bookmark shows filled.
    box.innerHTML = entries
      .map(function (e) { return window.gzTweet.cardHTML(Object.assign({ saved: true }, e)); })
      .join("");
  }

  async function load() {
    const box = document.getElementById("saved");
    if (!box) return;
    window.gzTweet.wire(box);
    let data;
    try {
      const r = await window.gzFetch("/api/save");
      data = await r.json();
    } catch (err) {
      if (err && err.gzGated) return; // wall raised
      if (last === null) box.innerHTML = '<p class="muted">Your saved list slipped away for a second. It will be back.</p>';
      return;
    }
    if (window.gzCache) window.gzCache.set("saved", data);
    paintSaved(box, data);
  }

  // SWR: paint the last good saved list immediately on cold load, then the poll
  // revalidates and repaints only if it changed. Cards render static (no entry
  // animation here to begin with), so the instant paint is not a cascade.
  function paintFromCache() {
    if (!window.gzCache) return;
    const box = document.getElementById("saved");
    if (!box) return;
    const data = window.gzCache.get("saved", 10 * 60 * 1000);
    if (!data) return;
    window.gzTweet.wire(box);
    paintSaved(box, data);
  }

  // Unsaving a card removes it from this list immediately (tweet.js fires tw-unsaved
  // on the card when the server confirms the unsave). Reset the render cache so the
  // next poll does not treat the shorter list as unchanged.
  function wireUnsave() {
    const box = document.getElementById("saved");
    if (!box) return;
    unsaveHandler = function (ev) {
      const card = ev.target && ev.target.closest ? ev.target.closest(".tweet") : null;
      if (card && card.parentNode) card.parentNode.removeChild(card);
      last = null;
      if (!box.querySelector(".tweet")) box.innerHTML = EMPTY;
    };
    box.addEventListener("tw-unsaved", unsaveHandler);
  }

  // ---- lifecycle ----------------------------------------------------------
  function boot() {
    // No token at all: show the login wall immediately, no round trip.
    if (!(window.gzMaybeAuthed ? window.gzMaybeAuthed() : window.gzToken())) {
      window.gzShowWall({ mode: "login" });
      return;
    }
    last = null;
    wireUnsave();
    paintFromCache();
    poll = window.gzLivePoll(load);
  }

  function mount(rootEl) {
    if (rootEl) rootEl.innerHTML = SKELETON;
    boot();
  }

  function unmount() {
    if (poll && poll.stop) poll.stop();
    poll = null;
    // The saved box is discarded on center-column swap, so the tw-unsaved listener
    // dies with it; clear the reference for tidiness.
    unsaveHandler = null;
  }

  window.gzPages = window.gzPages || {};
  window.gzPages.saved = { mount: mount, unmount: unmount };

  function isEntry() {
    return !!document.getElementById("saved-view") && !document.getElementById("root");
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
