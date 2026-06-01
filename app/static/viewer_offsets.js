(function () {
  function computeViewerTopPx() {
    try {
      // Intranet pages have their own top chrome; overlays must sit below it.
      // Use the chrome/tabs bottom so scrolling doesn't collapse the offset to 0.
      const chrome =
        document.querySelector(".nc-intranet-tabs") ||
        document.querySelector(".nc-intranet-top") ||
        document.querySelector(".nc-intranet-shell");
      if (chrome) {
        const r = chrome.getBoundingClientRect();
        if (Number.isFinite(r.bottom)) return Math.max(0, Math.round(r.bottom));
      }

      // Fallback: intranet body top (may vary with scroll; keep for legacy layouts).
      const intranetBody = document.querySelector(".nc-intranet-body");
      if (intranetBody) {
        const r = intranetBody.getBoundingClientRect();
        if (Number.isFinite(r.top)) return Math.max(0, Math.round(r.top));
      }
    } catch (_) {}

    try {
      // Non-intranet pages use the legacy top header.
      const header = document.querySelector(".nc-header");
      if (header) {
        const r = header.getBoundingClientRect();
        if (Number.isFinite(r.bottom)) return Math.max(0, Math.round(r.bottom));
      }
    } catch (_) {}
    return 0;
  }

  function computeViewerBottomPx() {
    const H = window.innerHeight || 0;
    let best = null;
    try {
      const footers = Array.from(document.querySelectorAll(".nc-footer"));
      for (const f of footers) {
        if (!f) continue;
        const r = f.getBoundingClientRect();
        // Pick the footer that visually sits at the bottom of the viewport.
        const dist = Math.abs((r.bottom || 0) - H);
        if (best == null || dist < best.dist) best = { el: f, rect: r, dist };
      }
    } catch (_) {}
    if (!best || !best.rect) return 0;
    const h = Math.max(0, Math.round(best.rect.height || 0));
    // If footer isn't actually at the bottom, don't reserve space.
    if (best.dist > 24) return 0;
    return h;
  }

  function syncViewerOffsets() {
    try {
      const topPx = computeViewerTopPx();
      const bottomPx = computeViewerBottomPx();
      document.documentElement.style.setProperty("--nc-viewer-top", `${topPx}px`);
      document.documentElement.style.setProperty("--nc-viewer-bottom", `${bottomPx}px`);
    } catch (_) {}

    // Also expose measured intranet chrome heights for sticky header layout.
    try {
      const top = document.querySelector(".nc-intranet-top");
      const tabs = document.querySelector(".nc-intranet-tabs");
      if (top) document.documentElement.style.setProperty("--nc-intranet-top-h", `${Math.round(top.offsetHeight || 0)}px`);
      if (tabs) document.documentElement.style.setProperty("--nc-intranet-tabs-h", `${Math.round(tabs.offsetHeight || 0)}px`);
    } catch (_) {}
  }

  let raf = 0;
  function syncViewerOffsetsSoon() {
    if (raf) return;
    raf = window.requestAnimationFrame(() => {
      raf = 0;
      syncViewerOffsets();
    });
  }

  // Expose a stable API for any page-specific JS.
  window.ncSyncViewerOffsets = syncViewerOffsets;
  window.ncSyncViewerOffsetsSoon = syncViewerOffsetsSoon;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => syncViewerOffsetsSoon(), { once: true });
  } else {
    syncViewerOffsetsSoon();
  }
  window.addEventListener("resize", syncViewerOffsetsSoon);
  window.addEventListener("scroll", syncViewerOffsetsSoon, { passive: true });
})();

