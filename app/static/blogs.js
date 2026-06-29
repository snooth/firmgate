(function () {
  const root = document.getElementById("nc-blogs");
  const raw = document.getElementById("nc-blogs-data");
  if (!root || !raw) return;

  let posts = [];
  try {
    posts = JSON.parse(raw.textContent || "[]") || [];
  } catch {
    posts = [];
  }

  const dlg = document.getElementById("nc-blog-dlg");
  const form = document.getElementById("nc-blog-form");
  const btnNew = document.getElementById("nc-blog-new");
  const btnCancel = document.getElementById("nc-blog-cancel");
  const status = document.getElementById("nc-blog-msg");
  const fTitle = document.getElementById("nc-blog-title");
  const fDate = document.getElementById("nc-blog-date");
  const fExcerpt = document.getElementById("nc-blog-excerpt");
  const fBody = document.getElementById("nc-blog-body");
  const fImage = document.getElementById("nc-blog-image");
  const fPostId = document.getElementById("nc-blog-post-id");
  const fStatus = document.getElementById("nc-blog-status");
  const pillStatus = document.getElementById("nc-blog-pill-status");
  const fCategory = document.getElementById("nc-blog-category");
  const fVisibility = document.getElementById("nc-blog-visibility");
  const fNotify = document.getElementById("nc-blog-notify");
  const fComments = document.getElementById("nc-blog-comments");
  const btnDraft = document.getElementById("nc-blog-save-draft");
  const btnPublish = document.getElementById("nc-blog-publish");
  const btnPreview = document.getElementById("nc-blog-preview-btn");
  const btnDelete = document.getElementById("nc-blog-delete");
  const cover = document.getElementById("nc-blog-cover");
  const coverInner = document.getElementById("nc-blog-cover-inner");
  const coverFile = document.getElementById("nc-blog-cover-file");
  const toolbar = document.querySelector(".nc-blog-toolbar");
  const heading = document.getElementById("nc-blog-heading");
  const meta = document.getElementById("nc-blog-meta");
  // (Preview panel removed for composer v3; we keep future hooks minimal.)

  // Preview viewer (PDF-style)
  const previewViewer = document.getElementById("nc-blog-preview-viewer");
  const previewClose = document.getElementById("nc-blog-preview-close");
  const previewEdit = document.getElementById("nc-blog-preview-edit");
  const previewDelete = document.getElementById("nc-blog-preview-delete");
  const prevTitle = document.getElementById("nc-blog-prev-h1");
  const prevContent = document.getElementById("nc-blog-prev-content");
  const prevHero = document.getElementById("nc-blog-prev-hero");
  const prevCat = document.getElementById("nc-blog-prev-cat");
  const prevDate = document.getElementById("nc-blog-prev-date");
  const prevAuthor = document.getElementById("nc-blog-prev-author");
  const prevAuthorAv = document.getElementById("nc-blog-prev-author-av");
  const prevTopTitle = document.getElementById("nc-blog-preview-title");

  const canWrite = root && root.getAttribute("data-can-write") === "1";
  const canDelete = root && root.getAttribute("data-can-delete") === "1";
  let lastViewedPost = null;
  let isSyncingFromPop = false;

  function setStatus(msg) {
    if (status) status.textContent = msg || "";
  }

  function postIdFrom(p) {
    if (!p) return null;
    const raw = p.post_id;
    if (raw != null && raw !== "" && Number.isFinite(Number(raw))) return Number(raw);
    const alt = p.id;
    if (alt != null && /^\d+$/.test(String(alt))) return Number(alt);
    return null;
  }

  async function api(path, opts = {}) {
    const r = await fetch(`/intranet/api${path}`, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      ...opts,
    });
    return r;
  }

  function fmtMeta(_p) {
    return "";
  }

  function escHtml(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function renderBodyHtml(raw) {
    const s = String(raw || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = s.split("\n");
    const out = [];
    let inList = false;
    function closeList() {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
    }
    for (const line0 of lines) {
      const line = line0.trimEnd();
      const t = line.trim();
      if (!t) {
        closeList();
        continue;
      }
      if (/^---+$/.test(t)) {
        closeList();
        out.push("<hr>");
        continue;
      }
      const h = /^(#{2,3})\s+(.*)$/.exec(t);
      if (h) {
        closeList();
        out.push(`<h3>${escHtml(h[2] || "")}</h3>`);
        continue;
      }
      const call = /^>\s+(.*)$/.exec(t);
      if (call) {
        closeList();
        out.push(`<div class="nc-blog-callout">${escHtml(call[1] || "")}</div>`);
        continue;
      }
      const li = /^[-*]\s+(.*)$/.exec(t);
      if (li) {
        if (!inList) {
          out.push("<ul>");
          inList = true;
        }
        out.push(`<li>${escHtml(li[1] || "")}</li>`);
        continue;
      }
      closeList();
      out.push(`<p>${escHtml(t)}</p>`);
    }
    closeList();
    return out.join("");
  }

  function initialsFromName(name) {
    const s = String(name || "").trim();
    if (!s) return "";
    const parts = s.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return s.slice(0, 2).toUpperCase();
  }

  function estReadMinutes(text) {
    const s = String(text || "").trim();
    if (!s) return 0;
    const words = s.split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.round(words / 200));
  }

  function sanitizeHtml(html) {
    // Allow a safe subset of tags/attrs for preview.
    const allowed = new Set(["P", "BR", "B", "I", "U", "EM", "STRONG", "H1", "H2", "H3", "UL", "OL", "LI", "A", "IMG", "BLOCKQUOTE", "HR", "DIV", "SPAN"]);
    const allowedAttr = {
      A: new Set(["href", "target", "rel"]),
      IMG: new Set(["src", "alt"]),
      DIV: new Set(["class"]),
      SPAN: new Set(["class"]),
      BLOCKQUOTE: new Set(["class"]),
    };
    const doc = new DOMParser().parseFromString(`<div>${String(html || "")}</div>`, "text/html");
    const root = doc.body;

    function walk(node) {
      const kids = Array.from(node.childNodes || []);
      for (const k of kids) {
        if (k.nodeType === 1) {
          const el = k;
          const tag = el.tagName;
          if (!allowed.has(tag)) {
            // Replace with its text content.
            const t = doc.createTextNode(el.textContent || "");
            el.replaceWith(t);
            continue;
          }
          // Strip attrs
          const keep = allowedAttr[tag] || new Set();
          Array.from(el.attributes || []).forEach((a) => {
            if (!keep.has(a.name)) el.removeAttribute(a.name);
          });
          if (tag === "A") {
            const href = (el.getAttribute("href") || "").trim();
            if (!href || href.toLowerCase().startsWith("javascript:")) el.removeAttribute("href");
            el.setAttribute("target", "_blank");
            el.setAttribute("rel", "noopener noreferrer");
          }
          if (tag === "IMG") {
            const src = (el.getAttribute("src") || "").trim();
            if (!src || src.toLowerCase().startsWith("javascript:")) {
              el.remove();
              continue;
            }
          }
          walk(el);
        } else if (k.nodeType === 3) {
          // ok
        } else {
          // remove comments/other
          k.remove();
        }
      }
    }
    walk(root);
    return root.innerHTML;
  }

  async function uploadImage(file) {
    const fd = new FormData();
    fd.append("file", file, file.name || "image.png");
    const r = await fetch("/intranet/api/blogs/upload-image", { method: "POST", credentials: "same-origin", body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.url) throw new Error(j.error || "Upload failed");
    return String(j.url);
  }

  function setPostStatus(st) {
    const s = st === "published" ? "published" : "draft";
    if (fStatus) fStatus.value = s;
    if (pillStatus) pillStatus.textContent = s === "published" ? "Published" : "Draft";
  }

  function urlWithOpen(id) {
    const u = new URL(window.location.href);
    if (id == null || id === "") u.searchParams.delete("open");
    else u.searchParams.set("open", String(id));
    return u.pathname + (u.search ? u.search : "") + (u.hash ? u.hash : "");
  }

  function syncUrlOpen(id, mode) {
    // mode: "push" | "replace"
    const href = urlWithOpen(id);
    const st = { ...(history.state || {}), blog_open: id ? String(id) : null };
    if (mode === "replace") history.replaceState(st, "", href);
    else history.pushState(st, "", href);
  }

  function openViewer(payload, opts = {}) {
    if (!previewViewer) return;
    const title = String(payload && payload.title ? payload.title : "").trim();
    const cat = String(payload && payload.category ? payload.category : "").trim();
    const author = String(payload && payload.author ? payload.author : "").trim();
    const date = String(payload && (payload.date || payload.date_iso) ? payload.date || payload.date_iso : "").trim();
    const coverUrl = String(payload && (payload.cover_image_url || payload.image || payload.cover) ? payload.cover_image_url || payload.image || payload.cover : "").trim();
    const body = payload && payload.body != null ? payload.body : "";
    const bodyHtml = typeof body === "string" && body.includes("<") ? body : renderBodyHtml(body);

    lastViewedPost = payload || null;

    if (prevTopTitle) prevTopTitle.textContent = opts.topTitle || "Post";
    if (prevTitle) prevTitle.textContent = title || "Untitled";
    if (prevCat) prevCat.textContent = cat || "Blog";
    if (prevDate) prevDate.textContent = date || "";
    if (prevAuthor) prevAuthor.textContent = author || (opts.fallbackAuthor || "");
    if (prevAuthorAv) prevAuthorAv.textContent = initialsFromName(author || opts.fallbackAuthor || "") || "";
    if (prevContent) prevContent.innerHTML = sanitizeHtml(bodyHtml);
    if (prevHero) {
      if (coverUrl) {
        prevHero.style.backgroundImage = `url("${coverUrl.replace(/"/g, '\\"')}")`;
        prevHero.hidden = false;
      } else {
        prevHero.style.backgroundImage = "";
        prevHero.hidden = true;
      }
    }

    const pidNum = postIdFrom(payload);
    if (previewEdit) {
      previewEdit.hidden = !(canWrite && pidNum);
    }
    if (previewDelete) {
      previewDelete.hidden = !(canDelete && pidNum);
    }

    previewViewer.hidden = false;

    const pid = pidNum != null ? String(pidNum) : null;
    if (!isSyncingFromPop) {
      const nav = opts && opts.nav ? String(opts.nav) : "push";
      if (nav === "replace") syncUrlOpen(pid, "replace");
      else if (nav === "none") {
        // do nothing
      } else syncUrlOpen(pid, "push");
    }
  }

  function openPreview() {
    const payload = {
      title: fTitle ? fTitle.value : "",
      category: fCategory ? fCategory.value : "",
      cover_image_url: fImage ? fImage.value : "",
      body: fBody ? fBody.innerHTML : "",
      author: "You",
      date: "",
    };
    openViewer(payload, { topTitle: "Preview", fallbackAuthor: "You", nav: "push" });
  }

  function closePreview() {
    if (!previewViewer) return;
    previewViewer.hidden = true;

    if (!isSyncingFromPop) {
      // If the URL indicates an open post, going Back should return to the list.
      const u = new URL(window.location.href);
      const has = u.searchParams.has("open");
      if (has) {
        try {
          history.back();
          return;
        } catch (_) {}
      }
      // Fallback: ensure URL doesn't keep open=...
      try {
        syncUrlOpen(null, "replace");
      } catch (_) {}
    }
  }

  function updatePreviewFromFields(_p) {}

  function openEditor(p) {
    if (!dlg) return;
    setStatus("");
    const pid = postIdFrom(p);
    if (heading) heading.textContent = pid ? "Edit blog post" : "New blog post";
    if (meta) meta.textContent = "";
    if (fPostId) fPostId.value = pid ? String(pid) : "";
    if (btnDelete) btnDelete.hidden = !(canDelete && pid);
    if (fTitle) fTitle.value = (p && p.title) || "";
    setPostStatus((p && p.status) || "draft");
    if (fCategory) fCategory.value = (p && p.category) || "";
    if (fVisibility) fVisibility.value = (p && p.visibility) || "all";
    if (fNotify) fNotify.checked = !!(p && p.notify_on_publish);
    if (fComments) fComments.checked = !!(p && p.allow_comments);
    if (fExcerpt) fExcerpt.value = (p && p.excerpt) || "";
    if (fBody) fBody.innerHTML = (p && p.body) || "";
    if (fImage) fImage.value = (p && (p.cover_image_url || p.image)) || "";
    applyCoverUi(fImage ? fImage.value : "");
    dlg.hidden = false;
    document.body.style.overflow = "hidden";
    try {
      (fTitle || fExcerpt).focus();
    } catch {}
  }

  function openReadMore(p) {
    // Full-width viewer for reading.
    openViewer(
      {
        ...(p || {}),
        title: (p && p.title) || "",
        category: (p && p.category) || "",
        cover_image_url: (p && (p.cover_image_url || p.image)) || "",
        author: (p && p.author) || "",
        date: (p && (p.date || p.date_iso)) || "",
        body: (p && p.body) || "",
      },
      { topTitle: "Blog post", nav: "push" }
    );
  }

  function setEditable(on) {
    [fTitle, fCategory, fVisibility, fExcerpt, fImage].forEach((el) => {
      if (!el) return;
      if (on) el.removeAttribute("readonly");
      else el.setAttribute("readonly", "true");
    });
    if (fBody) {
      if (on) fBody.setAttribute("contenteditable", "true");
      else fBody.setAttribute("contenteditable", "false");
    }
  }

  async function deletePost(postId) {
    if (postId == null || !Number.isFinite(postId)) return;
    const ok = window.confirm("Delete this blog post? This cannot be undone.");
    if (!ok) return;
    setStatus("Deleting…");
    const r = await api(`/blogs/${postId}`, { method: "DELETE" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setStatus(j.error || "Delete failed.");
      return;
    }
    try {
      if (dlg) dlg.hidden = true;
      document.body.style.overflow = "";
      if (previewViewer) previewViewer.hidden = true;
    } catch {}
    window.location.reload();
  }

  async function save(statusNext) {
    let postId = fPostId && fPostId.value ? Number(fPostId.value) : null;
    if (postId != null && !Number.isFinite(postId)) postId = null;
    const nextStatus = statusNext === "published" ? "published" : "draft";
    const payload = {
      title: fTitle ? fTitle.value : "",
      category: fCategory ? fCategory.value : "",
      visibility: fVisibility ? fVisibility.value : "all",
      excerpt: fExcerpt ? fExcerpt.value : "",
      body: fBody ? fBody.innerHTML : "",
      cover_image_url: fImage ? fImage.value : "",
      notify_on_publish: fNotify ? !!fNotify.checked : false,
      allow_comments: fComments ? !!fComments.checked : false,
      status: nextStatus,
    };
    if (!payload.title.trim()) {
      setStatus("Title is required.");
      return;
    }
    setStatus(nextStatus === "published" ? "Publishing…" : "Saving…");
    const r = await api(postId ? `/blogs/${postId}` : "/blogs", {
      method: postId ? "PATCH" : "POST",
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setStatus(j.error || "Save failed.");
      return;
    }
    // Reload posts so list reflects DB ordering/formatting
    const rr = await api("/blogs", { method: "GET" });
    const jj = await rr.json().catch(() => ({}));
    posts = jj.posts || posts;
    // Hard refresh list (simple: reload page)
    window.location.reload();
  }

  if (btnNew) btnNew.addEventListener("click", () => {
    setEditable(true);
    openEditor(null);
  });
  if (btnCancel) btnCancel.addEventListener("click", () => {
    if (dlg) dlg.hidden = true;
    document.body.style.overflow = "";
  });
  if (btnPreview) btnPreview.addEventListener("click", () => openPreview());
  if (previewClose) previewClose.addEventListener("click", closePreview);
  if (previewEdit)
    previewEdit.addEventListener("click", () => {
      if (!lastViewedPost) return;
      closePreview();
      setEditable(true);
      openEditor(lastViewedPost);
    });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      // Close editor first (if open), otherwise close the viewer.
      if (dlg && dlg.hidden === false) {
        dlg.hidden = true;
        document.body.style.overflow = "";
        return;
      }
      closePreview();
    }
  });

  // Card actions
  root.querySelectorAll("[data-blog-action][data-blog-id]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      const id = el.getAttribute("data-blog-id");
      const action = el.getAttribute("data-blog-action");
      const p = posts.find((x) => String(x.id) === String(id) || String(x.post_id) === String(id) || String(x.id) === String(id));
      if (!p) return;
      if (action === "edit") {
        setEditable(true);
        openEditor(p);
      } else if (action === "delete") {
        deletePost(postIdFrom(p));
      } else {
        openReadMore(p);
      }
    });
  });

  function openFromUrlIfNeeded(navMode) {
    try {
      const sp = new URLSearchParams(window.location.search || "");
      const openId = sp.get("open");
      if (!openId) return false;
      const p = posts.find((x) => String(x.id) === String(openId) || String(x.post_id) === String(openId));
      if (!p) return false;
      isSyncingFromPop = true;
      openViewer(
        {
          ...(p || {}),
          title: p.title || "",
          category: p.category || "",
          cover_image_url: p.cover_image_url || p.image || "",
          author: p.author || "",
          date: p.date || p.date_iso || "",
          body: p.body || "",
        },
        { topTitle: "Blog post", nav: navMode || "replace" }
      );
      isSyncingFromPop = false;
      return true;
    } catch (_) {
      isSyncingFromPop = false;
      return false;
    }
  }

  // Deep-link support: /intranet/blogs?open=<post_id>
  openFromUrlIfNeeded("replace");

  // Back/Forward should open/close the viewer.
  window.addEventListener("popstate", () => {
    const opened = openFromUrlIfNeeded("none");
    if (!opened) {
      isSyncingFromPop = true;
      closePreview();
      isSyncingFromPop = false;
    }
  });

  if (btnDraft) btnDraft.addEventListener("click", () => save("draft"));
  if (btnPublish) btnPublish.addEventListener("click", () => save("published"));
  if (btnDelete) {
    btnDelete.addEventListener("click", () => deletePost(postIdFrom({ post_id: fPostId ? fPostId.value : null })));
  }
  if (previewDelete) {
    previewDelete.addEventListener("click", () => deletePost(postIdFrom(lastViewedPost)));
  }
  if (form) form.addEventListener("submit", (e) => e.preventDefault());

  // Live preview while editing
  [fTitle, fExcerpt, fBody, fImage].forEach((el) => {
    if (!el) return;
    el.addEventListener("input", () => updatePreviewFromFields({ date: meta ? meta.textContent : "" }));
  });

  if (toolbar && fBody) {
    toolbar.addEventListener("click", async (e) => {
      const b = e.target && e.target.closest ? e.target.closest("button[data-cmd]") : null;
      if (!b) return;
      const cmd = b.getAttribute("data-cmd");
      if (!cmd) return;
      e.preventDefault();
      fBody.focus();
      try {
        if (cmd === "bold") document.execCommand("bold");
        else if (cmd === "italic") document.execCommand("italic");
        else if (cmd === "underline") document.execCommand("underline");
        else if (cmd === "ul") document.execCommand("insertUnorderedList");
        else if (cmd === "h1") document.execCommand("formatBlock", false, "h1");
        else if (cmd === "h2") document.execCommand("formatBlock", false, "h2");
        else if (cmd === "link") {
          const url = window.prompt("Link URL");
          if (url) document.execCommand("createLink", false, url);
        } else if (cmd === "img") {
          const url = window.prompt("Image URL");
          if (url) document.execCommand("insertImage", false, url);
        }
      } catch (_) {}
      updatePreviewFromFields({});
    });
  }

  // Cover image: click + drag/drop upload
  async function handleCoverFile(file) {
    if (!file) return;
    setStatus("Uploading image…");
    try {
      const url = await uploadImage(file);
      if (fImage) fImage.value = url;
      applyCoverUi(url);
      updatePreviewFromFields({});
      setStatus("Image uploaded.");
    } catch (err) {
      setStatus(String(err && err.message ? err.message : err) || "Upload failed");
    }
  }

  function applyCoverUi(url) {
    if (!cover) return;
    const u = String(url || "").trim();
    if (u) {
      cover.classList.add("has-image");
      cover.style.backgroundImage = `url("${u.replace(/"/g, '\\"')}")`;
      if (coverInner) coverInner.hidden = true;
    } else {
      cover.classList.remove("has-image");
      cover.style.backgroundImage = "";
      if (coverInner) coverInner.hidden = false;
    }
  }

  if (coverInner && coverFile) {
    coverInner.addEventListener("click", () => coverFile.click());
    coverInner.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") coverFile.click();
    });
    coverFile.addEventListener("change", () => {
      const f = coverFile.files && coverFile.files[0];
      handleCoverFile(f);
    });
  }
  if (cover) {
    cover.addEventListener("dragover", (e) => {
      e.preventDefault();
      cover.classList.add("is-dragover");
    });
    cover.addEventListener("dragleave", () => {
      cover.classList.remove("is-dragover");
    });
    cover.addEventListener("drop", (e) => {
      e.preventDefault();
      cover.classList.remove("is-dragover");
      const f = e.dataTransfer && e.dataTransfer.files ? e.dataTransfer.files[0] : null;
      handleCoverFile(f);
    });
  }

  // Paste image into editor -> upload -> insert <img>
  if (fBody) {
    fBody.addEventListener("paste", async (e) => {
      const dt = e.clipboardData;
      if (!dt || !dt.items) return;
      const items = Array.from(dt.items || []);
      const img = items.find((it) => it && it.kind === "file" && String(it.type || "").startsWith("image/"));
      if (!img) return;
      const file = img.getAsFile ? img.getAsFile() : null;
      if (!file) return;
      e.preventDefault();
      try {
        setStatus("Uploading image…");
        const url = await uploadImage(file);
        document.execCommand("insertImage", false, url);
        setStatus("Image added.");
        updatePreviewFromFields({});
      } catch (err) {
        setStatus(String(err && err.message ? err.message : err) || "Image upload failed");
      }
    });
  }
})();

