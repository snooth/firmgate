(function () {
  "use strict";

  const root = document.getElementById("nc-kanban-root");
  const boardEl = document.getElementById("nc-kanban-board");
  const statusEl = document.getElementById("nc-kanban-status");
  if (!root || !boardEl) return;

  const canEdit = root.dataset.canEdit === "1";
  const canDelete = root.dataset.canDelete === "1";
  const boardId = Number(root.dataset.boardId || 0);
  const apiBoard = root.dataset.apiBoard || "/intranet/api/kanban/board";
  const apiColumns = root.dataset.apiColumns || "/intranet/api/kanban/columns";
  const apiCards = root.dataset.apiCards || "/intranet/api/kanban/cards";
  const apiAssignees = root.dataset.apiAssignees || "/intranet/api/kanban/assignees";
  const apiGeneral = root.dataset.apiGeneral || "/intranet/api/kanban/general";
  const apiShares = root.dataset.apiShares || "/intranet/api/kanban/shares";
  const apiShareTargets = root.dataset.apiShareTargets || "/intranet/api/kanban/share-targets";
  const apiDeleted = root.dataset.apiDeleted || "/intranet/api/kanban/deleted";
  const apiBoardActivity = root.dataset.apiActivity || "/intranet/api/kanban/activity";
  const canManageShares = root.dataset.canManageShares === "1";
  const canDeleteBoard = root.dataset.canDeleteBoard === "1";
  const apiBoardDelete = root.dataset.apiBoardDelete || apiBoard;
  const kanbanHomeUrl = root.dataset.kanbanHomeUrl || "/intranet/kanban";
  const currentUserId = Number(root.dataset.currentUserId || 0);

  const DND_TYPE = "application/x-kanban-card-id";
  const PRIORITIES = [
    { value: "none", label: "No priority", tone: "nc-kanban-pill--neutral" },
    { value: "low", label: "Low", tone: "nc-kanban-pill--green" },
    { value: "medium", label: "Medium", tone: "nc-kanban-pill--blue" },
    { value: "high", label: "High", tone: "nc-kanban-pill--amber" },
    { value: "urgent", label: "Urgent", tone: "nc-kanban-pill--red" },
  ];
  let board = null;
  let assignees = [];
  let dialogMode = "create";
  let activeCard = null;
  let activeColumnId = null;
  let quill = null;
  let commentQuill = null;
  let activeTab = "details";

  const cardDialog = document.getElementById("nc-kanban-card-dialog");
  const titleInput = document.getElementById("nc-kanban-detail-title");
  const statusSelect = document.getElementById("nc-kanban-status-select");
  const statusPill = document.getElementById("nc-kanban-status-pill");
  const prioritySelect = document.getElementById("nc-kanban-priority-select");
  const priorityPill = document.getElementById("nc-kanban-priority-pill");
  const assigneeSelect = document.getElementById("nc-kanban-assignee-select");
  const assigneePill = document.getElementById("nc-kanban-assignee-pill");
  const assigneeAvatar = document.getElementById("nc-kanban-assignee-avatar");
  const assigneeName = document.getElementById("nc-kanban-assignee-name");
  const assigneePlaceholder = document.getElementById("nc-kanban-assignee-placeholder");
  const assigneeClearBtn = document.getElementById("nc-kanban-assignee-clear");
  const dueInput = document.getElementById("nc-kanban-due-input");
  const dueMoreBtn = document.getElementById("nc-kanban-due-more");
  const dueMenu = document.getElementById("nc-kanban-due-menu");
  const dueClearBtn = document.getElementById("nc-kanban-due-clear");
  const saveDetailsBtn = document.getElementById("nc-kanban-save-details");
  const deleteBtn = document.getElementById("nc-kanban-card-delete");
  const menuMarkDoneBtn = document.getElementById("nc-kanban-menu-mark-done");
  const menuUnassignBtn = document.getElementById("nc-kanban-menu-unassign");
  const menuActivityBtn = document.getElementById("nc-kanban-menu-activity");
  const menuBtn = document.getElementById("nc-kanban-card-menu");
  const menuPop = document.getElementById("nc-kanban-card-menu-pop");
  const addColumnBtn = document.getElementById("nc-kanban-add-column");
  const attachmentInput = document.getElementById("nc-kanban-attachment-input");
  const attachmentList = document.getElementById("nc-kanban-attachment-list");
  const attachmentDropzone = document.getElementById("nc-kanban-attachment-dropzone");
  const attachmentsEmpty = document.getElementById("nc-kanban-attachments-empty");
  const commentList = document.getElementById("nc-kanban-comment-list");
  const commentsEmpty = document.getElementById("nc-kanban-comments-empty");
  const commentSubmit = document.getElementById("nc-kanban-comment-submit");
  const activityList = document.getElementById("nc-kanban-activity-list");
  const activityEmpty = document.getElementById("nc-kanban-activity-empty");
  const countAttachments = document.getElementById("nc-kanban-tab-count-attachments");
  const countComments = document.getElementById("nc-kanban-tab-count-comments");

  const generalPanel = document.getElementById("nc-kanban-general-panel");
  const generalBackdrop = document.getElementById("nc-kanban-general-backdrop");
  const generalCloseBtn = document.getElementById("nc-kanban-general-close");
  const generalBoardName = document.getElementById("nc-kanban-general-board-name");
  const generalTabLabel = document.getElementById("nc-kanban-general-tab-label");
  const boardMenuBtn = document.getElementById("nc-kanban-board-menu");
  const boardMenuPop = document.getElementById("nc-kanban-board-menu-pop");
  const boardSettingsName = document.getElementById("nc-kanban-board-settings-name");
  const boardSettingsSubtitle = document.getElementById("nc-kanban-board-settings-subtitle");
  const boardSettingsSaveBtn = document.getElementById("nc-kanban-board-settings-save");
  const heroBoardName = document.getElementById("nc-kanban-hero-board-name");
  const heroBoardSub = document.getElementById("nc-kanban-hero-board-sub");
  const shareList = document.getElementById("nc-kanban-share-list");
  const shareUserSelect = document.getElementById("nc-kanban-share-user");
  const shareGroupSelect = document.getElementById("nc-kanban-share-group");
  const shareUserAddBtn = document.getElementById("nc-kanban-share-user-add");
  const shareGroupAddBtn = document.getElementById("nc-kanban-share-group-add");
  const sharesSaveBtn = document.getElementById("nc-kanban-shares-save");
  const deletedList = document.getElementById("nc-kanban-deleted-list");
  const deletedEmpty = document.getElementById("nc-kanban-deleted-empty");
  const deletedCountBadge = document.getElementById("nc-kanban-general-deleted-count");
  const boardActivityList = document.getElementById("nc-kanban-board-activity-list");
  const boardActivityEmpty = document.getElementById("nc-kanban-board-activity-empty");
  const filterProgressBtn = document.getElementById("nc-kanban-filter-progress-btn");
  const filterPriorityBtn = document.getElementById("nc-kanban-filter-priority-btn");
  const filterAssigneeBtn = document.getElementById("nc-kanban-filter-assignee-btn");
  const filterProgressPop = document.getElementById("nc-kanban-filter-progress-pop");
  const filterPriorityPop = document.getElementById("nc-kanban-filter-priority-pop");
  const filterAssigneePop = document.getElementById("nc-kanban-filter-assignee-pop");
  const filterProgressOptions = document.getElementById("nc-kanban-filter-progress-options");
  const filterPriorityOptions = document.getElementById("nc-kanban-filter-priority-options");
  const filterAssigneeOptions = document.getElementById("nc-kanban-filter-assignee-options");
  const filterClearBtn = document.getElementById("nc-kanban-filter-clear");
  const filterSummary = document.getElementById("nc-kanban-filter-summary");

  let generalTab = "settings";
  let shareTargets = { users: [], groups: [] };
  let shareDraft = { users: [], groups: [] };
  let generalLoaded = false;
  let boardFilters = { columns: [], priorities: [], assignees: [] };
  let openFilterPop = null;

  function esc(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg || "";
  }

  function boardQuery(url) {
    if (!boardId) return url;
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}board_id=${encodeURIComponent(String(boardId))}`;
  }

  function withBoardId(payload) {
    const body = payload && typeof payload === "object" ? { ...payload } : {};
    if (boardId) body.board_id = boardId;
    return body;
  }

  async function api(url, opts) {
    const r = await fetch(url, {
      credentials: "same-origin",
      headers: { Accept: "application/json", ...(opts && opts.body instanceof FormData ? {} : { "Content-Type": "application/json" }) },
      ...opts,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Request failed");
    return j;
  }

  function dotClass(token) {
    const t = String(token || "").trim();
    if (!t) return "";
    return t.startsWith("is-") ? t : `is-${t}`;
  }

  function initials(name) {
    const parts = String(name || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function cardCountLabel(n) {
    const count = Number(n) || 0;
    return count === 1 ? "1 card" : `${count} cards`;
  }

  function formatDue(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return "";
      return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    } catch (_) {
      return "";
    }
  }

  function isoToLocalInput(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return "";
      const pad = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch (_) {
      return "";
    }
  }

  function localInputToIso(val) {
    if (!val) return null;
    try {
      const d = new Date(val);
      if (Number.isNaN(d.getTime())) return null;
      return d.toISOString();
    } catch (_) {
      return null;
    }
  }

  function getColumnById(columnId) {
    return (board && board.columns ? board.columns : []).find((c) => Number(c.id) === Number(columnId)) || null;
  }

  function isDoneColumn(columnId) {
    const col = getColumnById(columnId);
    if (!col) return false;
    const title = String(col.title || "").trim().toLowerCase();
    if (title === "done" || title.includes("finished") || title.includes("complete")) return true;
    return String(col.color_token || "").trim().toLowerCase() === "green";
  }

  function isTodoColumn(col) {
    if (!col) return false;
    if (col.is_todo === true) return true;
    const title = String(col.title || "").trim().toLowerCase().replace(/-/g, " ");
    return title === "to do" || title === "todo";
  }

  function pillToneClass(column) {
    const token = dotClass(column && column.color_token);
    if (token === "is-green") return "nc-kanban-pill--green";
    if (token === "is-amber") return "nc-kanban-pill--amber";
    if (token === "is-blue") return "nc-kanban-pill--blue";
    if (token === "is-indigo") return "nc-kanban-pill--indigo";
    return "nc-kanban-pill--neutral";
  }

  function priorityMeta(value) {
    const raw = String(value || "medium").trim().toLowerCase();
    return PRIORITIES.find((p) => p.value === raw) || PRIORITIES.find((p) => p.value === "medium");
  }

  function renderPriorityPill(priority) {
    if (!priorityPill) return;
    const meta = priorityMeta(priority);
    priorityPill.textContent = meta.label;
    priorityPill.className = `nc-kanban-pill ${meta.tone}`;
  }

  function ensureQuill() {
    if (quill || typeof Quill === "undefined") return quill;
    const mount = document.getElementById("nc-kanban-quill-editor");
    if (!mount) return null;
    quill = new Quill(mount, {
      theme: "snow",
      placeholder: "Start writing, or try '/' to add, '@' to mention…",
      modules: {
        toolbar: [
          ["bold", "italic", "underline", "strike"],
          [{ header: 1 }, { header: 2 }],
          [{ list: "bullet" }, { list: "ordered" }],
          ["blockquote", "code-block", "link"],
          ["clean"],
        ],
      },
    });
    if (!canEdit) quill.enable(false);
    return quill;
  }

  function pickCommentImageFile() {
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

  async function uploadCommentImage(file) {
    if (!activeCard || !activeCard.id || !file) throw new Error("No card");
    if (!file.type || !file.type.startsWith("image/")) throw new Error("Image required");
    if (file.size > 8 * 1024 * 1024) throw new Error("Image must be 8 MB or smaller.");
    const fd = new FormData();
    fd.append("file", file, file.name || "screenshot.png");
    const r = await fetch(
      `/intranet/api/kanban/cards/${encodeURIComponent(String(activeCard.id))}/comment-images`,
      { method: "POST", body: fd, credentials: "same-origin" }
    );
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Image upload failed");
    if (!j.url) throw new Error("No image URL returned");
    return String(j.url);
  }

  function insertCommentImageAtCaret(url) {
    if (!commentQuill) return;
    const range = commentQuill.getSelection(true);
    const idx = range ? range.index : commentQuill.getLength();
    commentQuill.insertEmbed(idx, "image", url, "user");
    commentQuill.setSelection(idx + 1, 0);
  }

  async function uploadAndInsertCommentImage(file) {
    if (!file || !file.type || !file.type.startsWith("image/")) return;
    setStatus("Uploading image…");
    try {
      const url = await uploadCommentImage(file);
      insertCommentImageAtCaret(url);
      setStatus("");
    } catch (err) {
      setStatus(err.message || "Could not upload image.");
    }
  }

  function ensureCommentQuill() {
    if (commentQuill || typeof Quill === "undefined") return commentQuill;
    const mount = document.getElementById("nc-kanban-comment-quill");
    if (!mount) return null;
    commentQuill = new Quill(mount, {
      theme: "snow",
      placeholder: "Write a comment… Paste screenshots with Ctrl+V.",
      modules: {
        toolbar: {
          container: [
            ["bold", "italic", "underline", "strike"],
            [{ header: 1 }, { header: 2 }],
            [{ list: "bullet" }, { list: "ordered" }],
            ["blockquote", "code-block", "link", "image"],
            ["clean"],
          ],
          handlers: {
            image: function () {
              void pickCommentImageFile().then((f) => {
                if (f) void uploadAndInsertCommentImage(f);
              });
            },
          },
        },
      },
    });

    commentQuill.root.addEventListener(
      "paste",
      (e) => {
        const items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        for (let i = 0; i < items.length; i += 1) {
          if (items[i].type && items[i].type.indexOf("image") !== -1) {
            e.preventDefault();
            const blob = items[i].getAsFile();
            if (blob) void uploadAndInsertCommentImage(blob);
            return;
          }
        }
      },
      true
    );

    commentQuill.root.addEventListener(
      "drop",
      (e) => {
        const dt = e.dataTransfer;
        if (!dt || !dt.files || !dt.files.length) return;
        const f = dt.files[0];
        if (f.type && f.type.startsWith("image/")) {
          e.preventDefault();
          void uploadAndInsertCommentImage(f);
        }
      },
      true
    );

    return commentQuill;
  }

  function resetCommentEditor() {
    ensureCommentQuill();
    if (commentQuill) commentQuill.setText("");
  }

  function commentBodyMarkup(c) {
    if (c.body_html && String(c.body_html).trim()) return String(c.body_html);
    const text = String(c.body || "").trim();
    if (!text) return "";
    return `<p>${esc(text)}</p>`;
  }

  function renderStatusPill(columnId) {
    if (!statusPill) return;
    const col = getColumnById(columnId) || { title: "Status", color_token: "" };
    statusPill.textContent = col.title || "Status";
    statusPill.className = `nc-kanban-pill ${pillToneClass(col)}`;
  }

  function renderAssigneePill(assigneeId, assigneeNameText) {
    const id = assigneeId ? Number(assigneeId) : 0;
    const name = assigneeNameText || (assignees.find((u) => Number(u.id) === id) || {}).name || "";
    if (assigneePill) assigneePill.hidden = !id;
    if (assigneePlaceholder) assigneePlaceholder.hidden = !!id;
    if (id && assigneePill) {
      if (assigneeAvatar) assigneeAvatar.textContent = initials(name);
      if (assigneeName) assigneeName.textContent = name;
    }
  }

  function updateMenuState(card) {
    const done = card && isDoneColumn(card.column_id);
    if (menuMarkDoneBtn) {
      menuMarkDoneBtn.classList.toggle("is-checked", !!done);
      menuMarkDoneBtn.disabled = !!done;
    }
    const mine =
      card &&
      card.assignee_id &&
      currentUserId &&
      Number(card.assignee_id) === Number(currentUserId);
    if (menuUnassignBtn) menuUnassignBtn.hidden = !mine;
  }

  function applyCardResponse(j) {
    activeCard = j.card || activeCard;
    if (j.board) {
      board = j.board;
      renderBoard(j.board);
    }
    if (activeCard) fillDetailForm(activeCard);
  }

  async function patchCard(payload) {
    if (!activeCard || !activeCard.id) return null;
    const j = await api(`/intranet/api/kanban/cards/${encodeURIComponent(String(activeCard.id))}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    applyCardResponse(j);
    return j;
  }

  function populateStatusOptions(selectedId) {
    if (!statusSelect || !board) return;
    statusSelect.innerHTML = "";
    (board.columns || []).forEach((col) => {
      const opt = document.createElement("option");
      opt.value = String(col.id);
      opt.textContent = col.title || "Column";
      if (Number(col.id) === Number(selectedId)) opt.selected = true;
      statusSelect.appendChild(opt);
    });
    renderStatusPill(selectedId);
  }

  function populatePriorityOptions(selectedPriority) {
    if (!prioritySelect) return;
    const selected = String(selectedPriority || "medium").trim().toLowerCase();
    prioritySelect.innerHTML = "";
    PRIORITIES.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.value;
      opt.textContent = p.label;
      if (p.value === selected) opt.selected = true;
      prioritySelect.appendChild(opt);
    });
    renderPriorityPill(selected);
  }

  function populateAssigneeOptions(selectedId, assigneeNameText) {
    if (!assigneeSelect) return;
    assigneeSelect.innerHTML = '<option value="">Unassigned</option>';
    assignees.forEach((u) => {
      const opt = document.createElement("option");
      opt.value = String(u.id);
      opt.textContent = u.name || u.email || `User ${u.id}`;
      if (Number(u.id) === Number(selectedId)) opt.selected = true;
      assigneeSelect.appendChild(opt);
    });
    renderAssigneePill(selectedId, assigneeNameText);
  }

  function boardFilterStorageKey() {
    return `firmgate.kanbanFilters.${boardId || "0"}`;
  }

  function allColumnFilterIds(data) {
    return ((data && data.columns) || []).map((col) => String(col.id));
  }

  function allPriorityFilterIds() {
    return PRIORITIES.map((p) => p.value);
  }

  function collectAssigneeFilterOptions(data) {
    const map = new Map([["unassigned", "Unassigned"]]);
    assignees.forEach((u) => {
      map.set(String(u.id), u.name || u.email || `User ${u.id}`);
    });
    ((data && data.columns) || []).forEach((col) => {
      (col.cards || []).forEach((card) => {
        if (card.assignee_id) {
          const id = String(card.assignee_id);
          if (!map.has(id)) map.set(id, card.assignee_name || `User ${id}`);
        }
      });
    });
    return Array.from(map.entries())
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => {
        if (a.id === "unassigned") return -1;
        if (b.id === "unassigned") return 1;
        return String(a.label).localeCompare(String(b.label));
      });
  }

  function allAssigneeFilterIds(data) {
    return collectAssigneeFilterOptions(data).map((row) => row.id);
  }

  function loadBoardFiltersFromStorage() {
    try {
      const raw = localStorage.getItem(boardFilterStorageKey());
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      return {
        columns: Array.isArray(parsed.columns) ? parsed.columns.map(String) : [],
        priorities: Array.isArray(parsed.priorities) ? parsed.priorities.map(String) : [],
        assignees: Array.isArray(parsed.assignees) ? parsed.assignees.map(String) : [],
      };
    } catch (_) {
      return null;
    }
  }

  function saveBoardFiltersToStorage() {
    try {
      localStorage.setItem(boardFilterStorageKey(), JSON.stringify(boardFilters));
    } catch (_) {}
  }

  function syncBoardFiltersWithBoard(data) {
    const columnIds = allColumnFilterIds(data);
    const priorityIds = allPriorityFilterIds();
    const assigneeIds = allAssigneeFilterIds(data);
    const saved = loadBoardFiltersFromStorage();
    const next = {
      columns: (saved && saved.columns.length ? saved.columns : columnIds).filter((id) => columnIds.includes(id)),
      priorities: (saved && saved.priorities.length ? saved.priorities : priorityIds).filter((id) => priorityIds.includes(id)),
      assignees: (saved && saved.assignees.length ? saved.assignees : assigneeIds).filter((id) => assigneeIds.includes(id)),
    };
    if (!next.columns.length) next.columns = [...columnIds];
    if (!next.priorities.length) next.priorities = [...priorityIds];
    if (!next.assignees.length) next.assignees = [...assigneeIds];
    columnIds.forEach((id) => {
      if (!next.columns.includes(id)) next.columns.push(id);
    });
    assigneeIds.forEach((id) => {
      if (!next.assignees.includes(id)) next.assignees.push(id);
    });
    boardFilters = next;
  }

  function cardMatchesBoardFilters(card) {
    const priority = String(card.priority || "medium").trim().toLowerCase();
    const assigneeKey = card.assignee_id ? String(card.assignee_id) : "unassigned";
    if (boardFilters.priorities.length && !boardFilters.priorities.includes(priority)) return false;
    if (boardFilters.assignees.length && !boardFilters.assignees.includes(assigneeKey)) return false;
    return true;
  }

  function getFilteredBoardData(data) {
    const cols = (data && data.columns) || [];
    return cols
      .filter((col) => !boardFilters.columns.length || boardFilters.columns.includes(String(col.id)))
      .map((col) => ({
        ...col,
        cards: (col.cards || []).filter((card) => cardMatchesBoardFilters(card)),
      }));
  }

  function countBoardCards(data) {
    let total = 0;
    ((data && data.columns) || []).forEach((col) => {
      total += (col.cards || []).length;
    });
    return total;
  }

  function countFilteredBoardCards(data) {
    let visible = 0;
    getFilteredBoardData(data).forEach((col) => {
      visible += (col.cards || []).length;
    });
    return visible;
  }

  function boardFiltersAreDefault(data) {
    const columnIds = allColumnFilterIds(data);
    const priorityIds = allPriorityFilterIds();
    const assigneeIds = allAssigneeFilterIds(data);
    const same = (selected, all) =>
      selected.length === all.length && all.every((id) => selected.includes(id));
    return (
      same(boardFilters.columns, columnIds)
      && same(boardFilters.priorities, priorityIds)
      && same(boardFilters.assignees, assigneeIds)
    );
  }

  function filterBtnLabel(base, selectedCount, totalCount) {
    if (totalCount <= 0 || selectedCount >= totalCount) return base;
    return `${base} (${selectedCount})`;
  }

  function renderFilterCheckboxOptions(container, items, selected, group) {
    if (!container) return;
    container.innerHTML = items
      .map(
        (item) => `
      <label class="nc-kanban-filter-option">
        <input type="checkbox" data-filter-group="${esc(group)}" value="${esc(item.id)}" ${selected.includes(String(item.id)) ? "checked" : ""}>
        <span>${esc(item.label)}</span>
      </label>`
      )
      .join("");
  }

  function renderBoardFilterControls(data) {
    const columnItems = ((data && data.columns) || []).map((col) => ({
      id: String(col.id),
      label: col.title || "Column",
    }));
    const priorityItems = PRIORITIES.map((p) => ({ id: p.value, label: p.label }));
    const assigneeItems = collectAssigneeFilterOptions(data);

    renderFilterCheckboxOptions(filterProgressOptions, columnItems, boardFilters.columns, "columns");
    renderFilterCheckboxOptions(filterPriorityOptions, priorityItems, boardFilters.priorities, "priorities");
    renderFilterCheckboxOptions(filterAssigneeOptions, assigneeItems, boardFilters.assignees, "assignees");

    if (filterProgressBtn) {
      filterProgressBtn.textContent = filterBtnLabel("Progress", boardFilters.columns.length, columnItems.length);
      filterProgressBtn.classList.toggle("is-active", boardFilters.columns.length < columnItems.length);
    }
    if (filterPriorityBtn) {
      filterPriorityBtn.textContent = filterBtnLabel("Priority", boardFilters.priorities.length, priorityItems.length);
      filterPriorityBtn.classList.toggle("is-active", boardFilters.priorities.length < priorityItems.length);
    }
    if (filterAssigneeBtn) {
      filterAssigneeBtn.textContent = filterBtnLabel("Assignee", boardFilters.assignees.length, assigneeItems.length);
      filterAssigneeBtn.classList.toggle("is-active", boardFilters.assignees.length < assigneeItems.length);
    }

    const filtered = !boardFiltersAreDefault(data);
    if (filterClearBtn) filterClearBtn.hidden = !filtered;
    if (filterSummary) {
      if (!filtered) {
        filterSummary.hidden = true;
        filterSummary.textContent = "";
      } else {
        const visible = countFilteredBoardCards(data);
        const total = countBoardCards(data);
        filterSummary.hidden = false;
        filterSummary.textContent =
          visible === total ? `Showing all ${total} cards` : `Showing ${visible} of ${total} cards`;
      }
    }
  }

  function closeBoardFilterPop() {
    if (openFilterPop) {
      openFilterPop.hidden = true;
      openFilterPop = null;
    }
    [filterProgressBtn, filterPriorityBtn, filterAssigneeBtn].forEach((btn) => {
      if (btn) btn.setAttribute("aria-expanded", "false");
    });
  }

  function toggleBoardFilterPop(btn, pop) {
    if (!btn || !pop) return;
    const willOpen = pop.hidden;
    closeBoardFilterPop();
    if (willOpen) {
      pop.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      openFilterPop = pop;
    }
  }

  function onBoardFilterCheckboxChange(e) {
    const input = e.target;
    if (!input || input.type !== "checkbox" || !input.dataset.filterGroup) return;
    const group = input.dataset.filterGroup;
    const value = String(input.value || "");
    if (!value || !Object.prototype.hasOwnProperty.call(boardFilters, group)) return;
    const selected = new Set(boardFilters[group]);
    if (input.checked) {
      selected.add(value);
    } else if (selected.size <= 1) {
      input.checked = true;
      return;
    } else {
      selected.delete(value);
    }
    boardFilters[group] = Array.from(selected);
    saveBoardFiltersToStorage();
    if (board) {
      renderBoardFilterControls(board);
      renderBoardColumns(board);
    }
  }

  function clearBoardFilters() {
    if (!board) return;
    boardFilters = {
      columns: allColumnFilterIds(board),
      priorities: allPriorityFilterIds(),
      assignees: allAssigneeFilterIds(board),
    };
    saveBoardFiltersToStorage();
    renderBoardFilterControls(board);
    renderBoardColumns(board);
  }

  function applyBoardMeta(name, subtitle) {
    const displayName = (name || "Board").trim() || "Board";
    const displaySub = (subtitle || "Drag cards between columns to update status.").trim()
      || "Drag cards between columns to update status.";
    const boardTitle = document.getElementById("nc-kanban-board-title");
    const boardLead = document.querySelector(".nc-kanban-lead");
    if (boardTitle) boardTitle.textContent = displayName;
    if (boardLead) boardLead.textContent = displaySub;
    if (heroBoardName) heroBoardName.textContent = displayName;
    if (heroBoardSub) heroBoardSub.textContent = displaySub;
    if (generalBoardName) generalBoardName.textContent = displayName;
    if (board && typeof board === "object") {
      board.name = displayName;
      board.subtitle = displaySub;
    }
  }

  function renderBoard(data) {
    board = data;
    syncBoardFiltersWithBoard(data);
    renderBoardFilterControls(data);
    renderBoardColumns(data);
  }

  function renderBoardColumns(data) {
    boardEl.innerHTML = "";
    const boardTitle = document.getElementById("nc-kanban-board-title");
    const boardLead = document.querySelector(".nc-kanban-lead");
    if (data && data.name) applyBoardMeta(data.name, data.subtitle);
    else {
      if (boardTitle && data && data.name) boardTitle.textContent = data.name;
      if (boardLead && data && data.subtitle) boardLead.textContent = data.subtitle;
      if (generalBoardName && data && data.name) generalBoardName.textContent = data.name;
    }

    const cols = getFilteredBoardData(data);
    boardEl.style.setProperty("--nc-kanban-cols", String(Math.max(cols.length, 1)));
    if (!cols.length) {
      const empty = document.createElement("p");
      empty.className = "nc-crm2-empty nc-kanban-empty nc-kanban-board-filter-empty";
      empty.textContent = "No columns match the current filters.";
      boardEl.appendChild(empty);
      return;
    }
    cols.forEach((col) => {
      const colEl = document.createElement("section");
      colEl.className = "nc-kanban-col nc-crm2-col";
      colEl.dataset.columnId = String(col.id);

      const head = document.createElement("div");
      head.className = "nc-kanban-col-head nc-crm2-col-head";
      const dot = col.color_token
        ? `<span class="nc-crm2-dot ${esc(dotClass(col.color_token))}" aria-hidden="true"></span>`
        : "";
      head.innerHTML = `
        <div class="nc-crm2-col-title">${dot}<span>${esc(col.title)}</span></div>
        <div class="nc-crm2-col-meta" title="${esc(cardCountLabel((col.cards || []).length))}">${(col.cards || []).length}</div>
      `;

      const body = document.createElement("div");
      body.className = "nc-kanban-col-body nc-crm2-col-body";
      body.dataset.columnId = String(col.id);

      const cards = col.cards || [];
      if (!cards.length) {
        const empty = document.createElement("p");
        empty.className = "nc-crm2-empty nc-kanban-empty";
        empty.textContent = boardFiltersAreDefault(data) ? "No cards yet" : "No matching cards";
        body.appendChild(empty);
      } else {
        cards.forEach((card) => body.appendChild(renderCard(card)));
      }

      if (canEdit && isTodoColumn(col)) {
        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "nc-btn nc-btn-secondary nc-kanban-add-card-btn";
        addBtn.textContent = "+ Add card";
        addBtn.addEventListener("click", () => openCardDialog("create", col.id));
        body.appendChild(addBtn);
      }

      colEl.appendChild(head);
      colEl.appendChild(body);
      boardEl.appendChild(colEl);
    });
  }

  function renderCard(card) {
    const el = document.createElement("article");
    el.className = "nc-kanban-card nc-crm2-deal";
    el.dataset.cardId = String(card.id);
    if (canEdit) el.setAttribute("draggable", "true");

    const preview = card.body || (card.body_html ? card.body_html.replace(/<[^>]+>/g, " ").trim() : "");
    const notes = preview ? `<p class="nc-kanban-card-notes">${esc(preview.slice(0, 140))}</p>` : "";
    const person = card.assignee_name || card.created_by_name || "";
    const avatar = person
      ? `<span class="nc-crm2-avatar is-blue" title="${esc(person)}" aria-hidden="true">${esc(initials(person))}</span>`
      : "";
    const priority = priorityMeta(card.priority);
    const priorityTag =
      priority.value === "none"
        ? ""
        : `<span class="nc-kanban-pill nc-kanban-pill--card ${priority.tone}" title="Priority: ${esc(priority.label)}">${esc(priority.label)}</span>`;
    const due = card.due_at ? `<div class="nc-kanban-card-due">${esc(formatDue(card.due_at))}</div>` : "";
    const badges = [];
    if ((card.comment_count || 0) > 0) badges.push(`💬 ${card.comment_count}`);
    if ((card.attachment_count || 0) > 0) badges.push(`📎 ${card.attachment_count}`);
    const badgeRow = badges.length ? `<div class="nc-kanban-card-badges">${badges.join(" · ")}</div>` : "";

    el.innerHTML = `
      <div class="nc-kanban-card-top">
        ${avatar}
        <div class="nc-kanban-card-copy">
          <div class="nc-kanban-card-title-row">
            <div class="nc-kanban-card-title">${esc(card.title)}</div>
            ${priorityTag}
          </div>
          ${notes}
        </div>
      </div>
      ${due}
      ${badgeRow}
    `;
    el.addEventListener("click", () => {
      if (el.classList.contains("is-dragging")) return;
      void openCardDialog("edit", card.column_id, card);
    });
    return el;
  }

  function setTab(tab) {
    activeTab = tab;
    document.querySelectorAll(".nc-kanban-detail-tab").forEach((btn) => {
      const on = btn.getAttribute("data-kanban-tab") === tab;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    document.querySelectorAll(".nc-kanban-detail-panel").forEach((panel) => {
      const on = panel.getAttribute("data-kanban-panel") === tab;
      panel.classList.toggle("is-active", on);
      panel.hidden = !on;
    });
    if (tab === "comments") ensureCommentQuill();
  }

  function renderComments(card) {
    if (!commentList) return;
    const rows = card.comments || [];
    commentList.innerHTML = rows
      .map(
        (c) => `
      <li class="nc-kanban-comment">
        <div class="nc-kanban-comment-head">
          <span class="nc-crm2-avatar is-blue">${esc(initials(c.user_name))}</span>
          <div>
            <div class="nc-kanban-comment-author">${esc(c.user_name || "Someone")}</div>
            <div class="nc-kanban-comment-time">${esc(formatDue(c.created_at))}</div>
          </div>
        </div>
        <div class="nc-kanban-comment-body nc-kanban-comment-body--rich">${commentBodyMarkup(c)}</div>
      </li>`
      )
      .join("");
    if (commentsEmpty) commentsEmpty.hidden = rows.length > 0;
    if (countComments) countComments.textContent = String(rows.length);
  }

  function renderAttachments(card) {
    if (!attachmentList) return;
    const rows = card.attachments || [];
    attachmentList.innerHTML = rows
      .map(
        (a) => `
      <li class="nc-kanban-attachment">
        <a class="nc-kanban-attachment-link" href="/intranet/api/kanban/attachments/${encodeURIComponent(String(a.id))}" download>${esc(a.filename)}</a>
        <span class="nc-kanban-attachment-meta">${Math.max(1, Math.round((a.size || 0) / 1024))} KB</span>
        ${canEdit ? `<button type="button" class="nc-btn nc-btn-ghost nc-kanban-attachment-delete" data-attachment-id="${esc(a.id)}">Remove</button>` : ""}
      </li>`
      )
      .join("");
    if (attachmentsEmpty) attachmentsEmpty.hidden = rows.length > 0;
    if (countAttachments) countAttachments.textContent = String(rows.length);
    attachmentList.querySelectorAll(".nc-kanban-attachment-delete").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-attachment-id");
        if (!id || !activeCard) return;
        try {
          const j = await api(`/intranet/api/kanban/attachments/${encodeURIComponent(id)}`, { method: "DELETE" });
          activeCard = j.card;
          renderAttachments(activeCard);
          if (j.board) renderBoard(j.board);
        } catch (err) {
          setStatus(err.message || "Could not remove attachment.");
        }
      });
    });
  }

  function activityLabel(row) {
    const action = row.action || "";
    const d = row.details || {};
    if (action === "created") return "created this card";
    if (action === "moved" || action === "marked_done") {
      return `moved to ${d.to_column || d.column || "Done"}`;
    }
    if (action === "commented") return "added a comment";
    if (action === "attachment_added") return `attached ${d.filename || "a file"}`;
    if (action === "attachment_removed") return `removed ${d.filename || "an attachment"}`;
    if (action === "updated") return "updated card details";
    if (action === "deleted") return "deleted this card";
    if (action === "restored") return "restored this card";
    return action.replace(/_/g, " ");
  }

  function boardActivityLabel(row) {
    const action = row.action || "";
    const d = row.details || {};
    const cardTitle = row.card_title || d.title || "";
    const prefix = cardTitle ? `"${cardTitle}" — ` : "";
    if (action === "shares_updated") return "updated board sharing";
    if (action === "settings_updated") {
      if (d.name) return `renamed board to "${d.name}"`;
      if (d.subtitle) return "updated board subtitle";
      return "updated board settings";
    }
    if (action === "card_deleted") return `${prefix}moved to deleted items`;
    if (action === "card_restored") return `${prefix}restored from deleted items`;
    if (action === "created") return `${prefix}created`;
    if (action === "moved" || action === "marked_done") {
      return `${prefix}moved to ${d.to_column || d.column || "Done"}`;
    }
    if (action === "commented") return `${prefix}commented`;
    if (action === "attachment_added") return `${prefix}attached ${d.filename || "a file"}`;
    if (action === "attachment_removed") return `${prefix}removed ${d.filename || "an attachment"}`;
    if (action === "updated") return `${prefix}updated details`;
    if (action === "deleted") return `${prefix}deleted`;
    if (action === "restored") return `${prefix}restored`;
    return `${prefix}${action.replace(/_/g, " ")}`.trim();
  }

  function renderActivity(card) {
    if (!activityList) return;
    const rows = card.activity || [];
    activityList.innerHTML = rows
      .map(
        (a) => `
      <li class="nc-kanban-activity">
        <span class="nc-crm2-avatar is-indigo">${esc(initials(a.user_name || "?"))}</span>
        <div>
          <div class="nc-kanban-activity-text"><strong>${esc(a.user_name || "Someone")}</strong> ${esc(activityLabel(a))}</div>
          <div class="nc-kanban-activity-time">${esc(formatDue(a.created_at))}</div>
        </div>
      </li>`
      )
      .join("");
    if (activityEmpty) activityEmpty.hidden = rows.length > 0;
  }

  function fillDetailForm(card) {
    if (titleInput) titleInput.value = card.title || "";
    populateStatusOptions(card.column_id);
    populatePriorityOptions(card.priority || "medium");
    populateAssigneeOptions(card.assignee_id, card.assignee_name);
    if (dueInput) dueInput.value = isoToLocalInput(card.due_at);
    ensureQuill();
    if (quill) {
      const html = card.body_html || "";
      if (html) quill.root.innerHTML = html;
      else quill.setText(card.body || "");
    }
    renderComments(card);
    renderAttachments(card);
    renderActivity(card);
    updateMenuState(card);
  }

  async function loadCardDetail(cardId) {
    const j = await api(`/intranet/api/kanban/cards/${encodeURIComponent(String(cardId))}`);
    return j.card;
  }

  async function loadBoard() {
    setStatus("Loading…");
    try {
      const j = await api(apiBoard);
      renderBoard(j.board || {});
      setStatus("");
    } catch (e) {
      setStatus(e.message || "Could not load board.");
    }
  }

  const GENERAL_TAB_LABELS = {
    settings: "Settings",
    sharing: "Sharing",
    deleted: "Deleted items",
    activity: "Activity",
  };

  function setGeneralTab(name) {
    generalTab = name || "settings";
    if (generalTabLabel) {
      generalTabLabel.textContent = GENERAL_TAB_LABELS[generalTab] || "Settings";
    }
    document.querySelectorAll(".nc-kanban-general-tab").forEach((btn) => {
      const on = btn.getAttribute("data-general-tab") === generalTab;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", String(on));
    });
    document.querySelectorAll(".nc-kanban-general-panel").forEach((panel) => {
      const on = panel.getAttribute("data-general-panel") === generalTab;
      panel.classList.toggle("is-active", on);
      panel.hidden = !on;
    });
    if (generalTab === "deleted") void loadDeletedCards();
    if (generalTab === "activity") void loadBoardActivity();
    if (generalTab === "sharing") {
      const userCount = shareUserSelect ? shareUserSelect.options.length : 0;
      const groupCount = shareGroupSelect ? shareGroupSelect.options.length : 0;
      if (userCount <= 1 && groupCount <= 1) void loadShareTargets();
    }
  }

  function openGeneralPanel(tabName) {
    if (tabName) setGeneralTab(tabName);
    if (!generalPanel) return;
    generalPanel.hidden = false;
    if (generalBackdrop) {
      generalBackdrop.hidden = false;
      generalBackdrop.setAttribute("aria-hidden", "false");
    }
    root.classList.add("is-general-open");
    if (boardMenuBtn) boardMenuBtn.setAttribute("aria-expanded", "true");
    void loadGeneralPanel();
    setGeneralTab(generalTab);
  }

  function closeGeneralPanel() {
    if (!generalPanel) return;
    generalPanel.hidden = true;
    if (generalBackdrop) {
      generalBackdrop.hidden = true;
      generalBackdrop.setAttribute("aria-hidden", "true");
    }
    root.classList.remove("is-general-open");
    if (boardMenuBtn) boardMenuBtn.setAttribute("aria-expanded", "false");
    if (boardMenuPop) boardMenuPop.hidden = true;
  }

  function closeBoardMenu() {
    if (boardMenuPop) boardMenuPop.hidden = true;
    if (boardMenuBtn) boardMenuBtn.setAttribute("aria-expanded", "false");
  }

  function populateShareTargetSelects() {
    if (shareUserSelect) {
      const current = shareUserSelect.value;
      shareUserSelect.innerHTML = '<option value="">Select a user…</option>';
      (shareTargets.users || []).forEach((u) => {
        if (shareDraft.users.some((row) => Number(row.user_id) === Number(u.id))) return;
        const opt = document.createElement("option");
        opt.value = String(u.id);
        opt.textContent = u.name || u.email || `User ${u.id}`;
        shareUserSelect.appendChild(opt);
      });
      if (current) shareUserSelect.value = current;
    }
    if (shareGroupSelect) {
      const current = shareGroupSelect.value;
      shareGroupSelect.innerHTML = '<option value="">Select a group…</option>';
      (shareTargets.groups || []).forEach((g) => {
        if (shareDraft.groups.some((row) => Number(row.group_id) === Number(g.id))) return;
        const opt = document.createElement("option");
        opt.value = String(g.id);
        opt.textContent = g.name
          ? `${g.name}${Number(g.member_count || 0) ? ` (${Number(g.member_count)} members)` : ""}`
          : `Group ${g.id}`;
        shareGroupSelect.appendChild(opt);
      });
      if (current) shareGroupSelect.value = current;
    }
  }

  function renderShareDraft() {
    if (!shareList) return;
    const rows = [
      ...(shareDraft.users || []).map((row) => ({ kind: "user", ...row })),
      ...(shareDraft.groups || []).map((row) => ({ kind: "group", ...row })),
    ];
    if (!rows.length) {
      shareList.innerHTML = '<p class="nc-detail-muted">No one else has been shared with yet.</p>';
      return;
    }
    shareList.innerHTML = rows
      .map((row) => {
        const key = row.kind === "user" ? `u-${row.user_id}` : `g-${row.group_id}`;
        const target = shareTargets.users.find((u) => Number(u.id) === Number(row.user_id))
          || shareTargets.groups.find((g) => Number(g.id) === Number(row.group_id))
          || {};
        const label = row.kind === "user"
          ? esc(target.name || target.email || `User ${row.user_id}`)
          : esc(target.name || `Group ${row.group_id}`);
        const sub = row.kind === "group" ? `<span class="nc-kanban-share-kind">Group</span>` : "";
        const editToggle = canManageShares
          ? `<label class="nc-kanban-share-edit"><input type="checkbox" data-share-edit="${esc(key)}" ${row.can_edit ? "checked" : ""}> Can edit</label>`
          : `<span class="nc-detail-muted">${row.can_edit ? "Can edit" : "View only"}</span>`;
        const removeBtn = canManageShares
          ? `<button type="button" class="nc-btn nc-btn-ghost nc-kanban-share-remove" data-share-remove="${esc(key)}" aria-label="Remove">×</button>`
          : "";
        return `<div class="nc-kanban-share-row" data-share-key="${esc(key)}">
          <div class="nc-kanban-share-main">
            <span class="nc-crm2-avatar is-blue">${esc(initials(label))}</span>
            <div><div class="nc-kanban-share-name">${label}</div>${sub}</div>
          </div>
          <div class="nc-kanban-share-actions">${editToggle}${removeBtn}</div>
        </div>`;
      })
      .join("");
    shareList.querySelectorAll("[data-share-edit]").forEach((input) => {
      input.addEventListener("change", () => {
        const key = input.getAttribute("data-share-edit") || "";
        const checked = !!input.checked;
        if (key.startsWith("u-")) {
          const uid = Number(key.slice(2));
          shareDraft.users = shareDraft.users.map((row) =>
            Number(row.user_id) === uid ? { ...row, can_edit: checked } : row
          );
        } else if (key.startsWith("g-")) {
          const gid = Number(key.slice(2));
          shareDraft.groups = shareDraft.groups.map((row) =>
            Number(row.group_id) === gid ? { ...row, can_edit: checked } : row
          );
        }
      });
    });
    shareList.querySelectorAll("[data-share-remove]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-share-remove") || "";
        if (key.startsWith("u-")) {
          const uid = Number(key.slice(2));
          shareDraft.users = shareDraft.users.filter((row) => Number(row.user_id) !== uid);
        } else if (key.startsWith("g-")) {
          const gid = Number(key.slice(2));
          shareDraft.groups = shareDraft.groups.filter((row) => Number(row.group_id) !== gid);
        }
        populateShareTargetSelects();
        renderShareDraft();
      });
    });
  }

  function applyShareTargets(payload) {
    if (!payload || typeof payload !== "object") return false;
    shareTargets = {
      users: Array.isArray(payload.users) ? payload.users : [],
      groups: Array.isArray(payload.groups) ? payload.groups : [],
    };
    return (shareTargets.users.length + shareTargets.groups.length) > 0;
  }

  async function loadShareTargets() {
    try {
      const targetsRes = await api(boardQuery(apiShareTargets));
      applyShareTargets(targetsRes);
      populateShareTargetSelects();
      renderShareDraft();
      return true;
    } catch (err) {
      setStatus(err.message || "Could not load users and groups for sharing.");
      return false;
    }
  }

  async function loadGeneralPanel() {
    try {
      const generalRes = await api(boardQuery(apiGeneral));
      const general = generalRes.general || {};
      shareDraft = {
        users: (general.shared_users || []).map((row) => ({
          user_id: Number(row.user_id),
          can_edit: !!row.can_edit,
        })),
        groups: (general.shared_groups || []).map((row) => ({
          group_id: Number(row.group_id),
          can_edit: !!row.can_edit,
        })),
      };
      if (!applyShareTargets(general.share_targets)) {
        if (general.can_manage_shares || canManageShares) {
          await loadShareTargets();
        }
      }
      if (deletedCountBadge) deletedCountBadge.textContent = String(general.deleted_count || 0);
      if (boardSettingsName) boardSettingsName.value = general.board_name || "";
      if (boardSettingsSubtitle) boardSettingsSubtitle.value = general.board_subtitle || "";
      if (boardSettingsName) boardSettingsName.readOnly = !general.can_edit_settings;
      if (boardSettingsSubtitle) boardSettingsSubtitle.readOnly = !general.can_edit_settings;
      if (boardSettingsSaveBtn) boardSettingsSaveBtn.hidden = !general.can_edit_settings;
      applyBoardMeta(general.board_name, general.board_subtitle);
      generalLoaded = true;
      populateShareTargetSelects();
      renderShareDraft();
    } catch (err) {
      setStatus(err.message || "Could not load general settings.");
    }
  }

  async function saveBoardSettings() {
    if (!canEdit || !boardSettingsName) return;
    const name = (boardSettingsName.value || "").trim();
    if (!name) {
      setStatus("Board name is required.");
      return;
    }
    const subtitle = (boardSettingsSubtitle && boardSettingsSubtitle.value || "").trim();
    try {
      const j = await api(apiBoard, {
        method: "PATCH",
        body: JSON.stringify({ name, subtitle }),
      });
      if (j.board) renderBoard(j.board);
      else applyBoardMeta(name, subtitle);
      if (j.general) {
        if (boardSettingsName) boardSettingsName.value = j.general.board_name || name;
        if (boardSettingsSubtitle) boardSettingsSubtitle.value = j.general.board_subtitle || subtitle;
      }
      setStatus("Board settings saved.");
      window.setTimeout(() => setStatus(""), 2000);
      if (generalTab === "activity") void loadBoardActivity();
    } catch (err) {
      setStatus(err.message || "Could not save board settings.");
    }
  }

  async function saveShares() {
    if (!canManageShares) return;
    try {
      const j = await api(boardQuery(apiShares), {
        method: "PUT",
        body: JSON.stringify(withBoardId(shareDraft)),
      });
      if (j.general && deletedCountBadge) deletedCountBadge.textContent = String(j.general.deleted_count || 0);
      shareDraft = {
        users: (j.general.shared_users || []).map((row) => ({
          user_id: Number(row.user_id),
          can_edit: !!row.can_edit,
        })),
        groups: (j.general.shared_groups || []).map((row) => ({
          group_id: Number(row.group_id),
          can_edit: !!row.can_edit,
        })),
      };
      populateShareTargetSelects();
      renderShareDraft();
      setStatus("Sharing saved.");
      if (generalTab === "activity") void loadBoardActivity();
    } catch (err) {
      setStatus(err.message || "Could not save sharing.");
    }
  }

  async function loadDeletedCards() {
    if (!deletedList) return;
    try {
      const j = await api(boardQuery(apiDeleted));
      const rows = j.cards || [];
      deletedList.innerHTML = rows
        .map(
          (card) => `<li class="nc-kanban-deleted-item">
            <div>
              <div class="nc-kanban-deleted-title">${esc(card.title || "Untitled")}</div>
              <div class="nc-kanban-deleted-meta">${esc(card.column_title || "Column")} · deleted ${esc(formatDue(card.deleted_at))}${card.deleted_by_name ? ` by ${esc(card.deleted_by_name)}` : ""}</div>
            </div>
            <div class="nc-kanban-deleted-actions">
              ${canEdit ? `<button type="button" class="nc-btn nc-btn-secondary nc-kanban-restore-btn" data-card-id="${esc(card.id)}">Restore</button>` : ""}
              ${canDelete ? `<button type="button" class="nc-btn nc-btn-ghost nc-kanban-purge-btn" data-card-id="${esc(card.id)}">Delete permanently</button>` : ""}
            </div>
          </li>`
        )
        .join("");
      if (deletedEmpty) deletedEmpty.hidden = rows.length > 0;
      if (deletedCountBadge) deletedCountBadge.textContent = String(rows.length);
      deletedList.querySelectorAll(".nc-kanban-restore-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const id = btn.getAttribute("data-card-id");
          if (!id) return;
          try {
            const j = await api(`/intranet/api/kanban/cards/${encodeURIComponent(id)}/restore`, { method: "POST" });
            renderBoard(j.board || {});
            void loadDeletedCards();
            if (generalTab === "activity") void loadBoardActivity();
          } catch (err) {
            setStatus(err.message || "Could not restore card.");
          }
        });
      });
      deletedList.querySelectorAll(".nc-kanban-purge-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const id = btn.getAttribute("data-card-id");
          if (!id) return;
          if (!window.confirm("Permanently delete this card? This cannot be undone.")) return;
          try {
            const j = await api(`/intranet/api/kanban/cards/${encodeURIComponent(id)}/purge`, { method: "DELETE" });
            renderBoard(j.board || {});
            void loadDeletedCards();
          } catch (err) {
            setStatus(err.message || "Could not delete card.");
          }
        });
      });
    } catch (err) {
      setStatus(err.message || "Could not load deleted cards.");
    }
  }

  async function loadBoardActivity() {
    if (!boardActivityList) return;
    try {
      const j = await api(boardQuery(apiBoardActivity));
      const rows = j.activity || [];
      boardActivityList.innerHTML = rows
        .map(
          (a) => `<li class="nc-kanban-activity">
            <span class="nc-crm2-avatar is-indigo">${esc(initials(a.user_name || "?"))}</span>
            <div>
              <div class="nc-kanban-activity-text"><strong>${esc(a.user_name || "Someone")}</strong> ${esc(boardActivityLabel(a))}</div>
              <div class="nc-kanban-activity-time">${esc(formatDue(a.created_at))}</div>
            </div>
          </li>`
        )
        .join("");
      if (boardActivityEmpty) boardActivityEmpty.hidden = rows.length > 0;
    } catch (err) {
      setStatus(err.message || "Could not load activity.");
    }
  }

  async function loadAssignees() {
    try {
      const j = await api(apiAssignees);
      assignees = j.users || [];
      populateAssigneeOptions(activeCard && activeCard.assignee_id, activeCard && activeCard.assignee_name);
      if (board) {
        syncBoardFiltersWithBoard(board);
        renderBoardFilterControls(board);
      }
    } catch (_) {
      assignees = [];
    }
  }

  async function openCardDialog(mode, columnId, cardSummary) {
    if (!cardDialog) return;
    dialogMode = mode;
    activeColumnId = columnId;
    activeCard = cardSummary || null;
    setTab("details");
    if (menuPop) menuPop.hidden = true;

    if (mode === "edit" && cardSummary && cardSummary.id) {
      try {
        activeCard = await loadCardDetail(cardSummary.id);
      } catch (err) {
        setStatus(err.message || "Could not load card.");
        return;
      }
    }

    fillDetailForm(activeCard || { title: "", column_id: columnId, priority: "medium", comments: [], attachments: [], activity: [] });
    cardDialog.showModal();
    if (titleInput && canEdit) {
      titleInput.focus();
      titleInput.select();
    }
  }

  function closeCardDialog() {
    if (cardDialog && cardDialog.open) cardDialog.close();
    activeCard = null;
    if (menuPop) menuPop.hidden = true;
  }

  async function saveDetails() {
    if (!canEdit) return;
    const title = (titleInput && titleInput.value || "").trim();
    if (!title) return;
    ensureQuill();
    const bodyHtml = quill ? quill.root.innerHTML : "";
    const payload = {
      title,
      body_html: bodyHtml,
      column_id: statusSelect ? Number(statusSelect.value) : activeColumnId,
      priority: prioritySelect ? prioritySelect.value : "medium",
      assignee_id: assigneeSelect && assigneeSelect.value ? Number(assigneeSelect.value) : null,
      due_at: localInputToIso(dueInput && dueInput.value),
    };
    try {
      let j;
      if (dialogMode === "edit" && activeCard && activeCard.id) {
        j = await api(`/intranet/api/kanban/cards/${encodeURIComponent(String(activeCard.id))}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
      } else {
        j = await api(apiCards, {
          method: "POST",
          body: JSON.stringify(withBoardId({ ...payload, column_id: activeColumnId || payload.column_id, title })),
        });
        dialogMode = "edit";
      }
      activeCard = j.card;
      if (j.board) renderBoard(j.board);
      closeCardDialog();
    } catch (err) {
      setStatus(err.message || "Could not save card.");
    }
  }

  async function unassignSelf() {
    if (!canEdit || !activeCard || !activeCard.id) return;
    try {
      await patchCard({ assignee_id: null });
      if (menuPop) menuPop.hidden = true;
    } catch (err) {
      setStatus(err.message || "Could not unassign.");
    }
  }

  async function clearDueDate() {
    if (!canEdit || !activeCard || !activeCard.id) return;
    if (dueInput) dueInput.value = "";
    try {
      await patchCard({ due_at: null });
      if (dueMenu) dueMenu.hidden = true;
    } catch (err) {
      setStatus(err.message || "Could not clear due date.");
    }
  }

  async function deleteActiveCard() {
    if (!activeCard || !activeCard.id) return;
    if (!window.confirm("Move this card to deleted items?")) return;
    try {
      const j = await api(`/intranet/api/kanban/cards/${encodeURIComponent(String(activeCard.id))}`, { method: "DELETE" });
      if (j.board) renderBoard(j.board);
      closeCardDialog();
      if (generalLoaded && deletedCountBadge) {
        const current = Number(deletedCountBadge.textContent || 0);
        deletedCountBadge.textContent = String(current + 1);
      }
      if (generalPanel && !generalPanel.hidden && generalTab === "deleted") void loadDeletedCards();
      if (generalPanel && !generalPanel.hidden && generalTab === "activity") void loadBoardActivity();
    } catch (err) {
      setStatus(err.message || "Could not delete card.");
    }
  }

  async function markDone() {
    if (!activeCard || !activeCard.id || !canEdit) return;
    try {
      const j = await api(`/intranet/api/kanban/cards/${encodeURIComponent(String(activeCard.id))}/done`, { method: "POST" });
      applyCardResponse(j);
      if (menuPop) menuPop.hidden = true;
    } catch (err) {
      setStatus(err.message || "Could not mark done.");
    }
  }

  async function postComment() {
    if (!activeCard || !activeCard.id) return;
    ensureCommentQuill();
    if (!commentQuill) return;
    const bodyHtml = commentQuill.root.innerHTML || "";
    const plain = (commentQuill.getText() || "").trim();
    const hasImage = /<img[\s>]/i.test(bodyHtml);
    if (!plain && !hasImage) return;
    try {
      const j = await api(`/intranet/api/kanban/cards/${encodeURIComponent(String(activeCard.id))}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: plain, body_html: bodyHtml }),
      });
      activeCard = j.card;
      resetCommentEditor();
      renderComments(activeCard);
      renderActivity(activeCard);
      if (j.board) renderBoard(j.board);
    } catch (err) {
      setStatus(err.message || "Could not post comment.");
    }
  }

  async function uploadAttachment(file) {
    if (!activeCard || !activeCard.id || !file) return;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const j = await api(`/intranet/api/kanban/cards/${encodeURIComponent(String(activeCard.id))}/attachments`, {
        method: "POST",
        body: fd,
      });
      activeCard = j.card;
      renderAttachments(activeCard);
      renderActivity(activeCard);
      if (j.board) renderBoard(j.board);
    } catch (err) {
      setStatus(err.message || "Could not upload attachment.");
      throw err;
    }
  }

  async function uploadAttachments(files) {
    const rows = (files || []).filter((f) => f && f.name);
    if (!rows.length) return;
    setStatus(rows.length > 1 ? `Uploading ${rows.length} files…` : "Uploading…");
    let failed = 0;
    for (const file of rows) {
      try {
        await uploadAttachment(file);
      } catch (_) {
        failed += 1;
      }
    }
    setStatus(failed ? `${failed} upload${failed === 1 ? "" : "s"} failed.` : "");
  }

  async function deleteBoardEntity() {
    if (!canDeleteBoard) return;
    const name = (board && board.name) || (generalBoardName && generalBoardName.textContent) || "this board";
    if (!window.confirm(`Delete "${name}" and all of its cards? This cannot be undone.`)) return;
    setStatus("Deleting board…");
    try {
      await api(apiBoardDelete, { method: "DELETE" });
      window.location.href = kanbanHomeUrl;
    } catch (err) {
      setStatus(err.message || "Could not delete board.");
    }
  }

  async function addColumn() {
    const title = window.prompt("Column name");
    if (!title || !title.trim()) return;
    try {
      const j = await api(apiColumns, { method: "POST", body: JSON.stringify(withBoardId({ title: title.trim() })) });
      renderBoard(j.board || {});
    } catch (err) {
      setStatus(err.message || "Could not add column.");
    }
  }

  function cardDropIndex(bodyEl, clientY) {
    const cards = Array.from(bodyEl.querySelectorAll(".nc-kanban-card:not(.is-dragging)"));
    for (let i = 0; i < cards.length; i += 1) {
      const rect = cards[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return i;
    }
    return cards.length;
  }

  document.querySelectorAll(".nc-kanban-detail-tab").forEach((btn) => {
    btn.addEventListener("click", () => setTab(btn.getAttribute("data-kanban-tab") || "details"));
  });

  if (saveDetailsBtn) saveDetailsBtn.addEventListener("click", () => void saveDetails());
  if (menuMarkDoneBtn) menuMarkDoneBtn.addEventListener("click", () => void markDone());
  if (menuUnassignBtn) menuUnassignBtn.addEventListener("click", () => void unassignSelf());
  if (menuActivityBtn) {
    menuActivityBtn.addEventListener("click", () => {
      setTab("activity");
      if (menuPop) menuPop.hidden = true;
    });
  }
  if (deleteBtn) deleteBtn.addEventListener("click", () => void deleteActiveCard());
  if (commentSubmit) commentSubmit.addEventListener("click", () => void postComment());
  if (addColumnBtn) addColumnBtn.addEventListener("click", addColumn);

  if (generalCloseBtn) generalCloseBtn.addEventListener("click", closeGeneralPanel);
  if (generalBackdrop) generalBackdrop.addEventListener("click", closeGeneralPanel);
  if (boardSettingsSaveBtn) boardSettingsSaveBtn.addEventListener("click", () => void saveBoardSettings());
  if (boardMenuBtn && boardMenuPop) {
    boardMenuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = boardMenuPop.hidden;
      closeBoardMenu();
      if (open) {
        boardMenuPop.hidden = false;
        boardMenuBtn.setAttribute("aria-expanded", "true");
      }
    });
    boardMenuPop.querySelectorAll("[data-board-menu]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.getAttribute("data-board-menu") || "settings";
        closeBoardMenu();
        if (tab === "delete") {
          void deleteBoardEntity();
          return;
        }
        openGeneralPanel(tab);
      });
    });
    document.addEventListener("click", (e) => {
      if (boardMenuPop.hidden) return;
      if (boardMenuPop.contains(e.target) || boardMenuBtn.contains(e.target)) return;
      closeBoardMenu();
    });
  }
  document.querySelectorAll(".nc-kanban-general-tab").forEach((btn) => {
    btn.addEventListener("click", () => setGeneralTab(btn.getAttribute("data-general-tab") || "sharing"));
  });
  if (shareUserAddBtn && shareUserSelect) {
    shareUserAddBtn.addEventListener("click", () => {
      const uid = Number(shareUserSelect.value || 0);
      if (!uid || shareDraft.users.some((row) => Number(row.user_id) === uid)) return;
      shareDraft.users.push({ user_id: uid, can_edit: true });
      shareUserSelect.value = "";
      populateShareTargetSelects();
      renderShareDraft();
    });
  }
  if (shareGroupAddBtn && shareGroupSelect) {
    shareGroupAddBtn.addEventListener("click", () => {
      const gid = Number(shareGroupSelect.value || 0);
      if (!gid || shareDraft.groups.some((row) => Number(row.group_id) === gid)) return;
      shareDraft.groups.push({ group_id: gid, can_edit: true });
      shareGroupSelect.value = "";
      populateShareTargetSelects();
      renderShareDraft();
    });
  }
  if (sharesSaveBtn) sharesSaveBtn.addEventListener("click", () => void saveShares());

  if (filterProgressBtn && filterProgressPop) {
    filterProgressBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleBoardFilterPop(filterProgressBtn, filterProgressPop);
    });
  }
  if (filterPriorityBtn && filterPriorityPop) {
    filterPriorityBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleBoardFilterPop(filterPriorityBtn, filterPriorityPop);
    });
  }
  if (filterAssigneeBtn && filterAssigneePop) {
    filterAssigneeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleBoardFilterPop(filterAssigneeBtn, filterAssigneePop);
    });
  }
  [filterProgressOptions, filterPriorityOptions, filterAssigneeOptions].forEach((container) => {
    if (!container) return;
    container.addEventListener("change", onBoardFilterCheckboxChange);
  });
  if (filterClearBtn) filterClearBtn.addEventListener("click", clearBoardFilters);
  document.addEventListener("click", (e) => {
    if (!openFilterPop) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (openFilterPop.contains(target)) return;
    if (
      (filterProgressBtn && filterProgressBtn.contains(target))
      || (filterPriorityBtn && filterPriorityBtn.contains(target))
      || (filterAssigneeBtn && filterAssigneeBtn.contains(target))
    ) return;
    closeBoardFilterPop();
  });

  if (statusSelect) {
    statusSelect.addEventListener("change", () => {
      renderStatusPill(statusSelect.value);
      if (activeCard) updateMenuState({ ...activeCard, column_id: Number(statusSelect.value) });
    });
  }
  if (prioritySelect) {
    prioritySelect.addEventListener("change", () => {
      renderPriorityPill(prioritySelect.value);
    });
  }
  if (assigneeSelect) {
    assigneeSelect.addEventListener("change", () => {
      const id = assigneeSelect.value ? Number(assigneeSelect.value) : 0;
      const user = assignees.find((u) => Number(u.id) === id);
      renderAssigneePill(id, user && user.name);
      if (activeCard) updateMenuState({ ...activeCard, assignee_id: id || null });
    });
  }
  if (assigneeClearBtn) {
    assigneeClearBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (assigneeSelect) assigneeSelect.value = "";
      renderAssigneePill(0, "");
      if (activeCard) updateMenuState({ ...activeCard, assignee_id: null });
    });
  }
  if (dueMoreBtn && dueMenu) {
    dueMoreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      dueMenu.hidden = !dueMenu.hidden;
    });
  }
  if (dueClearBtn) dueClearBtn.addEventListener("click", () => void clearDueDate());
  if (menuBtn && menuPop) {
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      menuPop.hidden = !menuPop.hidden;
      if (dueMenu) dueMenu.hidden = true;
    });
    document.addEventListener("click", () => {
      if (menuPop) menuPop.hidden = true;
      if (dueMenu) dueMenu.hidden = true;
    });
  }
  if (attachmentInput) {
    attachmentInput.addEventListener("change", () => {
      const files = attachmentInput.files ? Array.from(attachmentInput.files) : [];
      if (files.length) void uploadAttachments(files);
      attachmentInput.value = "";
    });
  }

  if (attachmentDropzone && canEdit) {
    let dropDepth = 0;
    const setDropHighlight = (on) => attachmentDropzone.classList.toggle("is-dragover", !!on);

    attachmentDropzone.addEventListener("dragenter", (e) => {
      e.preventDefault();
      dropDepth += 1;
      setDropHighlight(true);
    });
    attachmentDropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    });
    attachmentDropzone.addEventListener("dragleave", (e) => {
      e.preventDefault();
      dropDepth -= 1;
      if (dropDepth <= 0) {
        dropDepth = 0;
        setDropHighlight(false);
      }
    });
    attachmentDropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropDepth = 0;
      setDropHighlight(false);
      const files = e.dataTransfer && e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
      if (files.length) void uploadAttachments(files);
    });
  }
  if (cardDialog) {
    cardDialog.querySelectorAll("[data-kanban-close]").forEach((btn) => {
      btn.addEventListener("click", closeCardDialog);
    });
    cardDialog.addEventListener("click", (e) => {
      if (e.target === cardDialog) closeCardDialog();
    });
  }

  document.addEventListener("dragstart", (e) => {
    if (!canEdit) return;
    const card = e.target && e.target.closest ? e.target.closest(".nc-kanban-card[data-card-id]") : null;
    if (!card || !boardEl.contains(card)) return;
    const id = card.getAttribute("data-card-id") || "";
    if (!id) return;
    card.classList.add("is-dragging");
    try {
      e.dataTransfer.setData(DND_TYPE, id);
      e.dataTransfer.setData("text/plain", id);
      e.dataTransfer.effectAllowed = "move";
    } catch (_) {}
  });

  document.addEventListener("dragend", (e) => {
    const card = e.target && e.target.closest ? e.target.closest(".nc-kanban-card.is-dragging") : null;
    if (card) card.classList.remove("is-dragging");
    boardEl.querySelectorAll(".nc-kanban-col-body.is-dropover").forEach((el) => el.classList.remove("is-dropover"));
  });

  document.addEventListener("dragover", (e) => {
    if (!canEdit) return;
    const body = e.target && e.target.closest ? e.target.closest(".nc-kanban-col-body[data-column-id]") : null;
    if (!body || !boardEl.contains(body)) return;
    const types = Array.from(e.dataTransfer.types || []);
    if (!types.includes(DND_TYPE) && !types.includes("text/plain")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    boardEl.querySelectorAll(".nc-kanban-col-body.is-dropover").forEach((el) => {
      if (el !== body) el.classList.remove("is-dropover");
    });
    body.classList.add("is-dropover");
  });

  document.addEventListener("dragleave", (e) => {
    const body = e.target && e.target.closest ? e.target.closest(".nc-kanban-col-body.is-dropover") : null;
    if (!body) return;
    const rt = e.relatedTarget;
    if (!body.contains(rt instanceof Node ? rt : null)) body.classList.remove("is-dropover");
  });

  document.addEventListener("drop", async (e) => {
    if (!canEdit) return;
    const body = e.target && e.target.closest ? e.target.closest(".nc-kanban-col-body[data-column-id]") : null;
    if (!body || !boardEl.contains(body)) return;
    body.classList.remove("is-dropover");
    let cardId = "";
    try {
      cardId = String(e.dataTransfer.getData(DND_TYPE) || e.dataTransfer.getData("text/plain") || "").trim();
    } catch (_) {
      cardId = "";
    }
    if (!cardId) return;
    e.preventDefault();
    const columnId = body.getAttribute("data-column-id");
    const position = cardDropIndex(body, e.clientY);
    try {
      const j = await api(`/intranet/api/kanban/cards/${encodeURIComponent(cardId)}/move`, {
        method: "PATCH",
        body: JSON.stringify({ column_id: Number(columnId), position }),
      });
      renderBoard(j.board || {});
    } catch (err) {
      setStatus(err.message || "Could not move card.");
      void loadBoard();
    }
  });

  void loadAssignees();
  void loadBoard().then(() => {
    const params = new URLSearchParams(window.location.search);
    const cardId = Number(params.get("card") || 0);
    if (!cardId) return;
    void loadCardDetail(cardId)
      .then((card) => openCardDialog("edit", card.column_id, card))
      .catch(() => {});
  });
})();
