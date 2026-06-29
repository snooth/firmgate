(function () {
  const root = document.getElementById("nc-wiki-root");
  if (!root) return;

  const apiPagesUrl =
    (root.getAttribute("data-api-pages") || "").trim() || "/intranet/api/wiki/pages";
  const apiWatchesUrl =
    (root.getAttribute("data-api-watches") || "").trim() ||
    apiPagesUrl.replace(/\/?pages\/?$/i, "/watches");
  const wikiApiBase = apiPagesUrl.replace(/\/?pages\/?$/i, "");
  const apiUploadUrl =
    (root.getAttribute("data-api-upload") || "").trim() || `${wikiApiBase}/upload-image`;

  function pageApiUrl(slug) {
    return `${wikiApiBase}/page/${encodeURIComponent(slug)}`;
  }

  function watchPutUrl(slug) {
    return `${pageApiUrl(slug)}/watch`;
  }

  function feedbackPutUrl(slug) {
    return `${pageApiUrl(slug)}/feedback`;
  }

  function notesApiUrl(slug) {
    return `${pageApiUrl(slug)}/notes`;
  }

  const listEl = document.getElementById("wiki-list");
  const searchEl = document.getElementById("wiki-search");
  const loadingEl = document.getElementById("wiki-loading");
  const titleEl = document.getElementById("wiki-title");
  const metaEl = document.getElementById("wiki-meta");
  const bodyEl = document.getElementById("wiki-body");
  const editorWrap = document.getElementById("wiki-editor-wrap");
  const breadcrumbsEl = document.getElementById("wiki-breadcrumbs");
  const tocEl = document.getElementById("wiki-toc");
  const relatedEl = document.getElementById("wiki-related");
  const btnNew = document.getElementById("wiki-new");
  const btnEdit = document.getElementById("wiki-edit");
  const btnDelete = document.getElementById("wiki-delete");
  const btnSave = document.getElementById("wiki-save");
  const btnCancel = document.getElementById("wiki-cancel");
  const btnWatch = document.getElementById("wiki-watch");
  const watchLabelEl = document.getElementById("wiki-watch-label");
  const btnMore = document.getElementById("wiki-more-btn");
  const moreMenu = document.getElementById("wiki-more-menu");
  const newPageModal = document.getElementById("wiki-newpage-modal");
  const newPageInput = document.getElementById("wiki-newpage-input");
  const newPageClose = document.getElementById("wiki-newpage-close");
  const newPageCancel = document.getElementById("wiki-newpage-cancel");
  const newPageCreate = document.getElementById("wiki-newpage-create");
  const btnFeedbackUp = document.getElementById("wiki-feedback-up");
  const btnFeedbackDown = document.getElementById("wiki-feedback-down");
  const feedbackHintEl = document.getElementById("wiki-feedback-hint");
  const feedbackUpCountEl = document.getElementById("wiki-feedback-up-count");
  const feedbackDownCountEl = document.getElementById("wiki-feedback-down-count");
  const titleEditWrap = document.getElementById("wiki-title-edit-wrap");
  const titleEditInput = document.getElementById("wiki-title-edit");
  const pagesCountEl = document.getElementById("wiki-pages-count");
  const btnNewRail = document.getElementById("wiki-new-rail");
  const mobileNavSelect = document.getElementById("wiki-mobile-nav-select");
  const mobilePageSelect = document.getElementById("wiki-mobile-page-select");
  const btnMobileNew = document.getElementById("wiki-mobile-new");
  const notesListEl = document.getElementById("wiki-notes-list");
  const notesEditor = document.getElementById("wiki-notes-editor");
  const notesPostBtn = document.getElementById("wiki-notes-post");
  const notesStatusEl = document.getElementById("wiki-notes-status");
  const notesComposeEl = document.getElementById("wiki-notes-compose");
  const notesEmojiBar = document.getElementById("wiki-notes-emoji-bar");
  const notesSectionEl = document.getElementById("wiki-notes-section");

  const WIKI_NOTE_EMOJIS = [
    "😀", "😊", "👍", "🎉", "❤️", "🔥", "✅", "❌", "⚠️", "💡",
    "📎", "📷", "🙏", "👀", "💬", "🚀", "⭐", "😅", "🤔", "👏",
  ];

  const canEdit = root.getAttribute("data-can-edit") === "1";
  const canDelete = root.getAttribute("data-can-delete") === "1";
  const canFeedbackShell = root.getAttribute("data-can-feedback") === "1";

  let allowEditCurrent = canEdit;
  let allowDeleteCurrent = canDelete;

  let pages = [];
  let currentSlug = null;
  let editing = false;
  /** @type {"all"|"recent"|"watchlist"} */
  let sidebarView = "all";
  /** @type {import("quill").default | null} */
  let quill = null;
  /** HTML seed for the editor (same as rendered body for this page). */
  let editorHtmlSeed = "";
  /** Server-backed watchlist (slug strings). */
  let watchSet = new Set();
  /** Last feedback payload from the API for the current page. */
  let lastFeedback = null;

  async function refreshWatchSet() {
    try {
      const j = await fetchJSON(apiWatchesUrl);
      watchSet = new Set((j.slugs || []).filter(Boolean).map(String));
    } catch (_) {
      watchSet = new Set();
    }
  }

  function filteredBySearch(basePages) {
    const raw = searchEl && searchEl.value != null ? String(searchEl.value) : "";
    const q = raw.trim().toLowerCase();
    if (!q) return basePages.slice();
    return basePages.filter((p) => {
      const title = (p.title != null ? String(p.title) : "").toLowerCase();
      const slug = (p.slug != null ? String(p.slug) : "").toLowerCase();
      return title.includes(q) || slug.includes(q);
    });
  }

  function pagesForView() {
    let base = filteredBySearch(pages);
    if (sidebarView === "recent") {
      base = [...base].sort((a, b) => {
        const ta = a.updated_at ? Date.parse(String(a.updated_at)) : 0;
        const tb = b.updated_at ? Date.parse(String(b.updated_at)) : 0;
        return tb - ta;
      });
    } else if (sidebarView === "watchlist") {
      base = base.filter((p) => watchSet.has(String(p.slug)));
    }
    return base;
  }

  function formatShortDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
    try {
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    } catch (_) {
      return String(iso).slice(0, 10);
    }
  }

  function formatMetaLine(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return `Last updated: ${iso}`;
    try {
      const ds = d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
      return `Last updated: ${ds}`;
    } catch (_) {
      return `Last updated: ${iso}`;
    }
  }

  function formatNoteWhen(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    try {
      return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    } catch (_) {
      return String(iso).slice(0, 16);
    }
  }

  function noteAuthorInitials(name) {
    const s = (name || "").trim();
    if (!s) return "?";
    const parts = s.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return s.slice(0, 2).toUpperCase();
  }

  function setNotesStatus(msg) {
    if (notesStatusEl) notesStatusEl.textContent = msg || "";
  }

  function setNotesComposeEnabled(on) {
    const en = !!on;
    if (notesEditor) {
      notesEditor.contentEditable = en ? "true" : "false";
      notesEditor.classList.toggle("is-disabled", !en);
    }
    if (notesPostBtn) notesPostBtn.disabled = !en;
    if (notesComposeEl) notesComposeEl.classList.toggle("is-disabled", !en);
    if (notesEmojiBar) {
      notesEmojiBar.querySelectorAll("button").forEach((b) => {
        b.disabled = !en;
      });
    }
  }

  function clearNotesUi() {
    if (notesListEl) {
      notesListEl.innerHTML = '<p class="nc-wiki-notes-empty">Open a page to view and add notes.</p>';
    }
    if (notesEditor) notesEditor.innerHTML = "";
    setNotesStatus("");
    setNotesComposeEnabled(false);
  }

  function renderNotesList(notes) {
    if (!notesListEl) return;
    if (!notes || !notes.length) {
      notesListEl.innerHTML = '<p class="nc-wiki-notes-empty">No notes yet. Be the first to comment.</p>';
      return;
    }
    notesListEl.innerHTML = notes
      .map((n) => {
        const who = escapeHtml(n.author_name || "User");
        const when = escapeHtml(formatNoteWhen(n.created_at));
        const ini = escapeHtml(noteAuthorInitials(n.author_name));
        const body = n.body_html || "";
        return `<article class="nc-wiki-note${n.is_mine ? " is-mine" : ""}">
          <header class="nc-wiki-note-head">
            <span class="nc-wiki-note-avatar" aria-hidden="true">${ini}</span>
            <span class="nc-wiki-note-meta"><strong>${who}</strong><span class="nc-wiki-note-when">${when}</span></span>
          </header>
          <div class="nc-wiki-note-body nc-wiki-prose">${body}</div>
        </article>`;
      })
      .join("");
  }

  async function loadNotes(slug) {
    if (!notesListEl || !slug) {
      clearNotesUi();
      return;
    }
    notesListEl.innerHTML = '<p class="nc-wiki-notes-empty">Loading notes…</p>';
    setNotesComposeEnabled(!editing);
    try {
      const j = await fetchJSON(notesApiUrl(slug));
      renderNotesList(j.notes || []);
      setNotesComposeEnabled(!editing);
    } catch (e) {
      notesListEl.innerHTML = `<p class="nc-wiki-notes-empty">${escapeHtml(e.message || "Could not load notes.")}</p>`;
      setNotesComposeEnabled(false);
    }
  }

  function insertEmojiInNotes(emoji) {
    if (!notesEditor || notesEditor.classList.contains("is-disabled")) return;
    notesEditor.focus();
    try {
      document.execCommand("insertText", false, emoji);
    } catch (_) {
      notesEditor.appendChild(document.createTextNode(emoji));
    }
  }

  async function insertNoteImage(file) {
    if (!file || !file.type || !file.type.startsWith("image/")) return;
    if (file.size > 8 * 1024 * 1024) {
      alert("Image must be 8 MB or smaller.");
      return;
    }
    setNotesStatus("Uploading image…");
    try {
      const url = await uploadWikiImageBlob(file);
      if (!notesEditor) return;
      notesEditor.focus();
      const img = document.createElement("img");
      img.src = url;
      img.alt = "Screenshot";
      img.className = "nc-wiki-note-img";
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const range = sel.getRangeAt(0);
        range.collapse(false);
        range.insertNode(img);
        range.setStartAfter(img);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        notesEditor.appendChild(img);
        notesEditor.appendChild(document.createElement("br"));
      }
      setNotesStatus("");
    } catch (e) {
      setNotesStatus(String(e && e.message ? e.message : e) || "Upload failed");
    }
  }

  function notesEditorHtml() {
    if (!notesEditor) return "";
    return (notesEditor.innerHTML || "").trim();
  }

  async function postNote() {
    if (!currentSlug || !notesEditor || editing) return;
    const html = notesEditorHtml();
    if (!html || html === "<br>" || html === "<p><br></p>") {
      setNotesStatus("Write something before posting.");
      return;
    }
    if (notesPostBtn) notesPostBtn.disabled = true;
    setNotesStatus("Posting…");
    try {
      const r = await fetch(notesApiUrl(currentSlug), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ body_html: html }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Could not post note");
      notesEditor.innerHTML = "";
      setNotesStatus("");
      await loadNotes(currentSlug);
    } catch (e) {
      setNotesStatus(String(e && e.message ? e.message : e) || "Post failed");
    } finally {
      if (notesPostBtn) notesPostBtn.disabled = !!editing || !currentSlug;
    }
  }

  function updateBreadcrumbs(pageTitle) {
    if (!breadcrumbsEl) return;
    if (!currentSlug) {
      breadcrumbsEl.innerHTML = "";
      return;
    }
    const path = window.location.pathname || "/intranet/wiki";
    const t = escapeHtml(pageTitle || currentSlug);
    breadcrumbsEl.innerHTML = `<a class="nc-wiki-bc-link" href="${escapeAttr(path)}">Wiki</a><span class="nc-wiki-bc-sep" aria-hidden="true">›</span><span class="nc-wiki-bc-current">${t}</span>`;
  }

  function buildTOC() {
    if (!tocEl) return;
    if (!bodyEl || bodyEl.hidden) {
      tocEl.innerHTML = '<p class="nc-wiki-toc-empty">Sections appear when the article has headings.</p>';
      return;
    }
    const headings = bodyEl.querySelectorAll("h2, h3");
    if (!headings.length) {
      tocEl.innerHTML = '<p class="nc-wiki-toc-empty">No headings on this page.</p>';
      return;
    }
    let n = 0;
    const parts = [];
    headings.forEach((el) => {
      const id = el.id || `wiki-h-${n++}`;
      if (!el.id) el.id = id;
      const text = (el.textContent || "").trim() || "Section";
      const isH3 = el.tagName === "H3";
      parts.push(
        `<a href="#${escapeAttr(
          id
        )}" class="nc-wiki-toc-link${isH3 ? " is-nested" : ""}">${escapeHtml(text)}</a>`
      );
    });
    tocEl.innerHTML = parts.join("");
  }

  function renderRelated() {
    if (!relatedEl) return;
    if (!currentSlug || !pages.length) {
      relatedEl.innerHTML = '<p class="nc-wiki-related-empty">No other pages yet.</p>';
      return;
    }
    const others = pages.filter((p) => p.slug !== currentSlug).slice(0, 5);
    if (!others.length) {
      relatedEl.innerHTML = '<p class="nc-wiki-related-empty">No other pages yet.</p>';
      return;
    }
    relatedEl.innerHTML = others
      .map((p) => {
        const sub = formatShortDate(p.updated_at);
        return `<button type="button" class="nc-wiki-related-row" data-slug="${escapeAttr(p.slug)}">
      <span class="nc-wiki-related-doc" aria-hidden="true"></span>
      <span class="nc-wiki-related-text">
        <span class="nc-wiki-related-title">${escapeHtml(p.title)}</span>
        ${sub ? `<span class="nc-wiki-related-sub">${escapeHtml(sub)}</span>` : ""}
      </span>
    </button>`;
      })
      .join("");
    relatedEl.querySelectorAll("[data-slug]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const slug = btn.getAttribute("data-slug");
        if (slug) void openPage(slug);
      });
    });
  }

  function renderFeedback(fb, opts) {
    const editingPage = !!(opts && opts.editing);
    if (!btnFeedbackUp || !btnFeedbackDown) return;
    const setCounts = (up, down) => {
      if (feedbackUpCountEl) feedbackUpCountEl.textContent = String(up);
      if (feedbackDownCountEl) feedbackDownCountEl.textContent = String(down);
    };
    if (!fb || !currentSlug) {
      btnFeedbackUp.disabled = true;
      btnFeedbackDown.disabled = true;
      btnFeedbackUp.classList.remove("is-selected");
      btnFeedbackDown.classList.remove("is-selected");
      setCounts(0, 0);
      btnFeedbackUp.setAttribute("aria-label", "Helpful");
      btnFeedbackDown.setAttribute("aria-label", "Not helpful");
      if (feedbackHintEl) {
        feedbackHintEl.textContent = canFeedbackShell
          ? "Open a page to rate it."
          : "Your role does not include wiki feedback.";
      }
      return;
    }
    const can = !!fb.can_vote && !editingPage;
    btnFeedbackUp.disabled = !can || fb.my_vote === 1;
    btnFeedbackDown.disabled = !can;
    btnFeedbackUp.setAttribute("aria-pressed", fb.my_vote === 1 ? "true" : "false");
    btnFeedbackDown.setAttribute("aria-pressed", fb.my_vote === -1 ? "true" : "false");
    btnFeedbackUp.classList.toggle("is-selected", fb.my_vote === 1);
    btnFeedbackDown.classList.toggle("is-selected", fb.my_vote === -1);
    const up = Number(fb.helpful_up) || 0;
    const down = Number(fb.helpful_down) || 0;
    setCounts(up, down);
    btnFeedbackUp.setAttribute("aria-label", `Helpful — ${up} vote${up === 1 ? "" : "s"}`);
    btnFeedbackDown.setAttribute("aria-label", `Not helpful — ${down} vote${down === 1 ? "" : "s"}`);
    if (feedbackHintEl) {
      feedbackHintEl.textContent = fb.can_vote
        ? "One helpful vote per person per page (cannot be undone). You can switch to not helpful once."
        : "Counts show all votes. Your role does not include submitting feedback.";
    }
  }

  function syncWatchButton() {
    if (!btnWatch) return;
    const has = !!(currentSlug && watchSet.has(String(currentSlug)));
    btnWatch.setAttribute("aria-pressed", has ? "true" : "false");
    if (watchLabelEl) watchLabelEl.textContent = has ? "Watching" : "Watch";
    const ic = btnWatch.querySelector(".nc-wiki-rail-btn-ic");
    if (ic) ic.textContent = has ? "★" : "☆";
    btnWatch.disabled = !currentSlug || editing;
  }

  function closeMoreMenu() {
    if (moreMenu) {
      moreMenu.hidden = true;
      if (btnMore) btnMore.setAttribute("aria-expanded", "false");
    }
  }

  function syncMoreButton() {
    if (!btnMore) return;
    const show = !!(allowDeleteCurrent && currentSlug && !editing);
    btnMore.hidden = !show;
    if (!show) closeMoreMenu();
  }

  function resetQuillEditorShell() {
    if (!editorWrap) return;
    editorWrap.querySelectorAll(".ql-toolbar").forEach((el) => el.remove());
    const old = document.getElementById("wiki-quill-editor");
    if (old) old.remove();
    const nu = document.createElement("div");
    nu.id = "wiki-quill-editor";
    nu.className = "nc-wiki-quill-editor";
    editorWrap.appendChild(nu);
  }

  async function fetchJSON(url, opts) {
    const r = await fetch(url, { credentials: "same-origin", ...opts });
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    let j = {};
    if (ct.includes("application/json")) {
      j = await r.json().catch(() => ({}));
    } else {
      await r.text().catch(() => "");
    }
    if (!r.ok) throw new Error(j.error || r.statusText || "Request failed");
    return j;
  }

  async function uploadWikiImageBlob(file) {
    const fd = new FormData();
    fd.append("file", file, file.name || "image.png");
    const r = await fetch(apiUploadUrl, { method: "POST", body: fd, credentials: "same-origin" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Image upload failed");
    if (!j.url) throw new Error("No image URL returned");
    return String(j.url);
  }

  function insertImageAtCaret(url) {
    if (!quill) return;
    const range = quill.getSelection(true);
    const idx = range ? range.index : quill.getLength();
    quill.insertEmbed(idx, "image", url, "user");
    quill.setSelection(idx + 1, 0);
  }

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function escapeAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;");
  }

  function destroyQuill() {
    if (quill) {
      try {
        if (typeof quill.destroy === "function") quill.destroy();
      } catch (_) {
        /* ignore */
      }
    }
    quill = null;
    resetQuillEditorShell();
  }

  function buildQuillToolbar() {
    return [
      [{ header: [1, 2, 3, 4, 5, 6, false] }],
      [{ font: [] }, { size: ["small", false, "large", "huge"] }],
      ["bold", "italic", "underline", "strike"],
      [{ color: [] }, { background: [] }],
      [{ script: "sub" }, { script: "super" }],
      [{ align: [] }, { direction: "rtl" }],
      [{ list: "ordered" }, { list: "bullet" }, { indent: "-1" }, { indent: "+1" }],
      ["blockquote", "code-block"],
      ["link", "image"],
      ["clean"],
    ];
  }

  function ensureQuill() {
    if (typeof window.Quill === "undefined") {
      throw new Error("Editor failed to load. Check your network connection.");
    }
    destroyQuill();
    const mount = document.getElementById("wiki-quill-editor");
    if (!mount) throw new Error("Missing editor mount.");
    const Q = window.Quill;
    try {
      const Font = Q.import("formats/font");
      if (Font && Array.isArray(Font.whitelist)) {
        Font.whitelist = ["sans-serif", "serif", "monospace"];
        Q.register(Font, true);
      }
    } catch (_) {
      /* keep default fonts if import path differs */
    }

    const toolbarContainer = buildQuillToolbar();

    function pickImageFile() {
      return new Promise((resolve) => {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = "image/*";
        inp.multiple = false;
        inp.style.display = "none";
        document.body.appendChild(inp);
        inp.addEventListener("change", () => {
          const f = inp.files && inp.files[0];
          try {
            document.body.removeChild(inp);
          } catch (_) {
            /* ignore */
          }
          resolve(f || null);
        });
        inp.click();
      });
    }

    async function uploadAndInsertImage(file) {
      if (!file || !file.type || !file.type.startsWith("image/")) return;
      if (file.size > 8 * 1024 * 1024) {
        alert("Image must be 8 MB or smaller.");
        return;
      }
      try {
        const url = await uploadWikiImageBlob(file);
        insertImageAtCaret(url);
      } catch (e) {
        alert(String(e && e.message ? e.message : e) || "Upload failed");
      }
    }

    quill = new Q(mount, {
      theme: "snow",
      modules: {
        toolbar: {
          container: toolbarContainer,
          handlers: {
            image: function () {
              void pickImageFile().then((f) => {
                if (f) void uploadAndInsertImage(f);
              });
            },
          },
        },
      },
    });

    quill.root.addEventListener(
      "paste",
      (e) => {
        const items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        for (let i = 0; i < items.length; i++) {
          if (items[i].type && items[i].type.indexOf("image") !== -1) {
            e.preventDefault();
            const blob = items[i].getAsFile();
            if (blob) void uploadAndInsertImage(blob);
            return;
          }
        }
      },
      true
    );

    quill.root.addEventListener(
      "drop",
      (e) => {
        const dt = e.dataTransfer;
        if (!dt || !dt.files || !dt.files.length) return;
        const f = dt.files[0];
        if (f.type && f.type.startsWith("image/")) {
          e.preventDefault();
          void uploadAndInsertImage(f);
        }
      },
      true
    );

    const html = editorHtmlSeed || "<p><br></p>";
    quill.clipboard.dangerouslyPasteHTML(html);
  }

  function setEditing(on) {
    const want = !!on;
    if (want === editing) return;
    editing = want;
    if (editorWrap) editorWrap.hidden = !editing;
    if (bodyEl) bodyEl.hidden = editing;
    if (btnEdit) btnEdit.hidden = editing || !allowEditCurrent || !currentSlug;
    if (btnDelete) btnDelete.hidden = editing || !allowDeleteCurrent || !currentSlug;
    if (btnSave) btnSave.hidden = !editing;
    if (btnCancel) btnCancel.hidden = !editing;
    if (titleEditWrap) titleEditWrap.hidden = !editing;
    if (titleEditInput && editing && titleEl) {
      titleEditInput.value = (titleEl.textContent || "").trim() || "";
    }
    syncWatchButton();
    syncMoreButton();
    renderFeedback(lastFeedback, { editing });
    setNotesComposeEnabled(!editing && !!currentSlug);
    if (editing) {
      closeMoreMenu();
      try {
        ensureQuill();
      } catch (e) {
        quill = null;
        resetQuillEditorShell();
        alert(String(e && e.message ? e.message : e) || "Editor error");
        editing = false;
        if (editorWrap) editorWrap.hidden = true;
        if (bodyEl) bodyEl.hidden = false;
        if (btnSave) btnSave.hidden = true;
        if (btnCancel) btnCancel.hidden = true;
        if (btnEdit && allowEditCurrent && currentSlug) btnEdit.hidden = false;
        if (btnDelete && allowDeleteCurrent && currentSlug) btnDelete.hidden = false;
        syncWatchButton();
        syncMoreButton();
        renderFeedback(lastFeedback, { editing: false });
      }
    } else {
      destroyQuill();
    }
  }

  function syncMobileNavSelect() {
    if (!mobileNavSelect) return;
    if ([...mobileNavSelect.options].some((o) => o.value === sidebarView)) {
      mobileNavSelect.value = sidebarView;
    }
  }

  function rebuildMobilePageSelect() {
    if (!mobilePageSelect) return;
    const list = pagesForView();
    mobilePageSelect.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = list.length ? "Select a page…" : "No pages in this view";
    mobilePageSelect.appendChild(placeholder);
    for (const p of list) {
      const opt = document.createElement("option");
      opt.value = p.slug;
      opt.textContent = p.title || p.slug;
      mobilePageSelect.appendChild(opt);
    }
    if (currentSlug && [...mobilePageSelect.options].some((o) => o.value === currentSlug)) {
      mobilePageSelect.value = currentSlug;
    } else {
      mobilePageSelect.value = "";
    }
  }

  function setSidebarView(view) {
    const v = view === "recent" || view === "watchlist" ? view : "all";
    sidebarView = v;
    document.querySelectorAll("[data-wiki-nav]").forEach((b) => {
      const key = b.getAttribute("data-wiki-nav") || "all";
      b.classList.toggle("is-active", key === sidebarView);
    });
    syncMobileNavSelect();
    renderList();
  }

  function renderList() {
    if (!listEl) return;
    if (pagesCountEl) {
      pagesCountEl.textContent = pages.length ? `(${pages.length})` : "";
    }
    if (!pages.length) {
      listEl.innerHTML = `<div class="nc-wiki-empty">No pages yet.${canEdit ? " Use <b>+ Create Wiki Page</b> below." : ""}</div>`;
      return;
    }
    const list = pagesForView();
    if (!list.length) {
      const q = searchEl && searchEl.value != null ? String(searchEl.value).trim() : "";
      if (sidebarView === "watchlist") {
        listEl.innerHTML =
          '<div class="nc-wiki-empty">No starred pages match. Use <b>Watch</b> (☆) in the panel on the right.</div>';
      } else if (q) {
        listEl.innerHTML = `<div class="nc-wiki-empty">No pages match <b>${escapeHtml(q)}</b>.</div>`;
      } else {
        listEl.innerHTML = `<div class="nc-wiki-empty">Nothing to show for this view.</div>`;
      }
      return;
    }
    listEl.innerHTML = list
      .map((p) => {
        const active = p.slug === currentSlug ? " is-active" : "";
        const sub = p.updated_at ? formatShortDate(p.updated_at) : "";
        return `<button type="button" class="nc-wiki-item${active}" data-slug="${escapeAttr(p.slug)}" role="listitem">
            <span class="nc-wiki-item-title">${escapeHtml(p.title)}</span>
            ${sub ? `<span class="nc-wiki-item-sub">${escapeHtml(sub)}</span>` : ""}
          </button>`;
      })
      .join("");
    listEl.querySelectorAll("[data-slug]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const slug = btn.getAttribute("data-slug");
        if (slug) void openPage(slug);
      });
    });
    rebuildMobilePageSelect();
  }

  async function openPage(slug) {
    if (!slug || !titleEl || !bodyEl || !metaEl) return;
    closeMoreMenu();
    if (editing) {
      destroyQuill();
      editing = false;
      if (editorWrap) editorWrap.hidden = true;
      if (btnSave) btnSave.hidden = true;
      if (btnCancel) btnCancel.hidden = true;
    }
    currentSlug = slug;
    allowEditCurrent = canEdit;
    allowDeleteCurrent = canDelete;
    setEditing(false);
    renderList();
    try {
      const j = await fetchJSON(pageApiUrl(slug));
      const ttl = j.title || slug;
      titleEl.textContent = ttl;
      const metaParts = [];
      if (j.updated_at) metaParts.push(formatMetaLine(j.updated_at));
      if (j.author_name) metaParts.push(`Author: ${j.author_name}`);
      metaEl.textContent = metaParts.join(" · ");
      bodyEl.innerHTML = j.body_html || "";
      bodyEl.hidden = false;
      editorHtmlSeed = j.body_html || "";
      updateBreadcrumbs(ttl);
      if (typeof j.watching === "boolean") {
        const s = String(slug);
        if (j.watching) watchSet.add(s);
        else watchSet.delete(s);
      }
      lastFeedback = j.feedback || null;
      renderFeedback(lastFeedback, { editing: false });
      const allowEdit = typeof j.can_edit === "boolean" ? j.can_edit : canEdit;
      const allowDel = typeof j.can_delete === "boolean" ? j.can_delete : canDelete;
      allowEditCurrent = allowEdit;
      allowDeleteCurrent = allowDel;
      if (btnEdit) btnEdit.hidden = !allowEdit;
      if (btnDelete) btnDelete.hidden = !allowDel || !currentSlug;
      syncMoreButton();
      syncWatchButton();
      void loadNotes(slug);
      try {
        const u = new URL(window.location.href);
        u.searchParams.set("slug", slug);
        window.history.replaceState({}, "", u);
      } catch (_) {
        /* ignore */
      }
      requestAnimationFrame(() => {
        buildTOC();
        renderRelated();
      });
    } catch (e) {
      lastFeedback = null;
      renderFeedback(null, { editing: false });
      bodyEl.innerHTML = `<p class="nc-wiki-error">${escapeHtml(e.message || String(e))}</p>`;
      if (tocEl) tocEl.innerHTML = '<p class="nc-wiki-toc-empty">Could not load article.</p>';
    }
  }

  function slugFromQuery() {
    try {
      const p = new URLSearchParams(window.location.search);
      return (p.get("slug") || "").trim();
    } catch (_) {
      return "";
    }
  }

  function clearArticleChrome() {
    lastFeedback = null;
    allowEditCurrent = canEdit;
    allowDeleteCurrent = canDelete;
    if (breadcrumbsEl) breadcrumbsEl.innerHTML = "";
    if (tocEl) tocEl.innerHTML = '<p class="nc-wiki-toc-empty">Open a page to see sections.</p>';
    if (relatedEl) relatedEl.innerHTML = '<p class="nc-wiki-related-empty">Related links appear when pages exist.</p>';
    renderFeedback(null, { editing: false });
    syncWatchButton();
    syncMoreButton();
    clearNotesUi();
  }

  async function init() {
    if (btnNew) btnNew.hidden = !canEdit;
    if (btnNewRail) btnNewRail.hidden = !canEdit;
    if (btnMobileNew) btnMobileNew.hidden = !canEdit;
    syncMobileNavSelect();
    if (loadingEl) loadingEl.textContent = "Loading pages…";
    document.querySelectorAll("[data-wiki-nav]").forEach((btn) => {
      btn.addEventListener("click", () => {
        setSidebarView(btn.getAttribute("data-wiki-nav") || "all");
      });
    });
    mobileNavSelect?.addEventListener("change", () => {
      setSidebarView(mobileNavSelect.value || "all");
    });
    mobilePageSelect?.addEventListener("change", () => {
      const slug = mobilePageSelect.value;
      if (slug) void openPage(slug);
    });
    btnMobileNew?.addEventListener("click", () => {
      if (btnNew && !btnNew.hidden) btnNew.click();
      else if (btnNewRail && !btnNewRail.hidden) btnNewRail.click();
    });
    try {
      await refreshWatchSet();
      const j = await fetchJSON(apiPagesUrl);
      pages = j.pages || [];
      renderList();
      const want = slugFromQuery();
      if (want) {
        currentSlug = want;
        await openPage(want);
      } else {
        if (!currentSlug && pages.length) currentSlug = pages[0].slug;
        if (currentSlug) {
          await openPage(currentSlug);
        } else {
          titleEl.textContent = "Wiki";
          metaEl.textContent = "";
          bodyEl.innerHTML = `<div class="nc-wiki-empty">No pages yet.${canEdit ? " Use <b>+ Create Wiki Page</b> below." : ""}</div>`;
          if (btnEdit) btnEdit.hidden = true;
          clearArticleChrome();
        }
      }
    } catch (e) {
      if (loadingEl) loadingEl.textContent = "Could not load wiki.";
      if (listEl) listEl.innerHTML = `<div class="nc-wiki-error">${escapeHtml(e.message || String(e))}</div>`;
    } finally {
      if (loadingEl && loadingEl.parentNode) loadingEl.remove();
    }
  }

  if (btnEdit) {
    btnEdit.addEventListener("click", () => {
      if (!currentSlug || editing) return;
      setEditing(true);
    });
  }

  if (btnCancel) {
    btnCancel.addEventListener("click", async () => {
      if (!currentSlug) return;
      await openPage(currentSlug);
    });
  }

  if (btnSave) {
    btnSave.addEventListener("click", async () => {
      if (!currentSlug || !quill) return;
      btnSave.disabled = true;
      try {
        const html = quill.getSemanticHTML ? quill.getSemanticHTML() : quill.root.innerHTML;
        const titlePatch =
          titleEditInput && titleEditInput.value != null
            ? String(titleEditInput.value).trim()
            : "";
        const payload = { content_html: html };
        if (titlePatch) payload.title = titlePatch;
        const r = await fetch(pageApiUrl(currentSlug), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(payload),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || "Save failed");
        const jj = await fetchJSON(apiPagesUrl);
        pages = jj.pages || [];
        renderList();
        await openPage(currentSlug);
      } catch (e) {
        alert(String(e && e.message ? e.message : e) || "Save failed");
      } finally {
        btnSave.disabled = false;
      }
    });
  }

  if (btnDelete) {
    btnDelete.addEventListener("click", async () => {
      if (!currentSlug) return;
      closeMoreMenu();
      if (!window.confirm(`Delete wiki page “${currentSlug}”? This cannot be undone.`)) return;
      btnDelete.disabled = true;
      try {
        const r = await fetch(pageApiUrl(currentSlug), {
          method: "DELETE",
          credentials: "same-origin",
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || "Delete failed");
        currentSlug = null;
        const jj = await fetchJSON(apiPagesUrl);
        pages = jj.pages || [];
        renderList();
        if (pages.length) {
          currentSlug = pages[0].slug;
          await openPage(currentSlug);
        } else {
          titleEl.textContent = "Wiki";
          metaEl.textContent = "";
          bodyEl.innerHTML = `<div class="nc-wiki-empty">No pages yet.${canEdit ? " Use <b>+ Create Wiki Page</b> below." : ""}</div>`;
          if (btnEdit) btnEdit.hidden = true;
          if (btnDelete) btnDelete.hidden = true;
          clearArticleChrome();
        }
      } catch (e) {
        alert(String(e && e.message ? e.message : e) || "Delete failed");
      } finally {
        btnDelete.disabled = false;
      }
    });
  }

  if (btnWatch) {
    btnWatch.addEventListener("click", async () => {
      if (!currentSlug || editing) return;
      const s = String(currentSlug);
      const next = !watchSet.has(s);
      btnWatch.disabled = true;
      try {
        const r = await fetch(watchPutUrl(s), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ watch: next }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || "Could not update watchlist");
        if (j.watching) watchSet.add(s);
        else watchSet.delete(s);
        syncWatchButton();
        if (sidebarView === "watchlist") renderList();
      } catch (e) {
        alert(String(e && e.message ? e.message : e) || "Watch failed");
      } finally {
        syncWatchButton();
      }
    });
  }

  async function submitFeedbackVote(vote) {
    if (!currentSlug || editing) return;
    try {
      const r = await fetch(feedbackPutUrl(currentSlug), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ vote }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Could not save feedback");
      if (j.feedback) {
        lastFeedback = j.feedback;
        renderFeedback(lastFeedback, { editing: false });
      }
    } catch (e) {
      alert(String(e && e.message ? e.message : e) || "Feedback failed");
    }
  }

  if (btnFeedbackUp) {
    btnFeedbackUp.addEventListener("click", () => {
      if (!lastFeedback || !lastFeedback.can_vote) return;
      if (lastFeedback.my_vote === 1) return;
      void submitFeedbackVote(1);
    });
  }
  if (btnFeedbackDown) {
    btnFeedbackDown.addEventListener("click", () => {
      if (!lastFeedback || !lastFeedback.can_vote) return;
      const mv = lastFeedback.my_vote;
      if (mv === -1) void submitFeedbackVote(0);
      else void submitFeedbackVote(-1);
    });
  }

  if (btnMore && moreMenu) {
    btnMore.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = moreMenu.hidden;
      moreMenu.hidden = !open;
      btnMore.setAttribute("aria-expanded", open ? "true" : "false");
    });
    document.addEventListener("click", (e) => {
      if (!moreMenu || moreMenu.hidden) return;
      const t = e.target;
      if (btnMore.contains(t)) return;
      if (moreMenu.contains(t)) return;
      closeMoreMenu();
    });
  }

  if (searchEl) {
    searchEl.addEventListener("input", () => {
      renderList();
    });
  }

  let newPageModalPrevFocus = null;

  function closeNewPageModal() {
    if (!newPageModal) return;
    newPageModal.hidden = true;
    newPageModal.setAttribute("aria-hidden", "true");
    if (newPageModalPrevFocus && typeof newPageModalPrevFocus.focus === "function") {
      try {
        newPageModalPrevFocus.focus();
      } catch (_) {
        /* ignore */
      }
    }
    newPageModalPrevFocus = null;
  }

  function openNewPageModal() {
    if (!newPageModal || !newPageInput) return;
    newPageModalPrevFocus = document.activeElement;
    newPageInput.value = "Untitled";
    newPageModal.hidden = false;
    newPageModal.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => {
      newPageInput.focus();
      newPageInput.select();
    });
  }

  async function createPageFromModal() {
    if (!newPageInput || !newPageCreate) return;
    const t = String(newPageInput.value || "").trim() || "Untitled";
    newPageCreate.disabled = true;
    if (btnNew) btnNew.disabled = true;
    if (btnNewRail) btnNewRail.disabled = true;
    try {
      const r = await fetch(apiPagesUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ title: t, body_md: `# ${t.replace(/\r?\n/g, " ")}\n\n` }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Could not create page");
      const slug = j.page && j.page.slug ? j.page.slug : null;
      closeNewPageModal();
      const jj = await fetchJSON(apiPagesUrl);
      pages = jj.pages || [];
      renderList();
      if (slug) await openPage(slug);
    } catch (e) {
      alert(String(e && e.message ? e.message : e) || "Create failed");
    } finally {
      newPageCreate.disabled = false;
      if (btnNew) btnNew.disabled = false;
      if (btnNewRail) btnNewRail.disabled = false;
    }
  }

  if (newPageModal) {
    newPageModal.addEventListener("click", (e) => {
      if (e.target === newPageModal) closeNewPageModal();
    });
  }
  if (newPageClose) newPageClose.addEventListener("click", () => closeNewPageModal());
  if (newPageCancel) newPageCancel.addEventListener("click", () => closeNewPageModal());
  if (newPageCreate) newPageCreate.addEventListener("click", () => void createPageFromModal());
  if (newPageInput) {
    newPageInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        void createPageFromModal();
      }
    });
  }
  document.addEventListener("keydown", (ev) => {
    if (!newPageModal || newPageModal.hidden) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeNewPageModal();
    }
  });

  if (btnNew) {
    btnNew.addEventListener("click", () => {
      openNewPageModal();
    });
  }
  if (btnNewRail) {
    btnNewRail.addEventListener("click", () => {
      openNewPageModal();
    });
  }

  if (notesEmojiBar) {
    notesEmojiBar.innerHTML = WIKI_NOTE_EMOJIS.map(
      (em) =>
        `<button type="button" class="nc-wiki-notes-emoji" data-emoji="${escapeAttr(em)}" title="Insert ${escapeAttr(em)}">${em}</button>`
    ).join("");
    notesEmojiBar.querySelectorAll("[data-emoji]").forEach((btn) => {
      btn.addEventListener("click", () => insertEmojiInNotes(btn.getAttribute("data-emoji") || ""));
    });
  }

  if (notesEditor) {
    notesEditor.addEventListener(
      "paste",
      (e) => {
        const items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        for (let i = 0; i < items.length; i++) {
          if (items[i].type && items[i].type.indexOf("image") !== -1) {
            e.preventDefault();
            const blob = items[i].getAsFile();
            if (blob) void insertNoteImage(blob);
            return;
          }
        }
      },
      true
    );
    notesEditor.addEventListener(
      "drop",
      (e) => {
        const dt = e.dataTransfer;
        if (!dt || !dt.files || !dt.files.length) return;
        const f = dt.files[0];
        if (f.type && f.type.startsWith("image/")) {
          e.preventDefault();
          void insertNoteImage(f);
        }
      },
      true
    );
  }

  if (notesPostBtn) {
    notesPostBtn.addEventListener("click", () => void postNote());
  }

  void init();
})();
