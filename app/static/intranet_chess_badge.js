/** Chess in-game chat unread count on intranet Game nav tab (red badge). */
(function () {
  const badge = document.getElementById("nc-intranet-tab-badge-game");
  if (!badge) return;

  const tab = badge.closest(".nc-intranet-tab");
  const POLL_MS = 5000;
  let timer = null;

  function setCount(n) {
    const total = Math.max(0, Number(n) || 0);
    if (total <= 0) {
      badge.hidden = true;
      badge.textContent = "0";
      badge.removeAttribute("aria-label");
      if (tab) tab.removeAttribute("data-unread");
      return;
    }
    const shown = total > 99 ? "99+" : String(total);
    badge.hidden = false;
    badge.textContent = shown;
    badge.setAttribute("aria-label", `${total} unread chess message${total === 1 ? "" : "s"}`);
    if (tab) tab.setAttribute("data-unread", String(total));
  }

  async function refresh() {
    try {
      const r = await fetch("/intranet/api/chess/chat/unread", {
        method: "GET",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (!r.ok) return;
      const j = await r.json().catch(() => ({}));
      setCount(j && j.total);
      if (typeof window.ncChessLobbyRefresh === "function") {
        window.ncChessLobbyRefresh();
      }
    } catch (_) {
      /* ignore */
    }
  }

  function start() {
    if (timer) window.clearInterval(timer);
    refresh();
    timer = window.setInterval(refresh, POLL_MS);
  }

  function stop() {
    if (timer) {
      window.clearInterval(timer);
      timer = null;
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") stop();
    else start();
  });

  window.ncChessNavBadge = { refresh, setCount };

  start();
})();
