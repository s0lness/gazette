// Shared liveness helpers for gazette. Dependency-free.
// - gzLivePoll(fn): poll every 12s while visible, refetch on focus/visibility,
//   pause while hidden. The edge cache (s-maxage=15) absorbs the extra polling.
// - gzRelTime(iso): "just now / 3m / 2h / 1d / 3d", falling back to the date for
//   anything older than a week.
// - gzTime(iso, fallback): a <span class="reltime" data-ts="..."> that a local
//   timer re-derives every 30s, no network fetch.
// - gzReduceMotion(): honours prefers-reduced-motion.
(function () {
  function gzReduceMotion() {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  }

  // Human relative time from an ISO timestamp. Ticks locally; no fetch.
  function gzRelTime(iso) {
    const t = Date.parse(iso);
    if (isNaN(t)) return "";
    const secs = Math.floor((Date.now() - t) / 1000);
    if (secs < 45) return "just now";
    const mins = Math.floor(secs / 60);
    if (mins < 60) return mins + "m";
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + "h";
    const days = Math.floor(hours / 24);
    if (days <= 7) return days + "d";
    // Older than a week: the calendar date reads better than "42d".
    const d = new Date(t);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  // A time chip that a local timer keeps fresh. `iso` drives the relative text;
  // `fallback` is shown when there is no usable timestamp (e.g. a bare date).
  function gzTime(iso, fallback) {
    if (!iso) return escAttr(fallback == null ? "" : fallback);
    return (
      '<span class="reltime" data-ts="' +
      escAttr(iso) +
      '" title="' +
      escAttr(iso) +
      '">' +
      escAttr(gzRelTime(iso)) +
      "</span>"
    );
  }

  function escAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Re-derive every visible relative timestamp from its data-ts. Runs on a 30s
  // local timer so the feed keeps ticking without any network traffic.
  function refreshTimes() {
    const nodes = document.querySelectorAll(".reltime[data-ts]");
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const txt = gzRelTime(el.getAttribute("data-ts"));
      if (el.textContent !== txt) el.textContent = txt;
    }
  }
  setInterval(refreshTimes, 30000);

  // Live polling: refresh now, then every 12s while visible; also on tab focus
  // and on regaining visibility. Pause while hidden. fn must be idempotent and
  // swallow its own fetch errors.
  function gzLivePoll(fn) {
    let timer = null;
    function start() {
      if (timer === null) timer = setInterval(fn, 12000);
    }
    function stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    }
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        stop();
      } else {
        fn();
        start();
      }
    });
    window.addEventListener("focus", fn);
    fn();
    if (!document.hidden) start();
  }

  window.gzRelTime = gzRelTime;
  window.gzTime = gzTime;
  window.gzLivePoll = gzLivePoll;
  window.gzReduceMotion = gzReduceMotion;
  window.gzRefreshTimes = refreshTimes;
})();
