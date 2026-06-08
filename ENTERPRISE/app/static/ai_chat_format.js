(function (global) {
  "use strict";

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function normalizeNewlines(text) {
    return String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }

  /** Break inline fences and numbered steps onto their own lines before parsing. */
  function normalizeMarkdown(raw) {
    let s = normalizeNewlines(raw);
    s = s.replace(/`{4,}/g, "```");
    s = s.replace(/([^\n`])\s*```/g, "$1\n```");
    s = s.replace(/```\s*(\d+\.\s+)/g, "```\n\n$1");
    s = s.replace(/([.!?])\s+(\d+\.\s+)/g, "$1\n\n$2");
    s = s.replace(/\*\*([^*]+)\*\*/g, (m, inner) => {
      if (inner.includes("\n")) return m;
      return `**${inner.trim()}**`;
    });
    return s;
  }

  /**
   * Split on ``` fences anywhere (same line as prose, no newline after lang, etc.).
   */
  function splitByCodeFences(raw) {
    const s = normalizeNewlines(raw);
    const segments = [];
    let i = 0;

    while (i < s.length) {
      const open = s.indexOf("```", i);
      if (open === -1) {
        const tail = s.slice(i);
        if (tail.trim()) segments.push({ type: "text", content: tail });
        break;
      }

      if (open > i) {
        segments.push({ type: "text", content: s.slice(i, open) });
      }

      let pos = open + 3;
      let lang = "";
      while (pos < s.length && /[a-zA-Z0-9_+#.-]/.test(s[pos])) {
        lang += s[pos++];
      }

      if (s[pos] === "\n") {
        pos += 1;
      } else if (s[pos] === " " || s[pos] === "\t") {
        pos += 1;
      }

      const bodyStart = pos;
      let close = s.indexOf("```", bodyStart);
      if (close === -1) {
        segments.push({ type: "code", lang, content: s.slice(bodyStart).trimEnd() });
        break;
      }

      let content = s.slice(bodyStart, close);
      content = content.replace(/^\n+/, "").replace(/\n+$/, "");
      segments.push({ type: "code", lang, content });
      i = close + 3;
      while (i < s.length && s[i] === "`") i += 1;
    }

    return segments;
  }

  function isFenceLine(line) {
    return /^`{3,}\s*/.test(String(line || "").trim());
  }

  function parseFenceOpen(line) {
    const m = String(line || "")
      .trim()
      .match(/^`{3,}\s*([\w.#+-]*)?\s*$/);
    return m ? (m[1] || "").trim() : null;
  }

  function isFenceClose(line) {
    return /^`{3,}\s*$/.test(String(line || "").trim());
  }

  function parseBlocks(raw) {
    const lines = normalizeNewlines(raw).split("\n");
    const blocks = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (isFenceLine(line)) {
        const lang = parseFenceOpen(line);
        if (lang !== null) {
          i += 1;
          const codeLines = [];
          while (i < lines.length && !isFenceClose(lines[i])) {
            codeLines.push(lines[i]);
            i += 1;
          }
          if (i < lines.length) i += 1;
          blocks.push({ type: "code", lang, content: codeLines.join("\n") });
          continue;
        }
      }

      if (!line.trim()) {
        i += 1;
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
        i += 1;
        continue;
      }

      const boldHeading = line.trim().match(/^\*\*(.+)\*\*$/);
      if (boldHeading) {
        blocks.push({ type: "heading", level: 4, text: boldHeading[1] });
        i += 1;
        continue;
      }

      if (/^\s*(\d+\.|-|\*)\s+/.test(line)) {
        const ordered = /^\s*\d+\./.test(line);
        const items = [];
        while (i < lines.length && /^\s*(\d+\.|-|\*)\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*(\d+\.|-|\*)\s+/, ""));
          i += 1;
        }
        blocks.push({ type: "list", ordered, items });
        continue;
      }

      const paraLines = [];
      while (i < lines.length) {
        const l = lines[i];
        if (!l.trim()) break;
        if (isFenceLine(l) && parseFenceOpen(l) !== null) break;
        if (/^(#{1,6})\s+/.test(l)) break;
        if (/^\s*(\d+\.|-|\*)\s+/.test(l)) break;
        if (/^\*\*(.+)\*\*$/.test(l.trim())) break;
        if (l.includes("```")) break;
        paraLines.push(l);
        i += 1;
      }
      if (paraLines.length) {
        blocks.push({ type: "paragraph", lines: paraLines });
      }
    }

    return blocks;
  }

  function parseMessageBlocks(raw) {
    const normalized = normalizeMarkdown(raw);
    const segments = splitByCodeFences(normalized);
    const blocks = [];

    segments.forEach((seg) => {
      if (seg.type === "code") {
        blocks.push({ type: "code", lang: seg.lang || "", content: seg.content });
      } else {
        blocks.push(...parseBlocks(seg.content));
      }
    });

    return blocks;
  }

  function formatInline(s) {
    let out = "";
    let i = 0;
    const str = String(s || "");

    while (i < str.length) {
      if (str.slice(i, i + 3) === "```") {
        i += 3;
        continue;
      }

      if (str[i] === "`") {
        const end = str.indexOf("`", i + 1);
        if (end !== -1 && str.slice(end, end + 3) !== "```") {
          out += `<code class="nc-ads-inline-code">${escapeHtml(str.slice(i + 1, end))}</code>`;
          i = end + 1;
          continue;
        }
      }

      if (str.slice(i, i + 2) === "**") {
        const end = str.indexOf("**", i + 2);
        if (end !== -1) {
          out += `<strong>${escapeHtml(str.slice(i + 2, end))}</strong>`;
          i = end + 2;
          continue;
        }
      }

      if (str[i] === "*" && str[i + 1] !== "*") {
        const end = str.indexOf("*", i + 1);
        if (end !== -1 && str[end + 1] !== "*") {
          out += `<em>${escapeHtml(str.slice(i + 1, end))}</em>`;
          i = end + 1;
          continue;
        }
      }

      if (str[i] === "[") {
        const close = str.indexOf("]", i + 1);
        const paren = close !== -1 ? str.indexOf("(", close + 1) : -1;
        const closeParen = paren !== -1 ? str.indexOf(")", paren + 1) : -1;
        if (close !== -1 && paren === close + 1 && closeParen !== -1) {
          const label = str.slice(i + 1, close);
          const url = str.slice(paren + 1, closeParen);
          if (/^(https?:\/\/|mailto:|\/)/i.test(url.trim())) {
            out += `<a href="${escapeHtml(url.trim())}" target="_blank" rel="noopener noreferrer">${escapeHtml(
              label
            )}</a>`;
            i = closeParen + 1;
            continue;
          }
        }
      }

      let next = i + 1;
      while (next < str.length) {
        const ch = str[next];
        if (ch === "`" || ch === "*" || ch === "[") break;
        next += 1;
      }
      out += escapeHtml(str.slice(i, next));
      i = next;
    }
    return out;
  }

  function renderHeading(level, text) {
    const n = Math.min(6, Math.max(3, level));
    const tag = `h${n}`;
    return `<${tag} class="nc-ads-heading nc-ads-heading--${n}">${formatInline(text)}</${tag}>`;
  }

  function renderParagraph(lines) {
    if (!lines.length) return "";
    return lines
      .filter((l) => String(l || "").trim())
      .map((l) => `<p>${formatInline(l)}</p>`)
      .join("");
  }

  function renderList(ordered, items) {
    const tag = ordered ? "ol" : "ul";
    const body = items.map((item) => `<li>${formatInline(item)}</li>`).join("");
    return `<${tag} class="nc-ads-list">${body}</${tag}>`;
  }

  function formatCodeForDisplay(code, lang) {
    const c = String(code || "").trimEnd();
    if (c.includes("\n")) return c;
    const l = String(lang || "").toLowerCase();
    if (l === "sh" || l === "bash" || l === "shell" || l === "zsh" || c.startsWith("#!")) {
      return c
        .replace(/^(\#!\/[^\s]+)\s+/, "$1\n")
        .replace(/\s+(echo\s+)/i, "\n$1");
    }
    if (c.length > 56) {
      return c.replace(/;\s+/g, ";\n");
    }
    return c;
  }

  function renderCodeBlock(lang, code) {
    const label = String(lang || "").trim();
    const langLabel = label || "code";
    const body = formatCodeForDisplay(code, lang);
    const langClass = label ? ` language-${escapeHtml(label)}` : "";
    return `<div class="nc-ads-code-block" data-lang="${escapeHtml(langLabel)}">
  <div class="nc-ads-code-toolbar">
    <span class="nc-ads-code-lang-badge" aria-hidden="true">&lt;/&gt;</span>
    <span class="nc-ads-code-lang">${escapeHtml(langLabel)}</span>
    <button type="button" class="nc-ads-code-copy" title="Copy code" aria-label="Copy code">
      <svg class="nc-ads-code-copy-ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      <span class="nc-ads-code-copy-label">Copy code</span>
    </button>
  </div>
  <div class="nc-ads-code-body">
    <pre class="nc-ads-code-pre" tabindex="0"><code class="nc-ads-code-snippet${langClass}">${escapeHtml(body)}</code></pre>
  </div>
</div>`;
  }

  function renderBlocks(blocks) {
    return blocks
      .map((b) => {
        if (b.type === "code") return renderCodeBlock(b.lang, b.content);
        if (b.type === "heading") return renderHeading(b.level, b.text);
        if (b.type === "list") return renderList(b.ordered, b.items);
        if (b.type === "paragraph") return renderParagraph(b.lines);
        return "";
      })
      .join("");
  }

  function formatAssistantMessage(text) {
    const raw = String(text || "");
    if (!raw.trim()) return "";
    const blocks = parseMessageBlocks(raw);
    if (!blocks.length) {
      return `<div class="nc-ads-md"><p>${escapeHtml(raw).replace(/\n/g, "<br>")}</p></div>`;
    }
    return `<div class="nc-ads-md">${renderBlocks(blocks)}</div>`;
  }

  function wireCodeCopyButtons(root) {
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll(".nc-ads-code-copy").forEach((btn) => {
      if (btn.dataset.wired === "1") return;
      btn.dataset.wired = "1";
      btn.addEventListener("click", () => {
        const block = btn.closest(".nc-ads-code-block");
        const code = block?.querySelector(".nc-ads-code-snippet")?.textContent || "";
        const label = btn.querySelector(".nc-ads-code-copy-label");
        const done = () => {
          if (label) label.textContent = "Copied!";
          btn.classList.add("is-copied");
          window.setTimeout(() => {
            if (label) label.textContent = "Copy code";
            btn.classList.remove("is-copied");
          }, 1800);
        };
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(code).then(done, () => window.alert("Could not copy."));
        } else {
          window.alert("Copy is not supported in this browser.");
        }
      });
    });
  }

  global.NcAiChatFormat = {
    escapeHtml,
    formatAssistantMessage,
    wireCodeCopyButtons,
  };
})(typeof window !== "undefined" ? window : globalThis);
