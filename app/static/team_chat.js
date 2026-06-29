// Team Chat UI + minimal persistence via /intranet/api/chat/*
(function () {
  const root = document.getElementById("nc-team-chat-root");
  if (!root) return;

  const btnNew = document.getElementById("tc-new");
  const list = document.getElementById("tc-list");
  const thread = document.getElementById("tc-thread");
  const form = document.getElementById("tc-compose");
  const pending = document.getElementById("tc-pending");
  const fMsg = document.getElementById("tc-msg");
  const btnEmoji = document.getElementById("tc-emoji");
  const btnGif = document.getElementById("tc-gif");
  const btnAttach = document.getElementById("tc-attach");
  const btnCall = document.getElementById("tc-call");
  const btnVideo = document.getElementById("tc-video");
  const btnBack = document.getElementById("tc-back");
  const btnDetails = document.getElementById("tc-toggle-details");
  const mqTcMobile =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(max-width: 900px)")
      : null;
  const fSearch = document.getElementById("tc-search");
  const right = document.getElementById("tc-right");
  const btnRightX = document.getElementById("tc-details-close");
  const dlgDetails = document.getElementById("tc-details-dialog");
  const btnDlgDetailsX = document.getElementById("tc-details-x2");
  const dlgAv = document.getElementById("tc-dlg-avatar");
  const dlgName = document.getElementById("tc-dlg-name");
  const dlgSub = document.getElementById("tc-dlg-sub");
  const dlgMembers = document.getElementById("tc-dlg-members");
  const notifyToggle = document.getElementById("tc-notify");
  const btnTitleEdit = document.getElementById("tc-title-edit");
  const btnDlgTitleEdit = document.getElementById("tc-dlg-title-edit");
  const btnDeleteRoom = document.getElementById("tc-delete-room");
  const adminActionsCard = document.getElementById("tc-admin-actions");
  const isPortalAdmin = root.getAttribute("data-portal-admin") === "1";

  const callDialog = document.getElementById("tc-call-dialog");
  const callClose = document.getElementById("tc-call-close");
  const callTitle = document.getElementById("tc-call-title");
  const callStatus = document.getElementById("tc-call-status");
  const callLead = document.getElementById("tc-call-lead");
  const callMute = document.getElementById("tc-call-mute");
  const callJitsiWrap = document.getElementById("tc-call-jitsi-wrap");
  const callJitsiFrame = document.getElementById("tc-call-jitsi-frame");
  const callParticipants = document.getElementById("tc-call-participants");
  const callVideoWrap = document.getElementById("tc-call-video-wrap");
  const callVideoStage = document.getElementById("tc-call-video-stage");
  const callCamera = document.getElementById("tc-call-camera");
  const callScreenShare = document.getElementById("tc-call-screenshare");
  const callFullscreen = document.getElementById("tc-call-fullscreen");
  const callEmbed = document.getElementById("tc-call-embed");
  const callEmbedDock = document.getElementById("tc-call-embed-dock");
  const voiceMode = String(root.getAttribute("data-voice-mode") || "webrtc").trim().toLowerCase();
  const jitsiBase = String(root.getAttribute("data-jitsi-base") || "https://meet.jit.si").trim().replace(/\/$/, "");
  const signalingEnabled = root.getAttribute("data-signaling-enabled") === "1";
  const signalingVoice = root.getAttribute("data-signaling-voice") !== "0";
  const signalingVideo = root.getAttribute("data-signaling-video") !== "0";

  const hAv = document.getElementById("tc-chat-avatar");
  const hTitle = document.getElementById("tc-chat-title");
  const hSub = document.getElementById("tc-chat-sub");

  const rAv = document.getElementById("tc-right-avatar");
  const rName = document.getElementById("tc-right-name");
  const rSub = document.getElementById("tc-right-sub");
  const rMembers = document.getElementById("tc-members");
  const rFiles = document.getElementById("tc-files");
  const btnMembersAdd = document.getElementById("tc-members-add");
  const dlgInvite = document.getElementById("tc-invite-dialog");
  const btnInviteClose = document.getElementById("tc-invite-x");
  const fInviteSearch = document.getElementById("tc-invite-search");
  const elInviteList = document.getElementById("tc-invite-list");
  const elInviteEmpty = document.getElementById("tc-invite-empty");

  const now = () => new Date();
  const pad2 = (n) => String(n).padStart(2, "0");
  const timeZone = String(root.getAttribute("data-time-zone") || "").trim();
  const timeOffsetMs = Number(root.getAttribute("data-time-offset-ms") || "0") || 0;
  const fmtTime = (d) => {
    const dd0 = d instanceof Date ? d : new Date(d);
    const dd = new Date(dd0.getTime() + timeOffsetMs);
    try {
      if (timeZone && typeof Intl !== "undefined" && Intl.DateTimeFormat) {
        return new Intl.DateTimeFormat(undefined, {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
          timeZone,
        }).format(dd);
      }
    } catch (_) {}
    let h = dd.getHours();
    const m = pad2(dd.getMinutes());
    const ap = h >= 12 ? "PM" : "AM";
    h = h % 12;
    if (h === 0) h = 12;
    return `${h}:${m} ${ap}`;
  };

  async function api(path, opts = {}) {
    const r = await fetch(`/intranet/api${path}`, { credentials: "same-origin", ...opts });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Request failed");
    return j;
  }

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function safeInitials(s) {
    const t = String(s || "").trim();
    if (!t) return "ME";
    const parts = t.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return t.slice(0, 2).toUpperCase();
  }

  const me = (() => {
    const name = String(root.getAttribute("data-me-name") || "").trim() || "You";
    const initialsAttr = String(root.getAttribute("data-me-initials") || "").trim();
    const idAttr = String(root.getAttribute("data-me-id") || "").trim();
    return {
      id: idAttr || "me",
      name,
      initials: initialsAttr ? initialsAttr.slice(0, 2).toUpperCase() : safeInitials(name),
    };
  })();

  const storageKey = `nc_tc_active_room_${String(me.id || "me")}`;
  function loadStoredActiveRoomId() {
    try {
      const v = window.localStorage.getItem(storageKey);
      return v ? String(v) : null;
    } catch (_) {
      return null;
    }
  }
  function storeActiveRoomId(id) {
    try {
      if (id == null) window.localStorage.removeItem(storageKey);
      else window.localStorage.setItem(storageKey, String(id));
    } catch (_) {}
  }

  let rooms = [];
  let activeRoomId = null;
  let lastMsgId = 0;
  let detailsOpen = true;
  let isUploading = false;
  let pollTimer = null;
  let activeRoomMeta = null; // {id,title,members,my_role,can_manage}
  let isPortalAdminFlag = isPortalAdmin;

  function canManageActive() {
    if (!activeRoomMeta) return false;
    if (activeRoomMeta.can_manage) return true;
    if (isPortalAdminFlag) return true;
    return String(activeRoomMeta.my_role || "") === "admin";
  }

  function updateManageChrome() {
    const on = canManageActive();
    if (btnTitleEdit) btnTitleEdit.hidden = !on;
    if (btnDlgTitleEdit) btnDlgTitleEdit.hidden = !on;
    if (btnMembersAdd) btnMembersAdd.hidden = !on;
    if (adminActionsCard) adminActionsCard.hidden = !on;
    const title = (activeRoomMeta && activeRoomMeta.title) || "";
    if (btnDeleteRoom) {
      btnDeleteRoom.disabled = !on || title === "General";
      btnDeleteRoom.title = title === "General" ? "The General chat cannot be deleted" : "";
    }
  }
  let activeMessages = []; // [{id,at,text,image_url,from:{id,name,initials}}]
  let pendingImageUrl = "";
  let pendingMediaLabel = "";
  let pendingAttachment = null; // {name,url,size}
  const ATTACH_PREFIX = "__ATTACH__";

  let searchPop = null;
  let searchTimer = null;
  let searchOpen = false;

  function ensureSearchPop() {
    if (searchPop) return;
    const pop = document.createElement("div");
    pop.className = "nc-tc-search-results";
    pop.hidden = true;
    document.body.appendChild(pop);
    searchPop = pop;
  }

  function positionSearchPop() {
    if (!searchPop || !fSearch) return;
    const r = fSearch.getBoundingClientRect();
    searchPop.style.left = `${Math.max(12, Math.min(window.innerWidth - searchPop.offsetWidth - 12, r.left))}px`;
    searchPop.style.top = `${Math.min(window.innerHeight - 12, r.bottom + 8)}px`;
  }

  function openSearchPop() {
    ensureSearchPop();
    if (!searchPop) return;
    searchPop.hidden = false;
    searchOpen = true;
    positionSearchPop();
  }

  function closeSearchPop() {
    if (!searchPop) return;
    searchPop.hidden = true;
    searchOpen = false;
    searchPop.innerHTML = "";
  }

  function fmtSnippet(s, q) {
    const t = String(s || "");
    const qq = String(q || "");
    if (!qq) return t.slice(0, 140);
    const idx = t.toLowerCase().indexOf(qq.toLowerCase());
    if (idx < 0) return t.slice(0, 140);
    const start = Math.max(0, idx - 40);
    const end = Math.min(t.length, idx + qq.length + 60);
    const prefix = start > 0 ? "…" : "";
    const suffix = end < t.length ? "…" : "";
    return prefix + t.slice(start, end) + suffix;
  }

  async function runChatSearch() {
    if (!fSearch) return;
    const q = String(fSearch.value || "").trim();
    if (!q) {
      closeSearchPop();
      return;
    }
    openSearchPop();
    try {
      const j = await api(`/chat/search?q=${encodeURIComponent(q)}&limit=50`, { method: "GET" });
      const res = (j && j.results) || [];
      if (!searchPop) return;
      searchPop.innerHTML = "";
      if (!res.length) {
        searchPop.innerHTML = `<div class="nc-detail-muted" style="padding:0.6rem 0.65rem;">No results.</div>`;
        positionSearchPop();
        return;
      }
      res.forEach((row) => {
        const room = row.room || {};
        const msg = row.message || {};
        const b = document.createElement("button");
        b.type = "button";
        b.className = "nc-tc-search-row";
        b.setAttribute("data-room-id", String(room.id));
        b.setAttribute("data-msg-id", String(msg.id));
        b.innerHTML = `
          <div>
            <div class="nc-tc-search-room">${esc(String(room.title || "Chat"))}</div>
            <div class="nc-tc-search-snippet">${esc(fmtSnippet(msg.text || "", q))}</div>
          </div>
          <div class="nc-tc-search-time">${esc(msg.at ? fmtTime(msg.at) : "")}</div>
        `;
        searchPop.appendChild(b);
      });
      positionSearchPop();
    } catch (_) {
      if (searchPop) searchPop.innerHTML = `<div class="nc-detail-muted" style="padding:0.6rem 0.65rem;">Search failed.</div>`;
      positionSearchPop();
    }
  }

  let emojiPop = null;
  let emojiPopOpen = false;
  let gifPop = null;
  let gifPopOpen = false;

  function insertAtCursor(input, text) {
    try {
      const start = Number(input.selectionStart || 0);
      const end = Number(input.selectionEnd || 0);
      const before = String(input.value || "").slice(0, start);
      const after = String(input.value || "").slice(end);
      input.value = before + text + after;
      const pos = start + text.length;
      input.setSelectionRange(pos, pos);
      input.focus();
    } catch (_) {
      input.value = String(input.value || "") + text;
      try {
        input.focus();
      } catch (_) {}
    }
  }

  function ensureEmojiPop() {
    if (emojiPop) return;
    const pop = document.createElement("div");
    pop.className = "nc-tc-emoji-pop";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Emoji picker");
    const emojis = [
      "😀",
      "😁",
      "😂",
      "🤣",
      "😊",
      "😍",
      "😘",
      "😎",
      "😅",
      "🙂",
      "🙃",
      "😉",
      "😴",
      "🤔",
      "😮",
      "😢",
      "😭",
      "😡",
      "👍",
      "👎",
      "🙏",
      "👏",
      "🔥",
      "🎉",
      "✅",
      "❌",
      "⭐",
      "❤️",
    ];
    pop.innerHTML = `
      <div class="nc-tc-emoji-grid">
        ${emojis.map((e) => `<button type="button" class="nc-tc-emoji-btn" data-emoji="${esc(e)}">${esc(e)}</button>`).join("")}
      </div>
    `;
    document.body.appendChild(pop);
    emojiPop = pop;

    pop.addEventListener("click", (e) => {
      const b = e.target && e.target.closest ? e.target.closest("button.nc-tc-emoji-btn[data-emoji]") : null;
      if (!b || !fMsg) return;
      const emo = String(b.getAttribute("data-emoji") || "");
      if (!emo) return;
      insertAtCursor(fMsg, emo);
      closeEmojiPop();
    });
  }

  function positionEmojiPop() {
    if (!emojiPop || !btnEmoji) return;
    const r = btnEmoji.getBoundingClientRect();
    const popRect = emojiPop.getBoundingClientRect();
    const pad = 8;
    const left = Math.max(pad, Math.min(window.innerWidth - popRect.width - pad, r.left));
    const top = Math.max(pad, r.top - popRect.height - 10);
    emojiPop.style.left = `${left}px`;
    emojiPop.style.top = `${top}px`;
  }

  function openEmojiPop() {
    if (!btnEmoji || !fMsg) return;
    ensureEmojiPop();
    if (!emojiPop) return;
    emojiPop.hidden = false;
    emojiPopOpen = true;
    positionEmojiPop();
  }

  function closeEmojiPop() {
    if (!emojiPop) return;
    emojiPop.hidden = true;
    emojiPopOpen = false;
  }

  function ensureGifPop() {
    if (gifPop) return;
    const pop = document.createElement("div");
    pop.className = "nc-tc-gif-pop";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "GIF picker");
    // A few curated funny animated GIFs (remote URLs are allowed by backend validation).
    const gifs = [
      { label: "Cat", url: "https://media.tenor.com/2roX3uxz_68AAAAC/cat-cute.gif" },
      { label: "Laugh", url: "https://media.tenor.com/7rQf0QWk0u0AAAAC/laughing-lol.gif" },
      { label: "Mind blown", url: "https://media.tenor.com/5qap8cR0J5wAAAAC/mind-blown.gif" },
      { label: "Deal", url: "https://media.tenor.com/0Ww5QmP0Q4gAAAAC/deal.gif" },
      { label: "Dance", url: "https://media.tenor.com/0W9Qq2f7t0wAAAAC/dance-happy.gif" },
      { label: "Nice", url: "https://media.tenor.com/7jYb2OqGfIYAAAAC/nice.gif" },
    ];
    pop.innerHTML = `
      <div class="nc-tc-gif-head">
        <div class="nc-tc-gif-title">GIFs</div>
        <button type="button" class="nc-tc-gif-upload" id="tc-gif-upload">Upload GIF</button>
      </div>
      <div class="nc-tc-gif-grid">
        ${gifs
          .map(
            (g) => `
          <button type="button" class="nc-tc-gif-btn" data-url="${esc(g.url)}" aria-label="${esc(g.label)}">
            <img class="nc-tc-gif-thumb" src="${esc(g.url)}" alt="${esc(g.label)}">
          </button>
        `
          )
          .join("")}
      </div>
    `;
    document.body.appendChild(pop);
    gifPop = pop;

    pop.addEventListener("click", (e) => {
      const upload = e.target && e.target.closest ? e.target.closest("#tc-gif-upload") : null;
      if (upload) {
        // reuse the attach picker but constrain to GIF
        const pick = document.createElement("input");
        pick.type = "file";
        pick.accept = "image/gif";
        pick.style.position = "fixed";
        pick.style.left = "-9999px";
        document.body.appendChild(pick);
        pick.addEventListener(
          "change",
          async () => {
            try {
              await handlePickedFiles(pick.files);
              closeGifPop();
            } finally {
              try {
                document.body.removeChild(pick);
              } catch (_) {}
            }
          },
          { once: true }
        );
        pick.click();
        return;
      }
      const b = e.target && e.target.closest ? e.target.closest("button.nc-tc-gif-btn[data-url]") : null;
      if (!b) return;
      const url = String(b.getAttribute("data-url") || "").trim();
      if (!url) return;
      pendingAttachment = null;
      pendingImageUrl = url;
      pendingMediaLabel = "GIF";
      renderPending();
      closeGifPop();
      try {
        fMsg && fMsg.focus();
      } catch (_) {}
    });
  }

  function positionGifPop() {
    if (!gifPop || !btnGif) return;
    const r = btnGif.getBoundingClientRect();
    const popRect = gifPop.getBoundingClientRect();
    const pad = 8;
    const left = Math.max(pad, Math.min(window.innerWidth - popRect.width - pad, r.left));
    const top = Math.max(pad, r.top - popRect.height - 10);
    gifPop.style.left = `${left}px`;
    gifPop.style.top = `${top}px`;
  }

  function openGifPop() {
    if (!btnGif || !activeRoomId) return;
    ensureGifPop();
    if (!gifPop) return;
    gifPop.hidden = false;
    gifPopOpen = true;
    positionGifPop();
  }

  function closeGifPop() {
    if (!gifPop) return;
    gifPop.hidden = true;
    gifPopOpen = false;
  }

  function initialsFromTitle(t) {
    const s = String(t || "").trim();
    if (!s) return "—";
    const parts = s.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return s.slice(0, 2).toUpperCase();
  }

  function isTcMobile() {
    return !!(mqTcMobile && mqTcMobile.matches);
  }

  function syncTcMobilePane() {
    const showChat = isTcMobile() && activeRoomId != null;
    root.classList.toggle("nc-tc-mobile-show-chat", showChat);
    if (btnBack) btnBack.hidden = !showChat;
  }

  function setDetailsOpen(on) {
    detailsOpen = !!on;
    root.classList.toggle("nc-tc-details-collapsed", !detailsOpen);
    if (btnDetails) btnDetails.setAttribute("aria-pressed", detailsOpen ? "true" : "false");
    if (!right) return;
    if (detailsOpen) right.classList.remove("is-collapsed");
    else right.classList.add("is-collapsed");
  }

  function showChatList() {
    activeRoomId = null;
    storeActiveRoomId(null);
    lastMsgId = 0;
    activeRoomMeta = null;
    activeMessages = [];
    renderList();
    renderHeader(null);
    renderMembers({ members: [] });
    renderFiles(null);
    renderThread([]);
    syncTcMobilePane();
  }

  function renderDetailsDialog(meta) {
    if (!dlgDetails) return;
    const title = meta && meta.title ? meta.title : "—";
    const av = initialsFromTitle(title);
    const mems = (meta && meta.members) || [];
    if (dlgAv) dlgAv.textContent = av;
    if (dlgName) dlgName.textContent = title;
    if (dlgSub) dlgSub.textContent = mems.length ? `${mems.length} member${mems.length === 1 ? "" : "s"}` : "—";
    if (dlgMembers) {
      dlgMembers.innerHTML = "";
      mems.slice(0, 12).forEach((m) => {
        const row = document.createElement("div");
        row.className = "nc-tc-member";
        row.innerHTML = `
          <div class="nc-tc-member-av" aria-hidden="true">${esc(m.initials || safeInitials(m.name))}</div>
          <div class="nc-tc-member-main">
            <div class="nc-tc-member-name">${esc(m.name || "")}</div>
            <div class="nc-tc-member-status"></div>
          </div>
          <div class="nc-tc-member-role">${esc(String(m.role || "") === "admin" ? "Admin" : "")}</div>
          <span class="nc-tc-member-rm-spacer" aria-hidden="true"></span>
        `;
        dlgMembers.appendChild(row);
      });
    }
  }

  async function deleteMessage(msgId) {
    if (!activeRoomId || !msgId) return;
    if (!window.confirm("Delete this message?")) return;
    try {
      await api(`/chat/rooms/${activeRoomId}/messages/${encodeURIComponent(String(msgId))}`, {
        method: "DELETE",
      });
      await loadMessages(false);
      await loadRooms();
    } catch (e) {
      window.alert(String((e && e.message) || e || "") || "Could not delete message.");
    }
  }

  async function muteMessage(msgId) {
    if (!activeRoomId || !msgId) return;
    if (
      !window.confirm(
        "Hide this message and replace it with a moderator warning?\n\nThe original content is kept for administrators only."
      )
    ) {
      return;
    }
    try {
      await api(
        `/chat/rooms/${activeRoomId}/messages/${encodeURIComponent(String(msgId))}/mute`,
        { method: "POST" }
      );
      await loadMessages(false);
      await loadRooms();
    } catch (e) {
      window.alert(String((e && e.message) || e || "") || "Could not mute message.");
    }
  }

  async function editMessage(msgId, currentText) {
    if (!activeRoomId || !msgId) return;
    const val = window.prompt("Edit message", currentText || "");
    if (val === null) return;
    const text = String(val).trim();
    if (!text) {
      window.alert("Message cannot be empty.");
      return;
    }
    try {
      await api(`/chat/rooms/${activeRoomId}/messages/${encodeURIComponent(String(msgId))}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      await loadMessages(false);
      await loadRooms();
    } catch (e) {
      window.alert(String((e && e.message) || e || "") || "Could not edit message.");
    }
  }

  async function deleteActiveRoom() {
    if (!activeRoomId || !canManageActive()) return;
    const title = (activeRoomMeta && activeRoomMeta.title) || "this chat";
    if (title === "General") {
      window.alert("The General chat cannot be deleted.");
      return;
    }
    if (
      !window.confirm(
        `Delete "${title}"?\n\nAll messages and members will be removed. This cannot be undone.`
      )
    ) {
      return;
    }
    try {
      await api(`/chat/rooms/${activeRoomId}`, { method: "DELETE" });
      activeRoomId = null;
      activeRoomMeta = null;
      storeActiveRoomId(null);
      await loadRooms();
      renderHeader(null);
      renderMembers({ members: [] });
      renderThread([]);
      updateManageChrome();
    } catch (e) {
      window.alert(String((e && e.message) || e || "") || "Could not delete chat.");
    }
  }

  async function saveRoomTitle(newTitle) {
    if (!activeRoomId || !canManageActive()) return;
    const title = String(newTitle || "").trim();
    if (!title) return;
    await api(`/chat/rooms/${activeRoomId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    // refresh room list + headers
    await loadRooms();
    await loadActiveRoomMeta();
  }

  function startInlineTitleEdit(targetEl, opts = {}) {
    if (!targetEl) return;
    const cur = String(targetEl.textContent || "").trim();
    const input = document.createElement("input");
    input.type = "text";
    input.className = "nc-tc-title-input";
    input.value = cur && cur !== "—" ? cur : (activeRoomMeta && activeRoomMeta.title ? String(activeRoomMeta.title) : "");
    targetEl.replaceWith(input);
    input.focus();
    try {
      input.setSelectionRange(input.value.length, input.value.length);
    } catch (_) {}

    const cancel = () => {
      const restore = document.createElement("div");
      restore.id = opts.id || "";
      restore.className = opts.className || "";
      restore.textContent = cur || "—";
      input.replaceWith(restore);
      if (typeof opts.onRestore === "function") opts.onRestore(restore);
    };

    const commit = async () => {
      const val = String(input.value || "").trim();
      if (!val) return cancel();
      try {
        await saveRoomTitle(val);
      } catch (e) {
        window.alert(String((e && e.message) || e || "") || "Could not rename chat.");
      }
      cancel();
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        commit();
      }
    });
    input.addEventListener("blur", () => commit());
  }

  function openDetailsPopover() {
    if (!dlgDetails || typeof dlgDetails.showModal !== "function") {
      // Fallback for older browsers: use the right sidebar if available.
      setDetailsOpen(true);
      return;
    }
    renderDetailsDialog(activeRoomMeta);
    try {
      dlgDetails.showModal();
    } catch (_) {}
  }

  function closeDetailsPopover() {
    if (!dlgDetails) return;
    try {
      dlgDetails.close();
    } catch (_) {}
  }

  function renderList() {
    if (!list) return;
    list.innerHTML = "";
    rooms.forEach((c) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = `nc-tc-item ${String(c.id) === String(activeRoomId) ? "is-active" : ""}`;
      row.setAttribute("role", "listitem");
      row.setAttribute("data-id", String(c.id));
      const av = initialsFromTitle(c.title);
      row.innerHTML = `
        <div class="nc-tc-item-av" aria-hidden="true">${esc(av)}</div>
        <div class="nc-tc-item-main">
          <div class="nc-tc-item-top">
            <div class="nc-tc-item-title">${esc(c.title || "")}</div>
            <div class="nc-tc-item-time">${c.last_at ? esc(fmtTime(c.last_at)) : ""}</div>
          </div>
          <div class="nc-tc-item-bot">
            <div class="nc-tc-item-prev">${esc(c.preview || "")}</div>
          </div>
        </div>
      `;
      list.appendChild(row);
    });
  }

  function renderHeader(meta) {
    const title = meta && meta.title ? meta.title : "—";
    const av = initialsFromTitle(title);
    const memCount = meta && Array.isArray(meta.members) ? meta.members.length : 0;
    if (hAv) hAv.textContent = av;
    if (hTitle) hTitle.textContent = title;
    if (hSub) hSub.textContent = memCount ? `${memCount} member${memCount === 1 ? "" : "s"}` : "—";
    if (rAv) rAv.textContent = av;
    if (rName) rName.textContent = title;
    if (rSub) rSub.textContent = memCount ? `${memCount} member${memCount === 1 ? "" : "s"}` : "—";
    updateManageChrome();
  }

  function renderMembers(meta) {
    if (!rMembers) return;
    rMembers.innerHTML = "";
    const mems = (meta && meta.members) || [];
    const manage = canManageActive();
    const n = mems.length;
    mems.forEach((m) => {
      const row = document.createElement("div");
      row.className = "nc-tc-member";
      const canRm =
        n > 1 && (String(m.id) === String(me.id) || (manage && String(m.id) !== String(me.id)));
      row.innerHTML = `
        <div class="nc-tc-member-av" aria-hidden="true">${esc(m.initials || safeInitials(m.name))}</div>
        <div class="nc-tc-member-main">
          <div class="nc-tc-member-name">${esc(m.name || "")}</div>
          <div class="nc-tc-member-status"></div>
        </div>
        <div class="nc-tc-member-role">${esc(String(m.role || "") === "admin" ? "Admin" : "")}</div>
        ${
          canRm
            ? `<button type="button" class="nc-tc-member-rm" title="Remove" aria-label="${String(m.id) === String(me.id) ? "Leave chat" : "Remove member"}" data-user-id="${esc(String(m.id))}">${String(m.id) === String(me.id) ? "&rarr;" : "&times;"}</button>`
            : `<span class="nc-tc-member-rm-spacer" aria-hidden="true"></span>`
        }
      `;
      rMembers.appendChild(row);
    });
  }

  let inviteFetchTimer = null;

  function debounceInviteSearch() {
    if (inviteFetchTimer) window.clearTimeout(inviteFetchTimer);
    inviteFetchTimer = window.setTimeout(() => loadInviteCandidates(), 280);
  }

  async function loadInviteCandidates() {
    if (!activeRoomId || !elInviteList || !elInviteEmpty) return;
    const q = fInviteSearch ? String(fInviteSearch.value || "").trim() : "";
    try {
      const j = await api(
        `/chat/rooms/${activeRoomId}/invite-candidates?q=${encodeURIComponent(q)}`,
        { method: "GET" }
      );
      const users = (j && j.users) || [];
      elInviteList.innerHTML = "";
      if (!users.length) {
        elInviteEmpty.hidden = false;
        return;
      }
      elInviteEmpty.hidden = true;
      users.forEach((u) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "nc-tc-invite-row";
        b.setAttribute("role", "option");
        b.setAttribute("data-user-id", String(u.id));
        b.innerHTML = `
          <div class="nc-tc-member-av" aria-hidden="true">${esc(u.initials || safeInitials(u.name))}</div>
          <div class="nc-tc-member-main">
            <div class="nc-tc-member-name">${esc(u.name || "")}</div>
          </div>
        `;
        elInviteList.appendChild(b);
      });
    } catch (_) {
      elInviteEmpty.hidden = false;
      elInviteEmpty.textContent = "Could not load colleagues.";
      elInviteList.innerHTML = "";
    }
  }

  function closeInviteDialog() {
    if (inviteFetchTimer) window.clearTimeout(inviteFetchTimer);
    if (!dlgInvite) return;
    try {
      dlgInvite.close();
    } catch (_) {}
    if (fInviteSearch) fInviteSearch.value = "";
    if (elInviteList) elInviteList.innerHTML = "";
    if (elInviteEmpty) {
      elInviteEmpty.hidden = true;
      elInviteEmpty.textContent = "No one matches.";
    }
  }

  async function openInviteDialog() {
    if (!dlgInvite || !activeRoomId) return;
    if (!fInviteSearch) return;
    fInviteSearch.value = "";
    if (typeof dlgInvite.showModal === "function") dlgInvite.showModal();
    try {
      fInviteSearch.focus();
    } catch (_) {}
    await loadInviteCandidates();
  }

  async function addMemberById(uid) {
    if (!activeRoomId) return;
    try {
      await api(`/chat/rooms/${activeRoomId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: uid }),
      });
    } catch (e) {
      window.alert(String(e && e.message ? e.message : e) || "Could not add member.");
      return;
    }
    closeInviteDialog();
    const roomChanged = await loadRooms();
    await loadActiveRoomMeta();
    renderHeader(activeRoomMeta);
    renderMembers(activeRoomMeta);
    if (roomChanged && activeRoomId) await refreshActive(true).catch(() => {});
  }

  async function removeMember(uid) {
    if (!activeRoomId) return;
    const leaving = String(uid) === String(me.id);
    if (!leaving) {
      const name =
        activeRoomMeta && activeRoomMeta.members && activeRoomMeta.members.find((m) => String(m.id) === String(uid));
      const label = name && name.name ? name.name : "this member";
      if (!window.confirm(`Remove ${label} from the chat?`)) return;
    } else if (!window.confirm("Leave this chat? You can be re-invited later.")) {
      return;
    }
    try {
      await api(`/chat/rooms/${activeRoomId}/members/${encodeURIComponent(String(uid))}`, { method: "DELETE" });
    } catch (e) {
      window.alert(String((e && e.message) || e || "") || "Could not remove member.");
      return;
    }
    if (leaving) {
      activeRoomMeta = null;
      const roomChanged = await loadRooms();
      if (!activeRoomId) {
        renderHeader(null);
        renderMembers({ members: [] });
        renderFiles(null);
        renderThread([]);
        return;
      }
      if (roomChanged && activeRoomId) await refreshActive(true).catch(() => {});
      else await refreshActive(true).catch(() => {});
    } else {
      await loadRooms();
      await loadActiveRoomMeta();
      renderHeader(activeRoomMeta);
      renderMembers(activeRoomMeta);
      renderFiles(activeRoomMeta);
    }
  }

  function renderFiles(_meta) {
    if (!rFiles) return;
    rFiles.innerHTML = "";
  }

  function messageNode(m) {
    const mine = m && m.from && String(m.from.id) === String(me.id);
    const isMuted = !!(m && m.muted);
    const wrap = document.createElement("div");
    wrap.className = `nc-tc-msg ${mine ? "is-mine" : ""}${isMuted ? " is-muted" : ""}`;
    const av = mine ? me.initials : (m.from && m.from.initials) || "U";
    const name = mine ? me.name : (m.from && m.from.name) || "User";
    const time = m.at ? fmtTime(m.at) : "";
    const imgUrl = !isMuted && m && m.image_url ? String(m.image_url) : "";
    const imgHtml = imgUrl
      ? `<div class="nc-tc-imgwrap">
          <button type="button" class="nc-tc-imgbtn" data-src="${esc(imgUrl)}" aria-label="Open image">
            <img class="nc-tc-img" src="${esc(imgUrl)}" alt="Pasted image">
          </button>
        </div>`
      : "";
    let attach = null;
    if (!isMuted && m && m.text && String(m.text).startsWith(ATTACH_PREFIX)) {
      try {
        attach = JSON.parse(String(m.text).slice(ATTACH_PREFIX.length));
      } catch (_) {
        attach = null;
      }
    }
    const attachHtml =
      attach && attach.url
        ? `<a class="nc-tc-attach" href="${esc(String(attach.url))}" target="_blank" rel="noopener">
            <div class="nc-tc-attach-ic" aria-hidden="true">📎</div>
            <div class="nc-tc-attach-main">
              <div class="nc-tc-attach-name">${esc(String(attach.name || "Attachment"))}</div>
              <div class="nc-tc-attach-sub">${esc(attach.size ? formatBytes(attach.size) : "")}</div>
            </div>
            <div class="nc-tc-attach-dl" aria-hidden="true">⤓</div>
          </a>`
        : "";
    wrap.innerHTML = `
      <div class="nc-tc-msg-av" aria-hidden="true">${esc(av)}</div>
      <div class="nc-tc-msg-bub">
        <div class="nc-tc-msg-meta">
          <div class="nc-tc-msg-name">${esc(name)}</div>
          <div class="nc-tc-msg-time">${esc(time)}</div>
        </div>
        ${
          m.text && (!attach || isMuted)
            ? `<div class="nc-tc-msg-text${isMuted ? " nc-tc-msg-text--muted" : ""}">${esc(m.text || "")}</div>`
            : ""
        }
        ${imgHtml}
        ${attachHtml}
        ${
          canManageActive() && m && m.id != null
            ? `<div class="nc-tc-msg-actions">
                ${
                  !isMuted
                    ? `<button type="button" class="nc-tc-msg-act" data-act="mute" data-msg-id="${esc(String(m.id))}">Mute</button>`
                    : ""
                }
                ${
                  !isMuted && m.text && !attach && !imgUrl
                    ? `<button type="button" class="nc-tc-msg-act" data-act="edit" data-msg-id="${esc(String(m.id))}">Edit</button>`
                    : ""
                }
                <button type="button" class="nc-tc-msg-act" data-act="delete" data-msg-id="${esc(String(m.id))}">Delete</button>
              </div>`
            : ""
        }
      </div>
    `;
    return wrap;
  }

  let imgDlg = null;
  let imgDlgImg = null;
  let imgDlgOpen = false;
  let imgDlgHistoryArmed = false;

  function ensureImageDialog() {
    if (imgDlg && imgDlgImg) return;
    const d = document.createElement("dialog");
    d.className = "nc-tc-imgdlg nc-modal-full";
    d.setAttribute("aria-label", "Image viewer");
    d.innerHTML = `
      <div class="nc-tc-imgdlg-inner">
        <img class="nc-tc-imgfull" alt="Image preview">
      </div>
    `;
    const img = d.querySelector("img.nc-tc-imgfull");
    imgDlg = d;
    imgDlgImg = img;

    // Clicking the image closes (acts like "back").
    if (img) {
      img.addEventListener("click", () => {
        try {
          d.close();
        } catch (_) {}
      });
    }

    // Click-away (backdrop) close: in <dialog>, the backdrop click targets the dialog element.
    d.addEventListener("click", (e) => {
      if (e.target === d) {
        try {
          d.close();
        } catch (_) {}
      }
    });
    d.addEventListener("cancel", (e) => {
      e.preventDefault();
      try {
        d.close();
      } catch (_) {}
    });

    // Keep browser Back in sync: if user closes via click-away/Esc/image click, consume the history entry.
    d.addEventListener("close", () => {
      if (!imgDlgOpen) return;
      imgDlgOpen = false;
      if (imgDlgHistoryArmed) {
        imgDlgHistoryArmed = false;
        try {
          history.back();
        } catch (_) {}
      }
    });

    // Close the dialog when user navigates "back".
    window.addEventListener("popstate", () => {
      if (!imgDlgOpen) return;
      imgDlgOpen = false;
      imgDlgHistoryArmed = false;
      try {
        d.close();
      } catch (_) {}
    });

    document.body.appendChild(d);
  }

  function openImage(url) {
    if (!url) return;
    ensureImageDialog();
    if (!imgDlg || !imgDlgImg) return;
    imgDlgImg.src = url;
    try {
      // Push a history entry so browser Back returns to chat (closes viewer).
      if (!imgDlgOpen) {
        imgDlgOpen = true;
        imgDlgHistoryArmed = true;
        try {
          history.pushState({ tc_img: true }, "");
        } catch (_) {
          imgDlgHistoryArmed = false;
        }
      }
      imgDlg.showModal();
    } catch (_) {
      // Fallback: if dialog can't show, navigate to image.
      window.open(url, "_blank");
    }
  }

  function renderThread(messages) {
    if (!thread) return;
    thread.innerHTML = "";
    const inner = document.createElement("div");
    inner.className = "nc-tc-thread-inner";
    const divider = document.createElement("div");
    divider.className = "nc-tc-day";
    divider.innerHTML = `<span>Today</span>`;
    inner.appendChild(divider);
    (messages || []).forEach((m) => inner.appendChild(messageNode(m)));
    thread.appendChild(inner);
    thread.scrollTop = thread.scrollHeight;
  }

  function renderPending() {
    if (!pending) return;
    const url = String(pendingImageUrl || "").trim();
    const att = pendingAttachment;
    if (!url && !att) {
      pending.hidden = true;
      pending.innerHTML = "";
      return;
    }
    pending.hidden = false;
    if (att) {
      const nm = att.name || "Attachment";
      const sz = typeof att.size === "number" && att.size > 0 ? formatBytes(att.size) : "";
      pending.innerHTML = `
        <div class="nc-tc-pending-chip nc-tc-pending-chip--file">
          <div class="nc-tc-pending-fileic" aria-hidden="true">📎</div>
          <div class="nc-tc-pending-meta">
            <div class="nc-tc-pending-title">${esc(nm)}</div>
            <div class="nc-tc-pending-sub">${sz ? esc(sz) + " · " : ""}Will send with your message</div>
          </div>
          <button type="button" class="nc-tc-pending-x" id="tc-pending-x" aria-label="Remove attachment">×</button>
        </div>
      `;
    } else {
      const title = pendingMediaLabel ? pendingMediaLabel : "Screenshot";
      pending.innerHTML = `
        <div class="nc-tc-pending-chip">
          <img class="nc-tc-pending-img" src="${esc(url)}" alt="Pending image">
          <div class="nc-tc-pending-meta">
            <div class="nc-tc-pending-title">${esc(title)}</div>
            <div class="nc-tc-pending-sub">Will send with your message</div>
          </div>
          <button type="button" class="nc-tc-pending-x" id="tc-pending-x" aria-label="Remove image">×</button>
        </div>
      `;
    }
    const x = document.getElementById("tc-pending-x");
    if (x) {
      x.addEventListener("click", () => {
        pendingImageUrl = "";
        pendingMediaLabel = "";
        pendingAttachment = null;
        renderPending();
        try {
          fMsg && fMsg.focus();
        } catch (_) {}
      });
    }
  }

  function formatBytes(n) {
    const v = Number(n) || 0;
    if (v <= 0) return "";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0;
    let x = v;
    while (x >= 1024 && i < units.length - 1) {
      x /= 1024;
      i += 1;
    }
    return `${x >= 10 || i === 0 ? Math.round(x) : x.toFixed(1)} ${units[i]}`;
  }

  async function uploadChatImage(file) {
    const fd = new FormData();
    fd.append("file", file, file.name || "image.png");
    const r = await fetch("/intranet/api/chat/upload-image", { method: "POST", credentials: "same-origin", body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.url) throw new Error(j.error || "Upload failed");
    return String(j.url);
  }

  async function uploadChatFile(file) {
    const fd = new FormData();
    fd.append("file", file, file.name || "file.bin");
    const r = await fetch("/intranet/api/chat/upload-file", { method: "POST", credentials: "same-origin", body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.url) throw new Error(j.error || "Upload failed");
    return { url: String(j.url), name: String(j.name || file.name || "Attachment"), size: Number(j.size) || file.size || 0 };
  }

  /** @returns true if active room changed and caller should hydrate (refreshActive); false otherwise */
  async function loadRooms() {
    const j = await api("/chat/rooms", { method: "GET" });
    if (j && j.is_portal_admin) isPortalAdminFlag = !!j.is_portal_admin;
    rooms = (j && j.rooms) || [];
    const ids = new Set((rooms || []).map((r) => String(r.id)));
    // Restore last selected room on refresh (per-user) if it's still available.
    if (activeRoomId == null) {
      const stored = loadStoredActiveRoomId();
      if (stored && ids.has(String(stored))) activeRoomId = stored;
    }
    const validSelection = activeRoomId != null && ids.has(String(activeRoomId));
    if (!validSelection) {
      const hadStored = !!loadStoredActiveRoomId();
      if (isTcMobile() && !hadStored) {
        activeRoomId = null;
        lastMsgId = 0;
        activeRoomMeta = null;
        activeMessages = [];
        renderThread([]);
        renderHeader(null);
        renderMembers({ members: [] });
        renderFiles(null);
        storeActiveRoomId(null);
      } else {
        activeRoomId = rooms[0] ? rooms[0].id : null;
        storeActiveRoomId(activeRoomId);
        lastMsgId = 0;
        activeRoomMeta = null;
        activeMessages = [];
        renderThread([]);
        if (activeRoomId == null) {
          renderHeader(null);
          renderMembers({ members: [] });
        }
      }
    }
    renderList();
    syncTcMobilePane();
    return !validSelection;
  }

  async function loadActiveRoomMeta() {
    if (!activeRoomId) return;
    const j = await api(`/chat/rooms/${activeRoomId}`, { method: "GET" });
    activeRoomMeta = j && j.room ? j.room : null;
    renderHeader(activeRoomMeta);
    renderMembers(activeRoomMeta);
    renderFiles(activeRoomMeta);
    renderDetailsDialog(activeRoomMeta);
    updateManageChrome();
  }

  function jitsiRoomName() {
    const id = String(activeRoomId || "").replace(/[^a-zA-Z0-9_-]/g, "");
    const title = String((activeRoomMeta && activeRoomMeta.title) || "Chat").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24);
    return `Firmgate-${title || "Chat"}-${id || "room"}`;
  }

  function setCallUi(mode, opts = {}) {
    const isJitsi = mode === "jitsi";
    const isVideo = !!opts.video;
    if (callLead) {
      if (isJitsi) {
        callLead.textContent = isVideo
          ? "Video call room — others in this chat should open the call too."
          : "Voice call room — others in this chat should open the call too.";
      } else {
        callLead.textContent = isVideo
          ? "Intranet video call (WebRTC). Others in this chat must join from the video or phone icon."
          : "Intranet voice call (WebRTC). Others in this chat must click the phone icon.";
      }
    }
    if (callParticipants) callParticipants.hidden = isJitsi;
    if (callMute) callMute.hidden = isJitsi;
    if (callCamera) callCamera.hidden = isJitsi || !isVideo;
    if (callScreenShare) callScreenShare.hidden = isJitsi || !isVideo;
    if (callFullscreen) callFullscreen.hidden = isJitsi || !isVideo;
    if (callEmbed) callEmbed.hidden = isJitsi || !isVideo;
    if (callVideoStage) callVideoStage.hidden = isJitsi || !isVideo;
    if (callVideoWrap) callVideoWrap.hidden = isJitsi || !isVideo;
    if (callJitsiWrap) callJitsiWrap.hidden = !isJitsi;
    if (callDialog) {
      callDialog.classList.toggle("is-video-call", !isJitsi && isVideo);
      callDialog.classList.toggle("is-embedded-call", false);
    }
  }

  function openJitsiCall(video) {
    if (!callJitsiFrame) return false;
    const room = jitsiRoomName();
    const cfg = video
      ? "#config.startWithVideoMuted=false&config.startWithAudioMuted=false&config.prejoinPageEnabled=false"
      : "#config.startWithVideoMuted=true&config.startWithAudioMuted=false&config.prejoinPageEnabled=false";
    callJitsiFrame.src = `${jitsiBase}/${encodeURIComponent(room)}${cfg}`;
    setCallUi("jitsi", { video: !!video });
    if (callStatus) {
      callStatus.textContent = video
        ? "Connected — allow camera and microphone when prompted."
        : "Connected — allow microphone when prompted.";
    }
    return true;
  }

  async function openCallViewer(opts = {}) {
    const wantVideo = !!(opts.video && !opts.audioOnly);
    if (!callDialog || typeof callDialog.showModal !== "function") {
      window.alert("Calling is not supported in this browser.");
      return;
    }
    if (!activeRoomId) {
      window.alert("Select a chat first.");
      return;
    }

    if (signalingEnabled) {
      if (wantVideo && !signalingVideo) {
        window.alert("Video calls are disabled in Administration → Intranet Signaling.");
        return;
      }
      if (!wantVideo && !signalingVoice) {
        window.alert("Voice calls are disabled in Administration → Intranet Signaling.");
        return;
      }
    } else if (wantVideo) {
      window.alert("Enable Intranet Signaling under Administration to use Team Chat video calls.");
      return;
    }

    const title = (activeRoomMeta && activeRoomMeta.title) || "Call";
    if (callTitle) callTitle.textContent = wantVideo ? `${title} — Video` : title;
    if (callStatus) callStatus.textContent = "Starting…";

    const useJitsi = !signalingEnabled && voiceMode === "jitsi";
    setCallUi(useJitsi ? "jitsi" : "webrtc", { video: wantVideo });

    try {
      callDialog.showModal();
    } catch (e) {
      window.alert(String(e.message || e) || "Could not open call.");
      return;
    }

    if (useJitsi) {
      openJitsiCall(wantVideo);
      return;
    }

    if (!window.isSecureContext) {
      if (signalingEnabled) {
        if (callStatus) callStatus.textContent = "WebRTC needs HTTPS.";
        return;
      }
      if (callStatus) callStatus.textContent = "WebRTC needs HTTPS. Switching to compatibility mode…";
      openJitsiCall(wantVideo);
      return;
    }

    if (!window.ncTeamChatCall || typeof window.ncTeamChatCall.start !== "function") {
      if (signalingEnabled) {
        if (callStatus) callStatus.textContent = "Call module failed to load.";
        return;
      }
      if (callStatus) callStatus.textContent = "Loading call module failed — using compatibility mode.";
      openJitsiCall(wantVideo);
      return;
    }

    if (callParticipants) callParticipants.hidden = false;
    if (callMute) callMute.hidden = false;
    if (callCamera) callCamera.hidden = !wantVideo;
    if (callScreenShare) callScreenShare.hidden = !wantVideo;
    if (callFullscreen) callFullscreen.hidden = !wantVideo;
    if (callEmbed) callEmbed.hidden = !wantVideo;
    if (callVideoStage) callVideoStage.hidden = !wantVideo;
    if (callVideoWrap) callVideoWrap.hidden = !wantVideo;

    let ok = false;
    try {
      ok = await window.ncTeamChatCall.start({
        roomId: Number(activeRoomId),
        meId: Number(me.id),
        meName: me.name,
        video: wantVideo,
        onClose: () => closeCallViewer({ popHistory: false }),
      });
    } catch (e) {
      if (callStatus) callStatus.textContent = String(e.message || e) || "Call failed.";
      ok = false;
    }

    if (!ok) {
      if (signalingEnabled) return;
      if (callStatus) callStatus.textContent = "WebRTC unavailable — trying compatibility mode…";
      openJitsiCall(wantVideo);
    }
  }

  function closeCallViewer(opts = {}) {
    if (!callDialog) return;
    const embedded = window.ncTeamChatCall && typeof window.ncTeamChatCall.isEmbedded === "function" && window.ncTeamChatCall.isEmbedded();
    if (!embedded) {
      if (window.ncTeamChatCall && typeof window.ncTeamChatCall.end === "function") {
        window.ncTeamChatCall.end(true);
      }
    } else if (opts.forceEnd && window.ncTeamChatCall && typeof window.ncTeamChatCall.end === "function") {
      window.ncTeamChatCall.end(true);
    }
    if (callJitsiFrame) callJitsiFrame.src = "about:blank";
    if (callJitsiWrap) callJitsiWrap.hidden = true;
    if (callVideoWrap) callVideoWrap.hidden = true;
    if (callVideoStage) callVideoStage.hidden = true;
    if (callCamera) callCamera.hidden = true;
    if (callScreenShare) callScreenShare.hidden = true;
    if (callFullscreen) callFullscreen.hidden = true;
    if (callEmbed) callEmbed.hidden = true;
    if (callEmbedDock) callEmbedDock.hidden = true;
    document.querySelector(".nc-tc-mid")?.classList.remove("has-embedded-call");
    if (callDialog) callDialog.classList.remove("is-video-call");
    try {
      if (callDialog.open) callDialog.close();
    } catch (_) {}
    document.body.style.overflow = "";
  }

  async function loadMessages(reset) {
    if (!activeRoomId) return;
    if (reset) {
      lastMsgId = 0;
      activeMessages = [];
      renderThread(activeMessages);
    }
    let j;
    try {
      j = await api(`/chat/rooms/${activeRoomId}/messages?after_id=${encodeURIComponent(String(lastMsgId || 0))}`, {
        method: "GET",
      });
    } catch (_) {
      const roomChanged = await loadRooms().catch(() => false);
      if (roomChanged && activeRoomId) await refreshActive(true).catch(() => {});
      return;
    }
    const msgs = (j && j.messages) || [];
    if (msgs.length) {
      msgs.forEach((m) => {
        activeMessages.push(m);
        const idNum = Number(m.id) || 0;
        if (idNum > lastMsgId) lastMsgId = idNum;
      });
      renderThread(activeMessages);
    }
    if (window.ncChatNavBadge && typeof window.ncChatNavBadge.refresh === "function") {
      window.ncChatNavBadge.refresh();
    }
  }

  async function refreshActive(reset) {
    await loadActiveRoomMeta();
    await loadMessages(reset);
  }

  function setActive(id) {
    activeRoomId = id;
    storeActiveRoomId(activeRoomId);
    lastMsgId = 0;
    activeRoomMeta = null;
    activeMessages = [];
    renderList();
    renderHeader(null);
    renderMembers({ members: [] });
    renderFiles(null);
    renderThread([]);
    syncTcMobilePane();
    refreshActive(true).catch(() => {});
    try {
      if (fMsg && !isTcMobile()) fMsg.focus();
    } catch (_) {}
  }

  function startPolling() {
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = window.setInterval(() => {
      if (!activeRoomId) return;
      loadMessages(false).catch(() => {});
    }, 1500);
  }

  if (list) {
    list.addEventListener("click", (e) => {
      const b = e.target && e.target.closest ? e.target.closest("button[data-id]") : null;
      if (!b) return;
      const id = b.getAttribute("data-id");
      if (!id) return;
      setActive(id);
    });
  }

  if (btnBack) {
    btnBack.addEventListener("click", (e) => {
      e.preventDefault();
      showChatList();
    });
  }

  if (mqTcMobile) {
    const onMqTc = () => {
      syncTcMobilePane();
      if (!isTcMobile() && activeRoomId == null && rooms.length) {
        setActive(rooms[0].id);
      }
    };
    if (typeof mqTcMobile.addEventListener === "function") {
      mqTcMobile.addEventListener("change", onMqTc);
    } else if (typeof mqTcMobile.addListener === "function") {
      mqTcMobile.addListener(onMqTc);
    }
  }

  if (btnDetails) {
    btnDetails.addEventListener("click", (e) => {
      e.preventDefault();
      // On narrow screens the right panel is hidden by CSS; use a popover dialog instead.
      if (window.matchMedia && window.matchMedia("(max-width: 1200px)").matches) {
        openDetailsPopover();
        return;
      }
      setDetailsOpen(!detailsOpen);
    });
  }
  if (btnRightX) btnRightX.addEventListener("click", () => setDetailsOpen(false));

  if (btnDlgDetailsX) btnDlgDetailsX.addEventListener("click", () => closeDetailsPopover());
  if (dlgDetails) {
    dlgDetails.addEventListener("click", (e) => {
      if (e.target === dlgDetails) closeDetailsPopover();
    });
    dlgDetails.addEventListener("cancel", (e) => {
      e.preventDefault();
      closeDetailsPopover();
    });
  }

  if (notifyToggle) {
    notifyToggle.addEventListener("change", () => {
      root.classList.toggle("is-notify-off", !notifyToggle.checked);
    });
  }

  if (btnEmoji) {
    btnEmoji.addEventListener("click", (e) => {
      e.preventDefault();
      if (emojiPopOpen) closeEmojiPop();
      else openEmojiPop();
    });
  }

  if (btnCall) {
    btnCall.addEventListener("click", (e) => {
      e.preventDefault();
      openCallViewer({ audioOnly: true });
    });
  }

  if (btnVideo) {
    btnVideo.addEventListener("click", (e) => {
      e.preventDefault();
      openCallViewer({ video: true });
    });
  }

  if (callClose) callClose.addEventListener("click", () => closeCallViewer());
  const callHangup = document.getElementById("tc-call-hangup");
  if (callHangup) callHangup.addEventListener("click", () => closeCallViewer());
  if (callDialog) {
    callDialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      const embedded = window.ncTeamChatCall && typeof window.ncTeamChatCall.isEmbedded === "function" && window.ncTeamChatCall.isEmbedded();
      if (embedded) {
        try {
          if (callDialog.open) callDialog.close();
        } catch (_) {}
        return;
      }
      closeCallViewer();
    });
    callDialog.addEventListener("close", () => {
      // Embedding the call closes the dialog on purpose; keep the call running.
      const embedded = window.ncTeamChatCall && typeof window.ncTeamChatCall.isEmbedded === "function" && window.ncTeamChatCall.isEmbedded();
      if (embedded) return;
      if (window.ncTeamChatCall && typeof window.ncTeamChatCall.end === "function") {
        window.ncTeamChatCall.end(true);
      }
      if (callJitsiFrame) callJitsiFrame.src = "about:blank";
    });
  }

  if (fSearch) {
    fSearch.addEventListener("input", () => {
      if (searchTimer) window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => runChatSearch().catch(() => {}), 220);
    });
    fSearch.addEventListener("focus", () => runChatSearch().catch(() => {}));
  }

  // GIF picker (curated + upload)
  if (btnGif) {
    btnGif.addEventListener("click", (e) => {
      e.preventDefault();
      if (gifPopOpen) closeGifPop();
      else openGifPop();
    });
  }

  async function handlePickedFiles(files) {
    const file = files && files[0] ? files[0] : null;
    if (!file || !activeRoomId) return;
    const ct = String(file.type || "").toLowerCase();
    try {
      if (isUploading) return;
      isUploading = true;
      root.classList.add("is-uploading");
      if (ct.startsWith("image/")) {
        const url = await uploadChatImage(file);
        pendingImageUrl = url;
        pendingMediaLabel = ct.includes("gif") ? "GIF" : "Screenshot";
        pendingAttachment = null;
      } else {
        const up = await uploadChatFile(file);
        pendingAttachment = up;
        pendingImageUrl = "";
        pendingMediaLabel = "";
      }
      renderPending();
    } catch (_) {
      // ignore for now
    } finally {
      isUploading = false;
      root.classList.remove("is-uploading");
      try {
        fMsg && fMsg.focus();
      } catch (_) {}
    }
  }

  if (btnAttach) {
    btnAttach.addEventListener("click", (e) => {
      e.preventDefault();
      if (!activeRoomId) return;
      const pick = document.createElement("input");
      pick.type = "file";
      pick.style.position = "fixed";
      pick.style.left = "-9999px";
      document.body.appendChild(pick);
      pick.addEventListener(
        "change",
        async () => {
          try {
            await handlePickedFiles(pick.files);
          } finally {
            try {
              document.body.removeChild(pick);
            } catch (_) {}
          }
        },
        { once: true }
      );
      pick.click();
    });
  }

  // Drag & drop anywhere in the chat panel
  if (root) {
    root.addEventListener("dragover", (e) => {
      if (!e.dataTransfer) return;
      if (Array.from(e.dataTransfer.types || []).includes("Files")) {
        e.preventDefault();
        root.classList.add("is-dragover");
      }
    });
    root.addEventListener("dragleave", () => root.classList.remove("is-dragover"));
    root.addEventListener("drop", (e) => {
      root.classList.remove("is-dragover");
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      e.preventDefault();
      handlePickedFiles(e.dataTransfer.files).catch(() => {});
    });
  }

  document.addEventListener("click", (e) => {
    if (emojiPopOpen) {
      if (emojiPop && emojiPop.contains(e.target)) return;
      if (btnEmoji && btnEmoji.contains(e.target)) return;
      closeEmojiPop();
    }
    if (gifPopOpen) {
      if (gifPop && gifPop.contains(e.target)) return;
      if (btnGif && btnGif.contains(e.target)) return;
      closeGifPop();
    }
    if (searchOpen) {
      if (searchPop && searchPop.contains(e.target)) return;
      if (fSearch && fSearch.contains(e.target)) return;
      closeSearchPop();
    }
  });

  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (emojiPopOpen) closeEmojiPop();
    if (gifPopOpen) closeGifPop();
    if (searchOpen) closeSearchPop();
  });

  window.addEventListener("resize", () => {
    if (emojiPopOpen) positionEmojiPop();
    if (gifPopOpen) positionGifPop();
    if (searchOpen) positionSearchPop();
  });

  document.addEventListener("click", (e) => {
    if (!searchOpen || !searchPop) return;
    const b = e.target && e.target.closest ? e.target.closest("button.nc-tc-search-row[data-room-id]") : null;
    if (!b) return;
    const rid = b.getAttribute("data-room-id");
    if (!rid) return;
    closeSearchPop();
    try {
      fSearch && (fSearch.value = "");
    } catch (_) {}
    setActive(rid);
  });

  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (callDialog && callDialog.open) closeCallViewer();
  });

  if (thread && !thread.dataset.adminActs) {
    thread.dataset.adminActs = "1";
    thread.addEventListener("click", (e) => {
      const btn = e.target instanceof Element ? e.target.closest(".nc-tc-msg-act") : null;
      if (!btn || !activeRoomId) return;
      e.preventDefault();
      const act = btn.getAttribute("data-act");
      const msgId = Number(btn.getAttribute("data-msg-id") || 0);
      if (!msgId) return;
      if (act === "delete") {
        deleteMessage(msgId);
        return;
      }
      if (act === "mute") {
        muteMessage(msgId);
        return;
      }
      if (act === "edit") {
        const msg = (activeMessages || []).find((m) => Number(m.id) === msgId);
        if (msg && msg.muted) return;
        const cur = msg && msg.text && !String(msg.text).startsWith(ATTACH_PREFIX) ? msg.text : "";
        editMessage(msgId, cur);
      }
    });
  }

  if (btnDeleteRoom) {
    btnDeleteRoom.addEventListener("click", () => {
      deleteActiveRoom().catch(() => {});
    });
  }

  if (btnTitleEdit) {
    btnTitleEdit.addEventListener("click", (e) => {
      if (!canManageActive()) return;
      e.preventDefault();
      const el = document.getElementById("tc-right-name");
      if (!el) return;
      startInlineTitleEdit(el, {
        id: "tc-right-name",
        className: "nc-tc-right-name",
      });
    });
  }

  if (btnDlgTitleEdit) {
    btnDlgTitleEdit.addEventListener("click", (e) => {
      if (!canManageActive()) return;
      e.preventDefault();
      const el = document.getElementById("tc-dlg-name");
      if (!el) return;
      startInlineTitleEdit(el, {
        id: "tc-dlg-name",
        className: "nc-tc-right-name",
      });
    });
  }

  if (btnMembersAdd) {
    btnMembersAdd.addEventListener("click", () => {
      if (!dlgInvite || typeof dlgInvite.showModal !== "function") {
        window.alert("This browser cannot open the add-member dialog. Try a current version of Chrome, Firefox, or Safari.");
        return;
      }
      openInviteDialog().catch(() => {});
    });
  }

  if (btnInviteClose) btnInviteClose.addEventListener("click", () => closeInviteDialog());

  if (dlgInvite) {
    dlgInvite.addEventListener("cancel", (e) => {
      e.preventDefault();
      closeInviteDialog();
    });
  }

  if (fInviteSearch) {
    fInviteSearch.addEventListener("input", () => debounceInviteSearch());
  }

  if (elInviteList) {
    elInviteList.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest ? e.target.closest("button.nc-tc-invite-row[data-user-id]") : null;
      if (!btn || !btn.getAttribute("data-user-id")) return;
      const uid = Number(btn.getAttribute("data-user-id"));
      if (!Number.isFinite(uid)) return;
      addMemberById(uid).catch((err) => {
        window.alert(String(err && err.message ? err.message : err) || "Could not add member.");
      });
    });
  }

  if (rMembers) {
    rMembers.addEventListener("click", (e) => {
      const rm = e.target && e.target.closest ? e.target.closest(".nc-tc-member-rm[data-user-id]") : null;
      if (!rm) return;
      const uid = rm.getAttribute("data-user-id");
      if (!uid) return;
      removeMember(Number(uid)).catch(() => {});
    });
  }

  if (thread) {
    thread.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest ? e.target.closest("button.nc-tc-imgbtn[data-src]") : null;
      if (!btn) return;
      const src = String(btn.getAttribute("data-src") || "").trim();
      if (!src) return;
      openImage(src);
    });
  }

  if (btnNew) {
    btnNew.addEventListener("click", async () => {
      const title = (window.prompt("Chat name") || "").trim();
      if (!title) return;
      try {
        const j = await api("/chat/rooms", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        });
        await loadRooms();
        if (j && j.room && j.room.id != null) setActive(j.room.id);
      } catch (e) {
        window.alert(String(e && e.message ? e.message : e) || "Could not create chat.");
      }
    });
  }

  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!activeRoomId || !fMsg) return;
      const t = String(fMsg.value || "").trim();
      const img = String(pendingImageUrl || "").trim();
      const att = pendingAttachment;
      if (!t && !img && !att) return;
      fMsg.value = "";
      try {
        if (t) {
          await api(`/chat/rooms/${activeRoomId}/messages`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: t, image_url: "" }),
          });
        }
        if (img) {
          await api(`/chat/rooms/${activeRoomId}/messages`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: "", image_url: img }),
          });
        }
        if (att && att.url) {
          await api(`/chat/rooms/${activeRoomId}/messages`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text: `${ATTACH_PREFIX}${JSON.stringify({ name: att.name || "Attachment", url: att.url, size: att.size || 0 })}`,
              image_url: "",
            }),
          });
        }
        pendingImageUrl = "";
        pendingMediaLabel = "";
        pendingAttachment = null;
        renderPending();
        const roomChanged = await loadRooms();
        if (roomChanged && activeRoomId) await refreshActive(true).catch(() => {});
        await loadMessages(false);
      } catch (_) {}
    });
  }

  if (fMsg) {
    fMsg.addEventListener("paste", async (e) => {
      const dt = e.clipboardData;
      if (!dt || !dt.items) return;
      const items = Array.from(dt.items || []);
      const imgItem = items.find((it) => it && it.kind === "file" && String(it.type || "").startsWith("image/"));
      if (!imgItem) return;
      const file = imgItem.getAsFile ? imgItem.getAsFile() : null;
      if (!file || !activeRoomId) return;
      e.preventDefault();
      if (isUploading) return;
      isUploading = true;
      root.classList.add("is-uploading");
      try {
        const url = await uploadChatImage(file);
        pendingImageUrl = url;
        pendingAttachment = null;
        renderPending();
      } catch (_) {
        // ignore for now
      } finally {
        isUploading = false;
        root.classList.remove("is-uploading");
      }
    });
  }

  (async () => {
    setDetailsOpen(!isTcMobile());
    try {
      await loadRooms();
      if (activeRoomId) await refreshActive(true);
      renderPending();
      startPolling();
      syncTcMobilePane();
    } catch (_) {}
  })();

  window.addEventListener("popstate", () => {
    const st = history.state && typeof history.state === "object" ? history.state : null;
    if (st && st.viewer && st.viewer.kind === "call") {
      // reopened by history navigation is not supported; just ensure it's open
      return;
    }
    if (callDialog && callDialog.open) closeCallViewer({ popHistory: false });
  });
})();
