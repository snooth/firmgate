(function () {
  const PIECES = {
    K: "\u2654",
    Q: "\u2655",
    R: "\u2656",
    B: "\u2657",
    N: "\u2658",
    P: "\u2659",
    k: "\u265A",
    q: "\u265B",
    r: "\u265C",
    b: "\u265D",
    n: "\u265E",
    p: "\u265F",
  };

  function apiBase(el) {
    const b = (el && el.getAttribute("data-api-base")) || "/intranet/api/chess";
    return b.replace(/\/$/, "");
  }

  async function apiJson(url, opts) {
    const res = await fetch(url, {
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || res.statusText || "Request failed");
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function setStatus(el, msg, isErr) {
    if (!el) return;
    el.textContent = msg || "";
    el.classList.toggle("nc-status--error", !!isErr);
  }

  function statusLabel(st) {
    if (st === "waiting") return "Waiting for opponent";
    if (st === "active") return "In progress";
    if (st === "finished") return "Finished";
    return st || "";
  }

  function resultText(game) {
    if (game.status !== "finished") return "";
    const r = game.result;
    if (r === "draw") return "Draw";
    if (r === "w") return "White wins";
    if (r === "b") return "Black wins";
    return game.end_reason || "Game over";
  }

  function parseFenBoard(fen) {
    const part = (fen || "").split(" ")[0] || "";
    const rows = part.split("/");
    const grid = [];
    for (let r = 0; r < 8; r++) {
      const row = [];
      const line = rows[r] || "";
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch >= "1" && ch <= "8") {
          for (let e = 0; e < parseInt(ch, 10); e++) row.push("");
        } else {
          row.push(ch);
        }
      }
      while (row.length < 8) row.push("");
      grid.push(row.slice(0, 8));
    }
    return grid;
  }

  function squareName(file, rank) {
    return String.fromCharCode(97 + file) + String(rank + 1);
  }

  function initLobby() {
    const root = document.getElementById("nc-game-lobby");
    if (!root) return;

    const base = apiBase(root);
    const statusEl = document.getElementById("chess-lobby-status");
    const listEl = document.getElementById("chess-games-list");
    const joinInput = document.getElementById("chess-join-code");

    function chatUnreadBadge(n) {
      const total = Math.max(0, Number(n) || 0);
      if (total <= 0) return "";
      const shown = total > 99 ? "99+" : String(total);
      const label = `${total} unread chat message${total === 1 ? "" : "s"}`;
      return `<span class="nc-game-list-chat-badge" aria-label="${escapeHtml(label)}">${escapeHtml(shown)}</span>`;
    }

    async function loadGames() {
      try {
        const data = await apiJson(`${base}/games`);
        const games = data.games || [];
        if (!games.length) {
          listEl.innerHTML = '<p class="nc-detail-muted">No games yet. Start one above.</p>';
          return;
        }
        listEl.innerHTML = games
          .map((g) => {
            const vs = `${escapeHtml(g.white_name || "—")} vs ${escapeHtml(g.black_name || "—")}`;
            const badge = statusLabel(g.status);
            const res = g.result ? ` · ${escapeHtml(g.result)}` : "";
            const unread = Number(g.unread_chat) || 0;
            const unreadRow = unread
              ? `<span class="nc-game-list-chat-hint">New chat</span>${chatUnreadBadge(unread)}`
              : "";
            return `<a class="nc-game-list-item${unread ? " nc-game-list-item--unread-chat" : ""}" href="${escapeHtml(g.url)}">
              <span class="nc-game-list-main">${vs}${unreadRow}</span>
              <span class="nc-game-list-meta">${escapeHtml(badge)}${res}</span>
              <span class="nc-game-list-code"><span class="nc-game-list-code-label">Game Code:</span> <code>${escapeHtml(g.id)}</code></span>
            </a>`;
          })
          .join("");
      } catch (e) {
        listEl.innerHTML = '<p class="nc-detail-muted">Could not load games.</p>';
        setStatus(statusEl, e.message, true);
      }
    }

    window.ncChessLobbyRefresh = loadGames;

    async function createGame(color) {
      setStatus(statusEl, "Creating game…");
      try {
        const data = await apiJson(`${base}/games`, {
          method: "POST",
          body: JSON.stringify({ color }),
        });
        const id = data.game && data.game.id;
        if (id) window.location.href = `/intranet/game/chess/${id}`;
        else setStatus(statusEl, "Created but no game id returned.", true);
      } catch (e) {
        setStatus(statusEl, e.message, true);
      }
    }

    async function joinByCode() {
      const code = (joinInput && joinInput.value.trim()) || "";
      if (!code) {
        setStatus(statusEl, "Enter a game code.", true);
        return;
      }
      setStatus(statusEl, "Joining…");
      try {
        await apiJson(`${base}/games/${encodeURIComponent(code)}/join`, { method: "POST", body: "{}" });
        window.location.href = `/intranet/game/chess/${encodeURIComponent(code)}`;
      } catch (e) {
        setStatus(statusEl, e.message, true);
      }
    }

    document.getElementById("chess-new-game")?.addEventListener("click", () => {
      const color = Math.random() < 0.5 ? "white" : "black";
      createGame(color);
    });
    document.getElementById("chess-join-btn")?.addEventListener("click", joinByCode);
    joinInput?.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") joinByCode();
    });

    loadGames();
    if (!window.ncChessLobbyPoll) {
      window.ncChessLobbyPoll = window.setInterval(() => loadGames().catch(() => {}), 5000);
    }
  }

  function initBoardPage() {
    const root = document.getElementById("nc-chess-app");
    if (!root) return;

    const gameId = (root.getAttribute("data-game-id") || "").trim();
    const base = apiBase(root);
    const boardEl = document.getElementById("chess-board");
    const statusEl = document.getElementById("chess-game-status");
    const bannerEl = document.getElementById("chess-status-banner");
    const movesEl = document.getElementById("chess-moves");
    const joinBtn = document.getElementById("chess-join-game");
    const resignBtn = document.getElementById("chess-resign");
    const copyBtn = document.getElementById("chess-copy-link");
    const chatMessagesEl = document.getElementById("chess-chat-messages");
    const chatForm = document.getElementById("chess-chat-form");
    const chatInput = document.getElementById("chess-chat-input");
    const chatHint = document.getElementById("chess-chat-hint");
    const meId = Number(root.getAttribute("data-me-id") || 0);

    let state = null;
    let selected = null;
    let pollTimer = null;
    let drag = null;
    let boardPointerBound = false;
    let lastRenderedFen = "";
    let lastRenderedFlip = false;
    let chatMessages = [];
    let lastChatId = 0;
    let chatPollTimer = null;
    let chatStickBottom = true;
    let clockTimer = null;

    function formatDurationMs(ms) {
      const n = Math.max(0, Number(ms) || 0);
      const totalSec = Math.floor(n / 1000);
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      if (h) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
      return `${m}:${String(s).padStart(2, "0")}`;
    }

    function liveClockMs(color) {
      if (!state) return 0;
      const side = color === "w" ? state.white : state.black;
      const base = Number((side && side.total_ms) || 0);
      if (state.status !== "active" || state.turn !== color) {
        return Number((side && side.clock_ms) ?? base);
      }
      const anchor = state.last_move_at || state.started_at;
      if (!anchor) return base;
      const t0 = Date.parse(anchor);
      if (Number.isNaN(t0)) return base;
      return base + Math.max(0, Date.now() - t0);
    }

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function flipBoard() {
      return state && state.viewer_color === "b";
    }

    function canMove() {
      return !!(state && state.status === "active" && state.is_your_turn);
    }

    function pieceAtSquare(sq) {
      if (!state || !sq) return "";
      const grid = parseFenBoard(state.fen);
      const file = sq.charCodeAt(0) - 97;
      const fenRow = 8 - parseInt(sq[1], 10);
      return (grid[fenRow] && grid[fenRow][file]) || "";
    }

    function pieceIsMine(piece) {
      if (!piece || !state) return false;
      const vc = state.viewer_color;
      const white = piece === piece.toUpperCase();
      return (vc === "w" && white) || (vc === "b" && !white);
    }

    function buildUci(fromSq, toSq) {
      let uci = fromSq + toSq;
      const piece = pieceAtSquare(fromSq);
      const toChessRank = parseInt(toSq[1], 10);
      if (piece && piece.toUpperCase() === "P" && (toChessRank === 1 || toChessRank === 8)) {
        uci += "q";
      }
      return uci;
    }

    function squareUnderPointer(clientX, clientY) {
      const el = document.elementFromPoint(clientX, clientY);
      const cell = el && el.closest ? el.closest("[data-sq]") : null;
      return cell ? cell.dataset.sq : null;
    }

    function clearDragHighlight() {
      if (!boardEl) return;
      boardEl.classList.remove("is-dragging");
      boardEl.querySelectorAll(".is-drag-source, .is-drop-hint").forEach((n) => {
        n.classList.remove("is-drag-source", "is-drop-hint");
      });
    }

    function endDrag() {
      if (drag && drag.ghost && drag.ghost.parentNode) {
        drag.ghost.parentNode.removeChild(drag.ghost);
      }
      drag = null;
      clearDragHighlight();
    }

    function moveGhost(clientX, clientY) {
      if (!drag || !drag.ghost) return;
      drag.ghost.style.left = `${clientX}px`;
      drag.ghost.style.top = `${clientY}px`;
    }

    function updateDropHint(clientX, clientY) {
      if (!boardEl || !drag) return;
      const sq = squareUnderPointer(clientX, clientY);
      boardEl.querySelectorAll(".is-drop-hint").forEach((n) => n.classList.remove("is-drop-hint"));
      if (sq && sq !== drag.fromSq) {
        const cell = boardEl.querySelector(`[data-sq="${sq}"]`);
        if (cell) cell.classList.add("is-drop-hint");
      }
    }

    function bindBoardPointerEvents() {
      if (!boardEl || boardPointerBound) return;
      boardPointerBound = true;

      boardEl.addEventListener("pointerdown", (ev) => {
        if (!canMove() || ev.button !== 0) return;
        const cell = ev.target.closest("[data-sq]");
        if (!cell) return;
        const sq = cell.dataset.sq;
        const piece = pieceAtSquare(sq);
        if (!pieceIsMine(piece)) {
          onSquareClick(sq);
          return;
        }
        ev.preventDefault();
        const pieceEl = cell.querySelector(".nc-chess-piece");
        const ghost = document.createElement("div");
        ghost.className = "nc-chess-drag-ghost " + (pieceEl ? pieceEl.className : "nc-chess-piece");
        ghost.textContent = pieceEl ? pieceEl.textContent : PIECES[piece] || piece;
        document.body.appendChild(ghost);
        drag = {
          fromSq: sq,
          startX: ev.clientX,
          startY: ev.clientY,
          moved: false,
          ghost,
          pointerId: ev.pointerId,
        };
        cell.classList.add("is-drag-source");
        boardEl.classList.add("is-dragging");
        moveGhost(ev.clientX, ev.clientY);
        try {
          cell.setPointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
      });

      boardEl.addEventListener("pointermove", (ev) => {
        if (!drag || ev.pointerId !== drag.pointerId) return;
        const dx = ev.clientX - drag.startX;
        const dy = ev.clientY - drag.startY;
        if (!drag.moved && dx * dx + dy * dy > 36) drag.moved = true;
        if (drag.moved) {
          ev.preventDefault();
          moveGhost(ev.clientX, ev.clientY);
          updateDropHint(ev.clientX, ev.clientY);
        }
      });

      const finishDrag = (ev) => {
        if (!drag || ev.pointerId !== drag.pointerId) return;
        const fromSq = drag.fromSq;
        const wasDrag = drag.moved;
        const toSq = wasDrag ? squareUnderPointer(ev.clientX, ev.clientY) : null;
        endDrag();
        try {
          boardEl.releasePointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
        if (wasDrag && toSq && toSq !== fromSq) {
          selected = null;
          sendMove(buildUci(fromSq, toSq));
        } else if (!wasDrag) {
          onSquareClick(fromSq);
        }
      };

      boardEl.addEventListener("pointerup", finishDrag);
      boardEl.addEventListener("pointercancel", finishDrag);
    }

    function updateSelectionHighlight() {
      if (!boardEl) return;
      boardEl.querySelectorAll(".nc-chess-square").forEach((cell) => {
        cell.classList.toggle("is-selected", cell.dataset.sq === selected);
      });
    }

    function renderBoard() {
      if (!boardEl || !state) return;
      const flipped = flipBoard();
      if (
        state.fen === lastRenderedFen &&
        flipped === lastRenderedFlip &&
        boardEl.childElementCount === 64
      ) {
        updateSelectionHighlight();
        return;
      }
      lastRenderedFen = state.fen;
      lastRenderedFlip = flipped;
      const grid = parseFenBoard(state.fen);
      boardEl.innerHTML = "";
      boardEl.classList.toggle("nc-chess-board--flipped", flipped);

      for (let displayRow = 0; displayRow < 8; displayRow++) {
        for (let displayCol = 0; displayCol < 8; displayCol++) {
          const fenRow = flipped ? 7 - displayRow : displayRow;
          const file = flipped ? 7 - displayCol : displayCol;
          const piece = grid[fenRow][file];
          const sq = squareName(file, 7 - fenRow);
          const light = (fenRow + file) % 2 === 0;
          const cell = document.createElement("button");
          cell.type = "button";
          cell.className = "nc-chess-square" + (light ? " nc-chess-square--light" : " nc-chess-square--dark");
          cell.dataset.sq = sq;
          if (selected === sq) cell.classList.add("is-selected");
          if (piece) {
            const span = document.createElement("span");
            span.className = "nc-chess-piece" + (piece === piece.toUpperCase() ? " nc-chess-piece--w" : " nc-chess-piece--b");
            span.textContent = PIECES[piece] || piece;
            span.draggable = false;
            cell.appendChild(span);
          }
          if (canMove() && pieceIsMine(piece)) {
            cell.classList.add("nc-chess-square--draggable");
          }
          boardEl.appendChild(cell);
        }
      }
      bindBoardPointerEvents();
    }

    function renderMeta() {
      if (!state) return;
      const w = state.white || {};
      const b = state.black || {};
      const vc = state.viewer_color;
      const set = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
      };

      root.dataset.viewerColor = vc || "";

      const opponent = vc === "w" ? b : vc === "b" ? w : null;
      const you = vc === "w" ? w : vc === "b" ? b : null;
      const opponentColor = vc === "w" ? "Black" : vc === "b" ? "White" : "—";
      const yourColor = vc === "w" ? "White" : vc === "b" ? "Black" : "—";

      const oppColorKey = vc === "w" ? "b" : vc === "b" ? "w" : null;
      const yourColorKey = vc === "w" ? "w" : vc === "b" ? "b" : null;
      const oppMs = oppColorKey ? liveClockMs(oppColorKey) : Number(w.clock_ms ?? w.total_ms ?? 0);
      const youMs = yourColorKey ? liveClockMs(yourColorKey) : Number(b.clock_ms ?? b.total_ms ?? 0);

      if (opponent && you) {
        set("chess-opponent-chip", opponentColor);
        set("chess-opponent-name", opponent.name || "—");
        set("chess-opponent-total", formatDurationMs(oppMs));
        set("chess-you-chip", yourColor);
        set("chess-you-name", you.name || "—");
        set("chess-you-total", formatDurationMs(youMs));
      } else {
        set("chess-opponent-chip", "White");
        set("chess-opponent-name", w.name || "—");
        set("chess-opponent-total", formatDurationMs(liveClockMs("w")));
        set("chess-you-chip", "Black");
        set("chess-you-name", b.name || "Waiting…");
        set("chess-you-total", formatDurationMs(liveClockMs("b")));
      }

      set("chess-game-total", state.total_game_display || "0:00");

      const youRole = document.getElementById("chess-you-role");
      const youPiece = document.getElementById("chess-you-piece");
      const youColorLabel = document.getElementById("chess-you-color-label");
      const yourClock = document.getElementById("chess-clock-you");
      const oppClock = document.getElementById("chess-clock-opponent");
      if (youRole) {
        if (vc === "w" || vc === "b") {
          youRole.hidden = false;
          youRole.classList.toggle("nc-chess-you-role--white", vc === "w");
          youRole.classList.toggle("nc-chess-you-role--black", vc === "b");
          if (youColorLabel) youColorLabel.textContent = yourColor;
          if (youPiece) youPiece.textContent = vc === "w" ? "\u2654" : "\u265A";
        } else {
          youRole.hidden = true;
        }
      }
      if (yourClock) {
        yourClock.hidden = !(vc === "w" || vc === "b");
        yourClock.classList.toggle("nc-chess-clock-bar--active-turn", !!state.is_your_turn);
      }
      if (oppClock) {
        const oppTurn =
          state.status === "active" &&
          (vc === "w" || vc === "b") &&
          ((state.turn === "w" && vc === "b") || (state.turn === "b" && vc === "w"));
        oppClock.classList.toggle("nc-chess-clock-bar--active-turn", oppTurn);
      }
      const oppChip = document.getElementById("chess-opponent-chip");
      if (oppChip) {
        oppChip.classList.toggle("nc-chess-clock-chip--white", opponentColor === "White");
        oppChip.classList.toggle("nc-chess-clock-chip--black", opponentColor === "Black");
      }
      const youChip = document.getElementById("chess-you-chip");
      if (youChip) {
        youChip.classList.toggle("nc-chess-clock-chip--white", yourColor === "White");
        youChip.classList.toggle("nc-chess-clock-chip--black", yourColor === "Black");
      }
      root.classList.toggle("nc-chess-page--playing", !!(vc === "w" || vc === "b"));
      root.classList.toggle("nc-chess-page--white", vc === "w");
      root.classList.toggle("nc-chess-page--black", vc === "b");

      if (bannerEl) {
        const parts = [statusLabel(state.status)];
        const res = resultText(state);
        if (res) parts.push(res);
        if (state.is_your_turn) parts.push("Your turn");
        bannerEl.textContent = parts.join(" · ");
        bannerEl.hidden = !parts.filter(Boolean).length;
        bannerEl.classList.toggle("nc-chess-banner--turn", !!state.is_your_turn);
      }

      if (movesEl) {
        const moves = state.moves || [];
        if (!moves.length) {
          movesEl.innerHTML = '<li class="nc-detail-muted">No moves yet.</li>';
        } else {
          movesEl.innerHTML = moves
            .map((m) => {
              const num = Math.ceil(m.ply / 2);
              const prefix = m.ply % 2 === 1 ? `${num}.` : `${num}…`;
              return `<li><span class="nc-chess-move-num">${escapeHtml(prefix)}</span> <strong>${escapeHtml(m.san)}</strong> <span class="nc-chess-move-meta">${escapeHtml(m.by)} · ${escapeHtml(m.think_display)}</span></li>`;
            })
            .join("");
        }
      }

      if (joinBtn) joinBtn.hidden = !state.can_join;
      if (resignBtn) {
        const playing = state.viewer_color && state.status === "active";
        resignBtn.hidden = !playing;
      }

      updateChatUi();
    }

    function formatChatTime(iso) {
      if (!iso) return "";
      try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return "";
        return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      } catch (_) {
        return "";
      }
    }

    function updateChatUi() {
      const canChat = !!(state && state.can_chat);
      if (chatForm) chatForm.classList.toggle("is-disabled", !canChat);
      if (chatInput) chatInput.disabled = !canChat;
      if (chatHint) {
        chatHint.textContent = canChat
          ? "Message your opponent."
          : state && state.can_join
            ? "Join the game to chat."
            : "Chat is available to players in this game.";
      }
    }

    function renderChat() {
      if (!chatMessagesEl) return;
      if (!chatMessages.length) {
        chatMessagesEl.innerHTML = '<p class="nc-chess-chat-empty">No messages yet. Say hello!</p>';
        return;
      }
      const atBottom =
        chatMessagesEl.scrollHeight - chatMessagesEl.scrollTop - chatMessagesEl.clientHeight < 48;
      chatMessagesEl.innerHTML = chatMessages
        .map((m) => {
          const mine = Number(m.from && m.from.id) === meId;
          return `<div class="nc-chess-chat-bubble${mine ? " nc-chess-chat-bubble--mine" : ""}">
            <div class="nc-chess-chat-meta"><span>${escapeHtml((m.from && m.from.name) || "Player")}</span><span>${escapeHtml(formatChatTime(m.at))}</span></div>
            <div class="nc-chess-chat-text">${escapeHtml(m.text || "")}</div>
          </div>`;
        })
        .join("");
      if (chatStickBottom || atBottom) {
        chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
        chatStickBottom = true;
      }
    }

    async function loadChat() {
      if (!gameId || !state || !state.can_chat) return;
      try {
        const j = await apiJson(
          `${base}/games/${encodeURIComponent(gameId)}/chat?after_id=${encodeURIComponent(String(lastChatId || 0))}`,
          { method: "GET" }
        );
        const msgs = (j && j.messages) || [];
        if (msgs.length) {
          msgs.forEach((m) => {
            chatMessages.push(m);
            const idNum = Number(m.id) || 0;
            if (idNum > lastChatId) lastChatId = idNum;
          });
          renderChat();
        }
        if (window.ncChessNavBadge && typeof window.ncChessNavBadge.refresh === "function") {
          window.ncChessNavBadge.refresh();
        }
      } catch (_) {
        /* ignore */
      }
    }

    async function sendChatMessage(text) {
      const body = String(text || "").trim();
      if (!body || !state || !state.can_chat) return;
      try {
        const j = await apiJson(`${base}/games/${encodeURIComponent(gameId)}/chat`, {
          method: "POST",
          body: JSON.stringify({ text: body }),
        });
        const m = j && j.message;
        if (m) {
          chatMessages.push(m);
          const idNum = Number(m.id) || 0;
          if (idNum > lastChatId) lastChatId = idNum;
          chatStickBottom = true;
          renderChat();
        }
        if (chatInput) chatInput.value = "";
        if (window.ncChessNavBadge && typeof window.ncChessNavBadge.refresh === "function") {
          window.ncChessNavBadge.refresh();
        }
      } catch (e) {
        setStatus(statusEl, e.message, true);
      }
    }

    if (chatMessagesEl) {
      chatMessagesEl.addEventListener("scroll", () => {
        chatStickBottom =
          chatMessagesEl.scrollHeight - chatMessagesEl.scrollTop - chatMessagesEl.clientHeight < 48;
      });
    }

    if (chatForm) {
      chatForm.addEventListener("submit", (ev) => {
        ev.preventDefault();
        sendChatMessage(chatInput && chatInput.value);
      });
    }

    async function refresh() {
      try {
        const data = await apiJson(`${base}/games/${encodeURIComponent(gameId)}`);
        const prevFen = state?.fen;
        const prevFlip = state ? flipBoard() : false;
        state = data.game;
        const flipped = flipBoard();
        if (state.fen !== prevFen || flipped !== prevFlip) {
          renderBoard();
        } else {
          updateSelectionHighlight();
        }
        renderMeta();
        setStatus(statusEl, "");
      } catch (e) {
        setStatus(statusEl, e.message, true);
      }
    }

    async function sendMove(uci) {
      endDrag();
      setStatus(statusEl, "Sending move…");
      try {
        const data = await apiJson(`${base}/games/${encodeURIComponent(gameId)}/move`, {
          method: "POST",
          body: JSON.stringify({ uci }),
        });
        state = data.game;
        selected = null;
        renderBoard();
        renderMeta();
        setStatus(statusEl, "");
      } catch (e) {
        setStatus(statusEl, e.message, true);
        selected = null;
        renderBoard();
      }
    }

    function onSquareClick(sq) {
      if (!canMove()) return;
      const piece = pieceAtSquare(sq);
      if (!selected) {
        if (pieceIsMine(piece)) {
          selected = sq;
          renderBoard();
        }
        return;
      }
      if (selected === sq) {
        selected = null;
        renderBoard();
        return;
      }
      const from = selected;
      selected = null;
      renderBoard();
      sendMove(buildUci(from, sq));
    }

    joinBtn?.addEventListener("click", async () => {
      setStatus(statusEl, "Joining…");
      try {
        const data = await apiJson(`${base}/games/${encodeURIComponent(gameId)}/join`, {
          method: "POST",
          body: "{}",
        });
        state = data.game;
        renderBoard();
        renderMeta();
        chatMessages = [];
        lastChatId = 0;
        chatStickBottom = true;
        loadChat().catch(() => {});
        setStatus(statusEl, "Joined.");
      } catch (e) {
        setStatus(statusEl, e.message, true);
      }
    });

    resignBtn?.addEventListener("click", async () => {
      if (!window.confirm("Resign this game?")) return;
      try {
        const data = await apiJson(`${base}/games/${encodeURIComponent(gameId)}/resign`, {
          method: "POST",
          body: "{}",
        });
        state = data.game;
        renderBoard();
        renderMeta();
        setStatus(statusEl, "You resigned.");
      } catch (e) {
        setStatus(statusEl, e.message, true);
      }
    });

    copyBtn?.addEventListener("click", async () => {
      const url = window.location.href;
      try {
        await navigator.clipboard.writeText(url);
        setStatus(statusEl, "Invite link copied.");
      } catch {
        setStatus(statusEl, url);
      }
    });

    async function refreshAll() {
      await refresh();
      await loadChat();
    }

    function updateClockDisplays() {
      if (!state) return;
      const w = state.white || {};
      const b = state.black || {};
      const vc = state.viewer_color;
      const set = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
      };
      if (vc === "w" || vc === "b") {
        const oppKey = vc === "w" ? "b" : "w";
        const youKey = vc;
        set("chess-opponent-total", formatDurationMs(liveClockMs(oppKey)));
        set("chess-you-total", formatDurationMs(liveClockMs(youKey)));
      } else {
        set("chess-opponent-total", formatDurationMs(liveClockMs("w")));
        set("chess-you-total", formatDurationMs(liveClockMs("b")));
      }
    }

    function tickClocks() {
      if (!state || state.status !== "active") return;
      updateClockDisplays();
    }

    refreshAll();
    pollTimer = window.setInterval(refresh, 4000);
    chatPollTimer = window.setInterval(() => loadChat().catch(() => {}), 2500);
    clockTimer = window.setInterval(tickClocks, 1000);
    window.addEventListener("beforeunload", () => {
      if (pollTimer) window.clearInterval(pollTimer);
      if (chatPollTimer) window.clearInterval(chatPollTimer);
      if (clockTimer) window.clearInterval(clockTimer);
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      initLobby();
      initBoardPage();
    });
  } else {
    initLobby();
    initBoardPage();
  }
})();
