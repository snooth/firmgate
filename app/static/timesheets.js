(function () {
  const root = document.getElementById("nc-ts");
  if (!root) return;

  const fMonth = document.getElementById("nc-ts-month");
  const fStart = document.getElementById("nc-ts-start");
  const fEnd = document.getElementById("nc-ts-end");
  const fProject = document.getElementById("nc-ts-project");
  const fRole = document.getElementById("nc-ts-role");
  const fDefHours = document.getElementById("nc-ts-hours");
  const body = document.getElementById("nc-ts-body");
  const totalEl = document.getElementById("nc-ts-total-hours");
  const status = document.getElementById("nc-ts-status");
  const btnPrint = document.getElementById("nc-ts-print");
  const btnSubmit = document.getElementById("nc-ts-submit");
  const chkShowWeekends = document.getElementById("nc-ts-show-weekends");
  const btnFillWeekdays = document.getElementById("nc-ts-fill-weekdays");

  const userName = root.getAttribute("data-user") || "";

  function setStatus(msg) {
    if (status) status.textContent = msg || "";
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function fmtDate(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
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
    const wd = d.getDay(); // 0 Sun .. 6 Sat
    return wd === 0 || wd === 6;
  }

  function weekday3(d) {
    return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()] || "";
  }

  function month3(d) {
    return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()] || "";
  }

  function fmtPdfDate(d) {
    // e.g. Wed-1-Apr
    return `${weekday3(d)}-${d.getDate()}-${month3(d)}`;
  }

  // Easter date (Gregorian) for holiday calculation.
  function easterSunday(year) {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31); // 3=Mar,4=Apr
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(year, month - 1, day);
  }

  function nthWeekdayOfMonth(year, monthIndex, weekday, n) {
    // monthIndex: 0-11, weekday: 0(Sun)-6
    const first = new Date(year, monthIndex, 1);
    const offset = (weekday - first.getDay() + 7) % 7;
    const day = 1 + offset + (n - 1) * 7;
    return new Date(year, monthIndex, day);
  }

  function firstWeekdayOfMonth(year, monthIndex, weekday) {
    return nthWeekdayOfMonth(year, monthIndex, weekday, 1);
  }

  function lastWeekdayOfMonth(year, monthIndex, weekday) {
    const last = new Date(year, monthIndex + 1, 0);
    const offset = (last.getDay() - weekday + 7) % 7;
    return new Date(year, monthIndex, last.getDate() - offset);
  }

  function holidayNameVIC(d) {
    // Minimal VIC set (sufficient to match your PDF template behavior).
    const y = d.getFullYear();
    const m = d.getMonth();
    const day = d.getDate();
    const key = `${y}-${pad2(m + 1)}-${pad2(day)}`;

    // Fixed date holidays
    if (key.endsWith("-01-01")) return "New Year's Day";
    if (key.endsWith("-01-26")) return "Australia Day";
    if (key.endsWith("-04-25")) return "ANZAC Day";
    if (key.endsWith("-12-25")) return "Christmas Day";
    if (key.endsWith("-12-26")) return "Boxing Day";

    // Easter-related
    const easter = easterSunday(y);
    const gf = new Date(easter.getFullYear(), easter.getMonth(), easter.getDate() - 2);
    const em = new Date(easter.getFullYear(), easter.getMonth(), easter.getDate() + 1);
    const es = new Date(easter.getFullYear(), easter.getMonth(), easter.getDate());
    const sat = new Date(easter.getFullYear(), easter.getMonth(), easter.getDate() - 1);
    const kGf = fmtDate(gf);
    const kEm = fmtDate(em);
    const kEs = fmtDate(es);
    const kSat = fmtDate(sat);
    if (key === kGf) return "Good Friday";
    if (key === kSat) return "Easter Saturday";
    if (key === kEs) return "Easter Sunday";
    if (key === kEm) return "Easter Monday";

    // Labour Day (VIC): second Monday in March
    const labour = nthWeekdayOfMonth(y, 2, 1, 2); // Mar, Monday
    if (key === fmtDate(labour)) return "Labour Day";

    // King's Birthday: second Monday in June
    const king = nthWeekdayOfMonth(y, 5, 1, 2); // Jun, Monday
    if (key === fmtDate(king)) return "King's Birthday";

    // Melbourne Cup Day: first Tuesday in November
    const cup = firstWeekdayOfMonth(y, 10, 2); // Nov, Tuesday
    if (key === fmtDate(cup)) return "Melbourne Cup Day";

    // AFL Grand Final Friday (VIC): last Friday in September
    const afl = lastWeekdayOfMonth(y, 8, 5); // Sep, Friday
    if (key === fmtDate(afl)) return "AFL Grand Final Friday";

    return "";
  }

  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s == null ? "" : String(s);
    return div.innerHTML;
  }

  function rowTemplate(dateObj, dateStr, isOff, holidayName) {
    const role = fRole ? String(fRole.value || "").trim() : "";
    const hours = fDefHours ? String(fDefHours.value || "").trim() : "";
    const project = fProject ? String(fProject.value || "").trim() : "";
    const isHol = !!holidayName;
    return `
      <tr class="nc-ts-row ${isOff ? "is-weekend" : ""} ${isHol ? "is-holiday" : ""}" data-date="${escapeHtml(dateStr)}">
        <td class="nc-ts-cell nc-ts-cell--date">
          <span class="nc-ts-date-screen">${escapeHtml(dateStr)}</span>
          <span class="nc-ts-date-print">${escapeHtml(fmtPdfDate(dateObj))}</span>
        </td>
        <td class="nc-ts-cell"><input class="nc-ts-in" type="text" value="${escapeHtml(isOff || isHol ? (isHol ? holidayName : "") : userName)}" data-k="consultant"></td>
        <td class="nc-ts-cell"><input class="nc-ts-in" type="text" value="${escapeHtml(isOff || isHol ? "" : role)}" data-k="role"></td>
        <td class="nc-ts-cell"><input class="nc-ts-in nc-ts-in--num" type="number" min="0" step="0.25" value="${escapeHtml(isOff || isHol ? "" : hours)}" data-k="hours"></td>
        <td class="nc-ts-cell"><input class="nc-ts-in" type="text" value="${escapeHtml(isOff || isHol ? "" : project)}" data-k="project"></td>
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

  function autofillWeekdays() {
    (body || document).querySelectorAll(".nc-ts-row").forEach((tr) => {
      if (tr.classList.contains("is-weekend") || tr.classList.contains("is-holiday")) return;
      const c = tr.querySelector('input[data-k="consultant"]');
      const r = tr.querySelector('input[data-k="role"]');
      const h = tr.querySelector('input[data-k="hours"]');
      const p = tr.querySelector('input[data-k="project"]');
      if (c && !String(c.value || "").trim()) c.value = userName;
      if (r && !String(r.value || "").trim()) r.value = fRole ? String(fRole.value || "") : "";
      if (h && !String(h.value || "").trim()) h.value = fDefHours ? String(fDefHours.value || "") : "";
      if (p && !String(p.value || "").trim()) p.value = fProject ? String(fProject.value || "") : "";
    });
    recalcTotal();
  }

  function buildMonth(yyyyMm) {
    if (!body) return;
    const d0 = firstOfMonth(yyyyMm);
    if (!d0) return;
    const d1 = lastOfMonth(d0);
    if (fStart) fStart.value = fmtDate(d0);
    if (fEnd) fEnd.value = fmtDate(d1);

    body.innerHTML = "";
    const cur = new Date(d0.getTime());
    while (cur <= d1) {
      const ds = fmtDate(cur);
      const hol = holidayNameVIC(cur);
      body.insertAdjacentHTML("beforeend", rowTemplate(cur, ds, isWeekend(cur), hol));
      cur.setDate(cur.getDate() + 1);
    }
    recalcTotal();
    applyWeekendVisibility();
  }

  function guessCurrentMonth() {
    const now = new Date();
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
  }

  if (fMonth) {
    fMonth.value = guessCurrentMonth();
    fMonth.addEventListener("change", () => buildMonth(fMonth.value));
  }

  if (fStart) {
    fStart.addEventListener("change", () => {
      const v = String(fStart.value || "").trim();
      if (v.length >= 7 && fMonth) fMonth.value = v.slice(0, 7);
      buildMonth((fMonth && fMonth.value) || guessCurrentMonth());
    });
  }

  // If default role/hours/project changes, update empty cells only.
  [fRole, fDefHours, fProject].forEach((el) => {
    if (!el) return;
    el.addEventListener("change", () => {
      (body || document).querySelectorAll(".nc-ts-row").forEach((tr) => {
        const roleIn = tr.querySelector('input[data-k="role"]');
        const hoursIn = tr.querySelector('input[data-k="hours"]');
        const projIn = tr.querySelector('input[data-k="project"]');
        if (roleIn && !String(roleIn.value || "").trim()) roleIn.value = String(fRole.value || "");
        if (hoursIn && !String(hoursIn.value || "").trim()) hoursIn.value = String(fDefHours.value || "");
        if (projIn && !String(projIn.value || "").trim()) projIn.value = String(fProject.value || "");
      });
      recalcTotal();
    });
  });

  if (body) {
    body.addEventListener("input", (e) => {
      const t = e.target;
      if (!t || !t.matches) return;
      if (t.matches('input[data-k="hours"]')) recalcTotal();
    });
  }

  if (btnPrint) btnPrint.addEventListener("click", () => window.print());

  if (chkShowWeekends) chkShowWeekends.addEventListener("change", applyWeekendVisibility);
  if (btnFillWeekdays) btnFillWeekdays.addEventListener("click", autofillWeekdays);

  if (btnSubmit) {
    btnSubmit.addEventListener("click", () => {
      setStatus("Submit is coming next (saving this to the server). For now, use Print to export.");
    });
  }

  // Initial render
  buildMonth((fMonth && fMonth.value) || guessCurrentMonth());
})();

