(function () {
  "use strict";

  const PAGE_SIZE = 8;
  const LS_SAVED = "nc_resource_pool_saved_searches_v1";

  const pool = window.__RP_POOL__ || { resources: [], kpis: {}, filters: {} };
  const canCreate = window.__RP_CAN_CREATE__ === true || window.__RP_CAN_CREATE__ === "true";
  const canDelete = window.__RP_CAN_DELETE__ === true || window.__RP_CAN_DELETE__ === "true";
  const rpUser = window.__RP_USER__ || { id: 0, name: "User" };
  const apiBase = "/intranet/api/resource-pool";
  const wikiUploadUrl = "/intranet/api/wiki/upload-image";

  const RP_NOTE_EMOJIS = [
    "😀", "😊", "👍", "🎉", "❤️", "🔥", "✅", "❌", "⚠️", "💡",
    "📎", "📷", "🙏", "👀", "💬", "🚀", "⭐", "😅", "🤔", "👏",
  ];
  const RP_NOTE_MORE_EMOJIS = [
    "😀", "😁", "😂", "🤣", "😊", "😍", "😘", "😎", "😅", "🙂",
    "🙃", "😉", "😴", "🤔", "😮", "😢", "😭", "😡", "👍", "👎",
    "🙏", "👏", "🔥", "🎉", "✅", "❌", "⭐", "❤️", "💡", "📷",
  ];
  let rpNotesEmojiPop = null;

  const RP_COLUMN_CATALOG = [
    { key: "name", label: "Name" },
    { key: "skills", label: "Key skills" },
    { key: "clearance", label: "Clearance" },
    { key: "location", label: "Location" },
    { key: "availability", label: "Availability" },
    { key: "employment_type", label: "Employment type" },
    { key: "department", label: "Department" },
    { key: "job_title", label: "Job title" },
    { key: "email", label: "Email" },
    { key: "phone", label: "Phone" },
    { key: "reports_to", label: "Reports to" },
    { key: "resource_added", label: "Resource added" },
    { key: "actions", label: "Actions" },
    { key: "notes", label: "Notes" },
    { key: "updated_at", label: "Last updated" },
  ];
  const RP_DEFAULT_COLUMNS = [
    "name",
    "skills",
    "clearance",
    "location",
    "availability",
    "actions",
    "notes",
    "updated_at",
  ];
  const RP_COLS_STORAGE_KEY = "nc.resource_pool.listColumns.v1";
  const RP_CATALOG_KEYS = new Set(RP_COLUMN_CATALOG.map((c) => c.key));
  const RP_CATALOG_BY_KEY = Object.fromEntries(RP_COLUMN_CATALOG.map((c) => [c.key, c]));

  function loadListColumns() {
    try {
      const raw = localStorage.getItem(RP_COLS_STORAGE_KEY);
      if (!raw) return RP_DEFAULT_COLUMNS.slice();
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return RP_DEFAULT_COLUMNS.slice();
      const out = parsed.map((k) => String(k)).filter((k) => RP_CATALOG_KEYS.has(k));
      return out.length ? out : RP_DEFAULT_COLUMNS.slice();
    } catch {
      return RP_DEFAULT_COLUMNS.slice();
    }
  }

  function saveListColumns(keys) {
    try {
      localStorage.setItem(RP_COLS_STORAGE_KEY, JSON.stringify(keys));
    } catch {
      /* ignore */
    }
  }

  let listColumns = loadListColumns();
  let columnEditorDraft = null;

  let all = Array.isArray(pool.resources) ? pool.resources.slice() : [];
  let filtered = all.slice();
  let page = 1;
  let selectedId = null;
  let selectedIds = new Set();
  let activeTab = "overview";
  let viewMode = "list";
  let panelViewMode = "content";
  let sectionEditKey = null;

  const el = (id) => document.getElementById(id);

  function selectedResource() {
    return all.find((x) => x.id === selectedId) || null;
  }

  function cvMediaUrl(r) {
    if (!r?.has_cv || !r.cv_stored) return "";
    return `/intranet/media/resource-pool/${r.id}/${encodeURIComponent(r.cv_stored)}`;
  }

  function mergeResource(updated) {
    if (!updated?.id) return;
    const i = all.findIndex((x) => x.id === updated.id);
    if (i >= 0) all[i] = updated;
    const j = filtered.findIndex((x) => x.id === updated.id);
    if (j >= 0) filtered[j] = updated;
  }

  function sectionEditBar(section, label) {
    if (!canCreate) return "";
    return `<div class="nc-rp-section-bar"><button type="button" class="nc-rp-section-edit" data-rp-section="${esc(section)}">Edit ${esc(label)}</button></div>`;
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatDate(iso) {
    if (!iso) return "—";
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return "—";
      return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
    } catch {
      return "—";
    }
  }

  function formatNoteWhen(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      return d.toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch {
      return iso;
    }
  }

  function stripHtml(html) {
    const d = document.createElement("div");
    d.innerHTML = html || "";
    return (d.textContent || "").trim();
  }

  function noteAuthorInitials(name) {
    const parts = String(name || "?").trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return (parts[0] || "?").slice(0, 2).toUpperCase();
  }

  function notePreviewText(n) {
    const plain = stripHtml(n.body_html || "");
    if (plain) return plain;
    return String(n.text || n.body || "").trim();
  }

  function runNotesCmd(cmd, val) {
    try {
      document.execCommand(cmd, false, val);
    } catch {
      /* ignore */
    }
  }

  async function uploadNoteImage(file) {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(wikiUploadUrl, { method: "POST", credentials: "same-origin", body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.url) throw new Error(data.error || "Image upload failed");
    return data.url;
  }

  function ensureRpNotesEmojiPop() {
    if (rpNotesEmojiPop) return rpNotesEmojiPop;
    const pop = document.createElement("div");
    pop.className = "nc-rp-notes-emoji-pop";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Emoji picker");
    pop.innerHTML = `<div class="nc-rp-notes-emoji-grid">${RP_NOTE_MORE_EMOJIS.map(
      (e) => `<button type="button" data-emoji="${esc(e)}">${esc(e)}</button>`
    ).join("")}</div>`;
    document.body.appendChild(pop);
    rpNotesEmojiPop = pop;
    document.addEventListener("click", (ev) => {
      if (!pop.classList.contains("is-open")) return;
      if (ev.target.closest(".nc-rp-notes-emoji-pop") || ev.target.closest("[data-rp-notes-emoji-more]")) return;
      pop.classList.remove("is-open");
    });
    return pop;
  }

  function renderNotesFeedHtml(notes) {
    const uid = Number(rpUser.id) || 0;
    if (!notes.length) {
      return '<p class="nc-rp-notes-empty">No notes yet. Post the first message below.</p>';
    }
    return notes
      .map((n) => {
        const mine = uid && Number(n.author_id) === uid;
        const who = esc(n.author_name || "Unknown");
        const when = esc(formatNoteWhen(n.created_at));
        const ini = esc(noteAuthorInitials(n.author_name));
        const body = n.body_html || (n.text ? `<p>${esc(n.text)}</p>` : "");
        return `<article class="nc-rp-notes-msg${mine ? " is-mine" : ""}">
          <span class="nc-rp-notes-av" aria-hidden="true">${ini}</span>
          <div class="nc-rp-notes-bub">
            <div class="nc-rp-notes-meta"><strong>${who}</strong> · ${when}</div>
            <div class="nc-rp-notes-body">${body}</div>
          </div>
        </article>`;
      })
      .join("");
  }

  function wireNotesChatPanel(panel, r) {
    const feed = panel.querySelector("[data-rp-notes-feed]");
    if (feed) {
      feed.innerHTML = renderNotesFeedHtml(Array.isArray(r.notes) ? r.notes : []);
      feed.scrollTop = feed.scrollHeight;
    }
    if (!canCreate) return;

    const editor = panel.querySelector("[data-rp-notes-editor]");
    const postBtn = panel.querySelector("[data-rp-notes-post]");
    const statusEl = panel.querySelector("[data-rp-notes-status]");
    const emojiBar = panel.querySelector("[data-rp-notes-emoji-bar]");
    const emojiMore = panel.querySelector("[data-rp-notes-emoji-more]");

    const setStatus = (t) => {
      if (statusEl) statusEl.textContent = t || "";
    };

    const insertEmoji = (emoji) => {
      if (!editor) return;
      editor.focus();
      try {
        document.execCommand("insertText", false, emoji);
      } catch {
        editor.appendChild(document.createTextNode(emoji));
      }
    };

    if (emojiBar) {
      emojiBar.innerHTML = RP_NOTE_EMOJIS.map(
        (e) => `<button type="button" class="nc-rp-notes-emoji" data-emoji="${esc(e)}" title="Insert ${esc(e)}">${esc(e)}</button>`
      ).join("");
      emojiBar.querySelectorAll("[data-emoji]").forEach((btn) => {
        btn.addEventListener("click", () => insertEmoji(btn.getAttribute("data-emoji") || ""));
      });
    }

    if (emojiMore) {
      emojiMore.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const pop = ensureRpNotesEmojiPop();
        const rect = emojiMore.getBoundingClientRect();
        pop.style.left = `${Math.min(rect.left, window.innerWidth - 240)}px`;
        pop.style.top = `${rect.top - 8}px`;
        pop.style.transform = "translateY(-100%)";
        pop.classList.add("is-open");
        pop.onclick = (e) => {
          const b = e.target.closest("button[data-emoji]");
          if (!b) return;
          insertEmoji(b.getAttribute("data-emoji") || "");
          pop.classList.remove("is-open");
        };
      });
    }

    panel.querySelector("[data-rp-notes-toolbar]")?.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-rp-cmd]");
      if (!btn || !editor) return;
      ev.preventDefault();
      const cmd = btn.getAttribute("data-rp-cmd");
      if (cmd === "createLink") {
        const url = window.prompt("Link URL");
        if (url) runNotesCmd("createLink", url);
      } else if (cmd) {
        runNotesCmd(cmd);
      }
      editor.focus();
    });

    panel.querySelector("[data-rp-notes-toolbar]")?.addEventListener("mousedown", (ev) => {
      if (ev.target.closest("[data-rp-cmd]")) ev.preventDefault();
    });

    if (editor) {
      editor.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && !ev.shiftKey) {
          ev.preventDefault();
          postBtn?.click();
        }
      });
      editor.addEventListener("paste", (e) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (let i = 0; i < items.length; i++) {
          if (items[i].type && items[i].type.indexOf("image") !== -1) {
            e.preventDefault();
            const blob = items[i].getAsFile();
            if (!blob) return;
            if (blob.size > 8 * 1024 * 1024) {
              setStatus("Image must be 8 MB or smaller.");
              return;
            }
            setStatus("Uploading image…");
            uploadNoteImage(blob)
              .then((url) => {
                editor.focus();
                const img = document.createElement("img");
                img.src = url;
                img.alt = "Pasted image";
                img.className = "nc-rp-notes-body-img";
                const sel = window.getSelection();
                if (sel?.rangeCount) {
                  const range = sel.getRangeAt(0);
                  range.collapse(false);
                  range.insertNode(img);
                  range.setStartAfter(img);
                  range.collapse(true);
                  sel.removeAllRanges();
                  sel.addRange(range);
                } else {
                  editor.appendChild(img);
                }
                setStatus("");
              })
              .catch((err) => setStatus(err.message || "Upload failed"));
            return;
          }
        }
      });
    }

    postBtn?.addEventListener("click", async () => {
      if (!editor) return;
      const html = (editor.innerHTML || "").trim();
      if (!html || html === "<br>" || html === "<p><br></p>") {
        setStatus("Write a note before posting.");
        return;
      }
      postBtn.disabled = true;
      setStatus("Posting…");
      try {
        const res = await fetch(`${apiBase}/resources/${r.id}/notes`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body_html: html }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Could not post note");
        editor.innerHTML = "";
        setStatus("");
        mergeResource(data.resource);
        const fresh = selectedResource();
        if (fresh && feed) {
          feed.innerHTML = renderNotesFeedHtml(fresh.notes || []);
          feed.scrollTop = feed.scrollHeight;
          renderProfileHead(fresh);
          if (activeTab !== "notes") renderPanelContent(fresh);
        }
      } catch (err) {
        setStatus(err.message || "Post failed");
      } finally {
        postBtn.disabled = false;
      }
    });
  }

  function renderNotesChatPanel(r) {
    const compose = canCreate
      ? `<div class="nc-rp-notes-compose">
          <div class="nc-rp-notes-toolbar" data-rp-notes-toolbar>
            <button type="button" class="nc-rp-notes-tool" data-rp-cmd="bold" title="Bold"><b>B</b></button>
            <button type="button" class="nc-rp-notes-tool" data-rp-cmd="italic" title="Italic"><i>I</i></button>
            <button type="button" class="nc-rp-notes-tool" data-rp-cmd="underline" title="Underline"><u>U</u></button>
            <button type="button" class="nc-rp-notes-tool" data-rp-cmd="insertUnorderedList" title="Bullet list">•≡</button>
            <button type="button" class="nc-rp-notes-tool" data-rp-cmd="createLink" title="Link">🔗</button>
          </div>
          <div class="nc-rp-notes-editor" contenteditable="true" role="textbox" aria-multiline="true"
            data-rp-notes-editor data-placeholder="Write a note… Paste text or screenshots (Ctrl+V). Enter to post, Shift+Enter for a new line."></div>
          <div class="nc-rp-notes-emoji-bar" data-rp-notes-emoji-bar"></div>
          <div class="nc-rp-notes-compose-foot">
            <button type="button" class="nc-rp-btn nc-rp-btn-ghost" data-rp-notes-emoji-more title="More emoji">😀</button>
            <button type="button" class="nc-rp-btn nc-rp-btn-primary" data-rp-notes-post>Post note</button>
            <span class="nc-rp-notes-status" data-rp-notes-status role="status"></span>
          </div>
        </div>`
      : "";
    return `<div class="nc-rp-tab-panel nc-rp-notes-chat-panel">
      <h3>Notes</h3>
      <div class="nc-rp-notes-chat">
        <div class="nc-rp-notes-feed" data-rp-notes-feed aria-live="polite"></div>
        ${compose}
      </div>
    </div>`;
  }

  function getFilters() {
    return {
      q: (el("rp-search")?.value || "").trim().toLowerCase(),
      skill: el("rp-filter-skills")?.value || "",
      clearance: el("rp-filter-clearance")?.value || "",
      location: el("rp-filter-location")?.value || "",
      availability: el("rp-filter-availability")?.value || "",
      employment: el("rp-filter-employment")?.value || "",
    };
  }

  function applyFilters() {
    const f = getFilters();
    filtered = all.filter((r) => {
      if (f.skill && !(r.skills || []).some((s) => s === f.skill)) return false;
      if (f.clearance && r.clearance_level !== f.clearance) return false;
      if (f.location && r.location !== f.location) return false;
      if (f.availability && r.availability_status !== f.availability) return false;
      if (f.employment && r.employment_type !== f.employment) return false;
      if (f.q) {
        const hay = [
          r.name,
          r.subtitle,
          r.department,
          r.email,
          r.location,
          r.clearance_level,
          r.department,
          ...(r.skills || []),
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(f.q)) return false;
      }
      return true;
    });
    page = 1;
    render();
  }

  function updateKpis() {
    const kpis = pool.kpis || {};
    const set = (id, v) => {
      const n = el(id);
      if (n) n.textContent = String(v ?? 0);
    };
    set("rp-kpi-total", kpis.total);
    set("rp-kpi-available-now", kpis.available_now);
    set("rp-kpi-available-30", kpis.available_30);
    set("rp-kpi-cleared", kpis.cleared);
    set("rp-kpi-gaps", kpis.skill_gaps);
    set("rp-kpi-available-now-meta", `${kpis.available_now_pct ?? 0}% of total`);
    set("rp-kpi-available-30-meta", `${kpis.available_30_pct ?? 0}% of total`);
    set("rp-kpi-cleared-meta", `${kpis.cleared_pct ?? 0}% of total`);
  }

  function populateFilterOptions() {
    const fl = pool.filters || {};
    const fill = (selId, items, placeholder) => {
      const sel = el(selId);
      if (!sel) return;
      const cur = sel.value;
      sel.innerHTML = `<option value="">${esc(placeholder)}</option>`;
      (items || []).forEach((it) => {
        const o = document.createElement("option");
        o.value = it;
        o.textContent = it;
        sel.appendChild(o);
      });
      if (cur) sel.value = cur;
    };
    fill("rp-filter-skills", fl.skills, "Skills");
    fill("rp-filter-clearance", fl.clearance_levels, "Clearance");
    fill("rp-filter-location", fl.locations, "Location");
    fill("rp-filter-employment", fl.employment_types, "Employment type");
  }

  function renderChips() {
    const f = getFilters();
    const chips = [];
    const labels = {
      skill: "Skills",
      clearance: "Clearance",
      location: "Location",
      availability: "Availability",
      employment: "Employment type",
    };
    const availLabels = {
      available_now: "Available now",
      available_soon: "Available within 30 days",
      unavailable: "Unavailable",
    };
    Object.keys(labels).forEach((key) => {
      const mapKey = key === "skill" ? "skill" : key;
      let val = f[mapKey];
      if (!val) return;
      if (key === "availability") val = availLabels[val] || val;
      chips.push({ key: mapKey, label: `${labels[key]}: ${val}` });
    });
    const wrap = el("rp-active-chips");
    const box = el("rp-chips");
    if (!wrap || !box) return;
    if (!chips.length) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    box.innerHTML = chips
      .map(
        (c) =>
          `<span class="nc-rp-chip">${esc(c.label)} <button type="button" data-rp-chip-remove="${esc(c.key)}" aria-label="Remove filter">×</button></span>`
      )
      .join("");
    box.querySelectorAll("[data-rp-chip-remove]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const k = btn.getAttribute("data-rp-chip-remove");
        const map = {
          skill: "rp-filter-skills",
          clearance: "rp-filter-clearance",
          location: "rp-filter-location",
          availability: "rp-filter-availability",
          employment: "rp-filter-employment",
        };
        const sid = map[k];
        if (sid && el(sid)) el(sid).value = "";
        applyFilters();
      });
    });
  }

  function renderTableCell(key, r) {
    const skills = (r.skills || [])
      .slice(0, 3)
      .map((s) => `<span class="nc-rp-skill-tag">${esc(s)}</span>`)
      .join("");
    switch (key) {
      case "name":
        return `<td>
              <div class="nc-rp-name-cell">
                <span class="nc-rp-avatar nc-rp-avatar--${r.tone % 6}">${esc(r.initials)}</span>
                <div>
                  <div class="nc-rp-name">${esc(r.name)}</div>
                  <div class="nc-rp-role">${esc(r.subtitle || "")}</div>
                </div>
              </div>
            </td>`;
      case "skills":
        return `<td><div class="nc-rp-skill-tags">${skills || "—"}</div></td>`;
      case "clearance":
        return `<td><span class="nc-rp-badge">${esc(r.clearance_level)}</span></td>`;
      case "location":
        return `<td>${esc(r.location || "—")}</td>`;
      case "availability":
        return `<td>${availabilityPill(r)}</td>`;
      case "employment_type":
        return `<td>${esc(r.employment_type || "—")}</td>`;
      case "department":
        return `<td>${esc(r.department || "—")}</td>`;
      case "job_title":
        return `<td>${esc(r.job_title || "—")}</td>`;
      case "email":
        return `<td>${esc(r.email || "—")}</td>`;
      case "phone":
        return `<td>${esc(r.phone || "—")}</td>`;
      case "reports_to":
        return `<td>${esc(r.reports_to || "—")}</td>`;
      case "resource_added":
        return `<td>${esc(r.contract_start ? formatDate(r.contract_start) : r.resource_added ? formatDate(r.resource_added) : "—")}</td>`;
      case "actions":
        return `<td class="nc-rp-th-actions" onclick="event.stopPropagation()">
              <div class="nc-rp-actions">
                <button type="button" class="nc-rp-icon-btn" data-rp-view="${r.id}" title="View" aria-label="View">👁</button>
                <button type="button" class="nc-rp-icon-btn" data-rp-csv="${r.id}" title="Export row">↓</button>
                ${canCreate ? `<button type="button" class="nc-rp-icon-btn" data-rp-edit="${r.id}" title="Edit">✎</button>` : ""}
              </div>
            </td>`;
      case "notes":
        return `<td>${r.notes_count ? `💬 ${r.notes_count}` : "—"}</td>`;
      case "updated_at":
        return `<td>${esc(formatDate(r.updated_at))}</td>`;
      default:
        return `<td>—</td>`;
    }
  }

  function renderTableHeader() {
    const tr = el("rp-thead-row");
    if (!tr) return;
    let html =
      '<th class="nc-rp-th-check"><input type="checkbox" id="rp-select-all" aria-label="Select all on page"></th>';
    listColumns.forEach((key) => {
      const def = RP_CATALOG_BY_KEY[key];
      const cls = key === "actions" ? ' class="nc-rp-th-actions"' : "";
      html += `<th${cls}>${esc(def ? def.label : key)}</th>`;
    });
    tr.innerHTML = html;
  }

  function onSelectAllChange(ev) {
    const checked = ev.target.checked;
    const start = (page - 1) * PAGE_SIZE;
    filtered.slice(start, start + PAGE_SIZE).forEach((r) => {
      if (checked) selectedIds.add(r.id);
      else selectedIds.delete(r.id);
    });
    renderTable();
  }

  function bindTableRowEvents(tbody) {
    if (!tbody) return;
    tbody.querySelectorAll("tr[data-rp-id]").forEach((row) => {
      row.addEventListener("click", () => {
        openPanel(parseInt(row.getAttribute("data-rp-id"), 10));
      });
    });
    tbody.querySelectorAll("[data-rp-row-check]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const id = parseInt(cb.getAttribute("data-rp-row-check"), 10);
        if (cb.checked) selectedIds.add(id);
        else selectedIds.delete(id);
      });
    });
    tbody.querySelectorAll("[data-rp-csv]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const id = parseInt(btn.getAttribute("data-rp-csv"), 10);
        const r = all.find((x) => x.id === id);
        if (r) exportCsv([r]);
      });
    });
    tbody.querySelectorAll("[data-rp-view]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        openPanel(parseInt(btn.getAttribute("data-rp-view"), 10));
      });
    });
    tbody.querySelectorAll("[data-rp-edit]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        openEditModal(parseInt(btn.getAttribute("data-rp-edit"), 10));
      });
    });
  }

  function buildColumnEditorDraft() {
    const visible = new Set(listColumns);
    const ordered = listColumns.slice();
    RP_COLUMN_CATALOG.forEach((c) => {
      if (!visible.has(c.key)) ordered.push(c.key);
    });
    return ordered.map((key) => ({ key, show: visible.has(key) }));
  }

  function renderColumnEditor() {
    const ul = el("rp-columns-editor");
    if (!ul || !columnEditorDraft) return;
    ul.innerHTML = "";
    columnEditorDraft.forEach((row, idx) => {
      const def = RP_CATALOG_BY_KEY[row.key];
      const li = document.createElement("li");
      li.className = "nc-rp-cols-row";
      const up = document.createElement("button");
      up.type = "button";
      up.className = "nc-rp-cols-move";
      up.textContent = "↑";
      up.disabled = idx === 0;
      const down = document.createElement("button");
      down.type = "button";
      down.className = "nc-rp-cols-move";
      down.textContent = "↓";
      down.disabled = idx === columnEditorDraft.length - 1;
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!row.show;
      cb.addEventListener("change", () => {
        row.show = cb.checked;
      });
      const span = document.createElement("span");
      span.textContent = def ? def.label : row.key;
      up.addEventListener("click", () => {
        if (idx <= 0) return;
        const prev = columnEditorDraft[idx - 1];
        columnEditorDraft[idx - 1] = row;
        columnEditorDraft[idx] = prev;
        renderColumnEditor();
      });
      down.addEventListener("click", () => {
        if (idx >= columnEditorDraft.length - 1) return;
        const next = columnEditorDraft[idx + 1];
        columnEditorDraft[idx + 1] = row;
        columnEditorDraft[idx] = next;
        renderColumnEditor();
      });
      li.appendChild(cb);
      li.appendChild(span);
      li.appendChild(up);
      li.appendChild(down);
      ul.appendChild(li);
    });
  }

  function openColumnEditor() {
    const dlg = el("rp-columns-dialog");
    if (!dlg) return;
    columnEditorDraft = buildColumnEditorDraft();
    renderColumnEditor();
    if (typeof dlg.showModal === "function") dlg.showModal();
  }

  function closeColumnEditor() {
    columnEditorDraft = null;
    const dlg = el("rp-columns-dialog");
    if (dlg) {
      try {
        dlg.close();
      } catch {
        /* ignore */
      }
    }
  }

  function applyColumnEditor(save) {
    if (!save || !columnEditorDraft) {
      closeColumnEditor();
      return;
    }
    const next = columnEditorDraft.filter((r) => r.show).map((r) => r.key);
    if (!next.length) {
      window.alert("Select at least one column to display.");
      return;
    }
    if (!next.includes("name")) {
      window.alert("The Name column cannot be hidden.");
      return;
    }
    listColumns = next;
    saveListColumns(listColumns);
    closeColumnEditor();
    renderTable();
  }

  function wireColumnEditor() {
    el("rp-columns-edit")?.addEventListener("click", () => openColumnEditor());
    el("rp-columns-close")?.addEventListener("click", () => closeColumnEditor());
    el("rp-columns-cancel")?.addEventListener("click", () => closeColumnEditor());
    el("rp-columns-save")?.addEventListener("click", () => applyColumnEditor(true));
    el("rp-columns-reset")?.addEventListener("click", () => {
      const vis = new Set(RP_DEFAULT_COLUMNS);
      const ordered = RP_DEFAULT_COLUMNS.slice();
      RP_COLUMN_CATALOG.forEach((c) => {
        if (!vis.has(c.key)) ordered.push(c.key);
      });
      columnEditorDraft = ordered.map((key) => ({ key, show: vis.has(key) }));
      renderColumnEditor();
    });
    const dlg = el("rp-columns-dialog");
    if (dlg) {
      dlg.addEventListener("cancel", (e) => {
        e.preventDefault();
        closeColumnEditor();
      });
      dlg.addEventListener("click", (e) => {
        if (e.target === dlg) closeColumnEditor();
      });
    }
  }

  function availabilityPill(r) {
    const st = r.availability_status;
    if (st === "available_now") {
      return `<span class="nc-rp-pill nc-rp-pill--now">${esc(r.availability_label || "Available now")}</span>`;
    }
    if (st === "available_soon") {
      return `<span class="nc-rp-pill nc-rp-pill--soon">${esc(r.availability_label)}</span>`;
    }
    return `<span class="nc-rp-pill nc-rp-pill--off">${esc(r.availability_label || "Unavailable")}</span>`;
  }

  function renderTable() {
    renderTableHeader();
    const tbody = el("rp-tbody");
    const empty = el("rp-empty");
    if (!tbody) return;
    const start = (page - 1) * PAGE_SIZE;
    const slice = filtered.slice(start, start + PAGE_SIZE);
    if (!slice.length) {
      tbody.innerHTML = "";
      if (empty) empty.hidden = false;
    } else {
      if (empty) empty.hidden = true;
      tbody.innerHTML = slice
        .map((r) => {
          const sel = selectedId === r.id ? " is-selected" : "";
          const checked = selectedIds.has(r.id) ? " checked" : "";
          const cells = listColumns.map((key) => renderTableCell(key, r)).join("");
          return `<tr class="${sel}" data-rp-id="${r.id}">
            <td class="nc-rp-td-check" onclick="event.stopPropagation()"><input type="checkbox" data-rp-row-check="${r.id}"${checked} aria-label="Select ${esc(r.name)}"></td>
            ${cells}
          </tr>`;
        })
        .join("");
    }

    bindTableRowEvents(tbody);

    const total = filtered.length;
    const meta = el("rp-pager-meta");
    if (meta) {
      const from = total ? start + 1 : 0;
      const to = Math.min(start + PAGE_SIZE, total);
      meta.textContent = `Showing ${from} to ${to} of ${total} results`;
    }
    renderPager(total);
    renderChips();
  }

  function renderPager(total) {
    const nav = el("rp-pager");
    if (!nav) return;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    let html = "";
    if (page > 1) html += `<button type="button" data-rp-page="${page - 1}">‹</button>`;
    const maxBtns = 7;
    let startP = Math.max(1, page - 3);
    let endP = Math.min(pages, startP + maxBtns - 1);
    startP = Math.max(1, endP - maxBtns + 1);
    for (let p = startP; p <= endP; p++) {
      html += `<button type="button" data-rp-page="${p}" class="${p === page ? "is-active" : ""}">${p}</button>`;
    }
    if (page < pages) html += `<button type="button" data-rp-page="${page + 1}">›</button>`;
    nav.innerHTML = html;
    nav.querySelectorAll("[data-rp-page]").forEach((b) => {
      b.addEventListener("click", () => {
        page = parseInt(b.getAttribute("data-rp-page"), 10) || 1;
        renderTable();
      });
    });
  }

  function profileSubtitle(r) {
    const jt = r.job_title && r.job_title !== "—" ? r.job_title : "";
    const et = r.employment_type || "";
    if (jt && et) return `${jt} | ${et}`;
    return jt || et || r.subtitle || "";
  }

  function rateDisplay(r) {
    const h = _s(r.hourly_rate);
    const d = _s(r.daily_rate);
    if (h && d) return `${esc(h)} p/h <span class="nc-rp-meta-muted">(Daily: ${esc(d)})</span>`;
    if (h) return `${esc(h)} p/h`;
    if (d) return `${esc(d)} p/d`;
    return "—";
  }

  function _s(v) {
    return String(v ?? "").trim();
  }

  function copyBtnHtml(value) {
    const v = String(value || "").trim();
    if (!v || v === "—") return "";
    return `<button type="button" class="nc-rp-copy" data-rp-copy="${esc(v)}" title="Copy" aria-label="Copy">⎘</button>`;
  }

  function compliancePercent(r) {
    const gaps = r.compliance_gaps || [];
    const total = 7;
    return Math.max(0, Math.min(100, Math.round(((total - gaps.length) / total) * 100)));
  }

  function showCvViewer(r) {
    const body = el("rp-panel-body");
    if (!body || !r?.has_cv) return;
    panelViewMode = "cv";
    const url = cvMediaUrl(r);
    body.innerHTML = `
      <div class="nc-rp-cv-viewer">
        <div class="nc-rp-cv-viewer-head">
          <span class="nc-rp-docs-meta">${esc(r.cv_original_name || "CV.pdf")}</span>
          <button type="button" class="nc-rp-btn nc-rp-btn-ghost" data-rp-cv-back>Back to profile</button>
        </div>
        <iframe src="${esc(url)}" title="CV preview" class="nc-rp-cv-iframe"></iframe>
      </div>`;
    body.querySelector("[data-rp-cv-back]")?.addEventListener("click", () => {
      panelViewMode = "content";
      renderPanelContent(r);
    });
    renderProfileToolbar(r);
    renderProfileHeadRight(r);
  }

  function renderProfileHead(r) {
    const head = el("rp-panel-head");
    if (!head || !r) return;
    head.innerHTML = `
      <div class="nc-rp-profile-hero">
        <span class="nc-rp-avatar nc-rp-avatar--${r.tone % 6}">${esc(r.initials)}</span>
        <div>
          <div class="nc-rp-profile-title-row">
            <h2 id="rp-modal-title">${esc(r.name)}</h2>
            ${availabilityPill(r)}
          </div>
          <p class="nc-rp-profile-subtitle">${esc(profileSubtitle(r))}</p>
        </div>
      </div>`;
  }

  function renderProfileToolbar(r) {
    const toolbar = el("rp-panel-toolbar");
    if (!toolbar || !r) return;
    let html = "";
    if (canCreate) {
      html += `<button type="button" class="nc-rp-btn nc-rp-btn-primary nc-rp-btn-profile" data-rp-panel-edit-profile><span class="nc-rp-btn-icon">✎</span> Edit profile</button>`;
    }
    html += `<button type="button" class="nc-rp-btn nc-rp-btn-ghost" data-rp-panel-csv>Export</button>`;
    html += `<div class="nc-rp-more-wrap">
      <button type="button" class="nc-rp-btn nc-rp-btn-ghost" data-rp-more-toggle aria-expanded="false">More actions ▾</button>
      <div class="nc-rp-more-menu" id="rp-more-menu" hidden>
        <button type="button" data-rp-more="share">Share profile link</button>
        <button type="button" data-rp-more="note">Add note</button>
        ${canCreate ? `<button type="button" data-rp-more="delete">Remove from pool</button>` : ""}
      </div>
    </div>`;
    toolbar.innerHTML = html;
  }

  function renderProfileHeadRight(r) {
    const right = el("rp-panel-head-right");
    if (!right || !r) return;
    if (r.has_cv && panelViewMode !== "cv") {
      right.innerHTML = `<button type="button" class="nc-rp-btn nc-rp-btn-ghost" data-rp-view-cv><span class="nc-rp-btn-icon">👁</span> View CV</button>`;
    } else {
      right.innerHTML = "";
    }
  }

  function bindProfilePanelEvents(root, r) {
    if (!root || !r) return;
    root.querySelectorAll("[data-rp-copy]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const v = btn.getAttribute("data-rp-copy") || "";
        navigator.clipboard?.writeText(v).then(
          () => {
            btn.textContent = "✓";
            setTimeout(() => {
              btn.textContent = "⎘";
            }, 1200);
          },
          () => window.alert("Could not copy.")
        );
      });
    });
    root.querySelector("[data-rp-update-availability]")?.addEventListener("click", () => openSectionModal("overview"));
    root.querySelector("[data-rp-view-all-notes]")?.addEventListener("click", () => {
      activeTab = "notes";
      document.querySelectorAll(".nc-rp-tabs button").forEach((b) => {
        const on = b.getAttribute("data-rp-tab") === "notes";
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-selected", on ? "true" : "false");
      });
      renderPanelContent(r);
    });
    root.querySelectorAll("[data-rp-quick]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const act = btn.getAttribute("data-rp-quick");
        if (act === "view-cv" && r.has_cv) showCvViewer(r);
        else if (act === "download-cv" && r.has_cv) window.open(cvMediaUrl(r), "_blank");
        else if (act === "add-note") openNotesTabAndFocus();
        else if (act === "edit") openEditModal(r.id);
        else if (act === "export") exportCsv([r]);
      });
    });
  }

  function bindProfileChromeEvents(r) {
    const toolbar = el("rp-panel-toolbar");
    toolbar?.querySelector("[data-rp-panel-edit-profile]")?.addEventListener("click", () => openEditModal(r.id));
    toolbar?.querySelector("[data-rp-panel-csv]")?.addEventListener("click", () => exportCsv([r]));
    const moreToggle = toolbar?.querySelector("[data-rp-more-toggle]");
    const moreMenu = el("rp-more-menu");
    moreToggle?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (!moreMenu) return;
      const open = moreMenu.hidden;
      moreMenu.hidden = !open;
      moreToggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    moreMenu?.querySelector('[data-rp-more="share"]')?.addEventListener("click", () => {
      const url = `${window.location.origin}/intranet/resource-pool?resource=${r.id}`;
      navigator.clipboard?.writeText(url).then(() => window.alert("Link copied to clipboard."));
      moreMenu.hidden = true;
    });
    moreMenu?.querySelector('[data-rp-more="note"]')?.addEventListener("click", () => {
      moreMenu.hidden = true;
      openNotesTabAndFocus();
    });
    moreMenu?.querySelector('[data-rp-more="delete"]')?.addEventListener("click", async () => {
      moreMenu.hidden = true;
      if (!canDelete || !window.confirm("Remove this resource from the pool?")) return;
      try {
        const res = await fetch(`${apiBase}/resources/${r.id}`, { method: "DELETE", credentials: "same-origin" });
        if (!res.ok) throw new Error("Delete failed");
        closePanel();
        await refreshPool();
      } catch {
        window.alert("Could not remove resource.");
      }
    });
    el("rp-panel-head-right")?.querySelector("[data-rp-view-cv]")?.addEventListener("click", () => showCvViewer(r));
  }

  function renderOverviewProfile(r) {
    const gaps = r.compliance_gaps || [];
    const pct = compliancePercent(r);
    const skills = r.skills || [];
    const aboutTags = skills.length
      ? skills
          .slice(0, 6)
          .map((s) => `<span class="nc-rp-skill-tag">${esc(s)}</span>`)
          .join("")
      : "";
    const aboutText =
      r.about ||
      (skills.length
        ? `${esc(r.name)} is a ${esc(r.job_title || "professional")} with experience across ${esc(skills.slice(0, 3).join(", "))}.`
        : "No profile summary yet. Add an about section via Edit profile.");
    const notes = Array.isArray(r.notes) ? r.notes : [];
    const noteIcons = ["nc-rp-note-dot--p", "nc-rp-note-dot--o", "nc-rp-note-dot--g"];
    const availClass = r.availability_status === "available_now" ? "" : " nc-rp-avail-card--off";
    const availTitle =
      r.availability_status === "available_now"
        ? "Available now"
        : r.availability_status === "available_soon"
          ? r.availability_label
          : "Not available";
    const availSub =
      r.availability_status === "available_now"
        ? "Open to new opportunities"
        : "Update status when circumstances change";
    const nextAvail =
      r.availability_status === "available_now"
        ? "Immediately"
        : r.availability_label || "—";
    const clearanceLine =
      r.clearance_level && r.clearance_level !== "—"
        ? `${esc(r.clearance_level)}${r.clearance_expiry ? ` (expires ${esc(formatDate(r.clearance_expiry))})` : ""}${r.clearance_status ? `<span class="nc-rp-tag-active">${esc(r.clearance_status)}</span>` : ""}`
        : "—";

    return `
      <div class="nc-rp-profile-layout">
        <div class="nc-rp-profile-main">
          <section class="nc-rp-card">
            <h3>About</h3>
            <p class="nc-rp-card-lead">${esc(aboutText)}</p>
            ${aboutTags ? `<div class="nc-rp-skill-tags">${aboutTags}</div>` : ""}
          </section>
          <section class="nc-rp-card">
            <div class="nc-rp-section-bar" style="margin:0 0 0.5rem">${canCreate ? `<button type="button" class="nc-rp-section-edit" data-rp-section="overview">Edit details</button>` : ""}</div>
            <h3>Key details</h3>
            <div class="nc-rp-kv-grid">
              <div class="nc-rp-kv"><label>Email</label><div class="nc-rp-kv-val">${esc(r.email || "—")}${copyBtnHtml(r.email)}</div></div>
              <div class="nc-rp-kv"><label>Phone</label><div class="nc-rp-kv-val">${esc(r.phone || "—")}${copyBtnHtml(r.phone)}</div></div>
              <div class="nc-rp-kv"><label>Location</label><div class="nc-rp-kv-val">${esc(r.location || "—")} <span class="nc-rp-tag-local">Local</span></div></div>
              <div class="nc-rp-kv"><label>Employment</label><div class="nc-rp-kv-val">${esc(r.employment_type || "—")}</div></div>
              <div class="nc-rp-kv"><label>Clearance</label><div class="nc-rp-kv-val">${clearanceLine}</div></div>
              <div class="nc-rp-kv"><label>Availability</label><div class="nc-rp-kv-val">${availabilityPill(r)}</div></div>
              <div class="nc-rp-kv nc-rp-kv--full" style="grid-column:1/-1"><label>Rate</label><div class="nc-rp-kv-val">${rateDisplay(r)}</div></div>
            </div>
          </section>
          <div class="nc-rp-compliance-row">
            <section class="nc-rp-card">
              <h3>Compliance status</h3>
              <p style="margin:0;font-weight:800;color:${pct === 100 ? "#15803d" : "#c2410c"}">${pct === 100 ? "Profile complete" : "Incomplete profile"}</p>
              <div class="nc-rp-progress"><span style="width:${pct}%"></span></div>
              <p class="nc-rp-meta-muted">Last reviewed: ${esc(formatDate(r.updated_at))}</p>
            </section>
            <section class="nc-rp-card">
              <h3>Compliance gaps</h3>
              <p style="margin:0;font-weight:800;color:${gaps.length ? "#c2410c" : "#15803d"}">${gaps.length ? `${gaps.length} gap${gaps.length === 1 ? "" : "s"} identified` : "No gaps identified"}</p>
              ${gaps.length ? `<ul style="margin:0.5rem 0 0;padding-left:1.1rem;font-size:0.82rem">${gaps.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>` : `<p class="nc-rp-meta-muted" style="margin-top:0.5rem">✓ All required fields complete</p>`}
            </section>
          </div>
          <section class="nc-rp-snapshot">
            <div class="nc-rp-snap"><div class="nc-rp-snap-ic">⏱</div><label>Key skills</label><strong>${skills.length || "—"}</strong><span>${skills.length ? "listed" : ""}</span></div>
            <div class="nc-rp-snap"><div class="nc-rp-snap-ic">🛡</div><label>Clearance</label><strong>${r.clearance_level && r.clearance_level !== "—" ? esc(r.clearance_level) : "—"}</strong><span>${r.cleared ? "cleared" : ""}</span></div>
            <div class="nc-rp-snap"><div class="nc-rp-snap-ic">📁</div><label>CV on file</label><strong>${r.has_cv ? "Yes" : "No"}</strong><span>${r.has_cv ? "uploaded" : "missing"}</span></div>
            <div class="nc-rp-snap"><div class="nc-rp-snap-ic">💬</div><label>Notes</label><strong>${notes.length}</strong><span>on profile</span></div>
            <div class="nc-rp-snap"><div class="nc-rp-snap-ic">📅</div><label>Last updated</label><strong>${esc(formatDate(r.updated_at))}</strong><span>profile</span></div>
          </section>
        </div>
        <aside class="nc-rp-profile-side">
          <div class="nc-rp-avail-card${availClass}">
            <h4>${esc(availTitle)}</h4>
            <p>${esc(availSub)}</p>
            <p class="nc-rp-meta-muted" style="margin-top:0.5rem">Next available from <strong>${esc(nextAvail)}</strong></p>
            ${canCreate ? `<button type="button" class="nc-rp-btn nc-rp-btn-ghost" data-rp-update-availability>Update availability</button>` : ""}
          </div>
          <section class="nc-rp-card">
            <h3>Quick actions</h3>
            <ul class="nc-rp-quick-list">
              ${r.has_cv ? `<li><button type="button" data-rp-quick="view-cv"><span><span class="nc-rp-quick-ic">👁</span>View CV</span><span>›</span></button></li>
              <li><button type="button" data-rp-quick="download-cv"><span><span class="nc-rp-quick-ic">↓</span>Download CV</span><span>›</span></button></li>` : ""}
              <li><button type="button" data-rp-quick="export"><span><span class="nc-rp-quick-ic">↗</span>Export profile</span><span>›</span></button></li>
              <li><button type="button" data-rp-quick="add-note"><span><span class="nc-rp-quick-ic">＋</span>Add note</span><span>›</span></button></li>
              ${canCreate ? `<li><button type="button" data-rp-quick="edit"><span><span class="nc-rp-quick-ic">✎</span>Edit profile</span><span>›</span></button></li>` : ""}
            </ul>
          </section>
          <section class="nc-rp-card">
            <h3>Notes (${notes.length})</h3>
            <div class="nc-rp-note-feed">
              ${notes.length
                ? notes
                    .slice(0, 3)
                    .map((n, i) => {
                      const preview = notePreviewText(n);
                      const who = esc(n.author_name || "Note");
                      return `<div class="nc-rp-note-item">
                        <span class="nc-rp-note-dot ${noteIcons[i % noteIcons.length]}">💬</span>
                        <div>
                          <strong>${who}</strong>
                          <time>${esc(formatDate(n.created_at))}</time>
                          <p>${esc(preview.length > 120 ? `${preview.slice(0, 117)}…` : preview)}</p>
                        </div>
                      </div>`;
                    })
                    .join("")
                : `<p class="nc-rp-meta-muted">No notes yet.</p>`}
            </div>
            ${notes.length > 0 ? `<button type="button" class="nc-rp-link-btn" data-rp-view-all-notes>View all notes</button>` : canCreate ? `<button type="button" class="nc-rp-link-btn" data-rp-quick="add-note">Add note</button>` : ""}
          </section>
        </aside>
      </div>`;
  }

  function renderPanelActions(r) {
    renderProfileToolbar(r);
    renderProfileHeadRight(r);
    bindProfileChromeEvents(r);
  }

  function bindSectionEditButtons(root) {
    root?.querySelectorAll("[data-rp-section]").forEach((btn) => {
      btn.addEventListener("click", () => openSectionModal(btn.getAttribute("data-rp-section")));
    });
  }

  async function uploadCv(resourceId, file) {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`${apiBase}/resources/${resourceId}/cv`, {
      method: "POST",
      credentials: "same-origin",
      body: fd,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Upload failed");
    return data.resource;
  }

  function renderPanelContent(r) {
    const body = el("rp-panel-body");
    if (!body || !r) return;
    if (panelViewMode === "cv") {
      showCvViewer(r);
      return;
    }
    if (activeTab === "overview") {
      body.innerHTML = renderOverviewProfile(r);
      bindSectionEditButtons(body);
      bindProfilePanelEvents(body, r);
      return;
    }
    if (activeTab === "skills") {
      body.innerHTML = `<div class="nc-rp-tab-panel nc-rp-card">${sectionEditBar("skills", "skills")}
        <h3>Skills</h3>
        <div class="nc-rp-skill-tags" style="max-width:none">${(r.skills || [])
        .map((s) => `<span class="nc-rp-skill-tag">${esc(s)}</span>`)
        .join("") || "<p class=\"nc-rp-meta-muted\">No skills listed yet.</p>"}</div></div>`;
      bindSectionEditButtons(body);
      return;
    }
    if (activeTab === "experience") {
      body.innerHTML = `<div class="nc-rp-tab-panel nc-rp-card">${sectionEditBar("experience", "experience")}
        <h3>Experience</h3>
        <div class="nc-rp-kv-grid">
          <div class="nc-rp-kv"><label>Role</label><div class="nc-rp-kv-val">${esc(r.job_title || "—")}</div></div>
          <div class="nc-rp-kv"><label>Department</label><div class="nc-rp-kv-val">${esc(r.department || "—")}</div></div>
          <div class="nc-rp-kv"><label>Reports to</label><div class="nc-rp-kv-val">${esc(r.reports_to || "—")}</div></div>
          <div class="nc-rp-kv"><label>Resource added</label><div class="nc-rp-kv-val">${esc(r.contract_start ? formatDate(r.contract_start) : r.resource_added ? formatDate(r.resource_added) : "—")}</div></div>
          <div class="nc-rp-kv" style="grid-column:1/-1"><label>Rate</label><div class="nc-rp-kv-val">${rateDisplay(r)}</div></div>
        </div></div>`;
      bindSectionEditButtons(body);
      return;
    }
    if (activeTab === "documents") {
      const uploadHtml = canCreate
        ? `<label class="nc-rp-btn nc-rp-btn-primary" style="width:fit-content;cursor:pointer">
            <input type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" data-rp-cv-upload hidden>
            ${r.has_cv ? "Replace CV" : "Upload CV"}
          </label>
          ${r.has_cv ? `<button type="button" class="nc-rp-btn nc-rp-btn-ghost" data-rp-cv-remove>Remove CV</button>` : ""}`
        : "";
      body.innerHTML = `
        <div class="nc-rp-tab-panel nc-rp-card nc-rp-docs-upload">
          <h3>Documents</h3>
          <div class="nc-rp-detail-section"><h3 style="font-size:0.82rem">CV / Resume</h3>
            ${r.has_cv ? `<p class="nc-rp-docs-meta">Current file: <strong>${esc(r.cv_original_name || "CV.pdf")}</strong>${r.cv_uploaded_at ? ` · uploaded ${esc(formatDate(r.cv_uploaded_at))}` : ""}</p>` : `<p class="nc-rp-docs-meta">No CV uploaded yet. Upload a PDF to enable View CV.</p>`}
            <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.5rem">${uploadHtml}</div>
          </div>
        </div>`;
      body.querySelector("[data-rp-cv-upload]")?.addEventListener("change", async (ev) => {
        const file = ev.target.files?.[0];
        if (!file) return;
        if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
          window.alert("Please upload a PDF file.");
          ev.target.value = "";
          return;
        }
        try {
          const updated = await uploadCv(r.id, file);
          mergeResource(updated);
          renderPanelActions(updated);
          renderPanelContent(updated);
        } catch (err) {
          window.alert(err.message || "Could not upload CV.");
        }
        ev.target.value = "";
      });
      body.querySelector("[data-rp-cv-remove]")?.addEventListener("click", async () => {
        if (!window.confirm("Remove this CV?")) return;
        try {
          const res = await fetch(`${apiBase}/resources/${r.id}/cv`, { method: "DELETE", credentials: "same-origin" });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || "Remove failed");
          mergeResource(data.resource);
          panelViewMode = "content";
          renderPanelActions(data.resource);
          renderPanelContent(data.resource);
        } catch (err) {
          window.alert(err.message || "Could not remove CV.");
        }
      });
      return;
    }
    if (activeTab === "notes") {
      body.innerHTML = renderNotesChatPanel(r);
      wireNotesChatPanel(body, r);
      return;
    }
    body.innerHTML = renderOverviewProfile(r);
    bindSectionEditButtons(body);
    bindProfilePanelEvents(body, r);
  }

  function openNotesTabAndFocus() {
    const r = selectedResource();
    if (!r) return;
    activeTab = "notes";
    document.querySelectorAll(".nc-rp-tabs button").forEach((b) => {
      const on = b.getAttribute("data-rp-tab") === "notes";
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    renderPanelContent(r);
    requestAnimationFrame(() => {
      const editor = el("rp-panel-body")?.querySelector("[data-rp-notes-editor]");
      editor?.focus();
    });
  }

  function openPanel(id) {
    const r = all.find((x) => x.id === id);
    const backdrop = el("rp-detail-backdrop");
    if (!r || !backdrop) return;
    selectedId = id;
    activeTab = "overview";
    panelViewMode = "content";
    backdrop.hidden = false;
    document.body.classList.add("nc-rp-modal-open");
    if (typeof window.ncSyncViewerOffsetsSoon === "function") {
      window.ncSyncViewerOffsetsSoon();
    }

    renderProfileHead(r);
    renderPanelActions(r);
    document.querySelectorAll(".nc-rp-tabs button").forEach((b) => {
      const tab = b.getAttribute("data-rp-tab");
      const on = tab === activeTab;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    renderPanelContent(r);
    renderTable();
    requestAnimationFrame(() => el("rp-panel-close")?.focus());
  }

  function closeSectionModal() {
    const bd = el("rp-section-backdrop");
    if (bd) bd.hidden = true;
    sectionEditKey = null;
  }

  function openSectionModal(section) {
    const r = selectedResource();
    if (!r || !canCreate) return;
    sectionEditKey = section;
    const form = el("rp-section-form");
    const title = el("rp-section-title");
    const bd = el("rp-section-backdrop");
    if (!form || !bd) return;
    const titles = {
      skills: "Edit skills",
      overview: "Edit overview",
      experience: "Edit experience",
    };
    if (title) title.textContent = titles[section] || "Edit";

    if (section === "skills") {
      form.innerHTML = `<p class="nc-rp-section-hint">Paste or type skills (comma or line separated).</p>
        <textarea id="rp-sec-skills"></textarea>`;
      const ta = el("rp-sec-skills");
      if (ta) ta.value = (r.skills || []).join(", ");
    } else if (section === "overview") {
      form.innerHTML = `
        <div class="nc-rp-edit-grid">
          <label class="nc-rp-edit-field"><span>Email</span><input type="email" id="rp-sec-email" value="${esc(r.email)}"></label>
          <label class="nc-rp-edit-field"><span>Phone</span><input type="tel" id="rp-sec-phone" value="${esc(r.phone)}"></label>
          <label class="nc-rp-edit-field"><span>Location</span><input type="text" id="rp-sec-location" value="${esc(r.location === "—" ? "" : r.location)}"></label>
          <label class="nc-rp-edit-field"><span>Employment type</span>
            <select id="rp-sec-employment">
              <option value="Employee"${r.employment_type === "Employee" ? " selected" : ""}>Employee</option>
              <option value="Contractor"${r.employment_type === "Contractor" ? " selected" : ""}>Contractor</option>
              <option value="Casual"${r.employment_type === "Casual" ? " selected" : ""}>Casual</option>
              <option value="Subcontractor"${r.employment_type === "Subcontractor" ? " selected" : ""}>Subcontractor</option>
            </select>
          </label>
          <label class="nc-rp-edit-field"><span>Clearance level</span><input type="text" id="rp-sec-clearance" value="${esc(r.clearance_level === "—" ? "" : r.clearance_level)}"></label>
          <label class="nc-rp-edit-field"><span>Clearance status</span><input type="text" id="rp-sec-clearance-status" value="${esc(r.clearance_status)}"></label>
          <label class="nc-rp-edit-field nc-rp-edit-field--full">
            <span>Availability</span>
            <select id="rp-sec-availability">
              <option value="auto"${(r.availability_override || "auto") === "auto" ? " selected" : ""}>Automatic (from resource added date)</option>
              <option value="available_now"${r.availability_override === "available_now" ? " selected" : ""}>Available now</option>
              <option value="unavailable"${r.availability_override === "unavailable" ? " selected" : ""}>Not available</option>
            </select>
          </label>
          <label class="nc-rp-edit-field nc-rp-edit-field--full"><span>About</span><textarea id="rp-sec-about" rows="4"></textarea></label>
        </div>`;
      const aboutEl = el("rp-sec-about");
      if (aboutEl) aboutEl.value = r.about || "";
    } else if (section === "experience") {
      form.innerHTML = `
        <div class="nc-rp-edit-grid">
          <label class="nc-rp-edit-field"><span>Job title</span><input type="text" id="rp-sec-job" value="${esc(r.job_title)}"></label>
          <label class="nc-rp-edit-field"><span>Department</span><input type="text" id="rp-sec-dept" value="${esc(r.department)}"></label>
          <label class="nc-rp-edit-field"><span>Reports to</span><input type="text" id="rp-sec-reports" value="${esc(r.reports_to === "—" ? "" : r.reports_to)}"></label>
          <label class="nc-rp-edit-field"><span>Resource added</span><input type="date" id="rp-sec-cstart" value="${toIsoDateInput(r.contract_start || r.resource_added)}"></label>
          <label class="nc-rp-edit-field"><span>Hourly rate</span><input type="text" id="rp-sec-hourly" value="${esc(r.hourly_rate)}"></label>
          <label class="nc-rp-edit-field"><span>Daily rate</span><input type="text" id="rp-sec-daily" value="${esc(r.daily_rate)}"></label>
        </div>`;
    }
    bd.hidden = false;
  }

  async function saveSectionModal() {
    const r = selectedResource();
    if (!r || !sectionEditKey) return;
    let url = "";
    let body = {};
    if (sectionEditKey === "skills") {
      url = `${apiBase}/resources/${r.id}/skills`;
      body = { skills_text: el("rp-sec-skills")?.value || "" };
    } else if (sectionEditKey === "overview") {
      url = `${apiBase}/resources/${r.id}/overview`;
      body = {
        email: el("rp-sec-email")?.value?.trim() || "",
        phone: el("rp-sec-phone")?.value?.trim() || "",
        location: el("rp-sec-location")?.value?.trim() || "",
        employment_type: el("rp-sec-employment")?.value || "Employee",
        clearance_level: el("rp-sec-clearance")?.value?.trim() || "",
        clearance_status: el("rp-sec-clearance-status")?.value?.trim() || "",
        availability_override: el("rp-sec-availability")?.value || "auto",
        about: el("rp-sec-about")?.value?.trim() || "",
      };
    } else if (sectionEditKey === "experience") {
      url = `${apiBase}/resources/${r.id}/experience`;
      body = {
        job_title: el("rp-sec-job")?.value?.trim() || "",
        department: el("rp-sec-dept")?.value?.trim() || "",
        reports_to: el("rp-sec-reports")?.value?.trim() || "",
        contract_start_date: el("rp-sec-cstart")?.value || "",
        hourly_rate: el("rp-sec-hourly")?.value?.trim() || "",
        daily_rate: el("rp-sec-daily")?.value?.trim() || "",
      };
    } else {
      return;
    }
    try {
      const res = await fetch(url, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Save failed");
      mergeResource(data.resource);
      closeSectionModal();
      await refreshPool();
      const fresh = selectedResource();
      if (fresh) {
        renderPanelActions(fresh);
        renderPanelContent(fresh);
      }
    } catch (err) {
      window.alert(err.message || "Could not save.");
    }
  }

  function closePanel() {
    selectedId = null;
    panelViewMode = "content";
    const backdrop = el("rp-detail-backdrop");
    if (backdrop) backdrop.hidden = true;
    document.body.classList.remove("nc-rp-modal-open");
    renderTable();
  }

  async function refreshPool() {
    try {
      const res = await fetch(apiBase, { credentials: "same-origin" });
      if (!res.ok) return;
      const data = await res.json();
      Object.assign(pool, data);
      all = Array.isArray(data.resources) ? data.resources.slice() : [];
      populateFilterOptions();
      updateKpis();
      applyFilters();
    } catch {
      /* ignore */
    }
  }

  function toIsoDateInput(val) {
    if (!val) return "";
    const s = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    return "";
  }

  function openEditModal(id) {
    if (!canCreate) return;
    const backdrop = el("rp-edit-backdrop");
    const form = el("rp-edit-form");
    const title = el("rp-edit-title");
    const delBtn = el("rp-edit-delete");
    if (!backdrop || !form) return;
    const r = id ? all.find((x) => x.id === id) : null;
    const isEdit = Boolean(r);
    if (title) title.textContent = isEdit ? "Edit resource" : "Add resource";
    if (delBtn) delBtn.hidden = !(isEdit && canDelete);
    el("rp-edit-id").value = r ? String(r.id) : "";
    el("rp-edit-full-name").value = r?.full_name || r?.name || "";
    el("rp-edit-email").value = r?.email || "";
    el("rp-edit-phone").value = r?.phone || "";
    el("rp-edit-job-title").value = r?.job_title || "";
    el("rp-edit-department").value = r?.department || "";
    el("rp-edit-employment").value = r?.employment_type || "Employee";
    el("rp-edit-location").value = r?.location?.replace(/ — .*/, "") || "";
    el("rp-edit-clearance").value = r?.clearance_level === "—" ? "" : r?.clearance_level || "";
    el("rp-edit-clearance-status").value = r?.clearance_status || "";
    el("rp-edit-contract-start").value = toIsoDateInput(r?.contract_start || r?.resource_added);
    el("rp-edit-skills").value = (r?.skills || []).join(", ");
    el("rp-edit-about").value = r?.about || "";
    backdrop.hidden = false;
  }

  function closeEditModal() {
    const backdrop = el("rp-edit-backdrop");
    if (backdrop) backdrop.hidden = true;
  }

  let importCvFile = null;

  function resetImportModal() {
    importCvFile = null;
    const fileInput = el("rp-import-file");
    if (fileInput) fileInput.value = "";
    const fn = el("rp-import-filename");
    if (fn) fn.textContent = "Choose PDF or .docx file";
    const status = el("rp-import-status");
    if (status) {
      status.hidden = true;
      status.textContent = "";
    }
    const warn = el("rp-import-warnings");
    if (warn) {
      warn.hidden = true;
      warn.innerHTML = "";
    }
    const fields = el("rp-import-fields");
    if (fields) fields.hidden = true;
    const save = el("rp-import-save");
    if (save) save.disabled = true;
    ["rp-import-given", "rp-import-family", "rp-import-email", "rp-import-job-title", "rp-import-location", "rp-import-clearance", "rp-import-skills"].forEach((id) => {
      const node = el(id);
      if (node) node.value = "";
    });
  }

  function openImportModal() {
    if (!canCreate) return;
    resetImportModal();
    const backdrop = el("rp-import-backdrop");
    if (backdrop) backdrop.hidden = false;
  }

  function closeImportModal() {
    const backdrop = el("rp-import-backdrop");
    if (backdrop) backdrop.hidden = true;
    resetImportModal();
  }

  function fillImportFromExtracted(extracted) {
    if (el("rp-import-given")) el("rp-import-given").value = extracted.given_name || "";
    if (el("rp-import-family")) el("rp-import-family").value = extracted.family_name || "";
    if (el("rp-import-email")) el("rp-import-email").value = extracted.email || "";
    if (el("rp-import-location")) el("rp-import-location").value = extracted.location || "";
    if (el("rp-import-clearance")) el("rp-import-clearance").value = extracted.clearance_level || "";
    if (el("rp-import-skills")) {
      el("rp-import-skills").value = (extracted.skills || []).join(", ");
    }
    const fields = el("rp-import-fields");
    if (fields) fields.hidden = false;
    const save = el("rp-import-save");
    if (save) save.disabled = false;
    const warn = el("rp-import-warnings");
    const warnings = extracted.warnings || [];
    if (warn) {
      if (warnings.length) {
        warn.hidden = false;
        warn.innerHTML = warnings.map((w) => `<li>${esc(w)}</li>`).join("");
      } else {
        warn.hidden = true;
        warn.innerHTML = "";
      }
    }
  }

  async function previewImportFile(file) {
    const status = el("rp-import-status");
    if (status) {
      status.hidden = false;
      status.textContent = "Reading CV…";
    }
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch(`${apiBase}/import/preview`, {
        method: "POST",
        credentials: "same-origin",
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (status) status.textContent = data.error || "Could not read CV.";
        return;
      }
      importCvFile = file;
      if (status) status.textContent = "Review extracted details, then create the resource.";
      fillImportFromExtracted(data.extracted || {});
    } catch {
      if (status) status.textContent = "Could not read CV.";
    }
  }

  async function saveImportResource() {
    if (!canCreate || !importCvFile) return;
    const given = el("rp-import-given")?.value?.trim() || "";
    const family = el("rp-import-family")?.value?.trim() || "";
    if (!given && !family) {
      window.alert("First or last name is required.");
      return;
    }
    const full = `${given} ${family}`.trim();
    const fd = new FormData();
    fd.append("file", importCvFile);
    fd.append("given_name", given);
    fd.append("family_name", family);
    fd.append("full_name", full);
    fd.append("email", el("rp-import-email")?.value?.trim() || "");
    fd.append("location", el("rp-import-location")?.value?.trim() || "");
    fd.append("clearance_level", el("rp-import-clearance")?.value?.trim() || "");
    fd.append("job_title", el("rp-import-job-title")?.value?.trim() || "");
    fd.append("skills", el("rp-import-skills")?.value?.trim() || "");
    const save = el("rp-import-save");
    if (save) save.disabled = true;
    try {
      const res = await fetch(`${apiBase}/import`, {
        method: "POST",
        credentials: "same-origin",
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        window.alert(data.error || "Could not import resource.");
        if (save) save.disabled = false;
        return;
      }
      closeImportModal();
      await refreshPool();
      if (data.resource?.id) {
        mergeResource(data.resource);
        openPanel(data.resource.id);
      }
    } catch {
      window.alert("Could not import resource.");
      if (save) save.disabled = false;
    }
  }

  function editFormPayload() {
    return {
      full_name: el("rp-edit-full-name")?.value?.trim() || "",
      email: el("rp-edit-email")?.value?.trim() || "",
      phone: el("rp-edit-phone")?.value?.trim() || "",
      job_title: el("rp-edit-job-title")?.value?.trim() || "",
      department: el("rp-edit-department")?.value?.trim() || "",
      employment_type: el("rp-edit-employment")?.value || "Employee",
      location: el("rp-edit-location")?.value?.trim() || "",
      clearance_level: el("rp-edit-clearance")?.value?.trim() || "",
      clearance_status: el("rp-edit-clearance-status")?.value?.trim() || "",
      contract_start_date: el("rp-edit-contract-start")?.value || "",
      skills: el("rp-edit-skills")?.value || "",
      about: el("rp-edit-about")?.value?.trim() || "",
    };
  }

  async function saveEditForm(ev) {
    ev.preventDefault();
    if (!canCreate) return;
    const id = parseInt(el("rp-edit-id")?.value || "", 10);
    const payload = editFormPayload();
    if (!payload.full_name) {
      window.alert("Full name is required.");
      return;
    }
    const url = Number.isFinite(id) && id > 0 ? `${apiBase}/resources/${id}` : `${apiBase}/resources`;
    const method = Number.isFinite(id) && id > 0 ? "PATCH" : "POST";
    try {
      const res = await fetch(url, {
        method,
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        window.alert(data.error || "Could not save resource.");
        return;
      }
      closeEditModal();
      await refreshPool();
      if (data.resource?.id) {
        mergeResource(data.resource);
        openPanel(data.resource.id);
      }
    } catch {
      window.alert("Could not save resource.");
    }
  }

  async function deleteEditResource() {
    if (!canDelete) return;
    const id = parseInt(el("rp-edit-id")?.value || "", 10);
    if (!Number.isFinite(id) || id <= 0) return;
    if (!window.confirm("Remove this resource from the pool?")) return;
    try {
      const res = await fetch(`${apiBase}/resources/${id}`, { method: "DELETE", credentials: "same-origin" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        window.alert(data.error || "Could not delete resource.");
        return;
      }
      closeEditModal();
      closePanel();
      await refreshPool();
    } catch {
      window.alert("Could not delete resource.");
    }
  }

  function csvCellValue(key, r) {
    switch (key) {
      case "name":
        return r.name;
      case "skills":
        return (r.skills || []).join("; ");
      case "clearance":
        return r.clearance_level;
      case "location":
        return r.location;
      case "availability":
        return r.availability_label;
      case "employment_type":
        return r.employment_type;
      case "department":
        return r.department;
      case "job_title":
        return r.job_title || r.subtitle;
      case "email":
        return r.email;
      case "phone":
        return r.phone;
      case "reports_to":
        return r.reports_to;
      case "resource_added":
        return r.contract_start || r.resource_added || "";
      case "notes":
        return r.notes_count ? String(r.notes_count) : "";
      case "updated_at":
        return r.updated_at || "";
      default:
        return "";
    }
  }

  function exportCsv(rows) {
    const cols = listColumns.filter((k) => k !== "actions");
    const header = cols.map((k) => RP_CATALOG_BY_KEY[k]?.label || k);
    const lines = [header.join(",")];
    rows.forEach((r) => {
      const row = cols.map((k) => `"${String(csvCellValue(k, r) ?? "").replace(/"/g, '""')}"`);
      lines.push(row.join(","));
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `resource-pool-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function loadSavedSearches() {
    try {
      return JSON.parse(localStorage.getItem(LS_SAVED) || "[]");
    } catch {
      return [];
    }
  }

  function saveSavedSearches(list) {
    try {
      localStorage.setItem(LS_SAVED, JSON.stringify(list.slice(0, 20)));
    } catch {
      /* ignore */
    }
  }

  function refreshSavedDropdown() {
    const sel = el("rp-saved-searches");
    if (!sel) return;
    const list = loadSavedSearches();
    sel.innerHTML = '<option value="">Saved searches</option>';
    list.forEach((item, i) => {
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent = item.name || `Search ${i + 1}`;
      sel.appendChild(o);
    });
  }

  function render() {
    renderTable();
  }

  function showGapAnalysis() {
    const dlg = el("rp-gap-dialog");
    const list = el("rp-gap-list");
    if (!dlg || !list) return;
    const counts = {};
    all.forEach((r) => {
      (r.compliance_gaps || []).forEach((g) => {
        counts[g] = (counts[g] || 0) + 1;
      });
    });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    list.innerHTML = sorted.length
      ? sorted.map(([g, n]) => `<li><strong>${esc(g)}</strong> — ${n} resource${n === 1 ? "" : "s"}</li>`).join("")
      : "<li>No compliance gaps detected.</li>";
    dlg.showModal();
  }

  function wire() {
    updateKpis();
    populateFilterOptions();
    refreshSavedDropdown();
    applyFilters();

    ["rp-search", "rp-filter-skills", "rp-filter-clearance", "rp-filter-location", "rp-filter-availability", "rp-filter-employment"].forEach(
      (id) => {
        el(id)?.addEventListener("input", applyFilters);
        el(id)?.addEventListener("change", applyFilters);
      }
    );

    el("rp-clear-filters")?.addEventListener("click", () => {
      if (el("rp-search")) el("rp-search").value = "";
      ["rp-filter-skills", "rp-filter-clearance", "rp-filter-location", "rp-filter-availability", "rp-filter-employment"].forEach(
        (id) => {
          if (el(id)) el(id).value = "";
        }
      );
      applyFilters();
    });

    el("rp-panel-close")?.addEventListener("click", closePanel);

    const rpBackdrop = el("rp-detail-backdrop");
    if (rpBackdrop && !rpBackdrop.dataset.rpWired) {
      rpBackdrop.dataset.rpWired = "1";
      rpBackdrop.addEventListener("click", (ev) => {
        if (ev.target === rpBackdrop) closePanel();
      });
      document.addEventListener("keydown", (ev) => {
        if (ev.key !== "Escape") return;
        const bd = el("rp-detail-backdrop");
        if (bd && !bd.hidden) closePanel();
      });
    }

    document.querySelectorAll(".nc-rp-tabs button").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".nc-rp-tabs button").forEach((b) => {
          b.classList.remove("is-active");
          b.setAttribute("aria-selected", "false");
        });
        btn.classList.add("is-active");
        btn.setAttribute("aria-selected", "true");
        activeTab = btn.getAttribute("data-rp-tab") || "overview";
        panelViewMode = "content";
        const r = selectedResource();
        if (r) {
          renderPanelActions(r);
          renderPanelContent(r);
        }
      });
    });

    wireColumnEditor();

    el("nc-resource-pool")?.addEventListener("change", (ev) => {
      if (ev.target?.id === "rp-select-all") onSelectAllChange(ev);
    });

    if (!document.body.dataset.rpMoreMenuWired) {
      document.body.dataset.rpMoreMenuWired = "1";
      document.addEventListener("click", (ev) => {
        const menu = el("rp-more-menu");
        const toggle = el("rp-panel-toolbar")?.querySelector("[data-rp-more-toggle]");
        if (!menu || menu.hidden) return;
        if (menu.contains(ev.target) || toggle?.contains(ev.target)) return;
        menu.hidden = true;
        toggle?.setAttribute("aria-expanded", "false");
      });
    }

    el("rp-export-btn")?.addEventListener("click", () => {
      const menu = el("rp-export-menu");
      if (!menu) return;
      const open = !menu.hidden;
      menu.hidden = open;
      el("rp-export-btn")?.setAttribute("aria-expanded", open ? "false" : "true");
    });

    document.addEventListener("click", (ev) => {
      const menu = el("rp-export-menu");
      const btn = el("rp-export-btn");
      if (!menu || menu.hidden) return;
      if (btn?.contains(ev.target) || menu.contains(ev.target)) return;
      menu.hidden = true;
      btn?.setAttribute("aria-expanded", "false");
    });

    el("rp-export-menu")?.querySelector('[data-rp-export="csv"]')?.addEventListener("click", () => {
      exportCsv(filtered);
      if (el("rp-export-menu")) el("rp-export-menu").hidden = true;
    });

    el("rp-save-search-btn")?.addEventListener("click", () => {
      const name = window.prompt("Name this search:");
      if (!name) return;
      const list = loadSavedSearches();
      list.unshift({ name: name.trim(), filters: getFilters() });
      saveSavedSearches(list);
      refreshSavedDropdown();
    });

    el("rp-saved-searches")?.addEventListener("change", () => {
      const sel = el("rp-saved-searches");
      const idx = parseInt(sel?.value || "", 10);
      if (Number.isNaN(idx)) return;
      const list = loadSavedSearches();
      const item = list[idx];
      if (!item?.filters) return;
      const f = item.filters;
      if (el("rp-search")) el("rp-search").value = f.q || "";
      if (el("rp-filter-skills")) el("rp-filter-skills").value = f.skill || "";
      if (el("rp-filter-clearance")) el("rp-filter-clearance").value = f.clearance || "";
      if (el("rp-filter-location")) el("rp-filter-location").value = f.location || "";
      if (el("rp-filter-availability")) el("rp-filter-availability").value = f.availability || "";
      if (el("rp-filter-employment")) el("rp-filter-employment").value = f.employment || "";
      applyFilters();
      sel.value = "";
    });

    el("rp-gap-analysis-btn")?.addEventListener("click", showGapAnalysis);
    el("rp-gap-dialog-close")?.addEventListener("click", () => el("rp-gap-dialog")?.close());

    el("rp-add-btn")?.addEventListener("click", () => openEditModal(null));
    el("rp-import-btn")?.addEventListener("click", openImportModal);
    el("rp-import-close")?.addEventListener("click", closeImportModal);
    el("rp-import-cancel")?.addEventListener("click", closeImportModal);
    el("rp-import-save")?.addEventListener("click", saveImportResource);
    const importBd = el("rp-import-backdrop");
    if (importBd && !importBd.dataset.rpWired) {
      importBd.dataset.rpWired = "1";
      importBd.addEventListener("click", (ev) => {
        if (ev.target === importBd) closeImportModal();
      });
    }
    const importFile = el("rp-import-file");
    const importDrop = el("rp-import-drop");
    importFile?.addEventListener("change", () => {
      const file = importFile.files?.[0];
      if (!file) return;
      const fn = el("rp-import-filename");
      if (fn) fn.textContent = file.name;
      previewImportFile(file);
    });
    importDrop?.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      importDrop.classList.add("is-drag");
    });
    importDrop?.addEventListener("dragleave", () => importDrop.classList.remove("is-drag"));
    importDrop?.addEventListener("drop", (ev) => {
      ev.preventDefault();
      importDrop.classList.remove("is-drag");
      const file = ev.dataTransfer?.files?.[0];
      if (!file || !importFile) return;
      importFile.files = ev.dataTransfer.files;
      const fn = el("rp-import-filename");
      if (fn) fn.textContent = file.name;
      previewImportFile(file);
    });
    el("rp-section-close")?.addEventListener("click", closeSectionModal);
    el("rp-section-cancel")?.addEventListener("click", closeSectionModal);
    el("rp-section-save")?.addEventListener("click", saveSectionModal);
    const secBd = el("rp-section-backdrop");
    if (secBd && !secBd.dataset.rpWired) {
      secBd.dataset.rpWired = "1";
      secBd.addEventListener("click", (ev) => {
        if (ev.target === secBd) closeSectionModal();
      });
    }
    el("rp-edit-form")?.addEventListener("submit", saveEditForm);
    el("rp-edit-close")?.addEventListener("click", closeEditModal);
    el("rp-edit-cancel")?.addEventListener("click", closeEditModal);
    el("rp-edit-delete")?.addEventListener("click", deleteEditResource);
    const editBackdrop = el("rp-edit-backdrop");
    if (editBackdrop && !editBackdrop.dataset.rpWired) {
      editBackdrop.dataset.rpWired = "1";
      editBackdrop.addEventListener("click", (ev) => {
        if (ev.target === editBackdrop) closeEditModal();
      });
    }

    document.querySelectorAll("[data-rp-view]").forEach((btn) => {
      btn.addEventListener("click", () => {
        viewMode = btn.getAttribute("data-rp-view") || "list";
        document.querySelectorAll("[data-rp-view]").forEach((b) => {
          const on = b.getAttribute("data-rp-view") === viewMode;
          b.classList.toggle("is-active", on);
          b.setAttribute("aria-pressed", on ? "true" : "false");
        });
      });
    });
  }

  function init() {
    if (!document.getElementById("nc-resource-pool")) return;
    wire();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
  document.addEventListener("turbo:load", init);
})();
