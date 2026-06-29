/**
 * OnlyOffice editor bootstrap: forcesave on close and before leaving the page.
 * Expects window.__ncOnlyOfficeConfig (object) from the host template.
 */
(function () {
  "use strict";

  const cfg = window.__ncOnlyOfficeConfig;
  if (!cfg || typeof DocsAPI === "undefined") return;

  let docEditor = null;
  let hasUnsavedChanges = false;
  let closing = false;
  let releaseEditSessionFn = null;

  function nudgeEditorLayout() {
    try {
      if (typeof window.ncSyncViewerOffsetsSoon === "function") {
        window.ncSyncViewerOffsetsSoon();
      }
    } catch (_) {
      /* ignore */
    }
    try {
      window.dispatchEvent(new Event("resize"));
    } catch (_) {
      /* ignore */
    }
  }

  cfg.events = cfg.events || {};
  const prevReady = cfg.events.onDocumentReady;
  cfg.events.onDocumentReady = function () {
    nudgeEditorLayout();
    [120, 400, 1200].forEach(function (ms) {
      window.setTimeout(nudgeEditorLayout, ms);
    });
    if (typeof prevReady === "function") {
      try {
        prevReady();
      } catch (_) {
        /* ignore */
      }
    }
  };

  const prevState = cfg.events.onDocumentStateChange;
  cfg.events.onDocumentStateChange = function (event) {
    hasUnsavedChanges = !!event.data;
    if (typeof prevState === "function") {
      try {
        prevState(event);
      } catch (_) {
        /* ignore */
      }
    }
  };

  docEditor = new DocsAPI.DocEditor("onlyoffice-editor", cfg);

  function triggerForceSave() {
    if (!docEditor) return;
    try {
      docEditor.serviceCommand("forcesave", "");
    } catch (_) {
      /* ignore */
    }
  }

  function destroyAndGo(href) {
    if (typeof releaseEditSessionFn === "function") releaseEditSessionFn();
    try {
      if (docEditor) docEditor.destroyEditor();
    } catch (_) {
      /* ignore */
    }
    window.setTimeout(function () {
      window.location.href = href;
    }, hasUnsavedChanges ? 800 : 0);
  }

  const closeEl = document.querySelector(".nc-onlyoffice-close");
  const closeHref = closeEl && closeEl.getAttribute("href");
  if (closeEl && closeHref) {
    closeEl.addEventListener("click", function (e) {
      e.preventDefault();
      if (closing) return;
      closing = true;
      if (hasUnsavedChanges) triggerForceSave();
      const maxWait = 15000;
      const step = 350;
      let waited = 0;
      const poll = window.setInterval(function () {
        waited += step;
        if (!hasUnsavedChanges || waited >= maxWait) {
          window.clearInterval(poll);
          destroyAndGo(closeHref);
        }
      }, step);
    });
  }

  window.addEventListener("beforeunload", function () {
    if (closing || !hasUnsavedChanges) return;
    triggerForceSave();
  });

  window.addEventListener("resize", nudgeEditorLayout);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", nudgeEditorLayout, { once: true });
  } else {
    nudgeEditorLayout();
  }

  (function bindEditSessionPresence() {
    const es = window.__ncEditSession;
    if (!es || !es.track || !es.nodeId) return;
    const base = String(es.apiBase || "/files").replace(/\/$/, "");
    const url = `${base}/api/edit-session/${encodeURIComponent(String(es.nodeId))}`;
    let released = false;

    function touch() {
      if (released) return;
      fetch(url, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
      }).catch(function () {});
    }

    function release() {
      if (released) return;
      released = true;
      fetch(url, { method: "DELETE", credentials: "same-origin", keepalive: true }).catch(function () {});
    }

    releaseEditSessionFn = release;
    touch();
    const heartbeat = window.setInterval(touch, 25000);
    window.addEventListener("pagehide", function () {
      window.clearInterval(heartbeat);
      release();
    });
  })();
})();
