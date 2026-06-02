(function () {
  const btnEdit = document.getElementById("nc-home-edit");
  const dlg = document.getElementById("nc-home-dlg");
  const form = document.getElementById("nc-home-form");
  const btnCancel = document.getElementById("nc-home-cancel");
  const btnSave = document.getElementById("nc-home-save");
  const btnX = document.getElementById("nc-home-x");
  const status = document.getElementById("nc-home-status");
  const raw = document.getElementById("nc-home-data");
  const annList = document.getElementById("nc-home-ann-list");
  const annAdd = document.getElementById("nc-home-ann-add");
  const newsList = document.getElementById("nc-home-news-list");
  const tabAnn = document.getElementById("nc-home-tab-ann");
  const tabNews = document.getElementById("nc-home-tab-news");
  if (!btnEdit || !dlg || !raw) return;

  let state = { announcements: [], featured_blog_post_ids: [] };
  try {
    const j = JSON.parse(raw.textContent || "{}");
    state.announcements = Array.isArray(j.announcements) ? j.announcements : [];
    state.featured_blog_post_ids = Array.isArray(j.featured_blog_post_ids)
      ? j.featured_blog_post_ids
      : [];
  } catch {
    /* ignore */
  }

  const TOOLBAR_HTML = `
    <div class="nc-blog-toolbar nc-home-ann-toolbar" role="toolbar" aria-label="Announcement formatting">
      <button type="button" class="nc-blog-tbtn" data-cmd="bold" title="Bold"><b>B</b></button>
      <button type="button" class="nc-blog-tbtn" data-cmd="italic" title="Italic"><i>I</i></button>
      <button type="button" class="nc-blog-tbtn" data-cmd="underline" title="Underline"><u>U</u></button>
      <button type="button" class="nc-blog-tbtn" data-cmd="strikeThrough" title="Strikethrough"><s>S</s></button>
      <span class="nc-blog-tsep" aria-hidden="true"></span>
      <button type="button" class="nc-blog-tbtn" data-cmd="justifyLeft" title="Align left">L</button>
      <button type="button" class="nc-blog-tbtn" data-cmd="justifyCenter" title="Align center">C</button>
      <button type="button" class="nc-blog-tbtn" data-cmd="justifyRight" title="Align right">R</button>
      <button type="button" class="nc-blog-tbtn" data-cmd="justifyFull" title="Justify">J</button>
      <span class="nc-blog-tsep" aria-hidden="true"></span>
      <button type="button" class="nc-blog-tbtn" data-cmd="h1" title="Heading 1">H1</button>
      <button type="button" class="nc-blog-tbtn" data-cmd="h2" title="Heading 2">H2</button>
      <button type="button" class="nc-blog-tbtn" data-cmd="h3" title="Heading 3">H3</button>
      <button type="button" class="nc-blog-tbtn" data-cmd="p" title="Paragraph">¶</button>
      <span class="nc-blog-tsep" aria-hidden="true"></span>
      <button type="button" class="nc-blog-tbtn" data-cmd="ul" title="Bullet list">≡</button>
      <button type="button" class="nc-blog-tbtn" data-cmd="ol" title="Numbered list">#</button>
      <button type="button" class="nc-blog-tbtn" data-cmd="blockquote" title="Quote">❝</button>
      <button type="button" class="nc-blog-tbtn" data-cmd="hr" title="Horizontal rule">—</button>
      <button type="button" class="nc-blog-tbtn" data-cmd="removeFormat" title="Clear formatting">⌫</button>
      <span class="nc-blog-tsep" aria-hidden="true"></span>
      <button type="button" class="nc-blog-tbtn" data-cmd="link" title="Link">🔗</button>
      <button type="button" class="nc-blog-tbtn" data-cmd="img" title="Image">🖼️</button>
    </div>`;

  function setStatus(msg) {
    if (status) status.textContent = msg || "";
  }

  const HOME_API = "/intranet/api/home";

  async function api(path, opts = {}) {
    return await fetch(`/intranet/api${path}`, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      ...opts,
    });
  }

  async function uploadImage(file) {
    const fd = new FormData();
    fd.append("file", file, file.name || "pasted-image.png");
    const r = await fetch("/intranet/api/home/upload-image", {
      method: "POST",
      credentials: "same-origin",
      body: fd,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.url) throw new Error(j.error || "Upload failed");
    return String(j.url);
  }

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function looksLikeHtml(s) {
    return /<\s*\/?\s*(?:!--|[a-zA-Z])/.test(String(s || ""));
  }

  function applyBodyToEditor(editor, htmlOrPlain) {
    if (!editor) return;
    const rawStr = String(htmlOrPlain || "").trim();
    if (!rawStr) {
      editor.innerHTML = "";
      return;
    }
    if (looksLikeHtml(rawStr)) {
      editor.innerHTML = rawStr;
    } else {
      const esc = escapeHtml(rawStr).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
      editor.innerHTML = esc.map((line) => `<p>${line || "<br>"}</p>`).join("");
    }
  }

  function runCmd(editor, cmd) {
    if (!editor) return;
    try {
      editor.focus();
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
        const url = window.prompt("Image URL (or paste a picture into the editor)");
        if (url) document.execCommand("insertImage", false, url);
      }
    } catch (_) {}
  }

  function renderAnnouncements() {
    if (!annList) return;
    annList.innerHTML = "";
    const rows = state.announcements || [];
    if (!rows.length) {
      const p = document.createElement("p");
      p.className = "nc-detail-muted";
      p.textContent = "No announcements yet.";
      annList.appendChild(p);
      return;
    }
    rows.forEach((a, idx) => {
      const wrap = document.createElement("div");
      wrap.className = "nc-home-ann-card";
      wrap.setAttribute("data-ann-idx", String(idx));
      const showFull =
        a.show_full_on_home === undefined || a.show_full_on_home === null ? true : !!a.show_full_on_home;
      wrap.innerHTML = `
        <div class="nc-home-ann-card-head">
          <span class="nc-detail-muted" style="font-size:0.82rem;">Announcement ${idx + 1}</span>
          <button type="button" class="nc-btn nc-btn-secondary nc-btn-sm nc-home-ann-remove" data-remove="${idx}">Remove announcement</button>
        </div>
        <label class="nc-detail-label">Category</label>
        <input class="nc-detail-input" data-k="category" value="${escapeHtml(a.category || "")}">
        <div style="height:0.4rem;"></div>
        <label class="nc-detail-label">Title</label>
        <input class="nc-detail-input" data-k="title" value="${escapeHtml(a.title || "")}">
        <div style="height:0.4rem;"></div>
        <label class="nc-detail-label">Body</label>
        ${TOOLBAR_HTML}
        <div class="nc-blog-editorbox nc-detail-input nc-home-ann-editorbox" data-k="body_html" contenteditable="true" role="textbox" aria-multiline="true" data-placeholder="Write your announcement…"></div>
        <label class="nc-home-ann-showfull">
          <input type="checkbox" data-k="show_full_on_home" ${showFull ? "checked" : ""}>
          <span><strong>Show full announcement on Home</strong> (uncheck to show only a short preview snippet on Home — the full text is still saved)</span>
        </label>
      `;
      annList.appendChild(wrap);
      const editor = wrap.querySelector('[data-k="body_html"]');
      applyBodyToEditor(editor, a.body_html || a.body || "");
    });
  }

  function stripDataUriImages(html) {
    return String(html || "").replace(
      /<img\b[^>]*\bsrc\s*=\s*["']?\s*data:image\/[^"'\s>]+["']?[^>]*>/gi,
      ""
    );
  }

  function syncAnnouncementsFromDom() {
    const anns = [];
    (annList || document).querySelectorAll(".nc-home-ann-card").forEach((card) => {
      const editor = card.querySelector('[data-k="body_html"]');
      const showFullEl = card.querySelector('[data-k="show_full_on_home"]');
      let bodyHtml = editor ? editor.innerHTML.trim() : "";
      bodyHtml = stripDataUriImages(bodyHtml);
      anns.push({
        category: (card.querySelector('[data-k="category"]')?.value || "").trim(),
        title: (card.querySelector('[data-k="title"]')?.value || "").trim(),
        body_html: bodyHtml,
        show_full_on_home: !!(showFullEl && showFullEl.checked),
      });
    });
    return anns;
  }

  function saveErrorMessage(r, j) {
    if (j && j.detail) return String(j.detail);
    if (j && j.error && j.error !== "forbidden") return String(j.error);
    if (r && r.status === 403) {
      return (
        "Save was blocked (permission denied). Try signing out and back in. " +
        "If you can open Administration, ask an admin to confirm your account has the admin role."
      );
    }
    if (r && r.status === 413) {
      return "Announcement is too large (often caused by pasted images). Use the image button or paste pictures so they upload.";
    }
    if (r && r.status >= 500) return "Server error while saving. Check Firmgate logs or try again.";
    if (r && r.status) return `Save failed (HTTP ${r.status}).`;
    return "Save failed.";
  }

  function renderNews(posts) {
    if (!newsList) return;
    newsList.innerHTML = "";
    const featured = new Set((state.featured_blog_post_ids || []).map(String));
    for (const p of posts || []) {
      if (!p.post_id) continue;
      const row = document.createElement("label");
      row.style.display = "flex";
      row.style.alignItems = "flex-start";
      row.style.gap = "0.5rem";
      row.style.padding = "0.35rem 0";
      row.innerHTML = `
        <input type="checkbox" value="${escapeHtml(String(p.post_id))}" ${featured.has(String(p.post_id)) ? "checked" : ""}>
        <span>
          <div style="font-weight:900;">${escapeHtml(p.title || "")}</div>
          <div class="nc-detail-muted" style="font-size:0.85rem;">${escapeHtml(p.excerpt || "")}</div>
        </span>
      `;
      newsList.appendChild(row);
    }
    const hint = document.createElement("p");
    hint.className = "nc-detail-muted";
    hint.textContent = "Tip: select up to 3 posts for Home. Extra selections will be trimmed.";
    newsList.appendChild(hint);
  }

  function featuredIdsFromDom() {
    if (!newsList) return state.featured_blog_post_ids || [];
    const ids = [];
    newsList.querySelectorAll('input[type="checkbox"]:checked').forEach((cb) => {
      const v = (cb.value || "").trim();
      if (v) ids.push(Number(v));
    });
    return ids.filter((x) => Number.isFinite(x)).slice(0, 20);
  }

  function setTab(which) {
    const tabs = dlg.querySelectorAll("[data-home-tab]");
    if (!tabs || !tabs.length) return;
    tabs.forEach((b) => {
      const on = b.getAttribute("data-home-tab") === which;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", String(on));
    });
    if (tabAnn) tabAnn.hidden = which !== "ann";
    if (tabNews) tabNews.hidden = which !== "news";
  }

  async function open() {
    setStatus("");
    renderAnnouncements();
    if (newsList) {
      const r = await api("/blogs", { method: "GET" });
      const j = await r.json().catch(() => ({}));
      renderNews(j.posts || []);
      setTab("ann");
    }
    dlg.hidden = false;
    document.body.style.overflow = "hidden";
  }

  async function save() {
    setStatus("Saving…");
    if (btnSave) btnSave.disabled = true;
    try {
      const cleaned = syncAnnouncementsFromDom();
      const payload = {
        config: {
          announcements: cleaned,
          featured_blog_post_ids: featuredIdsFromDom(),
        },
      };
      const body = JSON.stringify(payload);
      if (body.length > 8_000_000) {
        throw new Error(
          "Announcement content is too large to save. Remove embedded images and paste pictures instead so they upload."
        );
      }
      let r = await fetch(HOME_API, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (r.status === 403 || r.status === 405) {
        r = await fetch(HOME_API, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body,
        });
      }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(saveErrorMessage(r, j));
      dlg.hidden = true;
      document.body.style.overflow = "";
      window.location.reload();
    } catch (e) {
      setStatus(String(e && e.message ? e.message : e) || "Save failed");
    } finally {
      if (btnSave) btnSave.disabled = false;
    }
  }

  btnEdit.addEventListener("click", open);
  function close() {
    dlg.hidden = true;
    document.body.style.overflow = "";
  }
  if (btnX) btnX.addEventListener("click", close);
  if (btnCancel) btnCancel.addEventListener("click", close);
  if (form) form.addEventListener("submit", (e) => (e.preventDefault(), save()));

  if (dlg) {
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) close();
    });
    dlg.querySelectorAll("[data-home-tab]").forEach((b) => {
      b.addEventListener("click", () => setTab(b.getAttribute("data-home-tab")));
    });
  }

  if (annAdd) {
    annAdd.addEventListener("click", () => {
      state.announcements = syncAnnouncementsFromDom();
      state.announcements.push({
        category: "General",
        title: "",
        body_html: "",
        show_full_on_home: false,
      });
      renderAnnouncements();
    });
  }

  if (annList) {
    annList.addEventListener("mousedown", (e) => {
      const b = e.target && e.target.closest ? e.target.closest("button[data-cmd]") : null;
      if (b) e.preventDefault();
    });

    annList.addEventListener("click", (e) => {
      const t = e.target;
      if (!t || !t.closest) return;

      if (t.closest(".nc-home-ann-showfull")) {
        e.stopPropagation();
        return;
      }

      const removeBtn = t.closest("button[data-remove]");
      if (removeBtn) {
        e.preventDefault();
        e.stopPropagation();
        const card = removeBtn.closest(".nc-home-ann-card");
        if (!card) return;
        if (!window.confirm("Remove this announcement?")) return;
        state.announcements = syncAnnouncementsFromDom();
        const cards = [...annList.querySelectorAll(".nc-home-ann-card")];
        const i = cards.indexOf(card);
        if (i < 0) return;
        state.announcements.splice(i, 1);
        renderAnnouncements();
        return;
      }

      const cmdBtn = t.closest("button[data-cmd]");
      if (cmdBtn) {
        e.preventDefault();
        const card = cmdBtn.closest(".nc-home-ann-card");
        const editor = card ? card.querySelector('[data-k="body_html"]') : null;
        runCmd(editor, cmdBtn.getAttribute("data-cmd"));
      }
    });

    annList.addEventListener("paste", async (e) => {
      const editor = e.target && e.target.closest ? e.target.closest('[data-k="body_html"]') : null;
      if (!editor) return;
      const dt = e.clipboardData;
      if (!dt || !dt.items) return;
      const items = Array.from(dt.items || []);
      const imgItem = items.find((it) => it && it.kind === "file" && String(it.type || "").startsWith("image/"));
      if (!imgItem) return;
      const file = imgItem.getAsFile ? imgItem.getAsFile() : null;
      if (!file) return;
      e.preventDefault();
      setStatus("Uploading image…");
      try {
        const url = await uploadImage(file);
        editor.focus();
        document.execCommand("insertImage", false, url);
        setStatus("Image added.");
      } catch (err) {
        setStatus(String(err && err.message ? err.message : err) || "Image upload failed");
      }
    });
  }
})();
