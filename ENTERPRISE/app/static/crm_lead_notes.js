(function () {
  const root = document.getElementById("crm-notes-chat-root");
  if (!root) return;

  const leadId = root.getAttribute("data-lead-id");
  const threadEl = document.getElementById("crm-notes-thread");
  const inputEl = document.getElementById("crm-notes-input");
  const sendBtn = document.getElementById("crm-notes-send");
  const statusEl = document.getElementById("crm-notes-status");
  let loading = false;
  let pendingAttachments = []; // [{url,name,size,is_image}]

  function setStatus(t) {
    if (statusEl) statusEl.textContent = t || "";
  }

  function fmtWhen(iso) {
    if (!iso) return "";
    try {
      const ms = Date.parse(iso);
      if (Number.isNaN(ms)) return iso;
      const tz = root.getAttribute("data-time-zone") || "";
      const off = Number(root.getAttribute("data-time-offset-ms") || 0) || 0;
      const dd = new Date(ms + off);
      if (tz && typeof Intl !== "undefined") {
        return new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: tz,
        }).format(dd);
      }
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(ms));
    } catch {
      return iso;
    }
  }

  function appendNote(n, { scrollBottom } = { scrollBottom: true }) {
    if (!threadEl || !n) return;
    const row = document.createElement("div");
    row.className = "nc-crm-notes-msg" + (n.mine ? " is-mine" : "");
    row.setAttribute("data-note-id", String(n.id));

    const av = document.createElement("div");
    av.className = "nc-crm-notes-av";
    av.setAttribute("aria-hidden", "true");
    av.textContent = (n.author_initials || "?").slice(0, 2);

    const bubble = document.createElement("div");
    bubble.className = "nc-crm-notes-bub";

    const meta = document.createElement("div");
    meta.className = "nc-crm-notes-meta";

    const who = document.createElement("span");
    who.className = "nc-crm-notes-author";
    who.textContent = n.author || "User";

    const when = document.createElement("span");
    when.className = "nc-crm-notes-ts";
    when.textContent = fmtWhen(n.created_at);

    meta.appendChild(who);
    meta.appendChild(document.createTextNode(" · "));
    meta.appendChild(when);

    const body = document.createElement("div");
    body.className = "nc-crm-notes-body";
    body.textContent = n.body || "";

    bubble.appendChild(meta);
    bubble.appendChild(body);

    const atts = Array.isArray(n.attachments) ? n.attachments : [];
    if (atts.length) {
      const wrap = document.createElement("div");
      wrap.className = "nc-crm-notes-atts";
      for (const a of atts.slice(0, 20)) {
        if (!a || !a.url) continue;
        const url = String(a.url || "");
        const name = String(a.name || "");
        const isImg = !!a.is_image;

        if (isImg) {
          const img = document.createElement("img");
          img.className = "nc-crm-notes-img";
          img.src = url;
          img.alt = name || "Image";
          img.setAttribute("data-fullimg", "1");
          wrap.appendChild(img);
        } else {
          const link = document.createElement("a");
          link.className = "nc-crm-notes-att";
          link.href = url;
          link.target = "_blank";
          link.rel = "noreferrer";
          link.textContent = name || "Attachment";
          wrap.appendChild(link);
        }
      }
      bubble.appendChild(wrap);
    }

    row.appendChild(av);
    row.appendChild(bubble);
    threadEl.appendChild(row);

    if (scrollBottom) threadEl.scrollTop = threadEl.scrollHeight;
  }

  function renderEmptyHint() {
    if (!threadEl) return;
    const p = document.createElement("div");
    p.className = "nc-crm-notes-empty";
    p.textContent = "No notes yet. Add one below.";
    threadEl.appendChild(p);
  }

  async function load() {
    if (!leadId) return;
    setStatus("");
    loading = true;
    if (threadEl) threadEl.innerHTML = "";
    try {
      const r = await fetch(`/intranet/api/crm/leads/${leadId}/notes`, {
        credentials: "same-origin",
      });
      if (!r.ok) {
        setStatus("Could not load notes.");
        loading = false;
        return;
      }
      const j = await r.json();
      const list = Array.isArray(j.notes) ? j.notes : [];
      if (list.length === 0) renderEmptyHint();
      else list.forEach((n) => appendNote(n, { scrollBottom: false }));
      if (threadEl) threadEl.scrollTop = threadEl.scrollHeight;
    } catch {
      setStatus("Could not load notes.");
    } finally {
      loading = false;
    }
  }

  async function send() {
    if (!leadId || !inputEl) return;
    const body = String(inputEl.value || "").trim();
    const atts = Array.isArray(pendingAttachments) ? pendingAttachments : [];
    if (!body && atts.length === 0) return;
    setStatus("");
    if (sendBtn) sendBtn.disabled = true;
    inputEl.disabled = true;
    try {
      const r = await fetch(`/intranet/api/crm/leads/${leadId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ body, attachments: atts }),
      });
      if (!r.ok) {
        setStatus("Could not save note.");
        return;
      }
      const j = await r.json();
      const empties = threadEl ? threadEl.querySelectorAll(".nc-crm-notes-empty") : [];
      empties.forEach((el) => el.remove());
      if (j.note) appendNote(j.note, { scrollBottom: true });
      inputEl.value = "";
      pendingAttachments = [];
      inputEl.focus();
    } catch {
      setStatus("Could not save note.");
    } finally {
      if (sendBtn) sendBtn.disabled = false;
      if (inputEl) inputEl.disabled = false;
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

  function pushPendingAttachment(att) {
    if (!att || !att.url) return;
    pendingAttachments = Array.isArray(pendingAttachments) ? pendingAttachments : [];
    pendingAttachments.push(att);
    setStatus(`Attached: ${att.name || "file"}${att.size ? " (" + formatBytes(att.size) + ")" : ""}`);
    setTimeout(() => setStatus(""), 1400);
  }

  if (sendBtn) sendBtn.addEventListener("click", send);
  if (inputEl) {
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });

    inputEl.addEventListener("paste", async (e) => {
      try {
        const cd = e.clipboardData;
        if (!cd || !cd.items || !cd.items.length) return;
        const items = [...cd.items];
        const imgItem = items.find((it) => it.kind === "file" && String(it.type || "").startsWith("image/"));
        if (!imgItem) return;
        const file = imgItem.getAsFile();
        if (!file) return;
        e.preventDefault();
        setStatus("Uploading image…");
        const url = await uploadChatImage(file);
        pushPendingAttachment({ url, name: String(file.name || "screenshot.png"), size: file.size || 0, is_image: true });
      } catch {
        setStatus("Could not attach image.");
      }
    });

    inputEl.addEventListener("dragover", (e) => {
      if (!e.dataTransfer) return;
      const hasFiles = Array.from(e.dataTransfer.types || []).includes("Files");
      if (!hasFiles) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });

    inputEl.addEventListener("drop", async (e) => {
      try {
        if (!e.dataTransfer) return;
        const files = Array.from(e.dataTransfer.files || []);
        if (!files.length) return;
        e.preventDefault();
        const file = files[0];
        const isImg = String(file.type || "").startsWith("image/");
        setStatus(isImg ? "Uploading image…" : "Uploading file…");
        if (isImg) {
          const url = await uploadChatImage(file);
          pushPendingAttachment({ url, name: String(file.name || "image.png"), size: file.size || 0, is_image: true });
        } else {
          const up = await uploadChatFile(file);
          pushPendingAttachment({ url: up.url, name: up.name, size: up.size, is_image: false });
        }
      } catch {
        setStatus("Could not attach file.");
      } finally {
        setTimeout(() => setStatus(""), 1200);
      }
    });
  }

  if (threadEl) {
    threadEl.addEventListener("click", (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      const img = t.closest('img[data-fullimg="1"]');
      if (!img) return;
      const src = img.getAttribute("src") || "";
      if (!src) return;
      window.open(src, "_blank", "noopener");
    });
  }

  load();
})();
