(function () {
  "use strict";

  const root = document.getElementById("nc-acvb-root");
  if (!root) return;

  const templateInput = document.getElementById("nc-acvb-template-input");
  const sourceInput = document.getElementById("nc-acvb-source-input");
  const templateStatus = document.getElementById("nc-acvb-template-status");
  const sourceStatus = document.getElementById("nc-acvb-source-status");
  const buildBtn = document.getElementById("nc-acvb-build-btn");
  const downloadBtn = document.getElementById("nc-acvb-download-btn");
  const buildStatus = document.getElementById("nc-acvb-build-status");
  const instructionsEl = document.getElementById("nc-acvb-instructions");
  const previewPanel = document.getElementById("nc-acvb-preview-panel");
  const previewEl = document.getElementById("nc-acvb-preview");

  const fmt = window.NcAiChatFormat || {};
  const stream = window.NcAiStreamClient || {};
  const escapeHtml = stream.escapeHtml || fmt.escapeHtml || ((s) => String(s || ""));
  const consumeSseStream = stream.consumeSseStream;
  const postJsonSseStream = stream.postJsonSseStream;

  let state = { template: {}, source: {}, output: {}, llm: {} };

  async function api(path, opts) {
    const r = await fetch(`/intranet/api${path}`, { credentials: "same-origin", ...opts });
    const j = await r.json().catch(() => ({}));
    return { r, j };
  }

  function fileStatusLine(info, emptyLabel) {
    if (!info || !info.set) return emptyLabel;
    const name = escapeHtml(info.name || "File");
    const when = info.updated_at ? ` · ${escapeHtml(new Date(info.updated_at).toLocaleString())}` : "";
    return `${name}${when}`;
  }

  function renderStatus() {
    if (templateStatus) {
      templateStatus.innerHTML = fileStatusLine(state.template, "No template uploaded");
    }
    if (sourceStatus) {
      sourceStatus.innerHTML = fileStatusLine(state.source, "No source CV uploaded");
    }
    if (downloadBtn) {
      if (state.output && state.output.ready) {
        downloadBtn.hidden = false;
      } else {
        downloadBtn.hidden = true;
      }
    }
    if (buildBtn) {
      buildBtn.disabled = !(state.llm && state.llm.configured);
    }
  }

  function renderPreview(md) {
    if (!previewEl || !previewPanel) return;
    const text = String(md || "").trim();
    if (!text) {
      previewPanel.hidden = true;
      previewEl.innerHTML = "";
      return;
    }
    previewPanel.hidden = false;
    if (typeof fmt.formatAssistantMessage === "function") {
      previewEl.innerHTML = fmt.formatAssistantMessage(text);
      if (typeof fmt.wireCodeCopyButtons === "function") {
        fmt.wireCodeCopyButtons(previewEl);
      }
    } else {
      previewEl.innerHTML = `<p>${escapeHtml(text)}</p>`;
    }
  }

  async function loadStatus() {
    const { r, j } = await api("/ai-cv-builder/status", { method: "GET" });
    if (!r.ok || !j.ok) {
      if (buildStatus) buildStatus.textContent = j.error || "Could not load status.";
      return;
    }
    state = {
      template: j.template || {},
      source: j.source || {},
      output: j.output || {},
      llm: j.llm || {},
    };
    renderStatus();
    if (state.output && state.output.preview) {
      renderPreview(state.output.preview);
    }
    if (buildStatus && !state.llm.configured) {
      buildStatus.textContent = "AI is not configured. Ask an administrator to set the API key under AI Settings.";
    }
  }

  function fileExt(name) {
    const n = String(name || "");
    const i = n.lastIndexOf(".");
    return i >= 0 ? n.slice(i).toLowerCase() : "";
  }

  function validateFile(kind, file) {
    if (!file) return "No file selected.";
    const ext = fileExt(file.name);
    if (kind === "template") {
      if (ext !== ".docx") return "CV template must be a Word document (.docx).";
      return "";
    }
    if (ext !== ".pdf" && ext !== ".docx") return "Source CV must be PDF or Word (.docx).";
    return "";
  }

  function wireDropzone(zoneEl, kind) {
    if (!zoneEl) return;
    let dragDepth = 0;

    function setDragover(on) {
      zoneEl.classList.toggle("is-dragover", on);
    }

    zoneEl.addEventListener("dragenter", (e) => {
      e.preventDefault();
      dragDepth += 1;
      setDragover(true);
    });
    zoneEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      setDragover(true);
    });
    zoneEl.addEventListener("dragleave", (e) => {
      e.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setDragover(false);
    });
    zoneEl.addEventListener("drop", (e) => {
      e.preventDefault();
      dragDepth = 0;
      setDragover(false);
      const dt = e.dataTransfer;
      const file = dt && dt.files && dt.files.length ? dt.files[0] : null;
      const err = validateFile(kind, file);
      if (err) {
        window.alert(err);
        return;
      }
      void uploadFile(kind, file);
    });
  }

  async function uploadFile(kind, file) {
    if (!file) return;
    const err = validateFile(kind, file);
    if (err) {
      window.alert(err);
      return;
    }
    const path = kind === "template" ? "/ai-cv-builder/template" : "/ai-cv-builder/source";
    const fd = new FormData();
    fd.append("file", file);
    if (buildStatus) buildStatus.textContent = "Uploading…";
    const r = await fetch(`/intranet/api${path}`, { method: "POST", credentials: "same-origin", body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) {
      window.alert(j.error || "Upload failed.");
      if (buildStatus) buildStatus.textContent = "";
      return;
    }
    if (buildStatus) buildStatus.textContent = "Upload complete.";
    await loadStatus();
  }

  templateInput?.addEventListener("change", () => {
    const f = templateInput.files && templateInput.files[0];
    templateInput.value = "";
    void uploadFile("template", f);
  });

  sourceInput?.addEventListener("change", () => {
    const f = sourceInput.files && sourceInput.files[0];
    sourceInput.value = "";
    void uploadFile("source", f);
  });

  wireDropzone(document.getElementById("nc-acvb-template-drop"), "template");
  wireDropzone(document.getElementById("nc-acvb-source-drop"), "source");

  buildBtn?.addEventListener("click", async () => {
    if (!state.template.set || !state.source.set) {
      window.alert("Upload both your template and a source CV first.");
      return;
    }
    buildBtn.disabled = true;
    if (buildStatus) buildStatus.textContent = "AI is mapping the CV into your template…";
    if (previewPanel) previewPanel.hidden = false;
    if (previewEl) {
      previewEl.className = "nc-acvb-preview nc-ads-prose nc-aichat-streaming";
      previewEl.innerHTML = '<p class="nc-ads-thinking">Building CV…</p>';
    }

    let streamDone = false;

    try {
      const response = await (postJsonSseStream
        ? postJsonSseStream("/intranet/api/ai-cv-builder/build/stream", {
            instructions: (instructionsEl && instructionsEl.value) || "",
          })
        : fetch("/intranet/api/ai-cv-builder/build/stream", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              instructions: (instructionsEl && instructionsEl.value) || "",
            }),
          }));

      await consumeSseStream(response, {
        onToken(fullText) {
          if (stream.setStreamingPlainText && previewEl) {
            stream.setStreamingPlainText(previewEl, fullText);
          } else if (previewEl) {
            previewEl.textContent = fullText;
          }
        },
        onDone(payload) {
          streamDone = true;
          if (previewEl) previewEl.classList.remove("nc-aichat-streaming");
          if (buildStatus) {
            buildStatus.textContent = `Built successfully (${payload.slots_filled || 0} sections). Download your Word file below.`;
          }
          if (payload.preview_markdown) {
            renderPreview(payload.preview_markdown);
          } else if (payload.status && payload.status.output) {
            renderPreview(payload.status.output.preview);
          }
          void loadStatus();
        },
        onError(errMsg) {
          streamDone = true;
          if (previewEl) {
            previewEl.classList.remove("nc-aichat-streaming");
            previewEl.innerHTML = `<p class="nc-ads-error">${escapeHtml(errMsg || "Build failed.")}</p>`;
          }
          if (buildStatus) buildStatus.textContent = errMsg || "Build failed.";
        },
      });
      if (!streamDone && buildStatus) buildStatus.textContent = "No response received.";
    } catch (_e) {
      if (buildStatus) buildStatus.textContent = "Network error. Try again.";
    } finally {
      buildBtn.disabled = !(state.llm && state.llm.configured);
    }
  });

  void loadStatus();
})();
