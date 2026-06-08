/* global Chart */
(function () {
  /** @type {Array<{id:string,name:string,email:string,phone?:string,type:"Employee"|"Contractor",department:string,role:string,project_end_date?:string,contract_end_date?:string,contract_start_date?:string,start_date?:string,compliance_gaps?:string[]}>} */
  const PEOPLE_ALL = Array.isArray(window.__WFD_PEOPLE__) ? window.__WFD_PEOPLE__ : [];
  const WFD_DATE_FILTER_KEY = "nc.wfd.dateFilter.v1";
  let dateFilterFrom = "";
  let dateFilterTo = "";
  /** Roster slice after date filter (defaults to full list). */
  let activePeople = PEOPLE_ALL.slice();

  function getPeople() {
    return activePeople;
  }

  /** Server-side grouping by department / project (same as Workforce directory seed). */
  let PROJECT_MEMBERS_SEED = {};
  try {
    const s = window.__WFD_PROJECT_MEMBERS_SEED__;
    PROJECT_MEMBERS_SEED = s && typeof s === "object" ? s : {};
  } catch (_) {
    PROJECT_MEMBERS_SEED = {};
  }

  /** Maps duplicate account ids → canonical user id (same email merged for Workforce). */
  const USER_ID_ALIASES = (function () {
    try {
      const m = window.__WFD_USER_ID_ALIASES__;
      if (!m || typeof m !== "object") return {};
      const out = {};
      Object.keys(m).forEach((k) => {
        const v = m[k];
        if (v != null && String(v).trim() !== "") out[String(k)] = String(v).trim();
      });
      return out;
    } catch (_) {
      return {};
    }
  })();

  function canonicalUserId(raw) {
    let id = String(raw ?? "").trim();
    if (!id) return id;
    const seen = new Set();
    while (USER_ID_ALIASES[id] && !seen.has(id)) {
      seen.add(id);
      id = USER_ID_ALIASES[id];
    }
    return id;
  }

  function remapMembersMap(raw) {
    const out = {};
    Object.keys(raw || {}).forEach((proj) => {
      const arr = Array.isArray(raw[proj]) ? raw[proj] : [];
      const ids = [];
      const seen = new Set();
      arr.forEach((rid) => {
        const c = canonicalUserId(rid);
        if (c && !seen.has(c)) {
          seen.add(c);
          ids.push(c);
        }
      });
      out[proj] = ids;
    });
    return out;
  }

  function normProjectName(s) {
    const out = String(s ?? "").trim().replace(/\s+/g, " ");
    return out.length > 120 ? out.slice(0, 120) : out;
  }

  function stripProjectPrefix(s) {
    let t = String(s ?? "").trim().replace(/\s+/g, " ");
    while (t.length >= 8 && t.slice(0, 8).toLowerCase() === "project:") {
      t = t.slice(8).trim();
    }
    return t.length > 120 ? t.slice(0, 120) : t;
  }

  function canonicalProjectName(s) {
    return normProjectName(stripProjectPrefix(s));
  }

  /** Same rules as directory_panel.js / `data-project` on Workforce. */
  function keyForProject(name) {
    return canonicalProjectName(name).toLowerCase();
  }

  /** Normalizes project labels to stable lowercase keys (same as Workforce directory). */
  function normalizeMembersMap(raw) {
    const out = {};
    Object.keys(raw || {}).forEach((proj) => {
      const k = keyForProject(proj);
      if (!k) return;
      const arr = Array.isArray(raw[proj]) ? raw[proj] : [];
      const ids = arr.map((x) => String(x).trim()).filter(Boolean);
      if (!out[k]) out[k] = [];
      out[k].push(...ids);
    });
    Object.keys(out).forEach((k) => {
      out[k] = [...new Set(out[k])];
    });
    return out;
  }

  const WFD_BENCH_PROJECT_KEY = keyForProject("Unassigned");

  function getFilteredProjectMembersRaw() {
    const activeIds = new Set(getPeople().map((p) => String(p.id)));
    const out = {};
    Object.keys(PROJECT_MEMBERS_SEED || {}).forEach((proj) => {
      const arr = Array.isArray(PROJECT_MEMBERS_SEED[proj]) ? PROJECT_MEMBERS_SEED[proj] : [];
      const ids = [];
      const seen = new Set();
      arr.forEach((rid) => {
        const c = canonicalUserId(rid);
        if (c && activeIds.has(c) && !seen.has(c)) {
          seen.add(c);
          ids.push(c);
        }
      });
      if (ids.length) out[proj] = ids;
    });
    return out;
  }

  /** Assigned-to-project rows only (matches Workforce directory; Unassigned / bench excluded). */
  function workforceAssignmentsFromSeedOnly() {
    const seedOnly = normalizeMembersMap(remapMembersMap(getFilteredProjectMembersRaw()));
    const out = {};
    Object.keys(seedOnly).forEach((k) => {
      if (k === WFD_BENCH_PROJECT_KEY) return;
      out[k] = seedOnly[k];
    });
    return out;
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function phoneTableCell(phone) {
    const ph = String(phone || "").trim();
    if (!ph) return "";
    const dial = ph.replace(/[^\d+]/g, "");
    const href = dial ? `tel:${dial}` : `tel:${encodeURIComponent(ph)}`;
    return `<a href="${escAttr(href)}">${esc(ph)}</a>`;
  }

  /** Opens workforce profile overlay on the Directory page (`directory_panel.js` deep link). */
  function workforceProfileHref(personId) {
    try {
      const raw = window.__WFD_DIRECTORY_URL__;
      const base = String(raw != null && raw !== "" ? raw : "/intranet/directory").replace(/\/$/, "");
      const id = encodeURIComponent(String(personId || "").trim());
      if (!id) return "";
      return `${base}?user_id=${id}`;
    } catch (_) {
      return "";
    }
  }

  function nameTableCell(p) {
    const nm = esc(p.name || "");
    const href = workforceProfileHref(p.id);
    if (!href) return nm;
    return `<a class="nc-wfd-link" href="${escAttr(href)}">${nm}</a>`;
  }

  function loadMergedProjectMembers() {
    return workforceAssignmentsFromSeedOnly();
  }

  let PROJECT_LABEL_MAP = {};
  try {
    const pl = window.__WFD_PROJECT_LABELS__;
    PROJECT_LABEL_MAP = pl && typeof pl === "object" ? pl : {};
  } catch (_) {
    PROJECT_LABEL_MAP = {};
  }

  /** Display name for a normalized project key (matches Workforce section labels). */
  function labelForProjectKey(storageKey) {
    const key = String(storageKey || "")
      .replace(/^p:/, "")
      .trim()
      .toLowerCase();
    if (!key) return "";
    if (PROJECT_LABEL_MAP[key]) return PROJECT_LABEL_MAP[key];
    return key.replace(/\b\w/g, (ch) => ch.toUpperCase());
  }

  /** User-created project shells from Workforce directory ("Create New Project"). */
  function loadExplicitProjectKeysSet() {
    try {
      const raw = localStorage.getItem("dir.contractorProjects.v1");
      const j = raw ? JSON.parse(raw) : [];
      const out = new Set();
      if (Array.isArray(j)) {
        j.forEach((x) => {
          const k = keyForProject(x);
          if (k) out.add(k);
        });
      }
      return out;
    } catch (_) {
      return new Set();
    }
  }

  /** Keys from server seed (after normalisation) — any assigned workforce project counts as a slice. */
  function knownSeedProjectKeysSet() {
    try {
      const norm = normalizeMembersMap(remapMembersMap(getFilteredProjectMembersRaw()));
      return new Set(Object.keys(norm || {}));
    } catch (_) {
      return new Set();
    }
  }

  /**
   * True if this LS bucket should appear as its own slice (vs rolled into Employee & Bench).
   * Matches explicit Create-project names, server workforce-project assignments, or labels containing "project".
   */
  function isProjectSliceKey(lsKey, explicitKeys, seedKeys) {
    const k = String(lsKey || "").toLowerCase();
    if (explicitKeys.has(k)) return true;
    if (seedKeys && seedKeys.size && seedKeys.has(k)) return true;
    const label = labelForProjectKey(lsKey);
    const hay = `${label} ${lsKey}`.toLowerCase();
    return /\bproject\b/.test(hay);
  }

  function assignedProjectById(projectMembers) {
    /** @type {Map<string,string>} */
    const m = new Map();
    Object.keys(projectMembers || {}).forEach((k) => {
      const arr = Array.isArray(projectMembers[k]) ? projectMembers[k] : [];
      const projName = String(k || "").replace(/^p:/, "");
      for (const id of arr) {
        const v = String(id || "").trim();
        if (v) m.set(v, projName);
      }
    });
    return m;
  }

  function buildLegend(el, items) {
    if (!el) return;
    el.innerHTML = items
      .map(
        (it) => `<div class="nc-wfd-legend-row">
          <div style="display:flex; align-items:center; min-width:0;">
            <span class="nc-wfd-dot" style="background:${esc(it.color)}"></span>
            <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(it.label)}</span>
          </div>
          <div>${esc(it.value)}</div>
        </div>`
      )
      .join("");
  }

  let wfdCharts = [];

  function destroyCharts() {
    wfdCharts.forEach((c) => {
      try {
        c.destroy();
      } catch (_) {}
    });
    wfdCharts = [];
  }

  function parseIsoDateInput(v) {
    const s = String(v || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    return Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  }

  /** Resource overlaps [from, to] using start and contract/project end dates. */
  function personActiveInRange(p, fromMs, toMs) {
    if (fromMs == null && toMs == null) return true;
    const startMs =
      contractEndMillis(p.start_date) ?? contractEndMillis(p.contract_start_date);
    const ends = [p.contract_end_date, p.project_end_date]
      .map(contractEndMillis)
      .filter((x) => x != null);
    const endMs = ends.length ? Math.min(...ends) : null;
    const effStart = startMs ?? 0;
    const effEnd = endMs ?? Number.POSITIVE_INFINITY;
    const rangeStart = fromMs ?? 0;
    const rangeEnd = toMs ?? Number.POSITIVE_INFINITY;
    return effStart <= rangeEnd && effEnd >= rangeStart;
  }

  function applyDateFilterState() {
    const fromMs = dateFilterFrom ? parseIsoDateInput(dateFilterFrom) : null;
    const toMs = dateFilterTo ? parseIsoDateInput(dateFilterTo) : null;
    if (fromMs != null && toMs != null && fromMs > toMs) {
      window.alert("From date must be on or before To date.");
      return false;
    }
    activePeople = PEOPLE_ALL.filter((p) => personActiveInRange(p, fromMs, toMs));
    return true;
  }

  function loadDateFilterFromStorage() {
    try {
      const raw = localStorage.getItem(WFD_DATE_FILTER_KEY);
      if (!raw) return;
      const j = JSON.parse(raw);
      if (j && typeof j === "object") {
        dateFilterFrom = String(j.from || "").trim();
        dateFilterTo = String(j.to || "").trim();
      }
    } catch (_) {}
  }

  function saveDateFilterToStorage() {
    try {
      if (!dateFilterFrom && !dateFilterTo) {
        localStorage.removeItem(WFD_DATE_FILTER_KEY);
        return;
      }
      localStorage.setItem(
        WFD_DATE_FILTER_KEY,
        JSON.stringify({ from: dateFilterFrom, to: dateFilterTo })
      );
    } catch (_) {}
  }

  function formatFilterChipDate(iso) {
    const ms = parseIsoDateInput(iso);
    if (ms == null) return iso;
    const d = new Date(ms);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }

  function updateAsAtLabel() {
    const el = document.getElementById("wfd-as-at");
    if (!el) return;
    const base = String(window.__WFD_AS_AT_LABEL__ || el.dataset.defaultLabel || el.textContent || "").trim();
    if (!el.dataset.defaultLabel) el.dataset.defaultLabel = base;
    if (dateFilterFrom || dateFilterTo) {
      if (dateFilterFrom && dateFilterTo) {
        el.textContent = `${formatFilterChipDate(dateFilterFrom)} – ${formatFilterChipDate(dateFilterTo)}`;
      } else if (dateFilterFrom) {
        el.textContent = `From ${formatFilterChipDate(dateFilterFrom)}`;
      } else {
        el.textContent = `To ${formatFilterChipDate(dateFilterTo)}`;
      }
    } else {
      el.textContent = base;
    }
  }

  function kpiPct(n, total) {
    if (!total) return "0%";
    return `${Math.round((n / total) * 1000) / 10}%`;
  }

  /** Contracts Expiring KPI + Contract End column highlight (profile date, next 60 days). */
  const WFD_CONTRACT_EXPIRING_DAYS = 60;

  function referenceDateMs() {
    if (dateFilterTo) return parseIsoDateInput(dateFilterTo);
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  }

  function profileContractEndMs(p) {
    return contractEndMillis(p && p.contract_end_date);
  }

  function daysUntilContractEnd(endMs, refMs) {
    if (endMs == null || refMs == null) return null;
    return Math.floor((endMs - refMs) / 86400000);
  }

  function isContractExpiringWithin60(endMs, refMs) {
    const days = daysUntilContractEnd(endMs, refMs);
    if (days == null) return false;
    return days >= 0 && days <= WFD_CONTRACT_EXPIRING_DAYS;
  }

  function updateKpis() {
    const people = getPeople();
    const total = people.length;
    let employees = 0;
    let contractors = 0;
    for (const p of people) {
      const t = String((p && p.type) || "").trim().toLowerCase();
      if (t === "contractor") contractors += 1;
      else employees += 1;
    }
    const ref = referenceDateMs();
    const windowMs = 30 * 86400000;
    let onboarding = 0;
    let contractsExpiring = 0;
    let nonCompliant = 0;
    for (const p of people) {
      const sd = contractEndMillis(p.start_date) ?? contractEndMillis(p.contract_start_date);
      if (sd != null && ref - windowMs <= sd && sd <= ref) onboarding += 1;
      if (isContractExpiringWithin60(profileContractEndMs(p), ref)) contractsExpiring += 1;
      const gaps = p.compliance_gaps;
      if (Array.isArray(gaps) && gaps.length) nonCompliant += 1;
    }
    const set = (key, val) => {
      const el = document.querySelector(`[data-wfd-kpi="${key}"]`);
      if (el) el.textContent = String(val);
    };
    set("total", total);
    set("active", total);
    set("total-meta", `${employees} Employees ・ ${contractors} Contractors`);
    const filtered = total !== PEOPLE_ALL.length;
    set(
      "active-meta",
      filtered && PEOPLE_ALL.length ? `${kpiPct(total, PEOPLE_ALL.length)} of all resources` : "100% of total"
    );
    set("onboarding", onboarding);
    set("onboarding-meta", `${kpiPct(onboarding, total)} of total`);
    set("non-compliant", nonCompliant);
    set("non-compliant-meta", `${kpiPct(nonCompliant, total)} missing profile fields`);
    set("contracts-expiring", contractsExpiring);
    set("contracts-expiring-meta", `${kpiPct(contractsExpiring, total)} of total`);

    const footEmp = document.querySelector('[data-wfd-dept-foot="employees"]');
    const footCon = document.querySelector('[data-wfd-dept-foot="contractors"]');
    const footTot = document.querySelector('[data-wfd-dept-foot="total"]');
    if (footEmp) footEmp.textContent = String(employees);
    if (footCon) footCon.textContent = String(contractors);
    if (footTot) footTot.textContent = String(total);
  }

  function renderDeptTable() {
    const tb = document.getElementById("wfd-dept-tbody");
    if (!tb) return;
    /** @type {Record<string, {dept:string, employees:number, contractors:number, total:number}>} */
    const byDept = {};
    for (const p of getPeople()) {
      const dept = String((p && p.department) || "").trim() || "Unassigned";
      const r = byDept[dept] || { dept, employees: 0, contractors: 0, total: 0 };
      if (String((p && p.type) || "").trim().toLowerCase() === "contractor") r.contractors += 1;
      else r.employees += 1;
      r.total += 1;
      byDept[dept] = r;
    }
    const rows = Object.values(byDept).sort((a, b) => String(a.dept).localeCompare(String(b.dept)));
    tb.innerHTML = rows.length
      ? rows
          .map(
            (r) => `<tr>
              <td>${esc(r.dept)}</td>
              <td style="text-align:right;">${r.employees}</td>
              <td style="text-align:right;">${r.contractors}</td>
              <td style="text-align:right; font-weight: 750;">${r.total}</td>
            </tr>`
          )
          .join("")
      : '<tr><td colspan="4" class="nc-intranet-muted">No data.</td></tr>';
  }

  function syncFilterButtonState() {
    const btn = document.getElementById("wfd-filters-btn");
    if (!btn) return;
    const on = !!(dateFilterFrom || dateFilterTo);
    btn.classList.toggle("is-active", on);
  }

  function closeFiltersPopover() {
    const pop = document.getElementById("wfd-filters-popover");
    const btn = document.getElementById("wfd-filters-btn");
    if (pop) pop.hidden = true;
    if (btn) btn.setAttribute("aria-expanded", "false");
  }

  function openFiltersPopover() {
    const pop = document.getElementById("wfd-filters-popover");
    const btn = document.getElementById("wfd-filters-btn");
    const fromEl = document.getElementById("wfd-filter-from");
    const toEl = document.getElementById("wfd-filter-to");
    if (fromEl) fromEl.value = dateFilterFrom;
    if (toEl) toEl.value = dateFilterTo;
    if (pop) pop.hidden = false;
    if (btn) btn.setAttribute("aria-expanded", "true");
    fromEl?.focus();
  }

  function refreshDashboard() {
    if (!applyDateFilterState()) return;
    saveDateFilterToStorage();
    syncFilterButtonState();
    updateAsAtLabel();
    updateKpis();
    renderDeptTable();
    destroyCharts();
    initCharts();
    renderWorkforceList();
  }

  function wireDateFilters() {
    const btn = document.getElementById("wfd-filters-btn");
    const pop = document.getElementById("wfd-filters-popover");
    const fromEl = document.getElementById("wfd-filter-from");
    const toEl = document.getElementById("wfd-filter-to");
    const applyBtn = document.getElementById("wfd-filter-apply");
    const clearBtn = document.getElementById("wfd-filter-clear");
    if (!btn || !pop) return;

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (pop.hidden) openFiltersPopover();
      else closeFiltersPopover();
    });

    applyBtn?.addEventListener("click", () => {
      dateFilterFrom = String(fromEl?.value || "").trim();
      dateFilterTo = String(toEl?.value || "").trim();
      closeFiltersPopover();
      refreshDashboard();
    });

    clearBtn?.addEventListener("click", () => {
      dateFilterFrom = "";
      dateFilterTo = "";
      if (fromEl) fromEl.value = "";
      if (toEl) toEl.value = "";
      closeFiltersPopover();
      refreshDashboard();
    });

    pop.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", () => {
      if (!pop.hidden) closeFiltersPopover();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !pop.hidden) closeFiltersPopover();
    });
    [fromEl, toEl].forEach((el) => {
      el?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          applyBtn?.click();
        }
      });
    });
  }

  function countTypes() {
    let employees = 0;
    let contractors = 0;
    for (const p of getPeople()) {
      const t = String((p && p.type) || "").trim().toLowerCase();
      if (t === "contractor") contractors += 1;
      else employees += 1;
    }
    return { employees, contractors };
  }

  function initCharts() {
    const typeCanvas = document.getElementById("wfd-type");
    const projCanvas = document.getElementById("wfd-project");
    const cCanvas = document.getElementById("wfd-contractors");
    if (!typeCanvas || !projCanvas || !cCanvas) return;
    if (typeof Chart === "undefined") return;

    const { employees, contractors } = countTypes();

    const typeColors = ["rgba(37, 99, 235, .85)", "rgba(148, 163, 184, .9)"];
    wfdCharts.push(
      new Chart(typeCanvas.getContext("2d"), {
      type: "doughnut",
      data: {
        labels: ["Employees", "Contractors"],
        datasets: [{ data: [employees, contractors], backgroundColor: typeColors, borderWidth: 0 }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "68%",
        plugins: { legend: { display: false }, tooltip: { enabled: true } },
      },
    })
    );
    buildLegend(document.getElementById("wfd-type-legend"), [
      { label: "Employees", value: employees, color: typeColors[0] },
      { label: "Contractors", value: contractors, color: typeColors[1] },
    ]);

    // Workforce by project: counts per real project slice only (department buckets → Employee & Bench).
    const projLs = workforceAssignmentsFromSeedOnly();
    const explicitProjectKeys = loadExplicitProjectKeysSet();
    const seedProjectKeys = knownSeedProjectKeysSet();
    const assignedToProjectSlices = new Set();
    Object.keys(projLs).forEach((k) => {
      if (!isProjectSliceKey(k, explicitProjectKeys, seedProjectKeys)) return;
      (projLs[k] || []).forEach((id) => assignedToProjectSlices.add(String(id)));
    });
    const projEntries = [];
    Object.keys(projLs).forEach((k) => {
      if (!isProjectSliceKey(k, explicitProjectKeys, seedProjectKeys)) return;
      const n = (projLs[k] || []).length;
      if (n > 0) projEntries.push({ label: labelForProjectKey(k), count: n });
    });
    projEntries.sort((a, b) => b.count - a.count);
    let labels = projEntries.map((e) => e.label);
    let values = projEntries.map((e) => e.count);
    let unallocated = 0;
    for (const p of getPeople()) {
      if (!assignedToProjectSlices.has(String(p.id))) unallocated += 1;
    }
    if (unallocated > 0) {
      labels.push("Employee & Bench");
      values.push(unallocated);
    }
    if (!labels.length && getPeople().length) {
      labels = ["Employee & Bench"];
      values = [getPeople().length];
    }
    const projColors = [
      "rgba(37, 99, 235, .85)",
      "rgba(16, 185, 129, .85)",
      "rgba(245, 158, 11, .85)",
      "rgba(139, 92, 246, .85)",
      "rgba(14, 165, 233, .85)",
      "rgba(244, 63, 94, .85)",
      "rgba(148, 163, 184, .9)",
    ];
    wfdCharts.push(
      new Chart(projCanvas.getContext("2d"), {
        type: "doughnut",
        data: { labels, datasets: [{ data: values, backgroundColor: projColors.slice(0, values.length), borderWidth: 0 }] },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: "68%",
          plugins: { legend: { display: false }, tooltip: { enabled: true } },
        },
      })
    );
    buildLegend(
      document.getElementById("wfd-project-legend"),
      labels.map((l, i) => ({ label: l, value: values[i], color: projColors[i] || "rgba(148,163,184,.9)" }))
    );

    // Contractors by project (bar): same project-only buckets as the doughnut.
    const contractorIds = new Set(
      getPeople()
        .filter((p) => String((p && p.type) || "").trim().toLowerCase() === "contractor")
        .map((p) => String(p.id))
    );
    const cEntries = [];
    Object.keys(projLs).forEach((k) => {
      if (!isProjectSliceKey(k, explicitProjectKeys, seedProjectKeys)) return;
      let c = 0;
      (projLs[k] || []).forEach((id) => {
        if (contractorIds.has(String(id))) c += 1;
      });
      if (c > 0) cEntries.push({ label: labelForProjectKey(k), count: c });
    });
    cEntries.sort((a, b) => b.count - a.count);
    const topC = cEntries.slice(0, 12);
    wfdCharts.push(
      new Chart(cCanvas.getContext("2d"), {
        type: "bar",
        data: {
          labels: topC.map((x) => x.label),
          datasets: [{ label: "Contractors", data: topC.map((x) => x.count), backgroundColor: "rgba(37, 99, 235, .75)", borderRadius: 10 }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          indexAxis: "y",
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { color: "rgba(148,163,184,.18)" }, ticks: { precision: 0 } },
            y: { grid: { display: false } },
          },
        },
      })
    );
  }

  const _collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

  /** Full resource attribute catalog for Workforce List columns (key = sort key). */
  const WFD_COLUMN_CATALOG = [
    { key: "name", label: "Name" },
    { key: "type", label: "Type" },
    { key: "role", label: "Role / Title" },
    { key: "department", label: "Department" },
    { key: "project", label: "Project" },
    { key: "project_end", label: "Project End Date" },
    { key: "contract_end", label: "Contract End" },
    { key: "contract_start", label: "Contract Start" },
    { key: "contract_sign", label: "Contract Sign Date" },
    { key: "start_date", label: "Start Date" },
    { key: "email", label: "Email" },
    { key: "phone", label: "Phone" },
    { key: "location", label: "Location" },
    { key: "reports_to", label: "Reports To" },
    { key: "timezone", label: "Timezone" },
    { key: "intranet_login", label: "Firmgate Login" },
    { key: "contractor_company", label: "Contractor Company" },
    { key: "first_name", label: "First Name" },
    { key: "surname", label: "Surname" },
    { key: "presence", label: "Presence" },
  ];
  const WFD_DEFAULT_LIST_COLUMNS = [
    "name",
    "type",
    "role",
    "project",
    "project_end",
    "contract_end",
    "email",
    "phone",
  ];
  const WFD_COLS_STORAGE_KEY = "nc.wfd.listColumns.v1";
  const WFD_CATALOG_KEYS = new Set(WFD_COLUMN_CATALOG.map((c) => c.key));
  const WFD_CATALOG_BY_KEY = Object.fromEntries(WFD_COLUMN_CATALOG.map((c) => [c.key, c]));

  function loadListColumns() {
    try {
      const raw = localStorage.getItem(WFD_COLS_STORAGE_KEY);
      if (!raw) return WFD_DEFAULT_LIST_COLUMNS.slice();
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return WFD_DEFAULT_LIST_COLUMNS.slice();
      const out = parsed.map((k) => String(k)).filter((k) => WFD_CATALOG_KEYS.has(k));
      return out.length ? out : WFD_DEFAULT_LIST_COLUMNS.slice();
    } catch (_) {
      return WFD_DEFAULT_LIST_COLUMNS.slice();
    }
  }

  function saveListColumns(keys) {
    try {
      localStorage.setItem(WFD_COLS_STORAGE_KEY, JSON.stringify(keys));
    } catch (_) {}
  }

  let listColumns = loadListColumns();
  let listSortKey = "name";
  let listSortDir = "asc";
  let columnEditorDraft = null;

  function contractEndMillis(s) {
    const v = String(s || "").trim();
    if (!v) return null;
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
    if (iso) {
      const t = Date.UTC(+iso[1], +iso[2] - 1, +iso[3]);
      return Number.isFinite(t) ? t : null;
    }
    const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
    if (dmy) {
      const t = Date.UTC(+dmy[3], +dmy[2] - 1, +dmy[1]);
      return Number.isFinite(t) ? t : null;
    }
    const dmy2 = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(v);
    if (dmy2) {
      const t = Date.UTC(+dmy2[3], +dmy2[2] - 1, +dmy2[1]);
      return Number.isFinite(t) ? t : null;
    }
    return null;
  }

  /** Whole calendar days from today (UTC date) until contract end; null if unknown. */
  function daysFromTodayUntilContractEnd(dateStr) {
    const endMs = contractEndMillis(dateStr);
    if (endMs == null) return null;
    const now = new Date();
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return Math.floor((endMs - todayUtc) / 86400000);
  }

  /** CSS class for Contract End column — profile date expiring within 60 days. */
  function contractEndHighlightClass(dateStr) {
    const endMs = contractEndMillis(dateStr);
    if (endMs == null) return "";
    const now = new Date();
    const ref = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    if (isContractExpiringWithin60(endMs, ref)) return "nc-wfd-contract-end--urgent";
    const days = daysUntilContractEnd(endMs, ref);
    if (days != null && days > WFD_CONTRACT_EXPIRING_DAYS && days <= 90) {
      return "nc-wfd-contract-end--warn";
    }
    return "";
  }

  /**
   * @param {typeof PEOPLE[0]} a
   * @param {typeof PEOPLE[0]} b
   * @param {Map<string,string>} projById
   */
  const WFD_DATE_SORT_KEYS = new Set([
    "contract_end",
    "project_end",
    "contract_start",
    "contract_sign",
    "start_date",
  ]);

  function personSortText(p, key, projById) {
    switch (key) {
      case "name":
        return String(p.name || "");
      case "type":
        return String(p.type || "");
      case "role":
        return String(p.role || "");
      case "department":
        return String(p.department || "");
      case "project":
        return String(projById.get(String(p.id)) || "");
      case "project_end":
        return String(p.project_end_date || "");
      case "contract_end":
        return String(p.contract_end_date || "");
      case "contract_start":
        return String(p.contract_start_date || "");
      case "contract_sign":
        return String(p.contract_sign_date || "");
      case "start_date":
        return String(p.start_date || "");
      case "email":
        return String(p.email || "");
      case "phone":
        return String(p.phone || "");
      case "location":
        return String(p.location || "");
      case "reports_to":
        return String(p.reports_to || "");
      case "timezone":
        return String(p.timezone || "");
      case "intranet_login":
        return p.intranet_login_enabled === false ? "No" : "Yes";
      case "contractor_company":
        return String(p.contractor_company || "");
      case "first_name":
        return String(p.first_name || "");
      case "surname":
        return String(p.surname || "");
      case "presence":
        return String(p.presence_label || "");
      default:
        return "";
    }
  }

  function comparePeople(a, b, key, dir, projById) {
    const mul = dir === "asc" ? 1 : -1;
    if (WFD_DATE_SORT_KEYS.has(key)) {
      const field =
        key === "contract_end"
          ? "contract_end_date"
          : key === "project_end"
            ? "project_end_date"
            : key === "contract_start"
              ? "contract_start_date"
              : key === "contract_sign"
                ? "contract_sign_date"
                : "start_date";
      const ta = contractEndMillis(a[field]);
      const tb = contractEndMillis(b[field]);
      const sa = ta == null ? (dir === "asc" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY) : ta;
      const sb = tb == null ? (dir === "asc" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY) : tb;
      if (sa < sb) return -mul;
      if (sa > sb) return mul;
      return mul * _collator.compare(String(a.name || ""), String(b.name || ""));
    }
    const c = _collator.compare(personSortText(a, key, projById), personSortText(b, key, projById));
    return mul * c;
  }

  function renderListCell(p, colKey, projById) {
    const proj = projById.get(String(p.id)) || "";
    const projCell = proj ? labelForProjectKey(proj) : "";
    switch (colKey) {
      case "name":
        return `<td>${nameTableCell(p)}</td>`;
      case "type":
        return `<td>${esc(p.type)}</td>`;
      case "role":
        return `<td>${esc(p.role || "")}</td>`;
      case "department":
        return `<td>${esc(p.department || "")}</td>`;
      case "project":
        return `<td>${esc(projCell)}</td>`;
      case "project_end": {
        const v = String(p.project_end_date || "").trim();
        return `<td>${esc(v)}</td>`;
      }
      case "contract_end": {
        const end = String(p.contract_end_date || "").trim();
        const contractEndCls = end ? contractEndHighlightClass(end) : "";
        const inner = end
          ? contractEndCls
            ? `<span class="${esc(contractEndCls)}">${esc(end)}</span>`
            : esc(end)
          : "";
        return `<td>${inner}</td>`;
      }
      case "contract_start":
        return `<td>${esc(String(p.contract_start_date || "").trim())}</td>`;
      case "contract_sign":
        return `<td>${esc(String(p.contract_sign_date || "").trim())}</td>`;
      case "start_date":
        return `<td>${esc(String(p.start_date || "").trim())}</td>`;
      case "email":
        return `<td>${p.email ? `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : ""}</td>`;
      case "phone":
        return `<td>${phoneTableCell(p.phone)}</td>`;
      case "location":
        return `<td>${esc(p.location || "")}</td>`;
      case "reports_to":
        return `<td>${esc(p.reports_to || "")}</td>`;
      case "timezone":
        return `<td>${esc(p.timezone || "")}</td>`;
      case "intranet_login":
        return `<td>${esc(p.intranet_login_enabled === false ? "No" : "Yes")}</td>`;
      case "contractor_company":
        return `<td>${esc(p.contractor_company || "")}</td>`;
      case "first_name":
        return `<td>${esc(p.first_name || "")}</td>`;
      case "surname":
        return `<td>${esc(p.surname || "")}</td>`;
      case "presence":
        return `<td>${esc(p.presence_label || "")}</td>`;
      default:
        return `<td></td>`;
    }
  }

  function renderListHeader() {
    const row = document.getElementById("wfd-list-head-row");
    if (!row) return;
    row.innerHTML = listColumns
      .map((key) => {
        const def = WFD_CATALOG_BY_KEY[key];
        const label = def ? def.label : key;
        return `<th scope="col"><button type="button" class="nc-wfd-sort-btn" data-sort-key="${escAttr(key)}">${esc(label)}<span class="nc-wfd-sort-ind" aria-hidden="true"></span></button></th>`;
      })
      .join("");
  }

  function updateSortHeaderUI() {
    document.querySelectorAll("#wfd-list thead .nc-wfd-sort-btn").forEach((btn) => {
      const k = btn.getAttribute("data-sort-key");
      const ind = btn.querySelector(".nc-wfd-sort-ind");
      const th = btn.closest("th");
      if (k === listSortKey) {
        btn.classList.add("is-active");
        if (th) th.setAttribute("aria-sort", listSortDir === "asc" ? "ascending" : "descending");
        if (ind) ind.textContent = listSortDir === "asc" ? "▲" : "▼";
      } else {
        btn.classList.remove("is-active");
        if (th) th.setAttribute("aria-sort", "none");
        if (ind) ind.textContent = "";
      }
    });
  }

  function ensureSortKeyValid() {
    if (!listColumns.includes(listSortKey)) {
      listSortKey = listColumns[0] || "name";
      listSortDir = "asc";
    }
  }

  function renderWorkforceList() {
    const tb = document.querySelector("#wfd-list tbody");
    if (!tb) return;
    if (!listColumns.length) listColumns = WFD_DEFAULT_LIST_COLUMNS.slice();
    ensureSortKeyValid();
    renderListHeader();
    const members = loadMergedProjectMembers();
    const projById = assignedProjectById(members);
    const sorted = getPeople().slice().sort((a, b) => comparePeople(a, b, listSortKey, listSortDir, projById));
    const rows = sorted.map((p) => {
      const cells = listColumns.map((key) => renderListCell(p, key, projById)).join("");
      return `<tr>${cells}</tr>`;
    });
    tb.innerHTML = rows.join("");
    updateSortHeaderUI();
  }

  function wireListSort() {
    const thead = document.querySelector("#wfd-list thead");
    if (!thead || thead.dataset.wfdSortWired) return;
    thead.dataset.wfdSortWired = "1";
    thead.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest ? e.target.closest("[data-sort-key]") : null;
      if (!btn || !thead.contains(btn)) return;
      const key = btn.getAttribute("data-sort-key");
      if (!key) return;
      if (key === listSortKey) listSortDir = listSortDir === "asc" ? "desc" : "asc";
      else {
        listSortKey = key;
        listSortDir = "asc";
      }
      renderWorkforceList();
    });
  }

  function buildColumnEditorDraft() {
    const visible = new Set(listColumns);
    const ordered = listColumns.slice();
    WFD_COLUMN_CATALOG.forEach((c) => {
      if (!visible.has(c.key)) ordered.push(c.key);
    });
    return ordered.map((key) => ({ key, show: visible.has(key) }));
  }

  function renderColumnEditor() {
    const ul = document.getElementById("wfd-columns-editor");
    if (!ul || !columnEditorDraft) return;
    ul.innerHTML = "";
    columnEditorDraft.forEach((row, idx) => {
      const def = WFD_CATALOG_BY_KEY[row.key];
      const li = document.createElement("li");
      li.className = "nc-wfd-cols-row";
      li.setAttribute("role", "listitem");
      li.dataset.key = row.key;
      const up = document.createElement("button");
      up.type = "button";
      up.className = "nc-wfd-cols-move";
      up.textContent = "↑";
      up.disabled = idx === 0;
      up.setAttribute("aria-label", "Move up");
      const down = document.createElement("button");
      down.type = "button";
      down.className = "nc-wfd-cols-move";
      down.textContent = "↓";
      down.disabled = idx === columnEditorDraft.length - 1;
      down.setAttribute("aria-label", "Move down");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!row.show;
      cb.setAttribute("aria-label", `Show ${def ? def.label : row.key}`);
      cb.addEventListener("change", () => {
        row.show = cb.checked;
      });
      const span = document.createElement("span");
      span.textContent = def ? def.label : row.key;
      up.addEventListener("click", () => {
        if (idx <= 0) return;
        const prev = columnEditorDraft[idx - 1];
        columnEditorDraft[idx - 1] = row;
        columnEditorDraft[idx] = prev;
        renderColumnEditor();
      });
      down.addEventListener("click", () => {
        if (idx >= columnEditorDraft.length - 1) return;
        const next = columnEditorDraft[idx + 1];
        columnEditorDraft[idx + 1] = row;
        columnEditorDraft[idx] = next;
        renderColumnEditor();
      });
      li.appendChild(cb);
      li.appendChild(span);
      li.appendChild(up);
      li.appendChild(down);
      ul.appendChild(li);
    });
  }

  function openColumnEditor() {
    const dlg = document.getElementById("wfd-columns-dialog");
    if (!dlg) return;
    columnEditorDraft = buildColumnEditorDraft();
    renderColumnEditor();
    if (typeof dlg.showModal === "function") dlg.showModal();
  }

  function closeColumnEditor() {
    const dlg = document.getElementById("wfd-columns-dialog");
    columnEditorDraft = null;
    if (dlg) {
      try {
        dlg.close();
      } catch (_) {}
    }
  }

  function applyColumnEditor(save) {
    if (!save || !columnEditorDraft) {
      closeColumnEditor();
      return;
    }
    const next = columnEditorDraft.filter((r) => r.show).map((r) => r.key);
    if (!next.length) {
      window.alert("Select at least one column to display.");
      return;
    }
    listColumns = next;
    saveListColumns(listColumns);
    ensureSortKeyValid();
    closeColumnEditor();
    renderWorkforceList();
  }

  function wireColumnEditor() {
    const editBtn = document.getElementById("wfd-columns-edit");
    const dlg = document.getElementById("wfd-columns-dialog");
    if (editBtn) editBtn.addEventListener("click", () => openColumnEditor());
    document.getElementById("wfd-columns-close")?.addEventListener("click", () => closeColumnEditor());
    document.getElementById("wfd-columns-cancel")?.addEventListener("click", () => closeColumnEditor());
    document.getElementById("wfd-columns-save")?.addEventListener("click", () => applyColumnEditor(true));
    document.getElementById("wfd-columns-reset")?.addEventListener("click", () => {
      const vis = new Set(WFD_DEFAULT_LIST_COLUMNS);
      const ordered = WFD_DEFAULT_LIST_COLUMNS.slice();
      WFD_COLUMN_CATALOG.forEach((c) => {
        if (!vis.has(c.key)) ordered.push(c.key);
      });
      columnEditorDraft = ordered.map((key) => ({ key, show: vis.has(key) }));
      renderColumnEditor();
    });
    if (dlg) {
      dlg.addEventListener("cancel", (e) => {
        e.preventDefault();
        closeColumnEditor();
      });
      dlg.addEventListener("click", (e) => {
        if (e.target === dlg) closeColumnEditor();
      });
    }
  }

  function initList() {
    wireListSort();
    wireColumnEditor();
    renderWorkforceList();
  }

  /** Collapsible dashboard panels (charts, department table, workforce list). */
  function wirePanelCollapse() {
    document.querySelectorAll("[data-wfd-collapse-toggle]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const panel = btn.closest("[data-wfd-panel]");
        if (!panel) return;
        const collapsed = panel.classList.toggle("nc-wfd-panel--collapsed");
        btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
        const icon = btn.querySelector(".nc-wfd-min-icon");
        if (icon) icon.textContent = collapsed ? "+" : "−";
        const hint = btn.querySelector(".nc-wfd-sr-only");
        if (hint) {
          const expandLabel = btn.getAttribute("data-wfd-collapse-expand");
          const collapseLabel = btn.getAttribute("data-wfd-collapse-collapse");
          if (expandLabel && collapseLabel) {
            hint.textContent = collapsed ? expandLabel : collapseLabel;
          } else if (btn.id === "wfd-dept-collapse-btn") {
            hint.textContent = collapsed
              ? "Expand Workforce by Department section"
              : "Collapse Workforce by Department section";
          } else {
            hint.textContent = collapsed
              ? "Expand Workforce List section"
              : "Collapse Workforce List section";
          }
        }
      });
    });
  }

  let _wfdChartWait = 0;
  function boot() {
    wirePanelCollapse();
    wireDateFilters();
    loadDateFilterFromStorage();
    applyDateFilterState();
    syncFilterButtonState();
    updateAsAtLabel();
    updateKpis();
    renderDeptTable();
    initList();
    if (typeof Chart === "undefined") {
      if (_wfdChartWait++ < 100) window.setTimeout(boot, 30);
      return;
    }
    initCharts();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();

