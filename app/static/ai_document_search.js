(function () {
  "use strict";

  const root = document.getElementById("nc-ads-root");
  if (!root) return;

  const configured = root.dataset.configured === "1";
  const model = root.dataset.model || "gpt-4o-mini";
  const messagesEl = document.getElementById("nc-ads-messages");
  const form = document.getElementById("nc-ads-form");
  const input = document.getElementById("nc-ads-input");
  const sendBtn = document.getElementById("nc-ads-send");
  const statsEl = document.getElementById("nc-ads-stats");
  const historyEl = document.getElementById("nc-ads-history");
  const newChatBtn = document.getElementById("nc-ads-new-chat");

  let conversations = [];
  let activeConversationId = null;
  let statusPayload = null;

  async function api(path, opts) {
    const r = await fetch(`/intranet/api${path}`, { credentials: "same-origin", ...opts });
    const j = await r.json().catch(() => ({}));
    return { r, j };
  }

  const fmt = window.NcAiChatFormat || {};
  const stream = window.NcAiStreamClient || {};
  const escapeHtml = stream.escapeHtml || fmt.escapeHtml || ((s) => String(s || ""));
  const formatAnswer = fmt.formatAssistantMessage || ((text) => `<p>${escapeHtml(text)}</p>`);
  const consumeSseStream = stream.consumeSseStream;
  const postJsonSseStream = stream.postJsonSseStream;

  function scrollMessagesToEnd() {
    if (!messagesEl) return;
    messagesEl.scrollTop = messagesEl.scrollHeight;
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
    const items = sources
      .map(
        (s, i) =>
          `<li><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener" title="${escapeHtml(
            s.path || "Document"
          )}">[${i + 1}] ${escapeHtml(shortSourceLabel(s.path))}</a></li>`
      )
      .join("");
    const details = document.createElement("details");
    details.className = "nc-ads-sources-details";
    details.innerHTML = `<summary>Sources (${sources.length})</summary><ul class="nc-ads-sources">${items}</ul>`;
    intoEl.appendChild(details);
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
    return wrap;
  }

  function formatStatsLine(j) {
    if (!j) j = statusPayload || {};
    const st = j.stats || {};
    const sync = j.sync || {};
    let line = `${st.indexed_files || 0} files indexed · ${st.indexed_chunks || 0} sections · ${model}`;
    if (j.vector_index_version) {
      line += ` · vector v${j.vector_index_version}`;
    }
    if (sync.indexed_now > 0) {
      line += ` · ${sync.indexed_now} new`;
    }
    if (j.index_scope_mode === "folders") {
      line += " · folder scope";
    }
    if (sync.skipped_out_of_scope > 0) {
      line += ` · ${sync.skipped_out_of_scope} skipped (scope)`;
    }
    return line;
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
    clearMessages();
    const list = Array.isArray(messages) ? messages : [];
    list.forEach((m) => {
      const role = String(m.role || "").toLowerCase();
      if (role === "user") {
        appendMessage("user", `<p>${escapeHtml(m.content)}</p>`);
      } else if (role === "assistant") {
        const extra = m.welcome ? " nc-ads-msg--welcome" : "";
        const body = m.welcome
          ? `<p>${escapeHtml(m.content)}</p><p class="nc-ads-muted">Ask a question below.</p>`
          : formatAnswer(m.content);
        appendMessage("assistant", body, extra.trim() || undefined, m.sources);
      }
    });
    if (!list.length) {
      appendMessage(
        "assistant",
        `<p>Hello! I can search PDFs, Word, Excel, PowerPoint, and text files you have access to, then reason over what I find.</p><p class="nc-ads-muted">Ask a question below.</p>`,
        "nc-ads-msg--welcome"
      );
    }
  }

  async function loadConversations() {
    const { r, j } = await api("/ai-document-search/conversations", { method: "GET" });
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
    const { r, j } = await api("/ai-document-search/conversations", { method: "POST" });
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
    const { r, j } = await api(`/ai-document-search/conversations/${id}`, { method: "GET" });
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
      const pick = activeConversationId && conversations.some((c) => c.id === activeConversationId)
        ? activeConversationId
        : conversations[0].id;
      await switchConversation(pick);
      return;
    }
    await createConversation();
  }

  async function loadStatus({ busyLabel } = {}) {
    const reindexBtn = document.getElementById("nc-ads-reindex");
    if (reindexBtn) reindexBtn.disabled = true;
    if (statsEl && busyLabel) statsEl.textContent = busyLabel;
    try {
      const { r, j } = await api("/ai-document-search/status", { method: "GET" });
      if (!r.ok || !j.ok) {
        if (statsEl) statsEl.textContent = j.error || "Could not load index status.";
        return;
      }
      statusPayload = j;
      if (statsEl) statsEl.textContent = formatStatsLine(j);
    } catch (_e) {
      if (statsEl) statsEl.textContent = "Index status unavailable.";
    } finally {
      if (reindexBtn) reindexBtn.disabled = !configured;
    }
  }

  document.getElementById("nc-ads-reindex")?.addEventListener("click", () => {
    loadStatus({ busyLabel: "Indexing documents…" });
  });

  newChatBtn?.addEventListener("click", () => {
    void createConversation();
  });

  async function init() {
    await loadStatus();
    await ensureActiveConversation();
  }

  void init();

  if (!configured || !form || !input) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = (input.value || "").trim();
    if (!text || !activeConversationId) return;
    input.value = "";
    input.disabled = true;
    if (sendBtn) sendBtn.disabled = true;

    appendMessage("user", `<p>${escapeHtml(text)}</p>`);

    const streaming =
      stream.createStreamingBubble &&
      stream.createStreamingBubble(messagesEl, "Searching documents and thinking…");
    let streamWrap = null;
    let streamBubble = null;
    if (!streaming) {
      const thinking = appendMessage(
        "assistant",
        '<p class="nc-ads-thinking">Searching documents and thinking…</p>',
        "nc-ads-msg--pending"
      );
      streamWrap = thinking;
      streamBubble = thinking.querySelector(".nc-ads-bubble");
    } else {
      streamWrap = streaming.wrap;
      streamBubble = streaming.bubble;
    }

    let streamDone = false;

    try {
      const response = await (postJsonSseStream
        ? postJsonSseStream("/intranet/api/ai-document-search/chat/stream", {
            message: text,
            conversation_id: activeConversationId,
          })
        : fetch("/intranet/api/ai-document-search/chat/stream", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: text, conversation_id: activeConversationId }),
          }));

      await consumeSseStream(response, {
        onToken(fullText) {
          if (stream.setStreamingPlainText) {
            stream.setStreamingPlainText(streamBubble, fullText, messagesEl);
          }
        },
        onDone(payload) {
          streamDone = true;
          const answer = (payload && payload.answer) || "";
          if (stream.finalizeAssistantBubble) {
            stream.finalizeAssistantBubble(streamWrap, streamBubble, answer, formatAnswer, (bubble) => {
              renderSourcesBlock(payload.sources, bubble);
            });
          } else {
            streamWrap.remove();
            appendMessage("assistant", formatAnswer(answer), undefined, payload.sources);
          }
          if (payload.conversation) {
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
          statusPayload = { ...statusPayload, stats: payload.stats };
          if (statsEl) statsEl.textContent = formatStatsLine(payload);
        },
        onError(errMsg) {
          streamDone = true;
          streamWrap.remove();
          appendMessage("assistant", `<p class="nc-ads-error">${escapeHtml(errMsg || "Request failed.")}</p>`);
        },
      });
      if (!streamDone) {
        streamWrap.remove();
        appendMessage("assistant", `<p class="nc-ads-error">No response received.</p>`);
      }
    } catch (_err) {
      streamWrap.remove();
      appendMessage("assistant", `<p class="nc-ads-error">Network error. Try again.</p>`);
    } finally {
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
