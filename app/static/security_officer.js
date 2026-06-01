(function () {
  "use strict";

  const root = document.getElementById("security-officer-root");
  if (!root) return;

  const API = "/intranet/api/security-officer/stats";
  const REPORT_PDF = "/intranet/api/security-officer/report.pdf";
  const trainingUrl = "/intranet/security-training";

  let allUsers = [];

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function statusLabel(status) {
    if (status === "complete") return "Fully completed";
    if (status === "in_progress") return "In progress";
    if (status === "not_started") return "Not started";
    return "—";
  }

  function setKpi(key, val, meta) {
    const v = root.querySelector(`[data-so-kpi="${key}"]`);
    if (v) v.textContent = val;
    if (meta) {
      const m = root.querySelector(`[data-so-kpi="${key}-meta"]`);
      if (m) m.textContent = meta;
    }
  }

  function renderSummary(data) {
    const s = data.summary || {};
    const modules = Number(data.training_modules || 0);
    const users = Number(s.users_in_scope || 0);
    const complete = Number(s.all_complete || 0);
    const inProg = Number(s.in_progress || 0);
    const notStarted = Number(s.not_started || 0);
    const rate = s.completion_rate_pct != null ? `${s.completion_rate_pct}%` : "0%";

    setKpi("users", String(users));
    setKpi("complete", String(complete), complete === 1 ? "user finished all modules" : "users finished all modules");
    setKpi("progress", String(inProg));
    setKpi("not-started", String(notStarted));
    setKpi("rate", rate);
    const modEl = root.querySelector('[data-so-kpi="modules"]');
    if (modEl) modEl.textContent = String(modules);

    const asAt = document.getElementById("so-as-at");
    if (asAt) {
      const d = new Date();
      asAt.textContent = `As at ${d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
    }
  }

  function filteredUsers() {
    const q = (document.getElementById("so-search")?.value || "").trim().toLowerCase();
    const st = (document.getElementById("so-status-filter")?.value || "").trim();
    return allUsers.filter((u) => {
      if (st && u.status !== st) return false;
      if (!q) return true;
      const hay = `${u.full_name || ""} ${u.username || ""} ${u.email || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }

  function renderTable() {
    const body = document.getElementById("so-users-body");
    if (!body) return;
    const rows = filteredUsers();
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="4" class="nc-so-empty">No users match this filter.</td></tr>';
      return;
    }
    body.innerHTML = rows
      .map((u) => {
        const total = Number(u.total || 0);
        const done = Number(u.completed || 0);
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        const name = (u.full_name || u.username || u.email || "User").trim();
        const badgeClass =
          u.status === "complete"
            ? "nc-so-badge--complete"
            : u.status === "in_progress"
              ? "nc-so-badge--in_progress"
              : "nc-so-badge--not_started";
        const viewHref = `${trainingUrl}?user_id=${encodeURIComponent(String(u.user_id))}`;
        return `<tr>
          <td>
            <span class="nc-so-user-name">${escapeHtml(name)}</span>
            ${u.email ? `<span class="nc-so-user-email">${escapeHtml(u.email)}</span>` : ""}
          </td>
          <td><span class="nc-so-badge ${badgeClass}">${escapeHtml(statusLabel(u.status))}</span></td>
          <td>
            <div>${done} / ${total} (${pct}%)</div>
            <div class="nc-so-bar" aria-hidden="true"><span style="width:${pct}%"></span></div>
          </td>
          <td><a class="nc-so-link" href="${escapeHtml(viewHref)}">View training</a></td>
        </tr>`;
      })
      .join("");
  }

  async function load() {
    try {
      const r = await fetch(API, { credentials: "same-origin" });
      if (!r.ok) throw new Error("load failed");
      const data = await r.json();
      allUsers = data.users || [];
      renderSummary(data);
      renderTable();
      if (!Number(data.training_modules)) {
        const body = document.getElementById("so-users-body");
        if (body) {
          body.innerHTML =
            '<tr><td colspan="4" class="nc-so-empty">No training modules uploaded yet. Add files to the Security Training folder.</td></tr>';
        }
      }
    } catch (_e) {
      const body = document.getElementById("so-users-body");
      if (body) body.innerHTML = '<tr><td colspan="4" class="nc-so-empty">Could not load dashboard data.</td></tr>';
      const asAt = document.getElementById("so-as-at");
      if (asAt) asAt.textContent = "Error loading data";
    }
  }

  function filenameFromDisposition(header) {
    if (!header) return "";
    const m = /filename\*?=(?:UTF-8''|")?([^";\n]+)/i.exec(header);
    return m ? m[1].trim().replace(/^"|"$/g, "") : "";
  }

  async function downloadReport() {
    const btn = document.getElementById("so-print-report");
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = "Generating…";
    try {
      const r = await fetch(REPORT_PDF, { credentials: "same-origin" });
      if (!r.ok) throw new Error("Report failed");
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        filenameFromDisposition(r.headers.get("Content-Disposition")) ||
        `security-training-report-${new Date().toISOString().slice(0, 10)}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (_e) {
      window.alert("Could not generate the PDF report. Please try again.");
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
  }

  document.getElementById("so-search")?.addEventListener("input", renderTable);
  document.getElementById("so-status-filter")?.addEventListener("change", renderTable);
  document.getElementById("so-print-report")?.addEventListener("click", downloadReport);
  load();
})();
