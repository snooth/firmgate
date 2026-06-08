(function () {
  const list = document.getElementById("st-list");
  const body = document.getElementById("st-body");
  const title = document.getElementById("st-title");
  const count = document.getElementById("st-count");
  const progressEl = document.getElementById("st-progress");
  const viewActions = document.getElementById("st-view-actions");
  const adminActions = document.getElementById("st-admin-actions");
  const uploadBtn = document.getElementById("st-upload-btn");
  const uploadInput = document.getElementById("st-upload-input");
  if (!list || !body || !title) return;

  async function api(path, opts = {}) {
    const r = await fetch(`/intranet${path}`, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      ...opts,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Request failed");
    return j;
  }

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function extOf(name) {
    const n = String(name || "");
    const i = n.lastIndexOf(".");
    return i >= 0 ? n.slice(i + 1).toLowerCase() : "";
  }

  function trainingDisplayName(name) {
    const n = String(name || "").trim();
    if (!n) return "";
    const i = n.lastIndexOf(".");
    if (i <= 0) return n;
    return n.slice(0, i);
  }

  function kindLabel(kind) {
    switch (kind) {
      case "video":
        return "Video";
      case "slides":
        return "Slides";
      case "pdf":
        return "PDF";
      case "document":
        return "Document";
      case "spreadsheet":
        return "Spreadsheet";
      default:
        return "File";
    }
  }

  let items = [];
  let activeId = null;
  let folderId = null;
  let canUpload = false;
  let progress = { total: 0, completed: 0, all_complete: false };
  let viewingSelf = true;
  let progressUserName = "";

  function renderProgress() {
    if (!progressEl) return;
    const total = Number(progress.total || 0);
    const done = Number(progress.completed || 0);
    if (!total) {
      progressEl.hidden = true;
      return;
    }
    progressEl.hidden = false;
    const pct = Math.round((done / total) * 100);
    const who = viewingSelf ? "Your" : `${progressUserName || "User"}'s`;
    if (progress.all_complete) {
      progressEl.className = "nc-st-progress nc-st-progress--complete";
      progressEl.innerHTML = `
        <span class="nc-st-progress-icon" aria-hidden="true">✓</span>
        <span><strong>${who} training is complete.</strong> All ${total} materials marked done.</span>
      `;
      return;
    }
    progressEl.className = "nc-st-progress nc-st-progress--partial";
    progressEl.innerHTML = `
      <span class="nc-st-progress-bar" aria-hidden="true"><span style="width:${pct}%"></span></span>
      <span>${who} progress: <strong>${done} of ${total}</strong> complete (${pct}%)</span>
    `;
  }

  function renderList() {
    list.innerHTML = "";
    const doneN = items.filter((it) => it.completed).length;
    if (count) {
      count.textContent = items.length
        ? `${doneN} of ${items.length} complete`
        : "";
    }
    if (!items.length) {
      list.innerHTML = `<div class="nc-detail-muted" style="padding:0.85rem;">No training files found.</div>`;
      return;
    }
    items.forEach((it) => {
      const b = document.createElement("button");
      b.type = "button";
      const done = !!it.completed;
      b.className = `nc-st-item${String(it.id) === String(activeId) ? " is-active" : ""}${done ? " is-complete" : ""}`;
      const ext = extOf(it.name);
      const badge = ext ? ext.toUpperCase() : kindLabel(it.kind).toUpperCase();
      b.innerHTML = `
        <span class="nc-st-item-check" aria-hidden="true" title="${done ? "Completed" : "Not completed"}">${done ? "✓" : ""}</span>
        <div class="nc-st-item-main">
          <div class="nc-st-item-name">${esc(trainingDisplayName(it.name))}</div>
          <div class="nc-st-item-sub">${esc(kindLabel(it.kind))}${done ? " · Completed" : ""}</div>
        </div>
        <div class="nc-st-item-badge">${esc(badge)}</div>
      `;
      b.addEventListener("click", () => openItem(it));
      list.appendChild(b);
    });
  }

  function setBody(html) {
    body.innerHTML = html;
  }

  function renderViewActions(it) {
    if (!viewActions) return;
    if (!viewingSelf || !it) {
      viewActions.hidden = true;
      viewActions.innerHTML = "";
      return;
    }
    viewActions.hidden = false;
    if (it.completed) {
      viewActions.innerHTML = `<span class="nc-st-complete-badge">Completed</span>`;
      return;
    }
    viewActions.innerHTML = `<button type="button" class="nc-btn nc-btn-primary nc-btn-sm" id="st-mark-complete">Mark as complete</button>`;
    const btn = document.getElementById("st-mark-complete");
    if (btn) {
      btn.addEventListener("click", () => markComplete(it));
    }
  }

  async function markComplete(it) {
    if (!it || !viewingSelf) return;
    try {
      const j = await api(`/api/security-training/assets/${encodeURIComponent(String(it.id))}/complete`, {
        method: "POST",
        body: "{}",
      });
      progress = j.progress || progress;
      const row = items.find((x) => String(x.id) === String(it.id));
      if (row) {
        row.completed = true;
        row.completed_at = j.completed_at;
      }
      renderProgress();
      renderList();
      renderViewActions(row || it);
    } catch (e) {
      alert(String(e && e.message ? e.message : e) || "Could not save completion.");
    }
  }

  function wireVideoComplete(videoEl, it) {
    if (!videoEl || !it || it.completed || !viewingSelf) return;
    videoEl.addEventListener("ended", () => {
      if (!it.completed) markComplete(it);
    });
  }

  function openItem(it) {
    if (!it || !it.id) return;
    activeId = it.id;
    renderList();
    title.textContent = trainingDisplayName(it.name || "") || "Training";
    renderViewActions(it);
    if (it.kind === "video") {
      setBody(`
        <div class="nc-st-video-wrap">
          <video class="nc-st-video" controls playsinline src="/files/api/view/${encodeURIComponent(String(it.id))}"></video>
        </div>
      `);
      wireVideoComplete(body.querySelector(".nc-st-video"), it);
      return;
    }
    if (it.kind === "pdf") {
      setBody(`
        <iframe class="nc-st-frame" title="PDF viewer" loading="lazy"
          src="/files/api/view/${encodeURIComponent(String(it.id))}"></iframe>
      `);
      return;
    }
    const ooBase = `/onlyoffice/editor/${encodeURIComponent(String(it.id))}?embed=1&view=1`;
    const ooSrc = it.kind === "slides" ? `${ooBase}&slideshow=1` : ooBase;
    const ooTitle =
      it.kind === "slides" ? "Slides viewer" : it.kind === "spreadsheet" ? "Spreadsheet viewer" : "Document viewer";
    setBody(`
      <iframe class="nc-st-frame" title="${esc(ooTitle)}" loading="lazy" src="${ooSrc}"></iframe>
    `);
  }

  function assetsQuery() {
    const params = new URLSearchParams(window.location.search);
    const uid = (params.get("user_id") || "").trim();
    return uid ? `?user_id=${encodeURIComponent(uid)}` : "";
  }

  async function refresh() {
    const j = await api(`/api/security-training/assets${assetsQuery()}`);
    items = Array.isArray(j.items) ? j.items : [];
    folderId = j.folder_id != null ? j.folder_id : null;
    canUpload = !!j.can_upload;
    progress = j.progress || progress;
    viewingSelf = j.viewing_self !== false;
    progressUserName = j.progress_user_name || "";
    if (adminActions) {
      if (!canUpload) {
        try {
          adminActions.remove();
        } catch (e) {
          adminActions.hidden = true;
        }
      } else {
        adminActions.hidden = false;
      }
    }
    renderProgress();
    renderList();
    const keep = activeId != null ? items.find((x) => String(x.id) === String(activeId)) : null;
    if (keep) openItem(keep);
    else if (viewActions) {
      viewActions.hidden = true;
      viewActions.innerHTML = "";
    }
  }

  async function uploadFiles(files) {
    if (!canUpload || !folderId) return;
    const arr = Array.from(files || []);
    const allowedExt = [
      ".mp4",
      ".webm",
      ".mov",
      ".pdf",
      ".doc",
      ".docx",
      ".odt",
      ".rtf",
      ".txt",
      ".xls",
      ".xlsx",
      ".ods",
      ".csv",
      ".ppt",
      ".pptx",
      ".pps",
      ".ppsx",
      ".ppsm",
      ".pptm",
      ".odp",
      ".pot",
      ".potx",
      ".potm",
    ];
    const allowed = arr.filter((f) => {
      const n = String(f && f.name ? f.name : "").toLowerCase();
      return allowedExt.some((ext) => n.endsWith(ext));
    });
    if (!allowed.length) return;
    if (uploadBtn) uploadBtn.disabled = true;
    try {
      for (const f of allowed) {
        const fd = new FormData();
        fd.append("parent_id", String(folderId));
        fd.append("file", f);
        const r = await fetch("/files/api/upload", {
          method: "POST",
          credentials: "same-origin",
          body: fd,
        });
        if (!r.ok) throw new Error("Upload failed");
      }
      await refresh();
    } finally {
      if (uploadBtn) uploadBtn.disabled = false;
      if (uploadInput) uploadInput.value = "";
    }
  }

  (async () => {
    try {
      await refresh();
    } catch (e) {
      list.innerHTML = `<div class="nc-detail-muted" style="padding:0.85rem;">${esc(String(e && e.message ? e.message : e) || "Could not load files.")}</div>`;
    }
  })();

  if (uploadBtn && uploadInput) {
    uploadBtn.addEventListener("click", () => uploadInput.click());
    uploadInput.addEventListener("change", () => uploadFiles(uploadInput.files));
  }
})();
