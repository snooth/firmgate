(function () {
  "use strict";

  let creating = false;

  function setStatus(statusEl, msg) {
    if (statusEl) statusEl.textContent = msg || "";
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function api(url, opts) {
    const r = await fetch(url, {
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      ...opts,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Request failed");
    return j;
  }

  function renderBoards(grid, emptyEl, boards) {
    const rows = Array.isArray(boards) ? boards : [];
    grid.innerHTML = "";
    if (!rows.length) {
      if (emptyEl) emptyEl.hidden = false;
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
    rows.forEach((board) => {
      const card = document.createElement("article");
      card.className = "nc-kanban-home-card";

      const link = document.createElement("a");
      link.className = "nc-kanban-home-card-link";
      link.href = board.url || `/intranet/kanban/board/${encodeURIComponent(String(board.id))}`;
      link.innerHTML = `
        <div class="nc-kanban-home-card-head">
          <h3>${escapeHtml(board.name || "Board")}</h3>
          <span class="nc-kanban-home-card-stat">${Number(board.open_count || 0)} open</span>
        </div>
        <p class="nc-kanban-home-card-sub">${escapeHtml(board.subtitle || "")}</p>
        <div class="nc-kanban-home-card-meta">
          <span>${Number(board.card_count || 0)} cards</span>
          <span>${Number(board.column_count || 0)} columns</span>
          <span>${Number(board.done_count || 0)} done</span>
        </div>
      `;
      card.appendChild(link);

      grid.appendChild(card);
    });
  }

  async function loadBoards(root, statusEl, grid, emptyEl) {
    const apiBoards = root.dataset.apiBoards || "/intranet/api/kanban/boards";
    setStatus(statusEl, "Loading boards…");
    try {
      const j = await api(apiBoards);
      renderBoards(grid, emptyEl, j.boards || []);
      setStatus(statusEl, "");
    } catch (e) {
      setStatus(statusEl, e.message || "Could not load boards.");
    }
  }

  function initKanbanHome() {
    const root = document.getElementById("nc-kanban-home");
    if (!root || root.dataset.ncKanbanHomeWired === "1") return;
    root.dataset.ncKanbanHomeWired = "1";

    const grid = document.getElementById("nc-kanban-home-grid");
    const statusEl = document.getElementById("nc-kanban-home-status");
    const emptyEl = document.getElementById("nc-kanban-home-empty");
    const createBtn = document.getElementById("nc-kanban-create-board");
    const createDialog = document.getElementById("nc-kanban-create-dialog");
    const createForm = document.getElementById("nc-kanban-create-form");
    const createCancel = document.getElementById("nc-kanban-create-cancel");
    const createName = document.getElementById("nc-kanban-create-name");
    const createSubtitle = document.getElementById("nc-kanban-create-subtitle");
    const createSubmitBtn = createForm
      ? createForm.querySelector('button[type="submit"]')
      : null;

    if (!grid) return;

    const apiBoards = root.dataset.apiBoards || "/intranet/api/kanban/boards";
    const canCreate = root.dataset.canCreate === "1";

    function openCreateDialog() {
      if (!createDialog) return;
      if (createName) createName.value = "";
      if (createSubtitle) createSubtitle.value = "";
      createDialog.showModal();
      if (createName) createName.focus();
    }

    function closeCreateDialog() {
      if (createDialog && createDialog.open) createDialog.close();
    }

    async function submitCreate(ev) {
      ev.preventDefault();
      if (creating) return;
      const name = createName ? createName.value.trim() : "";
      if (!name) return;
      const subtitle = createSubtitle ? createSubtitle.value.trim() : "";
      creating = true;
      if (createSubmitBtn) createSubmitBtn.disabled = true;
      setStatus(statusEl, "Creating board…");
      try {
        const j = await api(apiBoards, {
          method: "POST",
          body: JSON.stringify({ name, subtitle: subtitle || undefined }),
        });
        closeCreateDialog();
        const board = j.board || {};
        if (board.url) {
          window.location.href = board.url;
          return;
        }
        if (board.id) {
          window.location.href = `/intranet/kanban/board/${encodeURIComponent(String(board.id))}`;
          return;
        }
        await loadBoards(root, statusEl, grid, emptyEl);
      } catch (e) {
        setStatus(statusEl, e.message || "Could not create board.");
      } finally {
        creating = false;
        if (createSubmitBtn) createSubmitBtn.disabled = false;
      }
    }

    if (createBtn && canCreate) createBtn.addEventListener("click", openCreateDialog);
    if (createCancel) createCancel.addEventListener("click", closeCreateDialog);
    if (createForm) createForm.addEventListener("submit", submitCreate);

    void loadBoards(root, statusEl, grid, emptyEl);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initKanbanHome);
  } else {
    initKanbanHome();
  }
  document.addEventListener("turbo:load", initKanbanHome);
})();
