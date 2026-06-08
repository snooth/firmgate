(function () {
  "use strict";

  const PHOTO_STORAGE_KEY = "dir.employeePhotos.v1";
  const NOTE_STORAGE_KEY = "dir.employeeNotes.v1";
  const dataEl = document.getElementById("nc-user-page-data");
  if (!dataEl) return;
  let cfg = {};
  try {
    cfg = JSON.parse(dataEl.textContent || "{}");
  } catch (_) {
    return;
  }

  function esc(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function loadPhotoStore() {
    try {
      const raw = window.localStorage.getItem(PHOTO_STORAGE_KEY);
      const j = raw ? JSON.parse(raw) : {};
      return j && typeof j === "object" ? j : {};
    } catch (_) {
      return {};
    }
  }

  function getPhotoFor(id) {
    const k = String(id || "");
    const store = loadPhotoStore();
    const v = store && typeof store === "object" ? String(store[k] || "") : "";
    return v && v.startsWith("data:image/") ? v : "";
  }

  function applyAvatarPhoto(el, id) {
    if (!el) return;
    const dataUrl = getPhotoFor(id);
    if (dataUrl) {
      el.classList.add("has-photo");
      el.style.backgroundImage = `url("${dataUrl}")`;
      el.textContent = "";
    }
  }

  const av = document.getElementById("nc-user-hero-avatar");
  if (av) applyAvatarPhoto(av, cfg.id);

  const dot = document.getElementById("nc-user-presence-dot");
  const label = document.getElementById("nc-user-presence-label");
  const timeEl = document.getElementById("nc-user-local-time");

  function applyPresence(presence) {
    const st = presence && presence.status ? String(presence.status) : "offline";
    const lbl = presence && presence.label ? String(presence.label) : "Offline";
    if (label) label.textContent = lbl;
    if (dot) {
      dot.classList.toggle("is-away", st === "away");
      dot.classList.toggle("is-offline", st === "offline");
    }
  }

  function formatLocalTime(tz) {
    try {
      return new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
        timeZone: tz || "Australia/Melbourne",
      }).format(new Date());
    } catch (_) {
      return new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    }
  }

  const tz = (cfg.timezone || "Australia/Melbourne").trim() || "Australia/Melbourne";
  if (timeEl) {
    const tick = () => {
      timeEl.textContent = formatLocalTime(tz);
    };
    tick();
    window.setInterval(tick, 30000);
  }

  if (cfg.presence) applyPresence(cfg.presence);

  if (cfg.id) {
    fetch(`/intranet/api/presence/status?ids=${encodeURIComponent(String(cfg.id))}`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : {}))
      .then((j) => {
        const items = j.items || [];
        const hit = items.find((x) => String(x.id) === String(cfg.id));
        if (hit && hit.presence) applyPresence(hit.presence);
      })
      .catch(() => {});
  }

  const notesList = document.getElementById("nc-user-notes-list");
  const noteText = document.getElementById("nc-user-note-text");
  const noteSend = document.getElementById("nc-user-note-send");
  const noteAttach = document.getElementById("nc-user-note-attach");
  const noteAttachImg = document.getElementById("nc-user-note-attach-img");
  const noteAttachX = document.getElementById("nc-user-note-attach-x");
  const imgViewer = document.getElementById("nc-user-img-viewer");
  const imgViewerEl = document.getElementById("nc-user-img-el");
  const imgViewerTitle = document.getElementById("nc-user-img-title");
  const imgViewerClose = document.getElementById("nc-user-img-close");
  const userId = String(cfg.id || "");
  const currentUser = String(cfg.current_user || "Member");
  let pendingImageData = "";
  let pendingImageName = "";

  function loadNotesStore() {
    try {
      return JSON.parse(window.localStorage.getItem(NOTE_STORAGE_KEY) || "{}") || {};
    } catch (_) {
      return {};
    }
  }

  function saveNotesStore(store) {
    try {
      window.localStorage.setItem(NOTE_STORAGE_KEY, JSON.stringify(store || {}));
    } catch (_) {}
  }

  function getNotesFor(id) {
    const store = loadNotesStore();
    const arr = store && Array.isArray(store[String(id)]) ? store[String(id)] : [];
    return arr.slice(0, 500);
  }

  function setNotesFor(id, notes) {
    const store = loadNotesStore();
    store[String(id)] = Array.isArray(notes) ? notes.slice(0, 500) : [];
    saveNotesStore(store);
  }

  function setPendingImage(dataUrl, name) {
    pendingImageData = String(dataUrl || "");
    pendingImageName = String(name || "");
    if (noteAttach && noteAttachImg) {
      if (pendingImageData) {
        noteAttach.hidden = false;
        noteAttachImg.src = pendingImageData;
      } else {
        noteAttach.hidden = true;
        noteAttachImg.removeAttribute("src");
      }
    }
  }

  function openImgViewer(src, title = "Image") {
    if (!imgViewer || !imgViewerEl) return;
    try {
      if (window.ncSyncViewerOffsets) window.ncSyncViewerOffsets();
    } catch (_) {}
    if (imgViewerTitle) imgViewerTitle.textContent = title;
    imgViewerEl.src = String(src || "");
    imgViewer.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function closeImgViewer() {
    if (!imgViewer || !imgViewerEl) return;
    imgViewer.hidden = true;
    imgViewerEl.removeAttribute("src");
    document.body.style.overflow = "";
  }

  function renderNotes() {
    if (!notesList || !userId) return;
    const notes = getNotesFor(userId);
    if (!notes.length) {
      notesList.innerHTML = `<div class="nc-sc2-chat-bubble">No notes yet.</div>`;
      return;
    }
    notesList.innerHTML = notes
      .map((n) => {
        const by = esc(n.by || "");
        const at = n.at ? new Date(n.at).toLocaleString() : "";
        const text = esc(n.text || "");
        const img = n && n.image_data ? String(n.image_data) : "";
        const att = n && n.attachment && n.attachment.url ? n.attachment : null;
        const isMe = String(n.by || "") === currentUser;
        const attHtml = att
          ? att.is_image
            ? `<div class="nc-sc2-chat-imgwrap"><img class="nc-sc2-chat-img" data-fullimg="1" alt="Attachment image" src="${esc(att.url)}"></div>`
            : `<div class="nc-sc2-chat-imgwrap"><a href="${esc(att.url)}" target="_blank" rel="noreferrer">${esc(
                att.name || "Attachment"
              )}</a></div>`
          : "";
        return `<div class="nc-sc2-chat-bubble ${isMe ? "is-me" : ""}">
          <div><span class="nc-sc2-chat-by">${by}</span><span class="nc-sc2-chat-at">${esc(at)}</span></div>
          ${text ? `<div class="nc-sc2-chat-text">${text}</div>` : ""}
          ${img ? `<div class="nc-sc2-chat-imgwrap"><img class="nc-sc2-chat-img" data-fullimg="1" alt="Pasted image" src="${esc(img)}"></div>` : ""}
          ${attHtml}
        </div>`;
      })
      .join("");
    notesList.scrollTop = notesList.scrollHeight;
  }

  if (notesList) {
    renderNotes();
    notesList.addEventListener("click", (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      const img = t.closest('img[data-fullimg="1"]');
      if (!img) return;
      const src = img.getAttribute("src") || "";
      if (src) openImgViewer(src, "Note image");
    });
  }

  if (imgViewerClose) imgViewerClose.addEventListener("click", () => closeImgViewer());

  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (imgViewer && !imgViewer.hidden) closeImgViewer();
  });

  if (noteSend && noteText && cfg.can_edit_workforce) {
    noteSend.addEventListener("click", () => {
      const text = String(noteText.value || "").trim();
      const img = String(pendingImageData || "");
      if (!text && !img) return;
      const notes = getNotesFor(userId);
      const note = { by: currentUser, at: new Date().toISOString(), text };
      if (img) {
        note.image_data = img;
        note.image_name = pendingImageName || "pasted-image";
      }
      notes.push(note);
      setNotesFor(userId, notes);
      noteText.value = "";
      setPendingImage("", "");
      renderNotes();
    });

    noteText.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey) return;
      e.preventDefault();
      noteSend.click();
    });

    noteText.addEventListener("paste", (e) => {
      try {
        const cd = e.clipboardData;
        if (!cd || !cd.items || !cd.items.length) return;
        const items = [...cd.items];
        const imgItem = items.find((it) => it.kind === "file" && String(it.type || "").startsWith("image/"));
        if (!imgItem) return;
        const file = imgItem.getAsFile();
        if (!file) return;
        e.preventDefault();
        const MAX_BYTES = 1500000;
        if (file.size && file.size > MAX_BYTES) {
          window.alert("Image is too large to store in notes. Please upload the file and link it instead.");
          return;
        }
        const fr = new FileReader();
        fr.onload = () => setPendingImage(String(fr.result || ""), file.name || "pasted-image");
        fr.readAsDataURL(file);
      } catch (_) {}
    });
  }

  if (noteAttachX) {
    noteAttachX.addEventListener("click", () => setPendingImage("", ""));
  }
})();
