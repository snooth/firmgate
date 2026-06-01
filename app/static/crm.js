(function () {
  function crmShellFlags() {
    const app = document.querySelector(".nc-intranet-app");
    if (!app) return { read: false, create: false, delete: false };
    return {
      read: app.getAttribute("data-crm-can-read") === "1",
      create: app.getAttribute("data-crm-can-create") === "1",
      delete: app.getAttribute("data-crm-can-delete") === "1",
    };
  }

  function crmCanCreate() {
    return crmShellFlags().create;
  }

  const viewer = document.getElementById("crm-viewer");
  const frame = document.getElementById("crm-frame");
  const closeBtn = document.getElementById("crm-close");
  const titleEl = document.getElementById("crm-title");

  const newLeadDrawer = document.getElementById("crm-new-lead-drawer");
  const newLeadBackdrop = document.getElementById("crm-new-lead-backdrop");
  const newLeadCloseBtn = document.getElementById("crm-new-lead-close");
  const newLeadIframe = document.getElementById("crm-new-lead-frame");

  const leadDetailDrawer = document.getElementById("crm-lead-detail-drawer");
  const leadDetailBackdrop = document.getElementById("crm-lead-detail-backdrop");
  const leadDetailCloseBtn = document.getElementById("crm-lead-detail-close");
  const leadDetailIframe = document.getElementById("crm-lead-detail-frame");
  const leadDetailTitleEl = document.getElementById("crm-lead-detail-sheet-title");

  const comingSoonDlg = document.getElementById("crm-coming-soon-dialog");
  const comingSoonCloseBtn = document.getElementById("crm-coming-soon-close");

  function normPath(pathname) {
    const p = String(pathname || "");
    return p.replace(/\/+$/, "") || "/";
  }

  function isNewLeadPath(pathname) {
    return normPath(pathname) === "/intranet/crm/leads/new";
  }

  function buildLeadPanelUrl(leadId) {
    const u = new URL(`/intranet/crm/leads/${leadId}/panel`, window.location.origin);
    u.searchParams.set("embed", "1");
    u.searchParams.set("inline", "1");
    return u.toString();
  }

  function mergeHistoryState() {
    const st = history.state;
    return st && typeof st === "object" && !Array.isArray(st) ? { ...st } : {};
  }

  function pushCrmSheet(sheetPayload) {
    const base = mergeHistoryState();
    delete base.crmSheet;
    history.pushState({ ...base, crmSheet: sheetPayload }, "", window.location.href);
  }

  function syncCrmSheetsFromHistoryState(st) {
    const state = st && typeof st === "object" ? st : {};
    const sheet = state.crmSheet;

    const showNew = !!(sheet && sheet.type === "newLead");
    const showDetail =
      !!(sheet && sheet.type === "leadDetail" && sheet.leadId != null && String(sheet.leadId).trim() !== "");

    if (newLeadDrawer && newLeadIframe) {
      if (showNew && !crmCanCreate()) {
        newLeadDrawer.hidden = true;
        newLeadIframe.src = "about:blank";
        try {
          const base = mergeHistoryState();
          delete base.crmSheet;
          history.replaceState(Object.keys(base).length ? base : {}, "", window.location.href);
        } catch {
          /* ignore */
        }
      } else if (showNew) {
        newLeadIframe.src = buildNewLeadInlineUrl();
        newLeadDrawer.hidden = false;
      } else if (!newLeadDrawer.hidden) {
        newLeadDrawer.hidden = true;
        newLeadIframe.src = "about:blank";
      }
    }

    if (leadDetailDrawer && leadDetailIframe) {
      if (showDetail) {
        const id = String(sheet.leadId);
        leadDetailIframe.src = buildLeadPanelUrl(id);
        leadDetailDrawer.hidden = false;
        if (leadDetailTitleEl && sheet.title) leadDetailTitleEl.textContent = String(sheet.title);
      } else if (!leadDetailDrawer.hidden) {
        leadDetailDrawer.hidden = true;
        leadDetailIframe.src = "about:blank";
      }
    }
  }

  function dismissLeadDetailViaHistory() {
    const st = history.state;
    if (st && st.crmSheet && st.crmSheet.type === "leadDetail") {
      try {
        history.back();
      } catch {
        const base = mergeHistoryState();
        delete base.crmSheet;
        history.replaceState(
          Object.keys(base).length ? base : {},
          "",
          window.location.href
        );
        syncCrmSheetsFromHistoryState(history.state || {});
      }
      return;
    }
    if (leadDetailDrawer) {
      leadDetailDrawer.hidden = true;
      leadDetailIframe.src = "about:blank";
    }
  }

  function dismissNewLeadViaHistory() {
    const st = history.state;
    if (st && st.crmSheet && st.crmSheet.type === "newLead") {
      try {
        history.back();
      } catch {
        const base = mergeHistoryState();
        delete base.crmSheet;
        history.replaceState(
          Object.keys(base).length ? base : {},
          "",
          window.location.href
        );
        syncCrmSheetsFromHistoryState(history.state || {});
      }
      return;
    }
    if (newLeadDrawer) {
      newLeadDrawer.hidden = true;
      newLeadIframe.src = "about:blank";
    }
  }

  function setTitle(t) {
    if (!titleEl) return;
    titleEl.textContent = String(t || "CRM");
  }

  function openViewer(url, { title, pushHistory = true } = {}) {
    if (!viewer || !frame || !url) return;
    const u = new URL(url, window.location.origin);
    u.searchParams.set("embed", "1");
    frame.src = u.toString();
    viewer.hidden = false;
    setTitle(title || "CRM");

    if (pushHistory) {
      const base = mergeHistoryState();
      delete base.crmSheet;
      history.pushState({ ...base, viewer: { kind: "crm", url: u.toString(), title: title || "CRM" } }, "", window.location.href);
    }
  }

  function closeViewer({ popHistory = true } = {}) {
    if (!viewer || !frame) return;
    viewer.hidden = true;
    frame.src = "about:blank";
    if (popHistory && history.state && history.state.viewer && history.state.viewer.kind === "crm") {
      try {
        history.back();
      } catch {
        /* ignore */
      }
    }
  }

  function buildNewLeadInlineUrl() {
    const u = new URL("/intranet/crm/leads/new", window.location.origin);
    u.searchParams.set("embed", "1");
    u.searchParams.set("inline", "1");
    return u.toString();
  }

  function openNewLeadDrawer() {
    if (!crmCanCreate()) return;
    if (newLeadDrawer && newLeadIframe) {
      pushCrmSheet({ type: "newLead" });
      newLeadIframe.src = buildNewLeadInlineUrl();
      newLeadDrawer.hidden = false;
      return;
    }
    openViewer("/intranet/crm/leads/new", { title: "New lead" });
  }

  function closeNewLeadDrawer() {
    dismissNewLeadViaHistory();
  }

  function openLeadDetailDrawer(leadId, displayName) {
    if (!leadDetailDrawer || !leadDetailIframe) return false;
    pushCrmSheet({
      type: "leadDetail",
      leadId: String(leadId),
      title: displayName || "Lead",
    });
    if (leadDetailTitleEl) leadDetailTitleEl.textContent = displayName || "Lead";
    leadDetailIframe.src = buildLeadPanelUrl(leadId);
    leadDetailDrawer.hidden = false;
    return true;
  }

  function closeLeadDetailDrawer() {
    dismissLeadDetailViaHistory();
  }

  if (newLeadBackdrop) newLeadBackdrop.addEventListener("click", dismissNewLeadViaHistory);
  if (newLeadCloseBtn) newLeadCloseBtn.addEventListener("click", dismissNewLeadViaHistory);

  window.addEventListener("message", (e) => {
    if (e.origin !== window.location.origin) return;
    const d = e.data;
    if (!d || typeof d !== "object") return;
    if (d.kind === "nc-crm-new-lead-saved" || d.kind === "nc-crm-new-lead-cancel") {
      dismissNewLeadViaHistory();
    }
  });

  if (leadDetailBackdrop) leadDetailBackdrop.addEventListener("click", dismissLeadDetailViaHistory);
  if (leadDetailCloseBtn) leadDetailCloseBtn.addEventListener("click", dismissLeadDetailViaHistory);

  function onLeadPanelLinkClick(e) {
    const a =
      e.target && typeof e.target.closest === "function" ? e.target.closest("a[data-crm-lead-panel]") : null;
    if (!a) return;
    if (
      e.button !== 0 ||
      e.ctrlKey ||
      e.metaKey ||
      e.shiftKey ||
      e.altKey ||
      a.target === "_blank"
    )
      return;
    if (!leadDetailDrawer || !leadDetailIframe) return;
    e.preventDefault();
    const leadId = a.getAttribute("data-lead-id");
    if (!leadId) return;
    const name = (a.getAttribute("data-lead-name") || "").trim();
    const label =
      name ||
      (a.textContent || "")
        .replace(/\s+/g, " ")
        .trim() ||
      "Lead";
    openLeadDetailDrawer(leadId, label);
  }

  function onClickLink(e) {
    const a = e.target && e.target.closest ? e.target.closest("a") : null;
    if (!a) return;
    if (a.target === "_blank" || a.download) return;
    const href = a.getAttribute("href") || "";
    if (!href || href.startsWith("#")) return;
    let path = "";
    try {
      path = new URL(href, window.location.origin).pathname || "";
    } catch {
      return;
    }
    if (!path.startsWith("/intranet/crm")) return;

    if (window.self !== window.top) return;

    if (document.getElementById("nc-crm-root")) return;

    e.preventDefault();
    openViewer(href, { title: a.textContent && a.textContent.trim() ? a.textContent.trim() : "CRM" });
  }

  function onClickOpen(e) {
    const el = e.target && e.target.closest ? e.target.closest("[data-crm-open]") : null;
    if (!el) return;
    const href = el.getAttribute("data-crm-open") || "";
    if (!href) return;
    e.preventDefault();

    try {
      const path = new URL(href, window.location.origin).pathname;
      if (isNewLeadPath(path)) {
        openNewLeadDrawer();
        return;
      }
    } catch {
      /* fallback below */
    }

    if (document.getElementById("nc-crm-root")) {
      const u = new URL(href, window.location.origin);
      try {
        if (new URLSearchParams(window.location.search).get("embed") === "1") {
          u.searchParams.set("embed", "1");
        }
      } catch {
        /* ignore */
      }
      window.location.assign(u.toString());
      return;
    }

    openViewer(href, { title: "CRM" });
  }

  document.addEventListener("click", onLeadPanelLinkClick);
  document.addEventListener("click", onClickLink);
  document.addEventListener("click", onClickOpen);

  function openComingSoonModal() {
    if (!comingSoonDlg) return;
    try {
      comingSoonDlg.showModal();
    } catch {
      /* ignore */
    }
  }

  function closeComingSoonModal() {
    if (!comingSoonDlg) return;
    try {
      comingSoonDlg.close();
    } catch {
      /* ignore */
    }
  }

  if (comingSoonCloseBtn) comingSoonCloseBtn.addEventListener("click", closeComingSoonModal);
  if (comingSoonDlg) {
    comingSoonDlg.addEventListener("click", (e) => {
      if (e.target === comingSoonDlg) closeComingSoonModal();
    });
  }

  document.addEventListener(
    "click",
    (e) => {
      const el = e.target && e.target.closest ? e.target.closest("[data-crm-coming-soon]") : null;
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      openComingSoonModal();
    },
    true
  );

  if (closeBtn) closeBtn.addEventListener("click", () => closeViewer());

  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (comingSoonDlg && comingSoonDlg.open) return;
    if (leadDetailDrawer && !leadDetailDrawer.hidden) {
      dismissLeadDetailViaHistory();
      return;
    }
    if (newLeadDrawer && !newLeadDrawer.hidden) {
      dismissNewLeadViaHistory();
      return;
    }
    if (viewer && !viewer.hidden) closeViewer({ popHistory: false });
  });

  syncCrmSheetsFromHistoryState(history.state || {});

  window.addEventListener("popstate", () => {
    const st = history.state || {};

    /* Drawers synced to history.session so browser Back restores the underlying CRM view */
    syncCrmSheetsFromHistoryState(st);

    if (!viewer || !frame) return;
    const v = st.viewer;
    if (v && v.kind === "crm") {
      openViewer(v.url, { title: v.title || "CRM", pushHistory: false });
      return;
    }
    if (!viewer.hidden) closeViewer({ popHistory: false });
  });

  /* Leads search: navigates to /crm/leads?q=… */
  const leadsQ = document.getElementById("crm-leads-q");
  if (leadsQ) {
    let t = null;
    leadsQ.addEventListener("input", () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        const q = String(leadsQ.value || "").trim();
        const u = new URL(window.location.href);
        if (q) u.searchParams.set("q", q);
        else u.searchParams.delete("q");
        window.location.href = u.toString();
      }, 250);
    });
  }
})();
