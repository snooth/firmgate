(function () {
  "use strict";

  const root = document.getElementById("nc-apa-root");
  if (!root) return;
  if (root.dataset.ncApaInit === "1") return;
  root.dataset.ncApaInit = "1";

  const configured = root.dataset.configured === "1";
  const model = root.dataset.model || "gpt-4o-mini";
  const messagesEl = document.getElementById("nc-apa-messages");
  const examplesEl = document.querySelector(".nc-apa-examples");
  const form = document.getElementById("nc-apa-form");
  const input = document.getElementById("nc-apa-input");
  const sendBtn = document.getElementById("nc-apa-send");
  const statsEl = document.getElementById("nc-apa-stats");
  const historyEl = document.getElementById("nc-apa-history");
  const newChatBtn = document.getElementById("nc-apa-new-chat");
  const docListEl = document.getElementById("nc-apa-doc-list");
  const fileInput = document.getElementById("nc-apa-file-input");
  const reindexBtn = document.getElementById("nc-apa-reindex");

  let conversations = [];
  let activeConversationId = null;
  let statusPayload = null;
  let chatInFlight = false;
  let initTask = null;
  let activeChatAbort = null;

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
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;"));

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
          if (j.ok && (j.answer != null || j.content != null)) {
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
                try {
                  onToken(fullText, payload);
                } catch (_e) {
                  /* ignore UI update errors */
                }
              } else if (payload.type === "status" && payload.content) {
                try {
                  onToken(fullText, payload);
                } catch (_e) {
                  /* ignore */
                }
              } else if (payload.type === "done") {
                streamFinished = true;
                try {
                  onDone(payload);
                } catch (handlerErr) {
                  onError((handlerErr && handlerErr.message) || "Could not render response.");
                }
              } else if (payload.type === "error") {
                streamFinished = true;
                onError(payload.error || "Request failed.");
              }
            }
          }
        }
        if (!streamFinished && fullText) {
          onDone({ ok: true, answer: fullText });
        } else if (!streamFinished) {
          onError("No response received.");
        }
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
        const scrollEl =
          scrollContainer && scrollContainer.isConnected
            ? scrollContainer
            : bubble.closest(".nc-ads-messages");
        if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
      },
      paintStreamingUpdate(bubble, text, scrollContainer) {
        client.setStreamingPlainText(bubble, text, scrollContainer);
      },
      finalizeAssistantBubble(wrap, bubble, text, formatHtml, afterRender) {
        if (wrap) wrap.classList.remove("nc-ads-msg--pending");
        if (bubble) bubble.classList.remove("nc-aichat-streaming");
        if (!bubble) return;
        const raw = String(text || "");
        let html =
          typeof formatHtml === "function"
            ? formatHtml(raw)
            : `<p>${escapeHtml(raw).replace(/\n/g, "<br>")}</p>`;
        if (!html && raw.trim()) {
          html = `<div class="nc-aichat-stream-text">${escapeHtml(raw).replace(/\n/g, "<br>")}</div>`;
        }
        bubble.innerHTML = html;
        if (typeof fmt.wireCodeCopyButtons === "function") {
          fmt.wireCodeCopyButtons(bubble);
        }
        if (typeof afterRender === "function") {
          afterRender(bubble);
        }
      },
      postJsonSseStream(url, body) {
        return fetch(url, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      },
    };
    window.NcAiStreamClient = client;
    return client;
  }

  const stream = ensureStreamClient();
  const consumeSseStream = stream.consumeSseStream;
  const postJsonSseStream = stream.postJsonSseStream;
  const paintToken = stream.paintStreamingUpdate || stream.setStreamingPlainText;

  function formatAnswer(text) {
    const raw = String(text || "");
    if (typeof fmt.formatAssistantMessage === "function") {
      const html = fmt.formatAssistantMessage(raw);
      if (html) return html;
    }
    if (!raw.trim()) return "";
    return `<p>${escapeHtml(raw).replace(/\n/g, "<br>")}</p>`;
  }

  document.addEventListener("turbo:before-render", () => {
    if (activeChatAbort) {
      activeChatAbort.abort();
      activeChatAbort = null;
    }
  });

  function scrollMessagesToEnd() {
    if (!messagesEl) return;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function syncExamplesVisibility() {
    if (!examplesEl || !messagesEl) return;
    const hasMsgs = messagesEl.querySelector(".nc-ads-msg:not(.nc-ads-msg--welcome)");
    examplesEl.hidden = !!hasMsgs;
  }

  function shortSourceLabel(path) {
    const p = String(path || "Document").trim();
    if (p.length <= 72) return p;
    const parts = p.split(/[/\\]/).filter(Boolean);
    if (parts.length >= 2) return `…/${parts.slice(-2).join("/")}`;
    return `…${p.slice(-68)}`;
  }

  function renderSourcesBlock(sources, intoEl) {
    if (!sources || !sources.length || !intoEl) return;
    try {
      const items = sources
        .filter((s) => s && typeof s === "object")
        .map(
          (s, i) =>
            `<li><a href="${escapeHtml(s.url || "#")}" target="_blank" rel="noopener" title="${escapeHtml(
              s.path || "Document"
            )}">[${i + 1}] ${escapeHtml(shortSourceLabel(s.path))}</a></li>`
        )
        .join("");
      if (!items) return;
      const details = document.createElement("details");
      details.className = "nc-ads-sources-details";
      details.innerHTML = `<summary>Sources (${sources.length})</summary><ul class="nc-ads-sources">${items}</ul>`;
      intoEl.appendChild(details);
    } catch (_e) {
      /* keep answer visible even if source links fail */
    }
  }

  function appendMessage(role, html, extraClass, sources) {
    const wrap = document.createElement("div");
    wrap.className = `nc-ads-msg nc-ads-msg--${role}${extraClass ? ` ${extraClass}` : ""}`;
    const bubble = document.createElement("div");
    bubble.className = role === "assistant" ? "nc-ads-bubble nc-ads-prose" : "nc-ads-bubble";
    bubble.innerHTML = html;
    if (typeof fmt.wireCodeCopyButtons === "function") {
      fmt.wireCodeCopyButtons(bubble);
    }
    if (sources && sources.length) {
      renderSourcesBlock(sources, bubble);
    }
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    scrollMessagesToEnd();
    syncExamplesVisibility();
    return wrap;
  }

  function formatStatsLine(j) {
    if (!j) j = statusPayload || {};
    const st = j.stats || {};
    const docs = (j.documents || []).length;
    return `${docs} uploaded · ${st.indexed_files || 0} indexed · ${st.indexed_chunks || 0} sections · ${model}`;
  }

  function renderDocList(docs) {
    if (!docListEl) return;
    const list = Array.isArray(docs) ? docs : [];
    if (!list.length) {
      docListEl.innerHTML = '<li class="nc-apa-doc-empty nc-detail-muted">No policy files yet.</li>';
      return;
    }
    docListEl.innerHTML = list
      .map((d) => {
        const name = escapeHtml(d.name || "File");
        const badge = d.indexed
          ? '<span class="nc-apa-doc-badge">indexed</span>'
          : '<span class="nc-apa-doc-badge nc-apa-doc-badge--warn">pending</span>';
        return `<li class="nc-apa-doc-item">
          <a class="nc-apa-doc-name" href="${escapeHtml(d.url || "#")}" target="_blank" rel="noopener">${name}</a>
          ${badge}
          <button type="button" class="nc-apa-doc-remove" data-id="${escapeHtml(String(d.id))}" title="Remove" aria-label="Remove ${name}">×</button>
        </li>`;
      })
      .join("");
    docListEl.querySelectorAll(".nc-apa-doc-remove").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-id");
        if (!id || !window.confirm("Remove this policy document from your library?")) return;
        const { r, j } = await api(`/ai-policy-assistant/documents/${id}`, { method: "DELETE" });
        if (!r.ok || !j.ok) {
          window.alert(j.error || "Could not remove.");
          return;
        }
        void loadStatus();
      });
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
        return `<button type="button" class="nc-ads-history-item${active ? " is-active" : ""}" data-id="${escapeHtml(
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
    });
  }

  function clearMessages() {
    if (messagesEl) messagesEl.innerHTML = "";
  }

  function renderConversationMessages(messages) {
    if (chatInFlight) return;
    clearMessages();
    const list = Array.isArray(messages) ? messages : [];
    list.forEach((m) => {
      const role = String(m.role || "").toLowerCase();
      if (role === "user") {
        appendMessage("user", `<p>${escapeHtml(m.content)}</p>`);
      } else if (role === "assistant") {
        const extra = m.welcome ? " nc-ads-msg--welcome" : "";
        const body = m.welcome
          ? `<p>${escapeHtml(m.content)}</p><p class="nc-ads-muted">Upload policies in the sidebar, then ask below.</p>`
          : formatAnswer(m.content);
        appendMessage("assistant", body, extra.trim() || undefined, m.sources);
      }
    });
    if (!list.length) {
      appendMessage(
        "assistant",
        `<p>Upload policies, SOPs, work instructions, and security manuals, then ask questions. I answer from your uploaded material and cite sources.</p><p class="nc-ads-muted">Use the sidebar to upload files.</p>`,
        "nc-ads-msg--welcome"
      );
    }
    syncExamplesVisibility();
  }

  async function loadConversations() {
    const { r, j } = await api("/ai-policy-assistant/conversations", { method: "GET" });
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

  async function fetchConversation(id) {
    const { r, j } = await api(`/ai-policy-assistant/conversations/${id}`, { method: "GET" });
    if (!r.ok || !j.ok || !j.conversation) return null;
    return j.conversation;
  }

  async function openConversation(id, { render = true } = {}) {
    const conv = await fetchConversation(id);
    if (!conv) return null;
    activeConversationId = conv.id;
    renderHistoryList();
    if (render && !chatInFlight) {
      renderConversationMessages(conv.messages || []);
    }
    return conv;
  }

  async function createConversation() {
    if (chatInFlight) return null;
    const { r, j } = await api("/ai-policy-assistant/conversations", { method: "POST" });
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
    if (chatInFlight || id === activeConversationId) return;
    const conv = await openConversation(id);
    if (conv && input) input.focus();
  }

  async function ensureActiveConversation() {
    await loadConversations();
    if (conversations.length) {
      const pick =
        activeConversationId && conversations.some((c) => c.id === activeConversationId)
          ? activeConversationId
          : conversations[0].id;
      await openConversation(pick);
      return;
    }
    await createConversation();
  }

  async function loadStatus({ busyLabel } = {}) {
    if (reindexBtn) reindexBtn.disabled = true;
    if (statsEl && busyLabel) statsEl.textContent = busyLabel;
    try {
      const { r, j } = await api("/ai-policy-assistant/status", { method: "GET" });
      if (!r.ok || !j.ok) {
        if (statsEl) statsEl.textContent = j.error || "Could not load status.";
        return;
      }
      statusPayload = j;
      renderDocList(j.documents);
      if (statsEl) statsEl.textContent = formatStatsLine(j);
    } catch (_e) {
      if (statsEl) statsEl.textContent = "Status unavailable.";
    } finally {
      if (reindexBtn) reindexBtn.disabled = !configured;
    }
  }

  reindexBtn?.addEventListener("click", async () => {
    if (reindexBtn) reindexBtn.disabled = true;
    if (statsEl) statsEl.textContent = "Re-indexing policies…";
    try {
      const { r, j } = await api("/ai-policy-assistant/reindex", { method: "POST" });
      if (r.ok && j.ok) {
        statusPayload = { ...statusPayload, stats: j.stats, sync: j.sync };
        renderDocList(statusPayload.documents);
        if (statsEl) statsEl.textContent = formatStatsLine(statusPayload);
      } else if (statsEl) statsEl.textContent = j.error || "Re-index failed.";
    } finally {
      if (reindexBtn) reindexBtn.disabled = !configured;
    }
  });

  const ALLOWED_EXT = new Set([".pdf", ".doc", ".docx", ".txt", ".md", ".xlsx", ".pptx"]);

  function fileExt(name) {
    const n = String(name || "");
    const i = n.lastIndexOf(".");
    return i >= 0 ? n.slice(i).toLowerCase() : "";
  }

  function filterAllowedFiles(fileList) {
    const out = [];
    const rejected = [];
    Array.from(fileList || []).forEach((f) => {
      const ext = fileExt(f.name);
      if (ALLOWED_EXT.has(ext)) out.push(f);
      else rejected.push(f.name || "file");
    });
    return { allowed: out, rejected };
  }

  async function uploadFiles(fileList) {
    const { allowed, rejected } = filterAllowedFiles(fileList);
    if (rejected.length) {
      window.alert(
        `Skipped unsupported file(s): ${rejected.slice(0, 5).join(", ")}${rejected.length > 5 ? "…" : ""}\n\nSupported: PDF, Word, text, Excel, PowerPoint.`
      );
    }
    if (!allowed.length) return;
    const fd = new FormData();
    allowed.forEach((f) => fd.append("file", f));
    if (statsEl) statsEl.textContent = "Uploading…";
    try {
      const r = await fetch("/intranet/api/ai-policy-assistant/upload", {
        method: "POST",
        credentials: "same-origin",
        body: fd,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        window.alert(j.error || "Upload failed.");
      }
    } catch (_e) {
      window.alert("Upload failed.");
    }
    void loadStatus();
  }

  fileInput?.addEventListener("change", async () => {
    const files = fileInput.files;
    fileInput.value = "";
    if (!files || !files.length) return;
    await uploadFiles(files);
  });

  (function wireUploadDropzone() {
    const zone = document.getElementById("nc-apa-upload-drop");
    if (!zone || !configured) return;
    let dragDepth = 0;

    function setDragover(on) {
      zone.classList.toggle("is-dragover", on);
    }

    zone.addEventListener("dragenter", (e) => {
      e.preventDefault();
      dragDepth += 1;
      setDragover(true);
    });
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      setDragover(true);
    });
    zone.addEventListener("dragleave", (e) => {
      e.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setDragover(false);
    });
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      dragDepth = 0;
      setDragover(false);
      const dt = e.dataTransfer;
      if (!dt || !dt.files || !dt.files.length) return;
      void uploadFiles(dt.files);
    });
  })();

  function streamedTextFromBubble(bubble) {
    if (!bubble || !bubble.isConnected) return "";
    const el = bubble.querySelector(".nc-aichat-stream-text");
    if (el) return (el.textContent || "").trim();
    const thinking = bubble.querySelector(".nc-ads-thinking");
    if (thinking && thinking.textContent && !/thinking|searching/i.test(thinking.textContent)) {
      return thinking.textContent.trim();
    }
    return "";
  }

  async function chatBlockingFallback(text, conversationId, signal) {
    return api("/ai-policy-assistant/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, conversation_id: conversationId }),
      signal,
    });
  }

  function mergeConversationMeta(payload) {
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
    if (payload.stats) {
      statusPayload = { ...statusPayload, stats: payload.stats };
      if (statsEl) statsEl.textContent = formatStatsLine(statusPayload);
    }
  }

  function finishAssistantReply(payload, streamWrap, streamBubble, streamedFullText) {
    const answer =
      (payload && (payload.answer != null ? payload.answer : payload.content)) ||
      streamedFullText ||
      streamedTextFromBubble(streamBubble) ||
      "";

    if (streamWrap && streamWrap.isConnected && streamBubble && streamBubble.isConnected && stream.finalizeAssistantBubble) {
      stream.finalizeAssistantBubble(streamWrap, streamBubble, answer, formatAnswer, (bubble) => {
        renderSourcesBlock(payload && payload.sources, bubble);
      });
    } else if (answer.trim()) {
      appendMessage("assistant", formatAnswer(answer), undefined, payload && payload.sources);
    } else {
      appendMessage("assistant", `<p class="nc-ads-error">No response received.</p>`);
    }
    mergeConversationMeta(payload);
  }

  function showAssistantError(streamWrap, errMsg) {
    if (streamWrap && streamWrap.isConnected) streamWrap.remove();
    appendMessage("assistant", `<p class="nc-ads-error">${escapeHtml(errMsg || "Request failed.")}</p>`);
  }

  newChatBtn?.addEventListener("click", () => {
    void createConversation();
  });

  async function init() {
    await loadStatus();
    await ensureActiveConversation();
  }

  initTask = init();

  if (!configured || !form || !input) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (chatInFlight) return;
    if (initTask) await initTask;

    const text = (input.value || "").trim();
    const convId = activeConversationId;
    if (!text || !convId) return;

    input.value = "";
    input.disabled = true;
    if (sendBtn) sendBtn.disabled = true;
    chatInFlight = true;

    if (activeChatAbort) activeChatAbort.abort();
    activeChatAbort = new AbortController();
    const { signal } = activeChatAbort;

    appendMessage("user", `<p>${escapeHtml(text)}</p>`);

    let streamWrap = null;
    let streamBubble = null;
    const streaming =
      stream.createStreamingBubble &&
      stream.createStreamingBubble(messagesEl, "Searching policies and thinking…");
    if (streaming && streaming.bubble) {
      streamWrap = streaming.wrap;
      streamBubble = streaming.bubble;
    } else {
      const thinking = appendMessage(
        "assistant",
        '<p class="nc-ads-thinking">Searching policies and thinking…</p>',
        "nc-ads-msg--pending"
      );
      streamWrap = thinking;
      streamBubble = thinking.querySelector(".nc-ads-bubble");
    }

    let streamDone = false;
    let streamedFullText = "";

    async function tryBlockingFallback() {
      if (streamBubble && streamBubble.isConnected) {
        streamBubble.innerHTML = '<p class="nc-ads-thinking">Retrying without streaming…</p>';
      }
      const { r, j } = await chatBlockingFallback(text, convId, signal);
      if (!r.ok || !j.ok) {
        showAssistantError(streamWrap, j.error || "Request failed.");
        return;
      }
      streamDone = true;
      finishAssistantReply(j, streamWrap, streamBubble, j.answer || streamedFullText);
    }

    try {
      if (!consumeSseStream) {
        await tryBlockingFallback();
        return;
      }

      const response = await (postJsonSseStream
        ? postJsonSseStream("/intranet/api/ai-policy-assistant/chat/stream", {
            message: text,
            conversation_id: convId,
          })
        : fetch("/intranet/api/ai-policy-assistant/chat/stream", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: text, conversation_id: convId }),
            signal,
          }));

      await consumeSseStream(response, {
        onToken(fullText, payload) {
          if (!streamBubble || !streamBubble.isConnected) return;
          if (payload && payload.type === "status" && payload.content && stream.setStreamingPlainText) {
            stream.setStreamingPlainText(streamBubble, payload.content, messagesEl);
            return;
          }
          streamedFullText = fullText || streamedFullText;
          if (paintToken) {
            paintToken(streamBubble, fullText, messagesEl);
          }
        },
        onDone(payload) {
          streamDone = true;
          if (!streamBubble || !streamBubble.isConnected) {
            mergeConversationMeta(payload);
            return;
          }
          finishAssistantReply(payload, streamWrap, streamBubble, streamedFullText);
        },
        onError(errMsg) {
          streamDone = true;
          const recovered = streamedFullText || streamedTextFromBubble(streamBubble);
          if (recovered && streamWrap && streamWrap.isConnected && stream.finalizeAssistantBubble) {
            finishAssistantReply({ ok: true, answer: recovered }, streamWrap, streamBubble, recovered);
            return;
          }
          showAssistantError(streamWrap, errMsg);
        },
      });

      if (!streamDone) {
        if (streamedFullText && streamWrap && streamWrap.isConnected) {
          streamDone = true;
          finishAssistantReply({ ok: true, answer: streamedFullText }, streamWrap, streamBubble, streamedFullText);
        } else {
          await tryBlockingFallback();
        }
      }
    } catch (err) {
      if (err && err.name === "AbortError") {
        showAssistantError(streamWrap, "Request cancelled.");
      } else if (!streamDone) {
        const recovered = streamedFullText || streamedTextFromBubble(streamBubble);
        if (recovered && streamWrap && streamWrap.isConnected) {
          finishAssistantReply({ ok: true, answer: recovered }, streamWrap, streamBubble, recovered);
        } else {
          await tryBlockingFallback();
        }
      }
    } finally {
      chatInFlight = false;
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
