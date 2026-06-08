(function () {
  "use strict";

  const root = document.getElementById("nc-ts-collection");
  if (!root) return;

  const apiUrl = root.dataset.apiUrl || "";
  const uploadUrl = root.dataset.uploadUrl || "";
  const removeUrl = root.dataset.removeUrl || "";
  const downloadAllUrl = root.dataset.downloadAllUrl || "";
  const exportPdfUrl = root.dataset.exportPdfUrl || "";
  const exportDocxUrl = root.dataset.exportDocxUrl || "";
  const canUpload = root.dataset.canUpload === "1";
  const heroMonthLabel = document.getElementById("nc-ts-col-hero-month");
  const btnPrev = document.getElementById("nc-ts-col-month-prev");
  const btnNext = document.getElementById("nc-ts-col-month-next");
  const btnDownloadAll = document.getElementById("nc-ts-col-download-all");
  const btnExportPdf = document.getElementById("nc-ts-col-export-pdf");
  const btnExportDocx = document.getElementById("nc-ts-col-export-docx");
  const tbody = document.getElementById("nc-ts-collection-tbody");
  const tableWrap = document.getElementById("nc-ts-collection-table-wrap");
  const emptyEl = document.getElementById("nc-ts-collection-empty");
  const fileInput = document.getElementById("nc-ts-collection-file-input");
  const selectAllCb = document.getElementById("nc-ts-col-select-all");

  let activeMonth = root.dataset.month || "";
  let pendingUploadUserId = null;
  let selectionWired = false;

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function firstOfMonth(yyyyMm) {
    const [y, m] = String(yyyyMm || "").split("-").map((x) => Number(x));
    if (!y || !m) return null;
    return new Date(y, m - 1, 1);
  }

  function monthKeyFromDate(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
  }

  function shiftMonthKey(yyyyMm, delta) {
    const d0 = firstOfMonth(yyyyMm);
    if (!d0 || !delta) return yyyyMm;
    const next = new Date(d0.getFullYear(), d0.getMonth() + delta, 1);
    return monthKeyFromDate(next);
  }

  function guessCurrentMonth() {
    const now = new Date();
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
  }

  function formatMonthLabel(yyyyMm) {
    const d0 = firstOfMonth(yyyyMm);
    if (!d0) return String(yyyyMm || "");
    return d0.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }

  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s == null ? "" : String(s);
    return div.innerHTML;
  }

  function dashCell() {
    return '<span class="nc-intranet-muted">—</span>';
  }

  function syncUrl(month) {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("month", month);
      window.history.replaceState({}, "", url.toString());
    } catch (_) {
      /* ignore */
    }
  }

  function renderFileCell(row) {
    const uploaded = !!row.uploaded;
    const parts = [];
    if (uploaded && row.original_name) {
      parts.push(`<span class="nc-ts-collection-fname">${escapeHtml(row.original_name)}</span>`);
    }
    if (canUpload) {
      const label = uploaded ? "Replace" : "Upload";
      parts.push(
        `<button type="button" class="nc-btn nc-btn-secondary nc-ts-collection-upload" data-user-id="${escapeHtml(String(row.user_id))}">${label}</button>`
      );
      if (uploaded) {
        parts.push(
          `<button type="button" class="nc-btn nc-btn-secondary nc-ts-collection-upload nc-ts-collection-remove" data-user-id="${escapeHtml(String(row.user_id))}">Remove</button>`
        );
      }
    } else if (!uploaded) {
      parts.push(dashCell());
    }
    return `<td class="nc-ts-collection-file"><div class="nc-ts-collection-file-inner">${parts.join("")}</div></td>`;
  }

  function renderRow(row, selected) {
    const checked = selected !== false;
    const uploaded = !!row.uploaded;
    const uploadedCell = uploaded
      ? `<td class="nc-ts-collection-uploaded">${escapeHtml(row.uploaded_label)}</td>`
      : `<td class="nc-ts-collection-uploaded">${dashCell()}</td>`;
    const viewCell = uploaded
      ? `<td class="nc-ts-collection-action"><a class="nc-ts-collection-view" href="${escapeHtml(row.download_url)}" target="_blank" rel="noopener">View</a></td>`
      : `<td class="nc-ts-collection-action">${dashCell()}</td>`;
    const employee = escapeHtml(row.employee_name);
    return `<tr data-user-id="${escapeHtml(String(row.user_id))}">
          <td class="nc-ts-collection-select">
            <input type="checkbox" class="nc-ts-collection-select-user" data-user-id="${escapeHtml(String(row.user_id))}"${
              checked ? " checked" : ""
            } aria-label="Select ${employee}">
          </td>
          <td class="nc-ts-collection-name">${employee}</td>
          ${renderFileCell(row)}
          ${uploadedCell}
          ${viewCell}
        </tr>`;
  }

  function renderGroupHeader(section) {
    if (!section || !section.show_header || !section.name) return "";
    return `<tr class="nc-ts-collection-group-row"><td colspan="5">${escapeHtml(section.name)}</td></tr>`;
  }

  function rowIsSelected(userId) {
    if (!tbody || userId == null) return true;
    const tr = tbody.querySelector(`tr[data-user-id="${userId}"]`);
    const cb = tr && tr.querySelector(".nc-ts-collection-select-user");
    return cb ? cb.checked : true;
  }

  function selectedUserIds() {
    if (!tbody) return [];
    return Array.from(tbody.querySelectorAll(".nc-ts-collection-select-user:checked"))
      .map((cb) => Number(cb.dataset.userId))
      .filter((id) => Number.isFinite(id));
  }

  function syncSelectAllCheckbox() {
    if (!selectAllCb || !tbody) return;
    const boxes = Array.from(tbody.querySelectorAll(".nc-ts-collection-select-user"));
    if (!boxes.length) {
      selectAllCb.checked = false;
      selectAllCb.indeterminate = false;
      return;
    }
    const checkedCount = boxes.filter((b) => b.checked).length;
    selectAllCb.checked = checkedCount === boxes.length;
    selectAllCb.indeterminate = checkedCount > 0 && checkedCount < boxes.length;
  }

  function wireSelectionControls() {
    if (selectionWired || !tbody) return;
    selectionWired = true;
    tbody.addEventListener("change", (e) => {
      if (e.target && e.target.classList.contains("nc-ts-collection-select-user")) {
        syncSelectAllCheckbox();
      }
    });
    if (selectAllCb) {
      selectAllCb.addEventListener("change", () => {
        if (!tbody) return;
        tbody.querySelectorAll(".nc-ts-collection-select-user").forEach((cb) => {
          cb.checked = selectAllCb.checked;
        });
        selectAllCb.indeterminate = false;
      });
    }
  }

  function renderSections(sections) {
    if (!tbody || !tableWrap || !emptyEl) return;
    const list = Array.isArray(sections) ? sections : [];
    const rowCount = list.reduce((n, s) => n + ((s && s.rows) || []).length, 0);
    if (!rowCount) {
      tbody.innerHTML = "";
      tableWrap.hidden = true;
      emptyEl.hidden = false;
      emptyEl.textContent = "No users found.";
      syncSelectAllCheckbox();
      return;
    }
    tbody.innerHTML = list
      .map((section) => {
        const header = renderGroupHeader(section);
        const rows = (section.rows || []).map((row) => renderRow(row, true)).join("");
        return header + rows;
      })
      .join("");
    tableWrap.hidden = false;
    emptyEl.hidden = true;
    wireSelectionControls();
    syncSelectAllCheckbox();
  }

  function renderRows(rows) {
    renderSections([{ show_header: false, rows: rows || [] }]);
  }

  function updateRow(row) {
    if (!tbody || !row || row.user_id == null) return;
    const tr = tbody.querySelector(`tr[data-user-id="${row.user_id}"]`);
    if (!tr) return;
    tr.outerHTML = renderRow(row, rowIsSelected(row.user_id));
    syncSelectAllCheckbox();
  }

  function syncHeroMonthLabel(yyyyMm, label) {
    activeMonth = yyyyMm;
    root.dataset.month = yyyyMm;
    if (heroMonthLabel) heroMonthLabel.textContent = label || formatMonthLabel(yyyyMm);
    syncUrl(yyyyMm);
  }

  async function loadMonth(month) {
    if (!apiUrl || !month) return;
    try {
      const res = await fetch(`${apiUrl}?month=${encodeURIComponent(month)}`, {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        throw new Error((data && data.error) || "Could not load collection.");
      }
      syncHeroMonthLabel(data.month, data.month_label);
      if (Array.isArray(data.sections) && data.sections.length) {
        renderSections(data.sections);
      } else {
        renderRows(data.rows);
      }
    } catch (err) {
      if (emptyEl) {
        emptyEl.hidden = false;
        emptyEl.textContent = err && err.message ? err.message : "Could not load collection.";
      }
      if (tableWrap) tableWrap.hidden = true;
    }
  }

  async function uploadForUser(userId, file) {
    if (!uploadUrl || !userId || !file || !activeMonth) return;
    const fd = new FormData();
    fd.append("user_id", String(userId));
    fd.append("month", activeMonth);
    fd.append("file", file, file.name);
    const res = await fetch(uploadUrl, {
      method: "POST",
      body: fd,
      credentials: "same-origin",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error((data && data.error) || "Upload failed.");
    }
    if (data.row) updateRow(data.row);
  }

  async function removeForUser(userId) {
    if (!removeUrl || !userId || !activeMonth) return;
    const tr = tbody && tbody.querySelector(`tr[data-user-id="${userId}"]`);
    const nameCell = tr && tr.querySelector(".nc-ts-collection-name");
    const employee = nameCell ? nameCell.textContent.trim() : "this employee";
    if (!window.confirm(`Remove the signed timesheet for ${employee}?`)) return;
    const fd = new FormData();
    fd.append("user_id", String(userId));
    fd.append("month", activeMonth);
    const res = await fetch(removeUrl, {
      method: "POST",
      body: fd,
      credentials: "same-origin",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error((data && data.error) || "Remove failed.");
    }
    if (data.row) updateRow(data.row);
  }

  function shiftMonth(delta) {
    if (!delta) return;
    const base = activeMonth || guessCurrentMonth();
    loadMonth(shiftMonthKey(base, delta));
  }

  function bulkDownloadUrl(baseUrl) {
    if (!baseUrl) return "";
    const month = activeMonth || guessCurrentMonth();
    const url = new URL(baseUrl, window.location.origin);
    url.searchParams.set("month", month);
    const ids = selectedUserIds();
    if (!ids.length) return "";
    ids.forEach((id) => url.searchParams.append("user_id", String(id)));
    return url.toString();
  }

  async function triggerBulkDownload(baseUrl, emptyMessage) {
    const url = bulkDownloadUrl(baseUrl);
    if (!url) {
      window.alert("Select at least one employee to export.");
      return;
    }
    try {
      const res = await fetch(url, { credentials: "same-origin" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data && data.error) || emptyMessage || "Download failed.");
      }
      const blob = await res.blob();
      const dispo = res.headers.get("Content-Disposition") || "";
      const match = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(dispo);
      const filename = match ? decodeURIComponent(match[1].replace(/"/g, "")) : "download";
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      window.alert(err && err.message ? err.message : "Download failed.");
    }
  }

  if (btnPrev) btnPrev.addEventListener("click", () => shiftMonth(-1));
  if (btnNext) btnNext.addEventListener("click", () => shiftMonth(1));
  if (btnDownloadAll) {
    btnDownloadAll.addEventListener("click", () => {
      triggerBulkDownload(downloadAllUrl, "No signed timesheets for this month.");
    });
  }
  if (btnExportPdf) {
    btnExportPdf.addEventListener("click", () => {
      triggerBulkDownload(exportPdfUrl, "No signed timesheets for this month.");
    });
  }
  if (btnExportDocx) {
    btnExportDocx.addEventListener("click", () => {
      triggerBulkDownload(exportDocxUrl, "Could not export collection.");
    });
  }

  if (canUpload && tbody) {
    tbody.addEventListener("click", (e) => {
      const removeBtn = e.target.closest(".nc-ts-collection-remove");
      if (removeBtn) {
        const userId = removeBtn.dataset.userId || null;
        if (!userId) return;
        removeBtn.disabled = true;
        removeForUser(userId)
          .catch((err) => {
            window.alert(err && err.message ? err.message : "Remove failed.");
          })
          .finally(() => {
            const nextBtn = tbody.querySelector(`.nc-ts-collection-remove[data-user-id="${userId}"]`);
            if (nextBtn) nextBtn.disabled = false;
          });
        return;
      }
      const btn = e.target.closest(".nc-ts-collection-upload");
      if (!btn || !fileInput) return;
      pendingUploadUserId = btn.dataset.userId || null;
      fileInput.value = "";
      fileInput.click();
    });
  }

  if (canUpload && fileInput) {
    fileInput.addEventListener("change", async () => {
      const userId = pendingUploadUserId;
      const file = fileInput.files && fileInput.files[0];
      pendingUploadUserId = null;
      if (!userId || !file) return;
      const btn = tbody && tbody.querySelector(`.nc-ts-collection-upload[data-user-id="${userId}"]`);
      if (btn) btn.disabled = true;
      try {
        await uploadForUser(userId, file);
      } catch (err) {
        window.alert(err && err.message ? err.message : "Upload failed.");
      } finally {
        const nextBtn = tbody && tbody.querySelector(`.nc-ts-collection-upload[data-user-id="${userId}"]`);
        if (nextBtn) nextBtn.disabled = false;
        fileInput.value = "";
      }
    });
  }

  if (!activeMonth) {
    activeMonth = guessCurrentMonth();
    syncHeroMonthLabel(activeMonth);
  }

  wireSelectionControls();
})();
