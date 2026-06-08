(function () {
  "use strict";

  const root = document.getElementById("nc-aichat-root");
  if (!root) return;
  if (root.dataset.ncAichatInit === "1") return;
  root.dataset.ncAichatInit = "1";

  const configured = root.dataset.configured === "1";
  const canDeleteConversations = root.dataset.canDelete === "1";
  const model = root.dataset.model || "gpt-4o-mini";
  const messagesEl = document.getElementById("nc-aichat-messages");
  const form = document.getElementById("nc-aichat-form");
  const input = document.getElementById("nc-aichat-input");
  const sendBtn = document.getElementById("nc-aichat-send");
  const metaEl = document.getElementById("nc-aichat-meta");
  const historyEl = document.getElementById("nc-aichat-history");
  const newChatBtn = document.getElementById("nc-aichat-new-chat");
  const chatSection = document.getElementById("nc-aichat-chat");
  const attachStrip = document.getElementById("nc-aichat-attachments");
  const fileInput = document.getElementById("nc-aichat-file-input");
  const ctxBackdrop = document.getElementById("nc-aichat-ctx-backdrop");
  const ctxMenu = document.getElementById("nc-aichat-ctx-menu");

  let conversations = [];
  let ctxConversationId = null;
  let activeConversationId = null;
  /** @type {{ id: string, file: File, name: string, isImage: boolean, previewUrl: string }[]} */
  let pendingFiles = [];
  let pendingIdSeq = 0;
  let dragDepth = 0;

  async function api(path, opts) {
    const r = await fetch(`/intranet/api${path}`, { credentials: "same-origin", ...opts });
    const j = await r.json().catch(() => ({}));
    return { r, j };
  }

  const fmt = window.NcAiChatFormat || {};
  const escapeHtml =
    (fmt.escapeHtml && fmt.escapeHtml.bind(fmt)) ||
    ((s) =>
      String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;"));

  function ensureStreamClient() {
    if (window.NcAiStreamClient && window.NcAiStreamClient.consumeSseStream) {
      return window.NcAiStreamClient;
    }
    const client = {
      escapeHtml,
      async consumeSseStream(response, handlers) {
        const onToken = handlers.onToken || (() => {});
        const onDone = handlers.onDone || (() => {});
        const onError = handlers.onError || (() => {});
        if (!response.ok) {
          const j = await response.json().catch(() => ({}));
          onError(j.error || `Request failed (${response.status}).`);
          return;
        }
        const ct = (response.headers.get("content-type") || "").toLowerCase();
        if (!ct.includes("text/event-stream") || !response.body) {
          const j = await response.json().catch(() => ({}));
          if (j.ok && j.answer != null) {
            onDone(j);
            return;
          }
          onError(j.error || "Unexpected response.");
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let fullText = "";
        let streamFinished = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            for (const line of block.split("\n")) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) continue;
              const raw = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed.slice(5).trim();
              if (!raw) continue;
              let payload;
              try {
                payload = JSON.parse(raw);
              } catch (_e) {
                continue;
              }
              if (payload.type === "token" && payload.content) {
                fullText += payload.content;
                onToken(fullText);
              } else if (payload.type === "done") {
                streamFinished = true;
                onDone(payload);
              } else if (payload.type === "error") {
                streamFinished = true;
                onError(payload.error || "Request failed.");
              }
            }
          }
        }
        if (!streamFinished && fullText) onDone({ ok: true, answer: fullText });
      },
      createStreamingBubble(container, thinkingText) {
        const wrap = document.createElement("div");
        wrap.className = "nc-ads-msg nc-ads-msg--assistant nc-ads-msg--pending";
        const bubble = document.createElement("div");
        bubble.className = "nc-ads-bubble nc-ads-prose nc-aichat-streaming";
        bubble.innerHTML = `<p class="nc-ads-thinking">${escapeHtml(thinkingText || "Thinking…")}</p>`;
        wrap.appendChild(bubble);
        if (container) {
          container.appendChild(wrap);
          container.scrollTop = container.scrollHeight;
        }
        return { wrap, bubble };
      },
      setStreamingPlainText(bubble, text, scrollContainer) {
        if (!bubble) return;
        bubble.innerHTML = text
          ? `<div class="nc-aichat-stream-text">${escapeHtml(text).replace(/\n/g, "<br>")}</div>`
          : '<p class="nc-ads-thinking">Thinking…</p>';
        const scrollEl = scrollContainer && scrollContainer.isConnected ? scrollContainer : bubble.closest(".nc-ads-messages");
        if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
      },
      paintStreamingUpdate(bubble, text, scrollContainer) {
        client.setStreamingPlainText(bubble, text, scrollContainer);
      },
      finalizeAssistantBubble(wrap, bubble, text, formatHtml) {
        if (wrap) wrap.classList.remove("nc-ads-msg--pending");
        if (bubble) bubble.classList.remove("nc-aichat-streaming");
        if (!bubble) return;
        bubble.innerHTML = typeof formatHtml === "function" ? formatHtml(text) : `<p>${escapeHtml(text)}</p>`;
        if (typeof fmt.wireCodeCopyButtons === "function") fmt.wireCodeCopyButtons(bubble);
      },
    };
    window.NcAiStreamClient = client;
    return client;
  }

  const stream = ensureStreamClient();
  const consumeChatStream = stream.consumeSseStream;
  const paintToken = stream.paintStreamingUpdate || stream.setStreamingPlainText;

  async function chatBlockingFallback({ message, conversationId, files }) {
    if (files && files.length) {
      const fd = new FormData();
      fd.append("message", message);
      fd.append("conversation_id", String(conversationId));
      files.forEach((p) => fd.append("file", p.file, p.name));
      const r = await fetch("/intranet/api/ai-chatbot/chat", {
        method: "POST",
        credentials: "same-origin",
        body: fd,
      });
      return r.json().then((j) => ({ r, j }));
    }
    const r = await fetch("/intranet/api/ai-chatbot/chat", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, conversation_id: conversationId }),
    });
    return r.json().then((j) => ({ r, j }));
  }
  let activeChatAbort = null;

  document.addEventListener("turbo:before-render", () => {
    if (activeChatAbort) {
      activeChatAbort.abort();
      activeChatAbort = null;
    }
  });

  function formatAnswer(text) {
    return typeof fmt.formatAssistantMessage === "function"
      ? fmt.formatAssistantMessage(text)
      : `<p>${escapeHtml(text)}</p>`;
  }

  function scrollMessagesToEnd() {
    if (!messagesEl) return;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function formatBytes(n) {
    const b = Number(n) || 0;
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  }

  function renderAttachmentsHtml(attachments) {
    if (!attachments || !attachments.length) return "";
    return attachments
      .map((a) => {
        const name = escapeHtml(a.name || "file");
        if (a.preview && a.kind === "image") {
          return `<figure class="nc-aichat-msg-attach nc-aichat-msg-attach--img">
            <img src="${escapeHtml(a.preview)}" alt="${name}" loading="lazy" />
            <figcaption>${name}</figcaption>
          </figure>`;
        }
        const excerpt = a.excerpt ? `<p class="nc-aichat-msg-attach-excerpt">${escapeHtml(a.excerpt)}</p>` : "";
        return `<div class="nc-aichat-msg-attach nc-aichat-msg-attach--file">
          <span class="nc-aichat-msg-attach-name">📎 ${name}</span>${excerpt}
        </div>`;
      })
      .join("");
  }

  function appendMessage(role, html, extraClass, attachments) {
    const wrap = document.createElement("div");
    wrap.className = `nc-ads-msg nc-ads-msg--${role}${extraClass ? ` ${extraClass}` : ""}`;
    const bubble = document.createElement("div");
    bubble.className = role === "assistant" ? "nc-ads-bubble nc-ads-prose" : "nc-ads-bubble";
    bubble.innerHTML = html + renderAttachmentsHtml(attachments);
    if (typeof fmt.wireCodeCopyButtons === "function") {
      fmt.wireCodeCopyButtons(bubble);
    }
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    scrollMessagesToEnd();
    return wrap;
  }

  function applyConversationUpdate(payload) {
    if (!payload || !payload.conversation) return;
    const idx = conversations.findIndex((c) => c.id === activeConversationId);
    const row = {
      id: payload.conversation.id,
      title: payload.conversation.title || "New chat",
      updated_at: payload.conversation.updated_at,
      message_count: (payload.conversation.messages || []).length,
    };
    if (idx >= 0) {
      conversations[idx] = row;
      conversations.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    } else {
      conversations.unshift(row);
    }
    renderHistoryList();
  }

  async function sendChatStream({ message, conversationId, files, signal }) {
    const opts = { method: "POST", credentials: "same-origin", signal };
    if (files && files.length) {
      const fd = new FormData();
      fd.append("message", message);
      fd.append("conversation_id", String(conversationId));
      files.forEach((p) => fd.append("file", p.file, p.name));
      return fetch("/intranet/api/ai-chatbot/chat/stream", { ...opts, body: fd });
    }
    return fetch("/intranet/api/ai-chatbot/chat/stream", {
      ...opts,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, conversation_id: conversationId }),
    });
  }

  function formatRelativeTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const diff = Date.now() - d.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString();
  }

  function closeConversationContextMenu() {
    ctxConversationId = null;
    if (ctxMenu) {
      ctxMenu.hidden = true;
      ctxMenu.innerHTML = "";
    }
    if (ctxBackdrop) ctxBackdrop.hidden = true;
  }

  function openConversationContextMenu(x, y, conversationId) {
    if (!canDeleteConversations || !ctxMenu || !ctxBackdrop || !conversationId) return;
    closeConversationContextMenu();
    ctxConversationId = conversationId;
    const conv = conversations.find((c) => Number(c.id) === Number(conversationId));
    const title = conv && conv.title ? conv.title : "this conversation";

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.textContent = "Delete";
    deleteBtn.dataset.danger = "1";
    deleteBtn.addEventListener("click", () => {
      closeConversationContextMenu();
      void deleteConversation(conversationId, title);
    });
    ctxMenu.appendChild(deleteBtn);

    ctxMenu.style.top = `${Math.min(y, window.innerHeight - 80)}px`;
    ctxMenu.style.left = `${Math.min(x, window.innerWidth - 180)}px`;
    ctxMenu.hidden = false;
    ctxBackdrop.hidden = false;
  }

  async function deleteConversation(id, titleHint) {
    const conv = conversations.find((c) => Number(c.id) === Number(id));
    const label = titleHint || (conv && conv.title) || "this conversation";
    if (!window.confirm(`Delete "${label}"? This cannot be undone.`)) return;
    const { r, j } = await api(`/ai-chatbot/conversations/${id}`, { method: "DELETE" });
    if (!r.ok || !j.ok) {
      window.alert(j.error || "Could not delete conversation.");
      return;
    }
    conversations = conversations.filter((c) => Number(c.id) !== Number(id));
    if (Number(activeConversationId) === Number(id)) {
      activeConversationId = null;
      clearPendingFiles();
      clearMessages();
      if (conversations.length) {
        await switchConversation(conversations[0].id);
      } else {
        await createConversation();
      }
      return;
    }
    renderHistoryList();
  }

  function renderHistoryList() {
    if (!historyEl) return;
    if (!conversations.length) {
      historyEl.innerHTML = '<p class="nc-ads-history-empty nc-detail-muted">No conversations yet.</p>';
      return;
    }
    historyEl.innerHTML = conversations
      .map((c) => {
        const active = c.id === activeConversationId;
        const title = escapeHtml(c.title || "New chat");
        const when = escapeHtml(formatRelativeTime(c.updated_at));
        const adminClass = canDeleteConversations ? " nc-ads-history-item--admin" : "";
        return `<button type="button" class="nc-ads-history-item${active ? " is-active" : ""}${adminClass}" data-id="${escapeHtml(
          String(c.id)
        )}" role="option" aria-selected="${active ? "true" : "false"}">
          <span class="nc-ads-history-title">${title}</span>
          <span class="nc-ads-history-meta">${when}</span>
        </button>`;
      })
      .join("");
    historyEl.querySelectorAll(".nc-ads-history-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = Number(btn.getAttribute("data-id"));
        if (id) void switchConversation(id);
      });
      if (canDeleteConversations) {
        btn.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          const id = Number(btn.getAttribute("data-id"));
          if (id) openConversationContextMenu(e.clientX, e.clientY, id);
        });
      }
    });
  }

  function clearMessages() {
    if (messagesEl) messagesEl.innerHTML = "";
  }

  function renderConversationMessages(messages) {
    clearMessages();
    const list = Array.isArray(messages) ? messages : [];
    list.forEach((m) => {
      const role = String(m.role || "").toLowerCase();
      if (role === "user") {
        const text = String(m.content || "").trim();
        const body = text ? `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>` : "";
        appendMessage("user", body, undefined, m.attachments);
      } else if (role === "assistant") {
        const extra = m.welcome ? " nc-ads-msg--welcome" : "";
        const body = m.welcome
          ? `<p>${escapeHtml(m.content)}</p><p class="nc-ads-muted">Type a message below — you can paste screenshots or drop files.</p>`
          : formatAnswer(m.content);
        appendMessage("assistant", body, extra.trim() || undefined);
      }
    });
    if (!list.length) {
      appendMessage(
        "assistant",
        `<p>Hello! I'm your intranet AI assistant. How can I help you today?</p><p class="nc-ads-muted">Type a message, paste a screenshot, or drop files below.</p>`,
        "nc-ads-msg--welcome"
      );
    }
  }

  function revokePendingPreview(item) {
    if (item && item.previewUrl && item.previewUrl.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(item.previewUrl);
      } catch (_e) {
        /* ignore */
      }
    }
  }

  function clearPendingFiles() {
    pendingFiles.forEach(revokePendingPreview);
    pendingFiles = [];
    renderPendingStrip();
  }

  function renderPendingStrip() {
    if (!attachStrip) return;
    if (!pendingFiles.length) {
      attachStrip.hidden = true;
      attachStrip.innerHTML = "";
      chatSection?.classList.remove("has-pending-attachments");
      return;
    }
    attachStrip.hidden = false;
    chatSection?.classList.add("has-pending-attachments");
    attachStrip.innerHTML = pendingFiles
      .map((p) => {
        const name = escapeHtml(p.name);
        const thumb =
          p.isImage && p.previewUrl
            ? `<img class="nc-aichat-pending-thumb" src="${escapeHtml(p.previewUrl)}" alt="" />`
            : `<span class="nc-aichat-pending-file-icon" aria-hidden="true">📄</span>`;
        return `<div class="nc-aichat-pending-item" data-id="${escapeHtml(p.id)}">
          ${thumb}
          <span class="nc-aichat-pending-name" title="${name}">${name}</span>
          <span class="nc-aichat-pending-size">${escapeHtml(formatBytes(p.file.size))}</span>
          <button type="button" class="nc-aichat-pending-remove" data-id="${escapeHtml(p.id)}" aria-label="Remove ${name}">×</button>
        </div>`;
      })
      .join("");
    attachStrip.querySelectorAll(".nc-aichat-pending-remove").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-id");
        const idx = pendingFiles.findIndex((p) => p.id === id);
        if (idx >= 0) {
          revokePendingPreview(pendingFiles[idx]);
          pendingFiles.splice(idx, 1);
          renderPendingStrip();
        }
      });
    });
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("read failed"));
      reader.readAsDataURL(file);
    });
  }

  function addPendingFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const room = 8 - pendingFiles.length;
    if (room <= 0) {
      window.alert("Maximum 8 attachments per message.");
      return;
    }
    files.slice(0, room).forEach((file) => {
      const isImage = String(file.type || "").startsWith("image/");
      const previewUrl = isImage ? URL.createObjectURL(file) : "";
      pendingFiles.push({
        id: `p${++pendingIdSeq}`,
        file,
        name: file.name || (isImage ? "image.png" : "file"),
        isImage,
        previewUrl,
      });
    });
    if (files.length > room) {
      window.alert(`Only ${room} more file(s) added (max 8 per message).`);
    }
    renderPendingStrip();
  }

  function setDragHighlight(on) {
    chatSection?.classList.toggle("is-dragover", on);
  }

  async function loadConversations() {
    const { r, j } = await api("/ai-chatbot/conversations", { method: "GET" });
    if (!r.ok || !j.ok) {
      if (historyEl) {
        historyEl.innerHTML = `<p class="nc-ads-history-empty nc-detail-muted">${escapeHtml(
          j.error || "Could not load conversations."
        )}</p>`;
      }
      return null;
    }
    conversations = j.conversations || [];
    return conversations;
  }

  async function createConversation() {
    const { r, j } = await api("/ai-chatbot/conversations", { method: "POST" });
    if (!r.ok || !j.ok || !j.conversation) {
      return null;
    }
    const conv = j.conversation;
    conversations = [{ id: conv.id, title: conv.title, updated_at: conv.updated_at, message_count: 0 }, ...conversations];
    activeConversationId = conv.id;
    renderHistoryList();
    renderConversationMessages(conv.messages || []);
    return conv;
  }

  async function switchConversation(id) {
    if (id === activeConversationId) return;
    clearPendingFiles();
    const { r, j } = await api(`/ai-chatbot/conversations/${id}`, { method: "GET" });
    if (!r.ok || !j.ok || !j.conversation) {
      return;
    }
    activeConversationId = j.conversation.id;
    renderHistoryList();
    renderConversationMessages(j.conversation.messages || []);
    if (input) input.focus();
  }

  async function ensureActiveConversation() {
    await loadConversations();
    if (conversations.length) {
      const pick =
        activeConversationId && conversations.some((c) => c.id === activeConversationId)
          ? activeConversationId
          : conversations[0].id;
      await switchConversation(pick);
      return;
    }
    await createConversation();
  }

  newChatBtn?.addEventListener("click", () => {
    clearPendingFiles();
    void createConversation();
  });

  if (canDeleteConversations && ctxBackdrop) {
    ctxBackdrop.addEventListener("click", closeConversationContextMenu);
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape") closeConversationContextMenu();
      },
      true
    );
    window.addEventListener(
      "scroll",
      () => {
        if (ctxMenu && !ctxMenu.hidden) closeConversationContextMenu();
      },
      true
    );
  }

  void ensureActiveConversation();

  if (metaEl && configured) {
    metaEl.textContent = `Model: ${model}`;
  }

  fileInput?.addEventListener("change", () => {
    if (fileInput.files && fileInput.files.length) {
      addPendingFiles(fileInput.files);
    }
    fileInput.value = "";
  });

  if (chatSection && configured) {
    chatSection.addEventListener("dragenter", (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes("Files")) return;
      e.preventDefault();
      dragDepth += 1;
      setDragHighlight(true);
    });
    chatSection.addEventListener("dragover", (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setDragHighlight(true);
    });
    chatSection.addEventListener("dragleave", (e) => {
      e.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setDragHighlight(false);
    });
    chatSection.addEventListener("drop", (e) => {
      e.preventDefault();
      dragDepth = 0;
      setDragHighlight(false);
      if (e.dataTransfer?.files?.length) addPendingFiles(e.dataTransfer.files);
    });
  }

  if (!configured || !form || !input) return;

  input.addEventListener("paste", (e) => {
    const cd = e.clipboardData;
    if (!cd || !cd.items || !cd.items.length) return;
    const items = Array.from(cd.items);
    const imgItem = items.find((it) => it.kind === "file" && String(it.type || "").startsWith("image/"));
    if (!imgItem) return;
    const file = imgItem.getAsFile ? imgItem.getAsFile() : null;
    if (!file) return;
    e.preventDefault();
    const name = file.name && file.name !== "image.png" ? file.name : `screenshot-${Date.now()}.png`;
    addPendingFiles([new File([file], name, { type: file.type || "image/png" })]);
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = (input.value || "").trim();
    if ((!text && !pendingFiles.length) || !activeConversationId) return;
    const filesToSend = pendingFiles.slice();
    const convId = activeConversationId;
    input.value = "";
    input.disabled = true;
    if (sendBtn) sendBtn.disabled = true;

    const userHtml = text ? `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>` : "";
    appendMessage("user", userHtml);

    const msgBox = document.getElementById("nc-aichat-messages");
    const streaming =
      stream.createStreamingBubble && stream.createStreamingBubble(msgBox, "Thinking…");
    if (!streaming || !streaming.bubble) {
      input.disabled = false;
      if (sendBtn) sendBtn.disabled = false;
      return;
    }

    if (activeChatAbort) activeChatAbort.abort();
    activeChatAbort = new AbortController();
    const { signal } = activeChatAbort;

    let streamDone = false;

    const previewAttsPromise = Promise.all(
      filesToSend.map(async (p) => {
        const att = { name: p.name, kind: p.isImage ? "image" : "file" };
        if (p.isImage) {
          try {
            att.preview = await fileToDataUrl(p.file);
          } catch (_e) {
            /* no preview */
          }
        }
        return att;
      })
    ).then((atts) => {
      clearPendingFiles();
      if (atts.length && streaming.wrap && streaming.wrap.isConnected) {
        const userBubble = streaming.wrap.previousElementSibling;
        const bubble = userBubble && userBubble.querySelector(".nc-ads-bubble");
        if (bubble) {
          const attachHtml = atts
            .map((a) => {
              const name = escapeHtml(a.name || "file");
              if (a.preview && a.kind === "image") {
                return `<figure class="nc-aichat-msg-attach nc-aichat-msg-attach--img"><img src="${escapeHtml(
                  a.preview
                )}" alt="${name}" loading="lazy" /><figcaption>${name}</figcaption></figure>`;
              }
              return `<div class="nc-aichat-msg-attach nc-aichat-msg-attach--file"><span class="nc-aichat-msg-attach-name">📎 ${name}</span></div>`;
            })
            .join("");
          bubble.innerHTML = (text ? `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>` : "") + attachHtml;
        }
      }
    });

    const CHAT_TIMEOUT_MS = 180000;
    const timeoutId = window.setTimeout(() => activeChatAbort.abort(), CHAT_TIMEOUT_MS);

    async function finishWithAnswer(payload, answer) {
      streamDone = true;
      if (!streaming.bubble.isConnected) return;
      if (stream.finalizeAssistantBubble) {
        stream.finalizeAssistantBubble(streaming.wrap, streaming.bubble, answer, formatAnswer);
      }
      applyConversationUpdate(payload);
    }

    async function showChatError(errMsg) {
      streamDone = true;
      if (streaming.wrap.isConnected) streaming.wrap.remove();
      appendMessage("assistant", `<p class="nc-ads-error">${escapeHtml(errMsg || "Request failed.")}</p>`);
    }

    async function tryBlockingFallback() {
      const { r, j } = await chatBlockingFallback({
        message: text,
        conversationId: convId,
        files: filesToSend,
      });
      if (!r.ok || !j.ok) {
        await showChatError(j.error || "Request failed.");
        return;
      }
      await finishWithAnswer(j, j.answer || "");
    }

    try {
      await previewAttsPromise;
      let streamError = null;
      try {
        const response = await sendChatStream({
          message: text,
          conversationId: convId,
          files: filesToSend,
          signal,
        });
        await new Promise((resolve, reject) => {
          let settled = false;
          const done = () => {
            if (!settled) {
              settled = true;
              resolve();
            }
          };
          consumeChatStream(response, {
            onToken(fullText) {
              if (!streaming.bubble.isConnected) return;
              paintToken(streaming.bubble, fullText, msgBox);
            },
            onDone(payload) {
              const answer = (payload && payload.answer) || "";
              void finishWithAnswer(payload, answer).then(done);
            },
            onError(errMsg) {
              streamError = errMsg || "Request failed.";
              done();
            },
          }).catch((e) => {
            streamError = e && e.message ? e.message : "Stream failed.";
            done();
          });
        });
      } catch (err) {
        if (err && err.name === "AbortError") {
          streamError = "Request timed out. Check AI Settings and your LLM server, then try again.";
        } else {
          streamError = (err && err.message) || "Network error.";
        }
      }

      if (!streamDone) {
        if (streaming.bubble && streaming.bubble.isConnected) {
          streaming.bubble.innerHTML = '<p class="nc-ads-thinking">Retrying without streaming…</p>';
        }
        await tryBlockingFallback();
      }
    } catch (_err) {
      if (!streamDone) await showChatError("Network error. Try again.");
    } finally {
      window.clearTimeout(timeoutId);
      activeChatAbort = null;
      input.disabled = false;
      if (sendBtn) sendBtn.disabled = false;
      input.focus();
    }
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
})();
