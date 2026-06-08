(function () {
  "use strict";

  const root = document.getElementById("nc-ata-root");
  if (!root) return;

  const docTypeEl = document.getElementById("nc-ata-doc-type");
  const fileInput = document.getElementById("nc-ata-file-input");
  const docList = document.getElementById("nc-ata-doc-list");
  const analyzeBtn = document.getElementById("nc-ata-analyze-btn");
  const statusEl = document.getElementById("nc-ata-status");
  const instructionsEl = document.getElementById("nc-ata-instructions");
  const resultsEl = document.getElementById("nc-ata-results");
  const summaryEl = document.getElementById("nc-ata-summary");
  const requirementsEl = document.getElementById("nc-ata-requirements");
  const complianceEl = document.getElementById("nc-ata-compliance");
  const risksEl = document.getElementById("nc-ata-risks");
  const draftsEl = document.getElementById("nc-ata-drafts");
  const uploadZone = document.getElementById("nc-ata-upload-drop");

  const fmt = window.NcAiChatFormat || {};
  const stream = window.NcAiStreamClient || {};
  const escapeHtml =
    stream.escapeHtml ||
    fmt.escapeHtml ||
    ((s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
  const consumeSseStream = stream.consumeSseStream;
  const postJsonSseStream = stream.postJsonSseStream;

  let state = { documents: [], analysis: null, llm: {} };

  async function api(path, opts) {
    const r = await fetch(`/intranet/api${path}`, { credentials: "same-origin", ...opts });
    const j = await r.json().catch(() => ({}));
    return { r, j };
  }

  function renderMarkdown(el, md) {
    if (!el) return;
    const text = String(md || "").trim();
    if (!text) {
      el.innerHTML = '<p class="nc-detail-muted">No content.</p>';
      return;
    }
    if (typeof fmt.formatAssistantMessage === "function") {
      el.innerHTML = fmt.formatAssistantMessage(text);
      if (typeof fmt.wireCodeCopyButtons === "function") fmt.wireCodeCopyButtons(el);
    } else {
      el.innerHTML = `<p>${escapeHtml(text)}</p>`;
    }
  }

  function renderDocList() {
    if (!docList) return;
    const docs = state.documents || [];
    if (!docs.length) {
      docList.innerHTML = '<li class="nc-detail-muted">No documents uploaded yet.</li>';
      return;
    }
    docList.innerHTML = docs
      .map(
        (d) => `<li class="nc-ata-doc-item">
          <span><strong>${escapeHtml(d.doc_type_label || d.doc_type)}</strong> — ${escapeHtml(d.name)}
          <span class="nc-ata-doc-meta">${d.uploaded_at ? escapeHtml(new Date(d.uploaded_at).toLocaleString()) : ""}</span></span>
          <button type="button" class="nc-btn nc-btn-ghost nc-ata-doc-remove" data-id="${escapeHtml(d.id)}" title="Remove">Remove</button>
        </li>`
      )
      .join("");
    docList.querySelectorAll(".nc-ata-doc-remove").forEach((btn) => {
      btn.addEventListener("click", () => void removeDoc(btn.dataset.id));
    });
  }

  function renderRequirements(rows) {
    if (!requirementsEl) return;
    if (!rows || !rows.length) {
      requirementsEl.innerHTML = '<p class="nc-detail-muted">No requirements extracted.</p>';
      return;
    }
    const head = `<table class="nc-ata-table"><thead><tr><th>ID</th><th>Priority</th><th>Section</th><th>Requirement</th></tr></thead><tbody>`;
    const body = rows
      .map(
        (r) => `<tr>
          <td><code>${escapeHtml(r.id)}</code></td>
          <td>${escapeHtml(r.priority)}</td>
          <td>${escapeHtml(r.section)}</td>
          <td>${escapeHtml(r.text)}${r.source_ref ? `<div class="nc-ata-ref">${escapeHtml(r.source_ref)}</div>` : ""}</td>
        </tr>`
      )
      .join("");
    requirementsEl.innerHTML = head + body + "</tbody></table>";
  }

  function renderCompliance(rows) {
    if (!complianceEl) return;
    if (!rows || !rows.length) {
      complianceEl.innerHTML = '<p class="nc-detail-muted">No compliance matrix generated.</p>';
      return;
    }
    const head = `<table class="nc-ata-table"><thead><tr><th>Ref</th><th>Requirement</th><th>Response</th><th>Status</th><th>Notes</th></tr></thead><tbody>`;
    const body = rows
      .map(
        (r) => `<tr>
          <td><code>${escapeHtml(r.requirement_id)}</code></td>
          <td>${escapeHtml(r.requirement)}</td>
          <td>${escapeHtml(r.response_location)}</td>
          <td><span class="nc-ata-badge nc-ata-badge--${escapeHtml(r.compliant)}">${escapeHtml(r.compliant)}</span></td>
          <td>${escapeHtml(r.evidence_notes)}</td>
        </tr>`
      )
      .join("");
    complianceEl.innerHTML = head + body + "</tbody></table>";
  }

  function renderRisks(rows) {
    if (!risksEl) return;
    if (!rows || !rows.length) {
      risksEl.innerHTML = '<p class="nc-detail-muted">No risks identified.</p>';
      return;
    }
    risksEl.innerHTML = rows
      .map(
        (r) => `<article class="nc-ata-risk">
          <h3 class="nc-ata-risk-title"><span class="nc-ata-badge nc-ata-badge--${escapeHtml(r.severity)}">${escapeHtml(r.severity)}</span> ${escapeHtml(r.title)}</h3>
          <p>${escapeHtml(r.description)}</p>
          ${r.mitigation ? `<p class="nc-ata-mitigation"><strong>Mitigation:</strong> ${escapeHtml(r.mitigation)}</p>` : ""}
        </article>`
      )
      .join("");
  }

  function renderDrafts(rows) {
    if (!draftsEl) return;
    if (!rows || !rows.length) {
      draftsEl.innerHTML = '<p class="nc-detail-muted">No draft responses generated.</p>';
      return;
    }
    draftsEl.innerHTML = rows
      .map(
        (r) => `<article class="nc-ata-draft">
          <h3 class="nc-ata-draft-title">${escapeHtml(r.section)}</h3>
          ${r.question_or_ref ? `<p class="nc-ata-draft-ref">${escapeHtml(r.question_or_ref)}</p>` : ""}
          <div class="nc-ata-draft-body">${escapeHtml(r.draft).replace(/\n/g, "<br>")}</div>
        </article>`
      )
      .join("");
  }

  function renderAnalysis() {
    const a = state.analysis;
    if (!a || !resultsEl) {
      if (resultsEl) resultsEl.hidden = true;
      return;
    }
    resultsEl.hidden = false;
    renderMarkdown(summaryEl, a.summary_markdown);
    renderRequirements(a.requirements);
    renderCompliance(a.compliance_matrix);
    renderRisks(a.risks);
    renderDrafts(a.draft_responses);
  }

  function wireTabs() {
    const tabs = root.querySelectorAll(".nc-ata-tab");
    const panels = root.querySelectorAll(".nc-ata-tab-panel");
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const name = tab.dataset.tab;
        tabs.forEach((t) => t.classList.toggle("nc-ata-tab--active", t === tab));
        panels.forEach((p) => {
          const on = p.dataset.panel === name;
          p.hidden = !on;
          p.classList.toggle("nc-ata-tab-panel--active", on);
        });
      });
    });
  }

  async function loadStatus() {
    const { r, j } = await api("/ai-tender-assistant/status", { method: "GET" });
    if (!r.ok || !j.ok) {
      if (statusEl) statusEl.textContent = j.error || "Could not load status.";
      return;
    }
    state = {
      documents: j.documents || [],
      analysis: j.analysis || null,
      llm: j.llm || {},
    };
    renderDocList();
    renderAnalysis();
    if (analyzeBtn) analyzeBtn.disabled = !(state.llm && state.llm.configured);
    if (statusEl && !state.llm.configured) {
      statusEl.textContent = "AI is not configured. Ask an administrator to set the API key under AI Settings.";
    }
  }

  const ALLOWED_EXT = new Set([".pdf", ".docx", ".txt", ".md"]);

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

  async function uploadFiles(files) {
    const docType = (docTypeEl && docTypeEl.value) || "other";
    const { allowed, rejected } = filterAllowedFiles(files);
    if (rejected.length) {
      window.alert(
        `Skipped unsupported file(s): ${rejected.slice(0, 5).join(", ")}${rejected.length > 5 ? "…" : ""}\n\nSupported: PDF, Word (.docx), or plain text (.txt, .md).`
      );
    }
    if (!allowed.length) return;
    for (const file of allowed) {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("doc_type", docType);
      if (statusEl) statusEl.textContent = `Uploading ${file.name}…`;
      const r = await fetch("/intranet/api/ai-tender-assistant/upload", {
        method: "POST",
        credentials: "same-origin",
        body: fd,
      });
      let j = {};
      try {
        j = await r.json();
      } catch (_e) {
        j = {};
      }
      if (!r.ok || !j.ok) {
        const msg =
          j.error ||
          (r.status === 403
            ? "Enterprise license required for AI Tender Assistant."
            : r.status === 404
              ? "Upload endpoint not found — restart the app server."
              : `Upload failed (${r.status}): ${file.name}`);
        window.alert(msg);
        if (statusEl) statusEl.textContent = msg;
        continue;
      }
    }
    if (statusEl) statusEl.textContent = "Upload complete.";
    await loadStatus();
  }

  async function removeDoc(id) {
    if (!id || !window.confirm("Remove this document? Any analysis will be cleared.")) return;
    const { r, j } = await api(`/ai-tender-assistant/documents/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!r.ok || !j.ok) {
      window.alert(j.error || "Could not remove document.");
      return;
    }
    state.documents = j.documents || [];
    state.analysis = j.analysis || null;
    renderDocList();
    renderAnalysis();
  }

  fileInput?.addEventListener("change", () => {
    const files = fileInput.files ? Array.from(fileInput.files) : [];
    fileInput.value = "";
    if (files.length) void uploadFiles(files);
  });

  (function wireUploadDropzone() {
    const zone = uploadZone;
    if (!zone) return;
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

  analyzeBtn?.addEventListener("click", async () => {
    if (!(state.documents || []).length) {
      window.alert("Upload at least one tender document first.");
      return;
    }
    analyzeBtn.disabled = true;
    if (statusEl) statusEl.textContent = "Analysing tender pack — streaming results…";
    if (resultsEl) resultsEl.hidden = false;
    if (summaryEl) {
      summaryEl.className = "nc-ata-summary nc-ads-prose nc-aichat-streaming";
      summaryEl.innerHTML = '<p class="nc-ads-thinking">Analysing tender pack…</p>';
    }
    root.querySelector('.nc-ata-tab[data-tab="summary"]')?.click();

    let streamDone = false;

    try {
      const response = await (postJsonSseStream
        ? postJsonSseStream("/intranet/api/ai-tender-assistant/analyze/stream", {
            instructions: (instructionsEl && instructionsEl.value) || "",
          })
        : fetch("/intranet/api/ai-tender-assistant/analyze/stream", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ instructions: (instructionsEl && instructionsEl.value) || "" }),
          }));

      await consumeSseStream(response, {
        onToken(fullText) {
          if (stream.setStreamingPlainText && summaryEl) {
            stream.setStreamingPlainText(summaryEl, fullText);
          } else if (summaryEl) {
            summaryEl.textContent = fullText;
          }
        },
        onDone(payload) {
          streamDone = true;
          if (summaryEl) summaryEl.classList.remove("nc-aichat-streaming");
          state.analysis = (payload.analysis || (payload.status && payload.status.analysis)) ?? null;
          renderAnalysis();
          if (statusEl) {
            const n = (state.analysis && state.analysis.requirements && state.analysis.requirements.length) || 0;
            statusEl.textContent = `Analysis complete — ${n} requirement(s) extracted. Review the tabs below.`;
          }
        },
        onError(errMsg) {
          streamDone = true;
          if (summaryEl) {
            summaryEl.classList.remove("nc-aichat-streaming");
            summaryEl.innerHTML = `<p class="nc-ads-error">${escapeHtml(errMsg || "Analysis failed.")}</p>`;
          }
          if (statusEl) statusEl.textContent = errMsg || "Analysis failed.";
        },
      });
      if (!streamDone && statusEl) statusEl.textContent = "No response received.";
    } catch (_e) {
      if (statusEl) statusEl.textContent = "Network error. Try again.";
    } finally {
      analyzeBtn.disabled = !(state.llm && state.llm.configured);
    }
  });

  wireTabs();
  void loadStatus();
})();
