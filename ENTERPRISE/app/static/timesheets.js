(function () {
  const root = document.getElementById("nc-ts");
  if (!root) return;

  const fMonth = document.getElementById("nc-ts-month");
  const monthDisplay = document.getElementById("nc-ts-month-display");
  const fStart = document.getElementById("nc-ts-start");
  const fEnd = document.getElementById("nc-ts-end");
  const fProject = document.getElementById("nc-ts-project");
  const fDefaultName = document.getElementById("nc-ts-default-name");
  const fState = document.getElementById("nc-ts-state");
  const fRole = document.getElementById("nc-ts-role");
  const fDefHours = document.getElementById("nc-ts-hours");
  const fDefaultProject = document.getElementById("nc-ts-default-project");
  const body = document.getElementById("nc-ts-body");
  const holidaysBody = document.getElementById("nc-ts-holidays-body");
  const holidaysTitle = document.getElementById("nc-ts-holidays-title");
  const totalEl = document.getElementById("nc-ts-total-hours");
  const status = document.getElementById("nc-ts-status");
  const heroMonthLabel = document.getElementById("nc-ts-hero-month");
  const btnMonthPrev = document.getElementById("nc-ts-month-prev");
  const btnMonthNext = document.getElementById("nc-ts-month-next");
  const btnSave = document.getElementById("nc-ts-save");
  const savedLabel = document.getElementById("nc-ts-saved-label");
  const btnCopyPrev = document.getElementById("nc-ts-copy-prev");
  const btnDownloadSidebar = document.getElementById("nc-ts-download-sidebar");
  const btnDownloadAgain = document.getElementById("nc-ts-download-again");
  const downloadBox = document.getElementById("nc-ts-download-box");
  const downloadFname = document.getElementById("nc-ts-download-fname");
  const signedDropzone = document.getElementById("nc-ts-signed-dropzone");
  const signedEmpty = document.getElementById("nc-ts-signed-empty");
  const signedFile = document.getElementById("nc-ts-signed-file");
  const signedFname = document.getElementById("nc-ts-signed-fname");
  const signedOpen = document.getElementById("nc-ts-signed-open");
  const signedFileInput = document.getElementById("nc-ts-signed-file-input");
  const btnSignedChoose = document.getElementById("nc-ts-signed-choose");
  const chkShowWeekends = document.getElementById("nc-ts-show-weekends");
  const btnFillWeekdays = document.getElementById("nc-ts-fill-weekdays");
  const fDeclaration = document.getElementById("nc-ts-declaration");
  const sigCaptureRoot = document.getElementById("nc-ts-sig-capture");
  const pdfUrl = root.getAttribute("data-pdf-url") || "/intranet/api/timesheets/pdf";
  const signedUrl = root.getAttribute("data-signed-url") || "/intranet/api/timesheets/signed";
  const signedDownloadBase =
    root.getAttribute("data-signed-download-url") || "/intranet/api/timesheets/signed/download";
  const holidaysApiUrl = root.getAttribute("data-holidays-url") || "/intranet/api/timesheets/holidays";
  const monthApiUrl = root.getAttribute("data-month-url") || "/intranet/api/timesheets/month";
  const exportDownloadBase =
    root.getAttribute("data-export-download-url") || "/intranet/api/timesheets/export/download";
  const signatureApiUrl =
    root.getAttribute("data-signature-url") || "/intranet/api/timesheets/signature";
  const prefsApiUrl = root.getAttribute("data-prefs-url") || "/intranet/api/timesheets/prefs";
  const defaultState = root.getAttribute("data-default-state") || "VIC";

  let employeeSignature = null;
  let signatureSaveTimer = null;

  const userName = root.getAttribute("data-user") || "";
  const defaultRole = root.getAttribute("data-job-title") || "Lead Engineer";
  const SNAPSHOT_KEY = "nc-ts-month-snapshots";
  const HOLIDAY_OVERRIDE_APPROVAL_SUFFIX = "* Written managers approved required *";

  let holidaysSeed = [];
  const holidayYearCache = new Map();
  try {
    holidaysSeed = JSON.parse(document.getElementById("nc-ts-holidays-data")?.textContent || "[]");
    holidayYearCache.set(`${new Date().getFullYear()}:${defaultState}`, indexHolidays(holidaysSeed));
  } catch (_) {
    holidaysSeed = [];
  }

  function currentStateValue() {
    const fromField = fState ? String(fState.value || "").trim().toUpperCase() : "";
    return fromField || defaultState || "VIC";
  }

  function holidayCacheKey(year, state) {
    return `${year}:${state || currentStateValue()}`;
  }

  function updateHolidayPanelTitle(state) {
    if (!holidaysTitle) return;
    holidaysTitle.textContent = `Public holidays (${state || currentStateValue()})`;
  }

  function indexHolidays(rows) {
    const map = {};
    (rows || []).forEach((h) => {
      if (h && h.date) map[h.date] = h.label || "";
    });
    return map;
  }

  function holidayRowsFromMap(map) {
    return Object.keys(map)
      .sort()
      .map((dateKey) => {
        const bits = dateKey.split("-").map((x) => Number(x));
        const d = bits.length === 3 ? new Date(bits[0], bits[1] - 1, bits[2]) : null;
        return {
          date: dateKey,
          label: map[dateKey],
          display_date: d
            ? d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })
            : dateKey,
        };
      });
  }

  async function ensureHolidaysForYear(year, state) {
    const st = state || currentStateValue();
    const cacheKey = holidayCacheKey(year, st);
    if (holidayYearCache.has(cacheKey)) return holidayYearCache.get(cacheKey);
    try {
      const r = await fetch(
        `${holidaysApiUrl}?year=${encodeURIComponent(year)}&state=${encodeURIComponent(st)}`,
        { credentials: "same-origin" }
      );
      const j = await r.json().catch(() => ({}));
      if (r.ok && Array.isArray(j.holidays)) {
        const map = indexHolidays(j.holidays);
        holidayYearCache.set(cacheKey, map);
        return map;
      }
    } catch (_) {
      /* fall through */
    }
    const map =
      year === new Date().getFullYear() && st === defaultState ? indexHolidays(holidaysSeed) : {};
    holidayYearCache.set(cacheKey, map);
    return map;
  }

  function renderHolidayPanel(rows) {
    if (!holidaysBody) return;
    updateHolidayPanelTitle(currentStateValue());
    holidaysBody.innerHTML = (rows || [])
      .map(
        (h) =>
          `<tr><td>${escapeHtml(h.display_date || h.date)}</td><td>${escapeHtml(h.label)}</td></tr>`
      )
      .join("");
  }

  function setStatus(msg, isErr) {
    if (!status) return;
    status.textContent = msg || "";
    status.style.color = isErr ? "var(--nc-danger, #dc2626)" : "";
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function fmtDate(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function fmtDateDisplay(d) {
    return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
  }

  function firstOfMonth(yyyyMm) {
    const [y, m] = String(yyyyMm || "").split("-").map((x) => Number(x));
    if (!y || !m) return null;
    return new Date(y, m - 1, 1);
  }

  function lastOfMonth(d) {
    return new Date(d.getFullYear(), d.getMonth() + 1, 0);
  }

  function isWeekend(d) {
    const wd = d.getDay();
    return wd === 0 || wd === 6;
  }

  function weekday3(d) {
    return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()] || "";
  }

  function month3(d) {
    return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()] || "";
  }

  function fmtPdfDate(d) {
    return `${weekday3(d)}-${d.getDate()}-${month3(d)}`;
  }

  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s == null ? "" : String(s);
    return div.innerHTML;
  }

  const grid = document.getElementById("nc-ts-grid");
  const colConsultant = grid ? grid.querySelector("col.nc-ts-col-consultant") : null;
  const colRole = grid ? grid.querySelector("col.nc-ts-col-role") : null;
  let measureEl = null;

  function textWidth(text) {
    if (!measureEl) {
      measureEl = document.createElement("span");
      measureEl.style.cssText =
        "position:absolute;left:-9999px;top:-9999px;white-space:pre;font-size:9pt;font-family:inherit;font-weight:400;";
      document.body.appendChild(measureEl);
    }
    measureEl.textContent = text || " ";
    return measureEl.offsetWidth;
  }

  function syncAutoColumnWidths() {
    const specs = [
      { key: "consultant", col: colConsultant, header: "Consultant", floor: 72 },
      { key: "role", col: colRole, header: "Role", floor: 72 },
    ];
    const pad = 18;
    specs.forEach(({ key, col, header, floor }) => {
      if (!col) return;
      let max = Math.max(floor, textWidth(header) + pad);
      if (key === "consultant") {
        max = Math.max(max, textWidth(defaultNameText()) + pad);
      }
      if (key === "role") {
        max = Math.max(max, textWidth(defaultRoleText()) + pad);
      }
      (body || document).querySelectorAll(`input[data-k="${key}"]`).forEach((inp) => {
        const v = String(inp.value || "").trim();
        if (v) max = Math.max(max, textWidth(v) + pad);
      });
      col.style.width = `${Math.ceil(max)}px`;
    });
  }

  function defaultNameText() {
    const fromField = fDefaultName ? String(fDefaultName.value || "").trim() : "";
    return fromField || userName;
  }

  function defaultRoleText() {
    return fRole ? String(fRole.value || defaultRole).trim() : defaultRole;
  }

  function defaultProjectText() {
    return fDefaultProject ? String(fDefaultProject.value || "").trim() : "";
  }

  function projectBranchText() {
    return fProject ? String(fProject.value || "").trim() : "";
  }

  function syncDeclarationName(name) {
    if (!fDeclaration) return;
    const n = String(name || "").trim() || "[your name]";
    const project = projectBranchText() || "[client, department, or project]";
    const suffix = project.endsWith(".") ? "" : ".";
    fDeclaration.value =
      `Declaration: I ${n} certify that the hours shown accurately represent my total hours worked for ${project}${suffix}`;
  }

  function isHolidayOverridden(tr) {
    return !!(tr && tr.getAttribute("data-holiday-override") === "1");
  }

  function isActiveHolidayRow(tr) {
    return !!(tr && tr.classList.contains("is-holiday") && !isHolidayOverridden(tr));
  }

  function hasWorkOnHolidayRow(row) {
    if (!row) return false;
    if (row.holiday_override) return true;
    return !!(
      String(row.consultant || "").trim() ||
      String(row.role || "").trim() ||
      String(row.hours ?? "").trim()
    );
  }

  function stripHolidayOverrideApproval(text) {
    let s = String(text || "").trim();
    while (s.includes(HOLIDAY_OVERRIDE_APPROVAL_SUFFIX)) {
      s = s.replace(HOLIDAY_OVERRIDE_APPROVAL_SUFFIX, "").trim();
    }
    return s;
  }

  function withHolidayOverrideApproval(projectText) {
    const base = stripHolidayOverrideApproval(projectText);
    if (!base) return HOLIDAY_OVERRIDE_APPROVAL_SUFFIX;
    return `${base} ${HOLIDAY_OVERRIDE_APPROVAL_SUFFIX}`;
  }

  function applyRowValues(tr, src) {
    if (!tr || !src) return;
    const consultant = tr.querySelector('input[data-k="consultant"]');
    const role = tr.querySelector('input[data-k="role"]');
    const hours = tr.querySelector('input[data-k="hours"]');
    const project = tr.querySelector('input[data-k="project"]');
    if (consultant) consultant.value = src.consultant || "";
    if (role) role.value = src.role || "";
    if (hours) hours.value = src.hours != null ? String(src.hours) : "";
    if (project) project.value = src.project || "";
  }

  function setHolidayOverride(tr, on, options) {
    if (!tr || !tr.classList.contains("is-holiday")) return;
    const opts = options || {};
    const consultant = tr.querySelector('input[data-k="consultant"]');
    const role = tr.querySelector('input[data-k="role"]');
    const hours = tr.querySelector('input[data-k="hours"]');
    const project = tr.querySelector('input[data-k="project"]');
    const btn = tr.querySelector(".nc-ts-hol-override-btn");
    const holLabel = tr.getAttribute("data-holiday") || "";

    if (on) {
      tr.setAttribute("data-holiday-override", "1");
      tr.classList.add("is-holiday-overridden");
      if (btn) btn.textContent = "Reset holiday";
      if (consultant && !String(consultant.value || "").trim()) consultant.value = defaultNameText();
      if (role && !String(role.value || "").trim()) role.value = defaultRoleText();
      if (hours && !String(hours.value || "").trim()) hours.value = fDefHours ? String(fDefHours.value || "") : "";
      if (project) {
        let base = stripHolidayOverrideApproval(String(project.value || "").trim());
        if (!opts.fromData) {
          if (!base || base === holLabel) base = defaultProjectText();
        } else if (!base) {
          base = defaultProjectText();
        }
        project.value = withHolidayOverrideApproval(base);
      }
    } else {
      tr.removeAttribute("data-holiday-override");
      tr.classList.remove("is-holiday-overridden");
      if (btn) btn.textContent = "Override";
      if (consultant) consultant.value = "";
      if (role) role.value = "";
      if (hours) hours.value = "";
      if (project) project.value = holLabel;
    }
    applyEditableState();
    recalcTotal();
    syncAutoColumnWidths();
  }

  function rowTemplate(dateObj, dateStr, isOff, holidayName) {
    const consultant = defaultNameText();
    const role = defaultRoleText();
    const hours = fDefHours ? String(fDefHours.value || "").trim() : "";
    const isHol = !!holidayName;
    let project = "";
    if (isHol) project = holidayName;
    else if (!isOff) project = defaultProjectText();
    return `
      <tr class="nc-ts-row ${isOff ? "is-weekend" : ""} ${isHol ? "is-holiday" : ""}" data-date="${escapeHtml(dateStr)}"${isHol ? ` data-holiday="${escapeHtml(holidayName)}"` : ""}>
        <td class="nc-ts-cell nc-ts-cell--date">
          <span class="nc-ts-date-screen">${escapeHtml(fmtDateDisplay(dateObj))}</span>
          <span class="nc-ts-date-print">${escapeHtml(fmtPdfDate(dateObj))}</span>
          ${isHol ? '<button type="button" class="nc-ts-hol-override-btn">Override</button>' : ""}
        </td>
        <td class="nc-ts-cell"><input class="nc-ts-in" type="text" value="${escapeHtml(isOff || isHol ? "" : consultant)}" data-k="consultant"></td>
        <td class="nc-ts-cell"><input class="nc-ts-in" type="text" value="${escapeHtml(isOff || isHol ? "" : role)}" data-k="role"></td>
        <td class="nc-ts-cell"><input class="nc-ts-in nc-ts-in--num" type="number" min="0" step="0.25" value="${escapeHtml(isOff || isHol ? "" : hours)}" data-k="hours"></td>
        <td class="nc-ts-cell"><input class="nc-ts-in" type="text" value="${escapeHtml(project)}" data-k="project"${isHol ? " readonly" : ""}></td>
      </tr>
    `;
  }

  function recalcTotal() {
    let sum = 0;
    (body || document).querySelectorAll('input[data-k="hours"]').forEach((el) => {
      const v = Number(String(el.value || "").trim());
      if (Number.isFinite(v)) sum += v;
    });
    if (totalEl) totalEl.textContent = String(Math.round(sum * 100) / 100);
  }

  function applyWeekendVisibility() {
    const show = !!(chkShowWeekends && chkShowWeekends.checked);
    (body || document).querySelectorAll(".nc-ts-row.is-weekend, .nc-ts-row.is-holiday").forEach((tr) => {
      tr.hidden = !show;
    });
  }

  function applyDefaultHoursToWeekdays() {
    const hoursVal = fDefHours ? String(fDefHours.value || "").trim() : "";
    (body || document).querySelectorAll(".nc-ts-row").forEach((tr) => {
      if (tr.classList.contains("is-weekend") || isActiveHolidayRow(tr)) return;
      const hoursIn = tr.querySelector('input[data-k="hours"]');
      if (hoursIn) hoursIn.value = hoursVal;
    });
    recalcTotal();
  }

  function applyDefaultNameToWeekdays() {
    const nameVal = defaultNameText();
    (body || document).querySelectorAll(".nc-ts-row").forEach((tr) => {
      if (tr.classList.contains("is-weekend") || isActiveHolidayRow(tr)) return;
      const nameIn = tr.querySelector('input[data-k="consultant"]');
      if (nameIn) nameIn.value = nameVal;
    });
    syncDeclarationName(nameVal);
    syncAutoColumnWidths();
  }

  function applyDefaultRoleToWeekdays() {
    const roleVal = defaultRoleText();
    (body || document).querySelectorAll(".nc-ts-row").forEach((tr) => {
      if (tr.classList.contains("is-weekend") || isActiveHolidayRow(tr)) return;
      const roleIn = tr.querySelector('input[data-k="role"]');
      if (roleIn) roleIn.value = roleVal;
    });
    syncAutoColumnWidths();
  }

  function applyDefaultProjectToWeekdays() {
    const projectVal = defaultProjectText();
    (body || document).querySelectorAll(".nc-ts-row").forEach((tr) => {
      if (tr.classList.contains("is-weekend") || isActiveHolidayRow(tr)) return;
      const projIn = tr.querySelector('input[data-k="project"]');
      if (!projIn) return;
      projIn.value = isHolidayOverridden(tr)
        ? withHolidayOverrideApproval(projectVal)
        : projectVal;
    });
    syncAutoColumnWidths();
  }

  function autofillWeekdays() {
    (body || document).querySelectorAll(".nc-ts-row").forEach((tr) => {
      if (tr.classList.contains("is-weekend") || isActiveHolidayRow(tr)) return;
      const c = tr.querySelector('input[data-k="consultant"]');
      const r = tr.querySelector('input[data-k="role"]');
      const h = tr.querySelector('input[data-k="hours"]');
      const p = tr.querySelector('input[data-k="project"]');
      if (c && !String(c.value || "").trim()) c.value = defaultNameText();
      if (r && !String(r.value || "").trim()) r.value = defaultRoleText();
      if (h && !String(h.value || "").trim()) h.value = fDefHours ? String(fDefHours.value || "") : "";
      if (p && !String(p.value || "").trim()) p.value = defaultProjectText();
    });
    recalcTotal();
    syncAutoColumnWidths();
  }

  function captureRowsByDate() {
    const out = {};
    (body || document).querySelectorAll(".nc-ts-row").forEach((tr) => {
      const date = tr.getAttribute("data-date") || "";
      if (!date || isActiveHolidayRow(tr)) return;
      const consultant = tr.querySelector('input[data-k="consultant"]');
      const role = tr.querySelector('input[data-k="role"]');
      const hours = tr.querySelector('input[data-k="hours"]');
      const project = tr.querySelector('input[data-k="project"]');
      out[date] = {
        consultant: consultant ? consultant.value : "",
        role: role ? role.value : "",
        hours: hours ? hours.value : "",
        project: project ? project.value : "",
        holiday_override: isHolidayOverridden(tr),
      };
    });
    return out;
  }

  function renderMonthGrid(d0, d1, holMap, preserveByDate) {
    if (!body) return;
    body.innerHTML = "";
    const cur = new Date(d0.getTime());
    while (cur <= d1) {
      const ds = fmtDate(cur);
      const hol = holMap[ds] || "";
      body.insertAdjacentHTML("beforeend", rowTemplate(cur, ds, isWeekend(cur), hol));
      cur.setDate(cur.getDate() + 1);
    }

    const preserved = preserveByDate && typeof preserveByDate === "object" ? preserveByDate : null;
    if (preserved) {
      (body || document).querySelectorAll(".nc-ts-row").forEach((tr) => {
        const date = tr.getAttribute("data-date") || "";
        const isHol = tr.classList.contains("is-holiday");
        const isOff = tr.classList.contains("is-weekend");
        const consultant = tr.querySelector('input[data-k="consultant"]');
        const role = tr.querySelector('input[data-k="role"]');
        const hours = tr.querySelector('input[data-k="hours"]');
        const project = tr.querySelector('input[data-k="project"]');
        if (isHol) {
          const holLabel = tr.getAttribute("data-holiday") || holMap[date] || "";
          const src = preserved[date];
          if (src && (src.holiday_override || hasWorkOnHolidayRow(src))) {
            setHolidayOverride(tr, true, { fromData: true });
            applyRowValues(tr, src);
          } else if (project) {
            project.value = holLabel;
          }
          return;
        }
        const src = preserved[date];
        if (!src) {
          if (isOff) {
            if (consultant) consultant.value = "";
            if (role) role.value = "";
            if (hours) hours.value = "";
            if (project) project.value = "";
          }
          return;
        }
        if (consultant) consultant.value = src.consultant || "";
        if (role) role.value = src.role || "";
        if (hours) hours.value = src.hours != null ? String(src.hours) : "";
        if (project) {
          const looksStale =
            !holMap[date] &&
            isHolidayLikeRow(
              {
                consultant: src.consultant,
                role: src.role,
                hours: src.hours,
                project: src.project,
                is_holiday: false,
              },
              holMap,
              date
            );
          project.value = looksStale ? defaultProjectText() : src.project || "";
        }
      });
    }

    recalcTotal();
    applyWeekendVisibility();
    syncAutoColumnWidths();
  }

  async function renderMonthWithHolidayState(preserveByDate) {
    const d0 = firstOfMonth(activeMonth || currentMonthValue());
    if (!d0 || !body) return null;
    const d1 = lastOfMonth(d0);
    const holMap = await ensureHolidaysForYear(d0.getFullYear(), currentStateValue());
    renderHolidayPanel(holidayRowsFromMap(holMap));
    renderMonthGrid(d0, d1, holMap, preserveByDate || null);
    return holMap;
  }

  function isHolidayLikeRow(row, holMap, date) {
    if (!row || !date) return false;
    if (row.holiday_override || hasWorkOnHolidayRow(row)) return false;
    if (holMap[date]) return true;
    if (row.is_holiday) return true;
    const project = String(row.project || "").trim();
    if (!project) return false;
    const consultant = String(row.consultant || "").trim();
    const role = String(row.role || "").trim();
    const hours = String(row.hours ?? "").trim();
    return !consultant && !role && !hours;
  }

  function draftRowsToPreserveMap(payload, holMap) {
    const preserve = {};
    (payload.rows || []).forEach((row) => {
      if (!row || !row.date) return;
      const date = String(row.date);
      if (isHolidayLikeRow(row, holMap, date)) return;
      preserve[date] = {
        consultant: row.consultant || "",
        role: row.role || "",
        hours: row.hours != null ? String(row.hours) : "",
        project: row.project || "",
        holiday_override: !!row.holiday_override || hasWorkOnHolidayRow(row),
      };
    });
    return preserve;
  }

  function snapshotRowsToPreserveMap(snap, holMap, d0, d1) {
    const preserve = {};
    const srcRows = snap.rows && typeof snap.rows === "object" ? snap.rows : {};
    const cur = new Date(d0.getTime());
    while (cur <= d1) {
      const ds = fmtDate(cur);
      if (holMap[ds] || isWeekend(cur)) {
        cur.setDate(cur.getDate() + 1);
        continue;
      }
      const day = ds.slice(8, 10);
      const src = srcRows[day];
      if (src && !isHolidayLikeRow(src, holMap, ds)) {
        preserve[ds] = {
          consultant: src.consultant || "",
          role: src.role || "",
          hours: src.hours != null ? String(src.hours) : "",
          project: src.project || "",
          holiday_override: !!src.holiday_override || hasWorkOnHolidayRow(src),
        };
      }
      cur.setDate(cur.getDate() + 1);
    }
    return preserve;
  }

  async function restoreMonthGridFromDraft(payload) {
    const d0 = firstOfMonth(activeMonth || currentMonthValue());
    if (!d0 || !payload) return;
    const d1 = lastOfMonth(d0);
    const holMap = await ensureHolidaysForYear(d0.getFullYear(), currentStateValue());
    renderHolidayPanel(holidayRowsFromMap(holMap));
    renderMonthGrid(d0, d1, holMap, draftRowsToPreserveMap(payload, holMap));
  }

  async function restoreMonthGridFromSnapshot(snap) {
    const d0 = firstOfMonth(activeMonth || currentMonthValue());
    if (!d0 || !snap) return;
    const d1 = lastOfMonth(d0);
    const holMap = await ensureHolidaysForYear(d0.getFullYear(), currentStateValue());
    renderHolidayPanel(holidayRowsFromMap(holMap));
    renderMonthGrid(d0, d1, holMap, snapshotRowsToPreserveMap(snap, holMap, d0, d1));
  }

  async function rebuildCurrentMonthForState() {
    if (!body || !activeMonth) return;
    await renderMonthWithHolidayState(captureRowsByDate());
  }

  async function buildMonth(yyyyMm) {
    if (!body) return;
    captureActiveMonth();
    const d0 = firstOfMonth(yyyyMm);
    if (!d0) return;
    const monthKey = `${d0.getFullYear()}-${pad2(d0.getMonth() + 1)}`;
    activeMonth = monthKey;
    if (fMonth) fMonth.value = monthKey;
    syncHeroMonthLabel(monthKey);
    const d1 = lastOfMonth(d0);
    if (fStart) fStart.value = fmtDate(d0);
    if (fEnd) fEnd.value = fmtDate(d1);

    const holMap = await ensureHolidaysForYear(d0.getFullYear(), currentStateValue());
    renderHolidayPanel(holidayRowsFromMap(holMap));
    renderMonthGrid(d0, d1, holMap);
    resetDownloadBox();
    await loadMonthState();
  }

  function monthKeyFromDate(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
  }

  function shiftMonthKey(yyyyMm, delta) {
    const d0 = firstOfMonth(yyyyMm);
    if (!d0 || !delta) return yyyyMm;
    const next = new Date(d0.getFullYear(), d0.getMonth() + delta, 1);
    return monthKeyFromDate(next);
  }

  function loadSnapshots() {
    try {
      const raw = sessionStorage.getItem(SNAPSHOT_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function saveSnapshots(all) {
    try {
      sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify(all || {}));
    } catch (_) {
      /* ignore quota errors */
    }
  }

  let activeMonth = "";
  let monthLocked = false;
  let unlockListenersBound = false;

  function guessCurrentMonth() {
    return monthKeyFromDate(new Date());
  }

  function captureActiveMonth() {
    if (!activeMonth || !body) return;
    const rows = {};
    (body || document).querySelectorAll(".nc-ts-row").forEach((tr) => {
      const date = tr.getAttribute("data-date") || "";
      if (date.length < 10) return;
      const day = date.slice(8, 10);
      const consultant = tr.querySelector('input[data-k="consultant"]');
      const role = tr.querySelector('input[data-k="role"]');
      const hours = tr.querySelector('input[data-k="hours"]');
      const project = tr.querySelector('input[data-k="project"]');
      rows[day] = {
        consultant: consultant ? consultant.value : "",
        role: role ? role.value : "",
        hours: hours ? hours.value : "",
        project: project ? project.value : "",
      };
    });
    const all = loadSnapshots();
    all[activeMonth] = {
      locked: monthLocked,
      state: currentStateValue(),
      project_branch: fProject ? fProject.value : "",
      default_name: fDefaultName ? fDefaultName.value : "",
      default_role: fRole ? fRole.value : "",
      default_hours: fDefHours ? fDefHours.value : "",
      default_project: fDefaultProject ? fDefaultProject.value : "",
      declaration: fDeclaration ? fDeclaration.value : "",
      employee_signature_image: employeeSignature ? employeeSignature.getDataUrl() : "",
      rows,
    };
    saveSnapshots(all);
  }

  function applyEditableState() {
    const locked = monthLocked;
    const fields = [
      fMonth,
      fStart,
      fEnd,
      fProject,
      fDefaultName,
      fState,
      fRole,
      fDefHours,
      fDefaultProject,
      fDeclaration,
    ];
    fields.forEach((el) => {
      if (!el) return;
      if (el.tagName === "SELECT" || el.type === "checkbox") {
        el.disabled = locked;
        el.readOnly = false;
      } else {
        el.disabled = false;
        el.readOnly = locked;
      }
    });
    if (chkShowWeekends) chkShowWeekends.disabled = locked;
    if (btnFillWeekdays) btnFillWeekdays.disabled = locked;
    if (btnCopyPrev) btnCopyPrev.disabled = locked;
    (body || document).querySelectorAll(".nc-ts-row").forEach((tr) => {
      const isHol = tr.classList.contains("is-holiday");
      const overridden = isHolidayOverridden(tr);
      tr.querySelectorAll("input").forEach((inp) => {
        inp.disabled = false;
        inp.readOnly = locked || (isHol && !overridden);
      });
      const overrideBtn = tr.querySelector(".nc-ts-hol-override-btn");
      if (overrideBtn) overrideBtn.disabled = locked;
    });
    if (sigCaptureRoot) {
      sigCaptureRoot.classList.toggle("is-disabled", locked);
      sigCaptureRoot.querySelectorAll("button, input[type='file']").forEach((el) => {
        el.disabled = locked;
      });
    }
  }

  function setMonthLocked(locked, options) {
    const quiet = !!(options && options.quiet);
    monthLocked = !!locked;
    root.classList.toggle("is-locked", monthLocked);
    if (btnSave) btnSave.disabled = monthLocked;
    if (savedLabel) savedLabel.hidden = !monthLocked;
    applyEditableState();
    if (!quiet) {
      setStatus(
        monthLocked
          ? "Timesheet saved for this month."
          : "Timesheet unlocked for editing. Press Save when finished."
      );
    }
  }

  function onTimesheetUserEdit(e) {
    if (!monthLocked) return;
    const t = e.target;
    if (!t || !root.contains(t)) return;
    if (t.closest(".nc-ts-sidebar")) return;
    if (e.type === "focusin" && !t.matches("input, textarea, select")) return;
    setMonthLocked(false);
  }

  function bindUnlockOnEdit() {
    if (unlockListenersBound || !root) return;
    unlockListenersBound = true;
    root.addEventListener("input", onTimesheetUserEdit, true);
    root.addEventListener("change", onTimesheetUserEdit, true);
    root.addEventListener("focusin", onTimesheetUserEdit, true);
  }

  async function saveTimesheet() {
    if (monthLocked) return;
    setStatus("Saving timesheet…");
    if (btnSave) btnSave.disabled = true;
    try {
      const payload = collectPayload();
      payload.locked = true;
      const r = await fetch(monthApiUrl, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Could not save timesheet.");
      setMonthLocked(true);
      captureActiveMonth();
    } catch (e) {
      if (btnSave) btnSave.disabled = false;
      setStatus(String(e && e.message ? e.message : e), true);
    }
  }

  function applyDraftMetaFromPayload(payload) {
    if (!payload) return;
    if (fState && payload.state != null) fState.value = String(payload.state || defaultState).toUpperCase();
    if (fProject && payload.project_branch != null) fProject.value = payload.project_branch;
    if (fDefaultName) {
      const name = payload.default_name != null ? payload.default_name : payload.consultant_name;
      if (name != null) fDefaultName.value = name;
    }
    if (fRole && payload.default_role != null) fRole.value = payload.default_role;
    if (fDefHours && payload.default_hours != null) fDefHours.value = payload.default_hours;
    if (fDefaultProject && payload.default_project != null) fDefaultProject.value = payload.default_project;
    if (fDeclaration && payload.declaration_text != null) fDeclaration.value = payload.declaration_text;
    if (employeeSignature && employeeSignature.setDataUrl) {
      employeeSignature.setDataUrl(payload.employee_signature_image || "");
    }
    syncDeclarationName(defaultNameText());
  }

  function applySnapshotMetaToCurrentMonth(snap) {
    if (!snap) return;
    if (fState && snap.state != null) fState.value = String(snap.state || defaultState).toUpperCase();
    if (fProject && snap.project_branch != null) fProject.value = snap.project_branch;
    if (fDefaultName && snap.default_name != null) fDefaultName.value = snap.default_name;
    if (fRole && snap.default_role != null) fRole.value = snap.default_role;
    if (fDefHours && snap.default_hours != null) fDefHours.value = snap.default_hours;
    if (fDefaultProject && snap.default_project != null) fDefaultProject.value = snap.default_project;
    if (fDeclaration && snap.declaration != null) fDeclaration.value = snap.declaration;
    if (employeeSignature && snap.employee_signature_image && employeeSignature.setDataUrl) {
      employeeSignature.setDataUrl(snap.employee_signature_image);
    }
    syncDeclarationName(defaultNameText());
  }

  function applyDraftFromPayload(payload) {
    if (!payload || !body) return;
    applyDraftMetaFromPayload(payload);

    const rowMap = {};
    (payload.rows || []).forEach((row) => {
      if (row && row.date) rowMap[row.date] = row;
    });
    (body || document).querySelectorAll(".nc-ts-row").forEach((tr) => {
      const date = tr.getAttribute("data-date") || "";
      const holLabel = tr.getAttribute("data-holiday") || "";
      const isHol = tr.classList.contains("is-holiday") || !!holLabel;
      const isOff = tr.classList.contains("is-weekend");
      const consultant = tr.querySelector('input[data-k="consultant"]');
      const role = tr.querySelector('input[data-k="role"]');
      const hours = tr.querySelector('input[data-k="hours"]');
      const project = tr.querySelector('input[data-k="project"]');
      if (isHol) {
        const src = rowMap[date];
        if (src && (src.holiday_override || hasWorkOnHolidayRow(src))) {
          setHolidayOverride(tr, true, { fromData: true });
          applyRowValues(tr, src);
        } else if (project) {
          project.value = holLabel;
        }
        return;
      }
      if (isOff) {
        if (consultant) consultant.value = "";
        if (role) role.value = "";
        if (hours) hours.value = "";
        if (project) project.value = "";
        return;
      }
      const src = rowMap[date];
      if (!src || src.is_holiday) return;
      if (consultant) consultant.value = src.consultant || "";
      if (role) role.value = src.role || "";
      if (hours) hours.value = src.hours != null ? String(src.hours) : "";
      if (project) project.value = src.project || "";
    });
    recalcTotal();
    syncAutoColumnWidths();
  }

  async function persistUserState(state) {
    try {
      const r = await fetch(prefsApiUrl, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: state || currentStateValue() }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Could not save state.");
    } catch (e) {
      setStatus(String(e && e.message ? e.message : e), true);
    }
  }

  async function loadUserPrefs() {
    try {
      const r = await fetch(prefsApiUrl, { credentials: "same-origin" });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.state && fState) {
        fState.value = String(j.state).toUpperCase();
      }
    } catch (_) {
      /* ignore */
    }
  }

  async function onStateChange() {
    const state = currentStateValue();
    updateHolidayPanelTitle(state);
    holidayYearCache.clear();
    await persistUserState(state);
    await rebuildCurrentMonthForState();
    await persistMonthDraftQuiet();
    setStatus(`Public holidays updated for ${state}.`);
  }

  async function persistUserSignature(imageDataUrl) {
    try {
      const r = await fetch(signatureApiUrl, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: imageDataUrl || "" }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Could not save signature.");
    } catch (e) {
      setStatus(String(e && e.message ? e.message : e), true);
    }
  }

  async function persistMonthDraftQuiet() {
    if (monthLocked) return;
    try {
      await fetch(monthApiUrl, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(collectPayload()),
      });
    } catch (_) {
      /* best effort */
    }
  }

  function onSignatureChange(imageDataUrl) {
    captureActiveMonth();
    clearTimeout(signatureSaveTimer);
    signatureSaveTimer = setTimeout(async () => {
      await persistUserSignature(imageDataUrl);
      await persistMonthDraftQuiet();
    }, 400);
  }

  async function loadUserSignature() {
    try {
      const r = await fetch(signatureApiUrl, { credentials: "same-origin" });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.image && employeeSignature?.setDataUrl) {
        employeeSignature.setDataUrl(j.image);
      }
    } catch (_) {
      /* ignore */
    }
  }

  async function loadMonthState() {
    const month = currentMonthValue();
    resetDownloadBox();
    clearSignedUpload();
    let draftHadSignature = false;
    try {
      const r = await fetch(`${monthApiUrl}?month=${encodeURIComponent(month)}`, {
        credentials: "same-origin",
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Could not load saved timesheet.");
      if (j.draft) {
        applyDraftMetaFromPayload(j.draft);
        draftHadSignature = !!j.draft.employee_signature_image;
        holidayYearCache.clear();
        await restoreMonthGridFromDraft(j.draft);
      } else if (employeeSignature?.setDataUrl) {
        employeeSignature.setDataUrl("");
      }
      if (!j.draft) {
        const stateBefore = currentStateValue();
        await loadUserPrefs();
        if (currentStateValue() !== stateBefore) {
          await renderMonthWithHolidayState(null);
        }
      }
      if (!draftHadSignature) await loadUserSignature();
      if (j.export && j.export.saved) {
        showDownloadResult(j.export.filename || "Timesheet.pdf");
      }
      if (j.signed && j.signed.uploaded) {
        showSignedUpload({
          original_name: j.signed.original_name,
          download_url: j.signed.download_url || `${signedDownloadBase}?month=${encodeURIComponent(month)}`,
        });
      }
      setMonthLocked(!!(j.draft && j.draft.locked), { quiet: true });
      syncDeclarationName(defaultNameText());
    } catch (e) {
      setStatus(String(e && e.message ? e.message : e), true);
    }
  }

  function applySnapshotToCurrentMonth(snap) {
    applySnapshotMetaToCurrentMonth(snap);
  }

  async function applySnapshotToCurrentMonthAsync(snap) {
    applySnapshotMetaToCurrentMonth(snap);
    await restoreMonthGridFromSnapshot(snap);
  }

  async function copyFromPreviousMonth() {
    if (monthLocked) {
      setStatus("Unlock the timesheet before copying from another month.", true);
      return;
    }
    captureActiveMonth();
    const cur = currentMonthValue();
    const prevKey = shiftMonthKey(cur, -1);
    try {
      const r = await fetch(`${monthApiUrl}?month=${encodeURIComponent(prevKey)}`, {
        credentials: "same-origin",
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.draft) {
        applyDraftMetaFromPayload(j.draft);
        await restoreMonthGridFromDraft(j.draft);
        setMonthLocked(false, { quiet: true });
        setStatus(`Copied from ${formatMonthLabel(prevKey)}.`);
        return;
      }
    } catch (_) {
      /* fall through to session snapshot */
    }
    const snap = loadSnapshots()[prevKey];
    if (!snap) {
      setStatus(`No saved data for ${formatMonthLabel(prevKey)}. Open that month first so it can be copied.`, true);
      return;
    }
    await applySnapshotToCurrentMonthAsync(snap);
    setMonthLocked(false, { quiet: true });
    setStatus(`Copied from ${formatMonthLabel(prevKey)}.`);
  }

  function openCurrentMonth() {
    const month = guessCurrentMonth();
    if (fMonth) fMonth.value = month;
    buildMonth(month);
  }

  function currentMonthValue() {
    return (fMonth && fMonth.value) || guessCurrentMonth();
  }

  function formatMonthLabel(yyyyMm) {
    const d0 = firstOfMonth(yyyyMm);
    if (!d0) return String(yyyyMm || "");
    return d0.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }

  function syncHeroMonthLabel(yyyyMm) {
    const label = formatMonthLabel(yyyyMm);
    if (heroMonthLabel) heroMonthLabel.textContent = label;
    if (monthDisplay) monthDisplay.textContent = label;
  }

  function shiftMonth(delta) {
    if (!delta) return;
    buildMonth(shiftMonthKey(activeMonth || currentMonthValue(), delta));
  }

  function showDownloadResult(fname) {
    if (downloadBox) downloadBox.classList.add("has-download");
    if (downloadFname) downloadFname.textContent = fname || "Timesheet.pdf";
  }

  function resetDownloadBox() {
    if (downloadBox) downloadBox.classList.remove("has-download");
    if (downloadFname) downloadFname.textContent = "";
  }

  function showSignedUpload(info) {
    if (!signedDropzone) return;
    signedDropzone.classList.add("has-file");
    if (signedEmpty) signedEmpty.hidden = true;
    if (signedFile) signedFile.hidden = false;
    if (signedFname) signedFname.textContent = info.original_name || "Signed timesheet.pdf";
    if (signedOpen && info.download_url) signedOpen.href = info.download_url;
  }

  function clearSignedUpload() {
    if (!signedDropzone) return;
    signedDropzone.classList.remove("has-file");
    if (signedEmpty) signedEmpty.hidden = false;
    if (signedFile) signedFile.hidden = true;
    if (signedFname) signedFname.textContent = "";
    if (signedOpen) signedOpen.href = "#";
  }

  async function loadSignedStatus() {
    await loadMonthState();
  }

  function isPdfFile(file) {
    if (!file) return false;
    const name = String(file.name || "").toLowerCase();
    return file.type === "application/pdf" || name.endsWith(".pdf");
  }

  async function uploadSignedPdf(file) {
    if (!file) return;
    if (!isPdfFile(file)) {
      setStatus("Signed timesheet must be a PDF.", true);
      return;
    }
    const month = currentMonthValue();
    setStatus("Uploading signed timesheet…");
    const fd = new FormData();
    fd.append("file", file);
    fd.append("month", month);
    fd.append("draft", JSON.stringify(collectPayload()));
    try {
      const r = await fetch(signedUrl, {
        method: "POST",
        credentials: "same-origin",
        body: fd,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Upload failed.");
      showSignedUpload({
        original_name: j.original_name,
        download_url: j.download_url || `${signedDownloadBase}?month=${encodeURIComponent(month)}`,
      });
      setStatus("Signed timesheet uploaded.");
    } catch (e) {
      setStatus(String(e && e.message ? e.message : e), true);
    } finally {
      if (signedFileInput) signedFileInput.value = "";
    }
  }

  function bindSignedDropzone() {
    if (!signedDropzone) return;

    const prevent = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };

    ["dragenter", "dragover"].forEach((ev) => {
      signedDropzone.addEventListener(ev, (e) => {
        prevent(e);
        signedDropzone.classList.add("is-dragover");
      });
    });
    ["dragleave", "drop"].forEach((ev) => {
      signedDropzone.addEventListener(ev, (e) => {
        prevent(e);
        if (ev === "dragleave" && !signedDropzone.contains(e.relatedTarget)) {
          signedDropzone.classList.remove("is-dragover");
        }
        if (ev === "drop") signedDropzone.classList.remove("is-dragover");
      });
    });
    signedDropzone.addEventListener("drop", (e) => {
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      uploadSignedPdf(file);
    });

    if (btnSignedChoose) {
      btnSignedChoose.addEventListener("click", () => {
        if (signedFileInput) signedFileInput.click();
      });
    }
    if (signedFileInput) {
      signedFileInput.addEventListener("change", () => {
        const file = signedFileInput.files && signedFileInput.files[0];
        uploadSignedPdf(file);
      });
    }
  }

  function collectPayload() {
    const rows = [];
    (body || document).querySelectorAll(".nc-ts-row").forEach((tr) => {
      const date = tr.getAttribute("data-date") || "";
      const consultant = tr.querySelector('input[data-k="consultant"]');
      const role = tr.querySelector('input[data-k="role"]');
      const hours = tr.querySelector('input[data-k="hours"]');
      const project = tr.querySelector('input[data-k="project"]');
      rows.push({
        date,
        consultant: consultant ? consultant.value : "",
        role: role ? role.value : "",
        hours: hours ? hours.value : "",
        project: project ? project.value : "",
        is_weekend: tr.classList.contains("is-weekend"),
        is_holiday: isActiveHolidayRow(tr),
        holiday_override: isHolidayOverridden(tr),
      });
    });
    return {
      month: currentMonthValue(),
      state: currentStateValue(),
      period_start: fStart ? fStart.value : "",
      period_end: fEnd ? fEnd.value : "",
      project_branch: fProject ? fProject.value : "",
      default_name: fDefaultName ? fDefaultName.value : "",
      default_role: fRole ? fRole.value : "",
      default_hours: fDefHours ? fDefHours.value : "",
      default_project: fDefaultProject ? fDefaultProject.value : "",
      consultant_name: defaultNameText(),
      declaration_text: fDeclaration ? fDeclaration.value : "",
      employee_signature: defaultNameText(),
      employee_signature_image: employeeSignature ? employeeSignature.getDataUrl() : "",
      supervisor_signature: "",
      locked: monthLocked,
      rows,
    };
  }

  async function downloadPdf(triggerBtn) {
    const buttons = [btnDownloadSidebar, btnDownloadAgain, triggerBtn].filter(Boolean);
    setStatus("Generating PDF…");
    buttons.forEach((b) => {
      b.disabled = true;
    });
    try {
      const r = await fetch(pdfUrl, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(collectPayload()),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "Download failed.");
      }
      const blob = await r.blob();
      const dispo = r.headers.get("Content-Disposition") || "";
      let fname = "Timesheet.pdf";
      const m = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(dispo);
      if (m && m[1]) fname = decodeURIComponent(m[1].trim());
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showDownloadResult(fname);
      setStatus("PDF downloaded.");
    } catch (e) {
      setStatus(String(e && e.message ? e.message : e), true);
    } finally {
      buttons.forEach((b) => {
        b.disabled = false;
      });
    }
  }

  if (fMonth) {
    fMonth.addEventListener("change", () => buildMonth(fMonth.value));
  }

  if (fEnd) {
    fEnd.addEventListener("change", () => {
      const v = String(fEnd.value || "").trim();
      if (v.length >= 7 && fMonth) fMonth.value = v.slice(0, 7);
      buildMonth((fMonth && fMonth.value) || guessCurrentMonth());
    });
  }

  if (fStart) {
    fStart.addEventListener("change", () => {
      const v = String(fStart.value || "").trim();
      if (v.length >= 7 && fMonth) fMonth.value = v.slice(0, 7);
      buildMonth((fMonth && fMonth.value) || guessCurrentMonth());
    });
  }

  if (fDefaultProject) {
    fDefaultProject.addEventListener("input", applyDefaultProjectToWeekdays);
    fDefaultProject.addEventListener("change", applyDefaultProjectToWeekdays);
  }

  if (fDefHours) {
    fDefHours.addEventListener("input", applyDefaultHoursToWeekdays);
    fDefHours.addEventListener("change", applyDefaultHoursToWeekdays);
  }

  if (fDefaultName) {
    fDefaultName.addEventListener("input", applyDefaultNameToWeekdays);
    fDefaultName.addEventListener("change", applyDefaultNameToWeekdays);
  }

  if (fProject) {
    fProject.addEventListener("input", () => syncDeclarationName(defaultNameText()));
    fProject.addEventListener("change", () => syncDeclarationName(defaultNameText()));
  }

  if (fRole) {
    fRole.addEventListener("input", applyDefaultRoleToWeekdays);
    fRole.addEventListener("change", applyDefaultRoleToWeekdays);
  }

  if (fState) {
    fState.addEventListener("change", () => {
      void onStateChange();
    });
  }

  if (body) {
    body.addEventListener("click", (e) => {
      const btn = e.target.closest(".nc-ts-hol-override-btn");
      if (!btn || monthLocked) return;
      const tr = btn.closest(".nc-ts-row");
      if (!tr) return;
      setHolidayOverride(tr, !isHolidayOverridden(tr));
    });
    body.addEventListener("input", (e) => {
      const t = e.target;
      if (!t || !t.matches) return;
      if (t.matches('input[data-k="hours"]')) recalcTotal();
      if (t.matches('input[data-k="consultant"], input[data-k="role"]')) syncAutoColumnWidths();
    });
  }

  if (btnDownloadSidebar) btnDownloadSidebar.addEventListener("click", () => downloadPdf(btnDownloadSidebar));
  if (btnDownloadAgain) btnDownloadAgain.addEventListener("click", () => downloadPdf(btnDownloadAgain));
  if (btnMonthPrev) btnMonthPrev.addEventListener("click", () => shiftMonth(-1));
  if (btnMonthNext) btnMonthNext.addEventListener("click", () => shiftMonth(1));
  if (btnSave) btnSave.addEventListener("click", () => saveTimesheet());
  bindUnlockOnEdit();
  if (btnCopyPrev) btnCopyPrev.addEventListener("click", copyFromPreviousMonth);
  bindSignedDropzone();
  if (chkShowWeekends) chkShowWeekends.addEventListener("change", applyWeekendVisibility);
  if (btnFillWeekdays) btnFillWeekdays.addEventListener("click", autofillWeekdays);

  employeeSignature = window.NcTimesheetSignature?.init(sigCaptureRoot, {
    onChange: onSignatureChange,
  });

  openCurrentMonth();

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && document.getElementById("nc-ts")) {
      captureActiveMonth();
    }
  });
})();
