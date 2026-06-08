(function (global) {
  "use strict";

  const fmt = global.NcAiChatFormat || {};
  const escapeHtml =
    fmt.escapeHtml ||
    ((s) =>
      String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;"));

  async function consumeSseStream(response, handlers) {
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
      if (j.ok && (j.answer != null || j.analysis != null || j.preview_markdown != null)) {
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
              streamFinished = true;
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
  }

  function createStreamingBubble(container, thinkingText, extraWrapClass) {
    const wrap = document.createElement("div");
    wrap.className = `nc-ads-msg nc-ads-msg--assistant nc-ads-msg--pending${extraWrapClass ? ` ${extraWrapClass}` : ""}`;
    const bubble = document.createElement("div");
    bubble.className = "nc-ads-bubble nc-ads-prose nc-aichat-streaming";
    bubble.innerHTML = `<p class="nc-ads-thinking">${escapeHtml(thinkingText || "Thinking…")}</p>`;
    wrap.appendChild(bubble);
    if (container) {
      container.appendChild(wrap);
      if (container.scrollHeight) container.scrollTop = container.scrollHeight;
    }
    return { wrap, bubble };
  }

  function setStreamingPlainText(bubble, text, scrollContainer) {
    if (!bubble) return;
    const body = text
      ? `<div class="nc-aichat-stream-text">${escapeHtml(text).replace(/\n/g, "<br>")}</div>`
      : '<p class="nc-ads-thinking">Thinking…</p>';
    bubble.innerHTML = body;
    const scrollEl =
      scrollContainer && scrollContainer.isConnected
        ? scrollContainer
        : bubble.closest(".nc-ads-messages");
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
  }

  function paintStreamingUpdate(bubble, text, scrollContainer) {
    const run = () => setStreamingPlainText(bubble, text, scrollContainer);
    if (typeof global.requestAnimationFrame === "function") {
      global.requestAnimationFrame(run);
    } else {
      run();
    }
  }

  function finalizeAssistantBubble(wrap, bubble, text, formatHtml, afterRender) {
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
  }

  async function postJsonSseStream(url, body) {
    return fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  global.NcAiStreamClient = {
    consumeSseStream,
    createStreamingBubble,
    setStreamingPlainText,
    paintStreamingUpdate,
    finalizeAssistantBubble,
    postJsonSseStream,
    escapeHtml,
  };
})();
