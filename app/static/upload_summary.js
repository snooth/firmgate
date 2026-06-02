/**
 * Upload finished summary modal (Documents + intranet header uploads).
 */
(function () {
  function init() {
    const dlg = document.getElementById("dlg-upload-summary");
    const closeBtn = document.getElementById("upload-summary-close");
    if (!dlg) return;
    if (closeBtn && !closeBtn.dataset.ncBound) {
      closeBtn.dataset.ncBound = "1";
      closeBtn.addEventListener("click", () => dlg.close());
    }
    if (!dlg.dataset.ncBackdropBound) {
      dlg.dataset.ncBackdropBound = "1";
      dlg.addEventListener("click", (e) => {
        if (e.target === dlg) dlg.close();
      });
    }
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function statRow(label, value, tone) {
    const cls = tone ? ` nc-upload-summary-stat--${tone}` : "";
    return `<li class="nc-upload-summary-stat${cls}"><span class="nc-upload-summary-stat-label">${esc(
      label
    )}</span><span class="nc-upload-summary-stat-value">${esc(String(value))}</span></li>`;
  }

  window.ncShowUploadSummaryDialog = function (stats) {
    const dlg = document.getElementById("dlg-upload-summary");
    const titleEl = document.getElementById("upload-summary-title");
    const introEl = document.getElementById("upload-summary-intro");
    const listEl = document.getElementById("upload-summary-stats");
    const noteEl = document.getElementById("upload-summary-note");
    if (!dlg || !titleEl || !listEl) return;

    const uploaded = Math.max(0, Number(stats && stats.uploaded) || 0);
    const skipped = Math.max(0, Number(stats && stats.skipped) || 0);
    const failed = Math.max(0, Number(stats && stats.failed) || 0);
    const total = Math.max(0, Number(stats && stats.total) || 0);
    const folderCount = Math.max(0, Number(stats && stats.folderCount) || 0);
    const cancelled = !!(stats && stats.cancelled);
    const partial = !!(stats && stats.partial) || failed > 0;
    const mode = stats && stats.mode === "folder" ? "folder" : "files";
    const notProcessed = Math.max(0, total - uploaded - skipped - failed);

    const prefix = mode === "folder" ? "Folder upload" : "Upload";
    let title = `${prefix} complete`;
    if (cancelled) title = `${prefix} stopped`;
    else if (failed > 0) title = `${prefix} finished with errors`;
    else if (partial) title = `${prefix} finished`;
    titleEl.textContent = title;

    if (introEl) {
      if (cancelled) {
        introEl.textContent = "The upload was cancelled. Files processed before you stopped are listed below.";
      } else if (mode === "folder") {
        introEl.textContent = "Your folder upload has finished. Here is the summary:";
      } else {
        introEl.textContent = "Your upload has finished. Here is the summary:";
      }
    }

    const rows = [];
    if (mode === "folder" && folderCount > 0) rows.push(statRow("Top-level folders", folderCount, ""));
    if (total > 0) rows.push(statRow("Total files", total, ""));
    rows.push(statRow("Successfully uploaded", uploaded, uploaded > 0 ? "ok" : ""));
    if (skipped > 0) rows.push(statRow("Kept existing (skipped)", skipped, "muted"));
    if (failed > 0) rows.push(statRow("Failed", failed, "err"));
    if (cancelled && notProcessed > 0) rows.push(statRow("Not processed", notProcessed, "muted"));

    listEl.innerHTML = rows.join("");

    if (noteEl) {
      const hint = stats && stats.note ? String(stats.note) : "";
      if (hint) {
        noteEl.textContent = hint;
        noteEl.hidden = false;
      } else if (failed > 0 && stats && stats.lastError) {
        noteEl.textContent = String(stats.lastError);
        noteEl.hidden = false;
      } else {
        noteEl.textContent = "";
        noteEl.hidden = true;
      }
    }

    if (typeof dlg.showModal === "function") dlg.showModal();
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
