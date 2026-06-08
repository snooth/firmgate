(function () {
  "use strict";

  const STORAGE_KEY = "firmgate.intranetSidebarCollapsed";

  /** Read active section from a document (current or incoming Turbo response). */
  function readNavActiveKey(doc) {
    const root = doc || document;
    const app = root.getElementById("nc-intranet-app");
    if (app && app.dataset.intranetNavActive) {
      return app.dataset.intranetNavActive;
    }
    const marker = root.querySelector("[data-intranet-nav-active]");
    return marker ? marker.dataset.intranetNavActive || "" : "";
  }

  /** Sidebar is turbo-permanent; strip legacy sub-item styling from AI Chatbot only. */
  function normalizeSidebarNavTabs() {
    const nav = document.querySelector(".nc-intranet-sidebar-nav");
    if (!nav) return;
    nav.querySelectorAll('.nc-intranet-tab[data-nav-key="ai_chatbot"]').forEach((tab) => {
      tab.classList.remove("nc-intranet-tab--sub");
    });
  }

  function syncIntranetNavActive(activeKey) {
    const key =
      activeKey !== undefined && activeKey !== null
        ? String(activeKey)
        : readNavActiveKey(document);
    const nav = document.querySelector(".nc-intranet-sidebar-nav");
    if (!nav) return;
    normalizeSidebarNavTabs();
    nav.querySelectorAll(".nc-intranet-tab[data-nav-key]").forEach((tab) => {
      const on = tab.dataset.navKey === key;
      tab.classList.toggle("is-active", on);
      if (on) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    });
  }

  function sidebarToggle() {
    return document.getElementById("nc-intranet-sidebar-toggle");
  }

  function isCollapsed() {
    return document.documentElement.classList.contains("nc-intranet-sidebar-collapsed");
  }

  function syncCollapsedNavLabels(collapsed) {
    document
      .querySelectorAll(".nc-intranet-tab-enterprise, .nc-intranet-tab-text, .nc-intranet-nav-section-label")
      .forEach((el) => {
        el.hidden = collapsed;
      });
  }

  function applyCollapsed(collapsed) {
    const sidebar = document.getElementById("nc-intranet-sidebar");
    document.documentElement.classList.toggle("nc-intranet-sidebar-collapsed", collapsed);
    syncCollapsedNavLabels(collapsed);
    document.documentElement.style.removeProperty("--nc-intranet-sidebar-w");
    if (sidebar) {
      sidebar.classList.toggle("is-collapsed", collapsed);
      sidebar.setAttribute("aria-expanded", collapsed ? "false" : "true");
    }
    const btn = sidebarToggle();
    if (btn) {
      btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
      btn.setAttribute("aria-label", collapsed ? "Expand navigation" : "Collapse navigation");
      btn.title = collapsed ? "Expand navigation" : "Collapse navigation";
    }
    const syncLayout = () => {
      if (typeof window.ncSyncViewerOffsetsSoon === "function") {
        window.ncSyncViewerOffsetsSoon();
      }
    };
    syncLayout();
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(syncLayout);
    });
  }

  function readStored() {
    try {
      return window.localStorage.getItem(STORAGE_KEY) === "1";
    } catch (_e) {
      return false;
    }
  }

  function store(collapsed) {
    try {
      window.localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
    } catch (_e) {}
  }

  function init() {
    syncIntranetNavActive();
    const btn = sidebarToggle();
    if (!btn) return;
    applyCollapsed(readStored());
    if (btn.dataset.wired === "1") return;
    btn.dataset.wired = "1";
    btn.addEventListener("click", () => {
      const next = !isCollapsed();
      applyCollapsed(next);
      store(next);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
  document.addEventListener("turbo:load", init);

  document.addEventListener("turbo:before-render", (event) => {
    const key = readNavActiveKey(event.detail.newBody);
    syncIntranetNavActive(key);
  });
})();
