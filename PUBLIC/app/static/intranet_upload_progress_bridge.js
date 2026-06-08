/**
 * Intranet header upload bar — listens for in-page upload manager events (and legacy popup messages).
 */
(function () {
  if (!document.body || !document.body.classList.contains("nc-page-intranet")) return;
  if (window.__ncUploadBridgeInit) return;
  window.__ncUploadBridgeInit = true;

  const origin = window.location.origin;
  let uploadProgressHideTimer = null;

  function refEl(id) {
    return document.getElementById(id);
  }

  function setUploadProgressVisible(visible) {
    const el = refEl("upload-progress");
    if (!el) return;
    el.hidden = !visible;
  }

  function updateUploadProgressUi(pct, label, detail) {
    const p = Math.min(100, Math.max(0, Number(pct) || 0));
    const fill = refEl("upload-progress-fill");
    const track = refEl("upload-progress-track");
    const labelEl = refEl("upload-progress-label");
    const detailEl = refEl("upload-progress-detail");
    if (fill) fill.style.width = `${p}%`;
    if (track) track.setAttribute("aria-valuenow", String(Math.round(p)));
    if (labelEl && label != null) labelEl.textContent = label;
    if (detailEl && detail != null) detailEl.textContent = detail || "";
  }

  function scheduleHide(delayMs) {
    if (uploadProgressHideTimer) clearTimeout(uploadProgressHideTimer);
    uploadProgressHideTimer = setTimeout(() => {
      uploadProgressHideTimer = null;
      setUploadProgressVisible(false);
      updateUploadProgressUi(0, "Uploading…", "");
    }, delayMs);
  }

  function setStatus(msg) {
    const st = refEl("status");
    if (st) st.textContent = msg || "";
  }

  function fmtSize(n) {
    if (n == null || n === "") return "—";
    const x = Number(n);
    if (!Number.isFinite(x)) return "—";
    if (x < 1024) return `${x} B`;
    if (x < 1024 * 1024) return `${(x / 1024).toFixed(1)} KB`;
    return `${(x / 1024 / 1024).toFixed(1)} MB`;
  }

  function fmtLocalFromMs(ms) {
    if (ms == null || Number.isNaN(ms)) return "—";
    try {
      return new Date(ms).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" });
    } catch {
      return "—";
    }
  }

  function fmtLocalFromIso(iso) {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" });
    } catch {
      return "—";
    }
  }

  function showUploadSummaryFromPayload(d) {
    if (typeof window.ncShowUploadSummaryDialog !== "function") return;
    const uploaded = Math.max(0, Number(d.uploaded) || 0);
    const skipped = Math.max(0, Number(d.skipped) || 0);
    const failed = Math.max(0, Number(d.failed) || 0);
    const total = Math.max(0, Number(d.totalFiles) || 0);
    if (!(uploaded || skipped || failed || total)) return;
    window.ncShowUploadSummaryDialog({
      uploaded,
      skipped,
      failed,
      total,
      folderCount: Math.max(0, Number(d.folderCount) || 0),
      mode: d.uploadMode === "folder" ? "folder" : "files",
      partial: !!d.partial || failed > 0,
      cancelled: d.phase === "cancelled",
      lastError: d.lastError || "",
    });
  }

  function showUploadConflictDialog(existing, incoming, canReplace) {
    return new Promise((resolve) => {
      const dlg = refEl("dlg-upload-conflict");
      const btnReplace = refEl("btn-uconflict-replace");
      const btnKeep = refEl("btn-uconflict-keep");
      const btnCancel = refEl("btn-uconflict-cancel");
      const hint = refEl("uconflict-readonly-hint");
      if (!dlg || !btnReplace || !btnKeep || !btnCancel) {
        resolve("cancel");
        return;
      }

      const done = (choice) => {
        try {
          dlg.close();
        } catch {
          /* ignore */
        }
        resolve(choice);
      };

      refEl("uconflict-existing-name").textContent = (existing && existing.name) || "—";
      refEl("uconflict-existing-size").textContent = fmtSize(existing && existing.size_bytes);
      refEl("uconflict-existing-date").textContent = fmtLocalFromIso(existing && existing.updated_at);

      const inName = (incoming && incoming.name) || "—";
      refEl("uconflict-new-name").textContent = inName;
      refEl("uconflict-new-size").textContent = fmtSize(incoming && incoming.size);
      refEl("uconflict-new-date").textContent = fmtLocalFromMs(incoming && incoming.lastModified);

      if (hint) hint.hidden = canReplace !== false;
      btnReplace.hidden = !canReplace;
      btnReplace.disabled = !canReplace;

      btnReplace.addEventListener("click", () => done("replace"), { once: true });
      btnKeep.addEventListener("click", () => done("keep"), { once: true });
      btnCancel.addEventListener("click", () => done("cancel"), { once: true });
      dlg.addEventListener("cancel", () => done("cancel"), { once: true });

      dlg.showModal();
    });
  }

  function handleUploadPayload(d) {
    if (!d || !d.phase) return;

    if (d.phase === "progress") {
      window.__ncBgUploadActive = true;
      setUploadProgressVisible(true);
      updateUploadProgressUi(d.pct, d.label, d.detail);
      return;
    }
    if (d.phase === "done" || d.phase === "cancelled") {
      window.__ncBgUploadActive = false;
      if (d.status) setStatus(d.status);
      let title = d.phase === "cancelled" ? "Upload stopped" : "Upload complete";
      if (d.phase === "done" && d.partial) title = "Upload finished with errors";
      if (d.uploadMode === "folder" && d.phase === "done" && !d.partial) title = "Folder upload complete";
      updateUploadProgressUi(100, title, d.detail || "");
      if (d.showSummary !== false) showUploadSummaryFromPayload(d);
      if (d.reload) {
        try {
          document.dispatchEvent(new CustomEvent("nc-filebrowser-reload"));
        } catch {
          /* ignore */
        }
      }
      if (d.delayHideMs != null) scheduleHide(d.delayHideMs);
      return;
    }
    if (d.phase === "error") {
      window.__ncBgUploadActive = false;
      if (d.message) setStatus(d.message);
      updateUploadProgressUi(0, "Upload failed", d.message || "");
      if (d.reload) {
        try {
          document.dispatchEvent(new CustomEvent("nc-filebrowser-reload"));
        } catch {
          /* ignore */
        }
      }
      if (d.delayHideMs != null) scheduleHide(d.delayHideMs);
    }
  }

  const dismiss = refEl("upload-progress-dismiss");
  if (dismiss && !dismiss.dataset.ncBridgeDismissBound) {
    dismiss.dataset.ncBridgeDismissBound = "1";
    dismiss.addEventListener("click", () => {
      if (uploadProgressHideTimer) clearTimeout(uploadProgressHideTimer);
      uploadProgressHideTimer = null;
      window.__ncBgUploadActive = false;
      setUploadProgressVisible(false);
      updateUploadProgressUi(0, "Uploading…", "");
    });
  }

  document.addEventListener("nc-upload-prog", (ev) => {
    handleUploadPayload(ev.detail);
  });

  document.addEventListener("nc-upload-conflict-request", (ev) => {
    const d = ev.detail;
    if (!d || !d.requestId) return;
    void showUploadConflictDialog(d.existing, d.incoming, d.canReplace !== false).then((choice) => {
      document.dispatchEvent(
        new CustomEvent("nc-upload-conflict-response", {
          detail: { requestId: d.requestId, choice },
        })
      );
    });
  });

  window.addEventListener("message", (ev) => {
    if (ev.origin !== origin) return;
    const d = ev.data;
    if (!d) return;

    if (d.nc === "fb-up" && d.type === "conflict-request") {
      const src = ev.source;
      if (!src || typeof src.postMessage !== "function") return;
      void showUploadConflictDialog(d.existing, d.incoming, d.canReplace !== false).then((choice) => {
        try {
          src.postMessage(
            { nc: "fb-up", type: "conflict-response", requestId: d.requestId, choice },
            origin
          );
        } catch {
          /* ignore */
        }
      });
      return;
    }

    if (d.nc !== "fb-up-prog") return;
    handleUploadPayload(d);
  });
})();
