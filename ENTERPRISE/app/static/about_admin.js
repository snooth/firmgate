(function () {
  const btnEdit = document.getElementById("nc-about-edit");
  const dlg = document.getElementById("nc-about-dlg");
  const btnX = document.getElementById("nc-about-x");
  const btnCancel = document.getElementById("nc-about-cancel");
  const form = document.getElementById("nc-about-form");
  const btnSave = document.getElementById("nc-about-save");
  const status = document.getElementById("nc-about-status");
  const raw = document.getElementById("nc-about-data");
  const fWhoTitle = document.getElementById("nc-about-who-title");
  const fWhoBody = document.getElementById("nc-about-who-body");
  const toolbar = document.querySelector("#nc-about-dlg .nc-about-toolbar");
  const selFont = document.getElementById("nc-about-font");
  const selSize = document.getElementById("nc-about-size");
  const linksWrap = document.getElementById("nc-about-links");
  const btnAddLink = document.getElementById("nc-about-link-add");
  const glanceWrap = document.getElementById("nc-about-glance");
  if (!btnEdit || !dlg || !raw) return;

  const GLANCE_SLOTS = 4;
  const emptyGlance = () =>
    Array.from({ length: GLANCE_SLOTS }, () => ({ value: "", label: "", subtitle: "" }));

  let state = { who_title: "Who we are", who_body: "", links: [], glance: emptyGlance() };
  try {
    const j = JSON.parse(raw.textContent || "{}");
    if (j && typeof j === "object") state = { ...state, ...j };
    if (!Array.isArray(state.links)) state.links = [];
    if (!Array.isArray(state.glance)) state.glance = emptyGlance();
    else {
      state.glance = emptyGlance().map((slot, i) => ({
        value: String((state.glance[i] && state.glance[i].value) || ""),
        label: String((state.glance[i] && state.glance[i].label) || ""),
        subtitle: String((state.glance[i] && state.glance[i].subtitle) || ""),
      }));
    }
  } catch (_) {}

  function setStatus(msg) {
    if (status) status.textContent = msg || "";
  }

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  async function api(path, opts = {}) {
    return await fetch(`/intranet/api${path}`, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      ...opts,
    });
  }

  async function uploadImage(file) {
    const fd = new FormData();
    fd.append("file", file, file.name || "image.png");
    const r = await fetch("/intranet/api/blogs/upload-image", { method: "POST", credentials: "same-origin", body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.url) throw new Error(j.error || "Upload failed");
    return String(j.url);
  }

  function looksLikeHtml(s) {
    return /<\s*\/?\s*(?:!--|[a-zA-Z])/.test(String(s || ""));
  }

  function applyBodyToEditor(htmlOrPlain) {
    if (!fWhoBody) return;
    const rawStr = String(htmlOrPlain || "").trim();
    if (!rawStr) {
      fWhoBody.innerHTML = "";
      return;
    }
    if (looksLikeHtml(rawStr)) {
      fWhoBody.innerHTML = rawStr;
    } else {
      const esc = escapeHtml(rawStr).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
      fWhoBody.innerHTML = esc.map((line) => `<p>${line || "<br>"}</p>`).join("");
    }
  }

  function renderLinks() {
    if (!linksWrap) return;
    linksWrap.innerHTML = "";
    const rows = Array.isArray(state.links) ? state.links : [];
    if (!rows.length) {
      const p = document.createElement("p");
      p.className = "nc-detail-muted";
      p.textContent = "No links yet.";
      linksWrap.appendChild(p);
      return;
    }
    rows.forEach((l, idx) => {
      const row = document.createElement("div");
      row.className = "nc-share-add-row";
      row.style.marginBottom = "0.5rem";
      row.innerHTML = `
        <input class="nc-detail-input" data-k="label" data-i="${idx}" placeholder="Label" value="${escapeHtml(l.label || "")}">
        <input class="nc-detail-input" data-k="url" data-i="${idx}" placeholder="URL (https://… or /intranet/…)" style="flex:2;" value="${escapeHtml(l.url || "")}">
        <button type="button" class="nc-btn nc-btn-secondary" data-remove="${idx}">Remove</button>
      `;
      linksWrap.appendChild(row);
    });
  }

  function renderGlance() {
    if (!glanceWrap) return;
    glanceWrap.innerHTML = "";
    const rows = Array.isArray(state.glance) ? state.glance : emptyGlance();
    rows.forEach((item, idx) => {
      const card = document.createElement("div");
      card.className = "nc-about-glance-edit";
      card.style.marginBottom = "0.75rem";
      card.innerHTML = `
        <div class="nc-detail-label" style="margin-bottom:0.35rem;">Stat ${idx + 1}</div>
        <div class="nc-share-add-row" style="margin-bottom:0.35rem;">
          <input class="nc-detail-input" data-glance="value" data-i="${idx}" placeholder="Value (e.g. 2019)" value="${escapeHtml(item.value || "")}">
          <input class="nc-detail-input" data-glance="label" data-i="${idx}" placeholder="Label (e.g. Founded)" value="${escapeHtml(item.label || "")}">
        </div>
        <input class="nc-detail-input" data-glance="subtitle" data-i="${idx}" placeholder="Description (e.g. Established in Australia)" value="${escapeHtml(item.subtitle || "")}" style="width:100%;">
      `;
      glanceWrap.appendChild(card);
    });
  }

  function open() {
    setStatus("");
    if (fWhoTitle) fWhoTitle.value = state.who_title || "Who we are";
    applyBodyToEditor(state.who_body || "");
    if (selFont) selFont.selectedIndex = 0;
    if (selSize) selSize.selectedIndex = 0;
    renderLinks();
    renderGlance();
    dlg.hidden = false;
    document.body.style.overflow = "hidden";
    try {
      (fWhoTitle || fWhoBody).focus();
    } catch (_) {}
  }

  function close() {
    dlg.hidden = true;
    document.body.style.overflow = "";
  }

  function syncFromInputs() {
    if (fWhoTitle) state.who_title = (fWhoTitle.value || "").trim();
    if (fWhoBody) state.who_body = fWhoBody.innerHTML.trim();
    if (glanceWrap) {
      const next = emptyGlance();
      glanceWrap.querySelectorAll("[data-glance]").forEach((el) => {
        const key = el.getAttribute("data-glance");
        const i = Number(el.getAttribute("data-i"));
        if (!key || Number.isNaN(i) || i < 0 || i >= GLANCE_SLOTS) return;
        next[i][key] = (el.value || "").trim();
      });
      state.glance = next;
    }
  }

  btnEdit.addEventListener("click", open);
  if (btnX) btnX.addEventListener("click", close);
  if (btnCancel) btnCancel.addEventListener("click", close);
  if (dlg) {
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) close();
    });
  }

  function runCmd(cmd, val) {
    if (!fWhoBody) return;
    try {
      fWhoBody.focus();
      if (cmd === "bold") document.execCommand("bold");
      else if (cmd === "italic") document.execCommand("italic");
      else if (cmd === "underline") document.execCommand("underline");
      else if (cmd === "strikeThrough") document.execCommand("strikeThrough");
      else if (cmd === "justifyLeft") document.execCommand("justifyLeft");
      else if (cmd === "justifyCenter") document.execCommand("justifyCenter");
      else if (cmd === "justifyRight") document.execCommand("justifyRight");
      else if (cmd === "justifyFull") document.execCommand("justifyFull");
      else if (cmd === "ul") document.execCommand("insertUnorderedList");
      else if (cmd === "ol") document.execCommand("insertOrderedList");
      else if (cmd === "h1") document.execCommand("formatBlock", false, "h1");
      else if (cmd === "h2") document.execCommand("formatBlock", false, "h2");
      else if (cmd === "h3") document.execCommand("formatBlock", false, "h3");
      else if (cmd === "p") document.execCommand("formatBlock", false, "p");
      else if (cmd === "blockquote") document.execCommand("formatBlock", false, "blockquote");
      else if (cmd === "hr") document.execCommand("insertHorizontalRule");
      else if (cmd === "removeFormat") document.execCommand("removeFormat");
      else if (cmd === "link") {
        const url = window.prompt("Link URL");
        if (url) document.execCommand("createLink", false, url);
      } else if (cmd === "img") {
        const url = window.prompt("Image URL (or paste a picture)");
        if (url) document.execCommand("insertImage", false, url);
      }
      else if (cmd === "fontName" && val) document.execCommand("fontName", false, val);
      else if (cmd === "fontSize" && val) document.execCommand("fontSize", false, val);
    } catch (_) {}
  }

  if (toolbar && fWhoBody) {
    toolbar.addEventListener("mousedown", (e) => {
      const b = e.target && e.target.closest ? e.target.closest("button[data-cmd]") : null;
      if (b) e.preventDefault();
    });
    toolbar.addEventListener("click", async (e) => {
      const b = e.target && e.target.closest ? e.target.closest("button[data-cmd]") : null;
      if (!b) return;
      const cmd = b.getAttribute("data-cmd");
      if (!cmd) return;
      e.preventDefault();
      runCmd(cmd);
    });
  }

  if (selFont && fWhoBody) {
    selFont.addEventListener("change", () => {
      const v = selFont.value || "";
      if (v) {
        runCmd("fontName", v);
      }
      selFont.selectedIndex = 0;
    });
  }

  if (selSize && fWhoBody) {
    selSize.addEventListener("change", () => {
      const v = selSize.value || "";
      if (v) runCmd("fontSize", v);
      selSize.selectedIndex = 0;
    });
  }

  if (fWhoBody) {
    fWhoBody.addEventListener("paste", async (e) => {
      const dt = e.clipboardData;
      if (!dt || !dt.items) return;
      const items = Array.from(dt.items || []);
      const imgItem = items.find((it) => it && it.kind === "file" && String(it.type || "").startsWith("image/"));
      if (!imgItem) return;
      const file = imgItem.getAsFile ? imgItem.getAsFile() : null;
      if (!file) return;
      e.preventDefault();
      try {
        setStatus("Uploading image…");
        const url = await uploadImage(file);
        document.execCommand("insertImage", false, url);
        setStatus("Image added.");
      } catch (err) {
        setStatus(String(err && err.message ? err.message : err) || "Image upload failed.");
      }
    });
  }

  if (linksWrap) {
    linksWrap.addEventListener("input", (e) => {
      const el = e.target;
      if (!el || !el.getAttribute) return;
      const k = el.getAttribute("data-k");
      const i = Number(el.getAttribute("data-i"));
      if (!k || Number.isNaN(i)) return;
      if (!Array.isArray(state.links)) state.links = [];
      const row = state.links[i] || {};
      row[k] = el.value || "";
      state.links[i] = row;
    });
    linksWrap.addEventListener("click", (e) => {
      const t = e.target;
      if (!t || !t.getAttribute) return;
      const rm = t.getAttribute("data-remove");
      if (rm == null) return;
      const idx = Number(rm);
      if (Number.isNaN(idx)) return;
      state.links.splice(idx, 1);
      renderLinks();
    });
  }

  if (btnAddLink) {
    btnAddLink.addEventListener("click", () => {
      if (!Array.isArray(state.links)) state.links = [];
      state.links.push({ label: "", url: "" });
      renderLinks();
    });
  }

  if (glanceWrap) {
    glanceWrap.addEventListener("input", (e) => {
      const el = e.target;
      if (!el || !el.getAttribute) return;
      const key = el.getAttribute("data-glance");
      const i = Number(el.getAttribute("data-i"));
      if (!key || Number.isNaN(i)) return;
      if (!Array.isArray(state.glance)) state.glance = emptyGlance();
      const row = state.glance[i] || { value: "", label: "", subtitle: "" };
      row[key] = el.value || "";
      state.glance[i] = row;
    });
  }

  async function save() {
    syncFromInputs();
    setStatus("Saving…");
    const payload = {
      who_title: (state.who_title || "").trim(),
      who_body: state.who_body || "",
      links: (state.links || []).map((x) => ({ label: x.label || "", url: x.url || "" })),
      glance: (state.glance || emptyGlance()).map((x) => ({
        value: (x.value || "").trim(),
        label: (x.label || "").trim(),
        subtitle: (x.subtitle || "").trim(),
      })),
    };
    const r = await api("/about", { method: "PUT", body: JSON.stringify(payload) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setStatus(j.error || "Save failed.");
      return;
    }
    close();
    window.location.reload();
  }

  if (form) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      save();
    });
  }
  if (btnSave) {
    btnSave.addEventListener("click", (e) => {
      e.preventDefault();
      save();
    });
  }
})();
