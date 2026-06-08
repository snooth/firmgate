/** Games hub — Chess, Lemmings, Sky Control. */
(function () {
  const hub = document.querySelector(".nc-game-hub");
  if (!hub) return;

  const root = document.getElementById("nc-game-lobby");
  const tabs = hub.querySelectorAll(".nc-game-hub-tab[data-game]");
  const panels = {
    chess: document.getElementById("nc-game-panel-chess"),
    lemmings: document.getElementById("nc-game-panel-lemmings"),
    "flight-sim": document.getElementById("nc-game-panel-flight-sim"),
  };

  const GAME_IDS = ["chess", "lemmings", "flight-sim"];

  let lemmingsLoaded = false;

  function bootLemmings() {
    if (lemmingsLoaded) return;
    const iframe = document.getElementById("lemmings-frame");
    const url = root && root.getAttribute("data-lemmings-url");
    if (!iframe || !url) return;
    iframe.src = url;
    lemmingsLoaded = true;
  }

  function show(game) {
    const id = GAME_IDS.includes(game) ? game : "chess";
    tabs.forEach((t) => {
      const on = t.getAttribute("data-game") === id;
      t.classList.toggle("is-active", on);
      if (on) t.setAttribute("aria-current", "page");
      else t.removeAttribute("aria-current");
    });
    Object.keys(panels).forEach((key) => {
      const panel = panels[key];
      if (panel) panel.hidden = key !== id;
    });
    if (id === "lemmings") bootLemmings();
    if (id === "flight-sim" && typeof window.ncSkyControlRefreshLeaderboard === "function") {
      window.ncSkyControlRefreshLeaderboard();
    }
  }

  tabs.forEach((t) => {
    t.addEventListener("click", () => {
      const g = t.getAttribute("data-game");
      if (!g) return;
      show(g);
      try {
        const url = new URL(window.location.href);
        url.hash = g === "chess" ? "" : g;
        history.replaceState(null, "", url.pathname + url.search + url.hash);
      } catch (_) {}
    });
  });

  const hashGame = (window.location.hash || "").replace(/^#/, "").toLowerCase();
  show(GAME_IDS.includes(hashGame) ? hashGame : "chess");
})();
