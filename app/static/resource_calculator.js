(function () {
  "use strict";

  const root = document.getElementById("nc-resource-calculator");
  if (!root || !window.__RCALC__) return;

  const bootstrap = window.__RCALC__;
  const settings = bootstrap.settings || {};
  const states = Array.isArray(bootstrap.states) ? bootstrap.states : ["ACT", "NSW", "VIC", "QLD", "SA", "WA", "NT"];

  const el = (id) => document.getElementById(id);

  function numVal(v, fallback) {
    const n = parseFloat(String(v ?? "").replace(/,/g, ""));
    return Number.isFinite(n) ? n : fallback;
  }

  function money(n, digits) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "—";
    return v.toLocaleString(undefined, {
      style: "currency",
      currency: "AUD",
      minimumFractionDigits: digits ?? 0,
      maximumFractionDigits: digits ?? 0,
    });
  }

  function pct(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "—";
    return `${v.toFixed(1)}%`;
  }

  function ratePct(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "—";
    return `${v.toFixed(2)}%`;
  }

  function esc(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function optionalOverride(id) {
    const raw = el(id)?.value;
    if (raw === "" || raw == null) return null;
    const n = parseFloat(String(raw).replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }

  function readOverrides() {
    return {
      super_percent: optionalOverride("rcalc-ov-super"),
      payroll_tax_percent: optionalOverride("rcalc-ov-payroll"),
      workers_comp_percent: optionalOverride("rcalc-ov-wc"),
      profit_margin_percent: optionalOverride("rcalc-ov-profit"),
    };
  }

  function stateDefaults(st) {
    return (settings.state_rates && settings.state_rates[st]) || {};
  }

  function updateOverridePlaceholders(workState) {
    const st = workState || String(el("rcalc-state")?.value || "").trim().toUpperCase();
    const rates = st ? stateDefaults(st) : {};
    const superEl = el("rcalc-ov-super");
    const payrollEl = el("rcalc-ov-payroll");
    const wcEl = el("rcalc-ov-wc");
    const profitEl = el("rcalc-ov-profit");
    if (superEl) superEl.placeholder = String(numVal(settings.super_percent, 12));
    if (payrollEl) payrollEl.placeholder = rates.payroll_tax_percent != null ? String(rates.payroll_tax_percent) : "—";
    if (wcEl) wcEl.placeholder = rates.workers_comp_percent != null ? String(rates.workers_comp_percent) : "—";
    if (profitEl) profitEl.placeholder = "0";
  }

  function buildEffectiveRates(st, overrides) {
    const dflt = stateDefaults(st);
    return {
      payroll_tax_percent:
        overrides.payroll_tax_percent != null ? overrides.payroll_tax_percent : numVal(dflt.payroll_tax_percent, 0),
      workers_comp_percent:
        overrides.workers_comp_percent != null ? overrides.workers_comp_percent : numVal(dflt.workers_comp_percent, 0),
    };
  }

  function readInputs() {
    return {
      loaded_daily: numVal(el("rcalc-daily")?.value, 0),
      work_state: String(el("rcalc-state")?.value || "").trim().toUpperCase(),
      days_per_year: Math.max(1, numVal(el("rcalc-days")?.value, settings.days_per_year || 220)),
    };
  }

  function calcSettings(inputs) {
    const overrides = readOverrides();
    const statesCfg = {};
    states.forEach((st) => {
      statesCfg[st] = buildEffectiveRates(st, overrides);
    });
    return {
      super_percent: overrides.super_percent != null ? overrides.super_percent : numVal(settings.super_percent, 12),
      profit_margin_percent: overrides.profit_margin_percent != null ? overrides.profit_margin_percent : 0,
      days_per_year: inputs.days_per_year,
      states: statesCfg,
    };
  }

  function calculateFromLoaded(loadedDaily, st, inputs, cfg) {
    const rates = (cfg.states && cfg.states[st]) || {};
    const superPct = numVal(cfg.super_percent, 12) / 100;
    const payrollPct = numVal(rates.payroll_tax_percent, 0) / 100;
    const wcPct = numVal(rates.workers_comp_percent, 0) / 100;
    const profitPct = numVal(cfg.profit_margin_percent, 0) / 100;
    const dpy = Math.max(1, inputs.days_per_year);
    const contractorDaily = loadedDaily;
    const contractorAnnual = contractorDaily * dpy;

    const superDaily = contractorDaily * superPct;
    const payrollTaxDaily = contractorDaily * payrollPct;
    const workersCompDaily = contractorDaily * wcPct;
    const profitDaily = contractorDaily * profitPct;
    const obligationsDaily = superDaily + payrollTaxDaily + workersCompDaily + profitDaily;
    const obligationsAnnual = obligationsDaily * dpy;

    const superAmt = superDaily * dpy;
    const payrollTax = payrollTaxDaily * dpy;
    const workersComp = workersCompDaily * dpy;
    const profitAmt = profitDaily * dpy;

    const resultingDaily = Math.max(0, contractorDaily - obligationsDaily);
    const resultingAnnual = resultingDaily * dpy;
    const hoursPerDay = Math.max(0.1, numVal(settings.hours_per_day, 7.6));
    const resultingHourly = resultingDaily / hoursPerDay;
    const marginPercent =
      resultingDaily > 0
        ? (obligationsDaily / resultingDaily) * 100
        : contractorDaily > 0
          ? (obligationsDaily / contractorDaily) * 100
          : 0;

    return {
      ok: true,
      is_contractor: false,
      work_state: st,
      loaded_daily: contractorDaily,
      base_daily: resultingDaily,
      resulting_charge_daily: resultingDaily,
      resulting_charge_annual: resultingAnnual,
      resulting_charge_hourly: resultingHourly,
      hours_per_day: hoursPerDay,
      days_per_year: dpy,
      base_annual: resultingAnnual,
      super: superAmt,
      super_percent: Math.round(superPct * 10000) / 100,
      payroll_tax: payrollTax,
      payroll_tax_percent: Math.round(payrollPct * 10000) / 100,
      workers_comp: workersComp,
      workers_comp_percent: Math.round(wcPct * 10000) / 100,
      profit: profitAmt,
      profit_margin_percent: Math.round(profitPct * 10000) / 100,
      loaded_annual: contractorAnnual,
      margin_percent: marginPercent,
      margin_value_daily: obligationsDaily,
      margin_value_annual: obligationsAnnual,
      super_daily: superDaily,
      payroll_tax_daily: payrollTaxDaily,
      workers_comp_daily: workersCompDaily,
      profit_daily: profitDaily,
    };
  }

  function calculateSelected(inputs) {
    const cfg = calcSettings(inputs);
    if (inputs.loaded_daily <= 0) {
      return { ok: false, message: "Enter a contractor daily rate greater than zero." };
    }
    if (!inputs.work_state || !states.includes(inputs.work_state)) {
      return {
        ok: false,
        message: "Select a work state.",
        loaded_daily: inputs.loaded_daily,
        days_per_year: inputs.days_per_year,
      };
    }
    return calculateFromLoaded(inputs.loaded_daily, inputs.work_state, inputs, cfg);
  }

  function calculateAllStates(inputs) {
    const cfg = calcSettings(inputs);
    if (inputs.loaded_daily <= 0) return [];
    return states.map((st) => calculateFromLoaded(inputs.loaded_daily, st, inputs, cfg));
  }

  function renderStateSelect() {
    const sel = el("rcalc-state");
    if (!sel) return;
    sel.innerHTML =
      `<option value="">Select state…</option>` +
      states.map((st) => `<option value="${esc(st)}">${esc(st)}</option>`).join("");
  }

  function renderKpis(calc) {
    const wrap = el("rcalc-kpis");
    if (!wrap) return;
    if (!calc || !calc.ok) {
      wrap.innerHTML = `<article class="nc-rcalc-kpi"><div class="nc-rcalc-kpi-label">Contractor daily</div><div class="nc-rcalc-kpi-val">—</div><div class="nc-rcalc-kpi-meta">${esc(
        calc?.message || "Enter contractor daily rate and state"
      )}</div></article>`;
      return;
    }
    wrap.innerHTML = `
      <article class="nc-rcalc-kpi"><div class="nc-rcalc-kpi-label">Contractor daily</div><div class="nc-rcalc-kpi-val">${money(
        calc.loaded_daily,
        0
      )}</div><div class="nc-rcalc-kpi-meta">${esc(calc.work_state)} · ${esc(String(calc.days_per_year))} days/yr · charge rate</div></article>
      <article class="nc-rcalc-kpi"><div class="nc-rcalc-kpi-label">Casual daily</div><div class="nc-rcalc-kpi-val">${money(
        calc.resulting_charge_daily,
        0
      )}</div><div class="nc-rcalc-kpi-meta">${money(calc.resulting_charge_hourly, 2)}/hr · includes casual loading of 25%</div></article>
      <article class="nc-rcalc-kpi"><div class="nc-rcalc-kpi-label">Tax and obligations total</div><div class="nc-rcalc-kpi-val">${money(
        calc.margin_value_daily,
        0
      )}</div><div class="nc-rcalc-kpi-meta">${money(calc.margin_value_annual, 0)} per year · taxes &amp; obligations</div></article>
      <article class="nc-rcalc-kpi"><div class="nc-rcalc-kpi-label">On-cost margin</div><div class="nc-rcalc-kpi-val">${pct(
        calc.margin_percent
      )}</div><div class="nc-rcalc-kpi-meta">Loaded vs base salary</div></article>`;
  }

  function renderBreakdown(calc) {
    const body = el("rcalc-breakdown-body");
    const title = el("rcalc-breakdown-state");
    if (title) title.textContent = calc && calc.ok ? calc.work_state : "—";
    if (!body) return;
    if (!calc || !calc.ok) {
      body.innerHTML = `<tr><td colspan="4" class="nc-rcalc-empty">${esc(
        calc?.message || "Enter a contractor daily rate and select a state."
      )}</td></tr>`;
      return;
    }
    const rows = [
      ["Contractor daily", calc.loaded_daily, calc.loaded_annual, "Charge rate"],
      ["Super guarantee", calc.super_daily, calc.super, ratePct(calc.super_percent)],
      ["Payroll tax", calc.payroll_tax_daily, calc.payroll_tax, ratePct(calc.payroll_tax_percent)],
      ["Workers compensation", calc.workers_comp_daily, calc.workers_comp, ratePct(calc.workers_comp_percent)],
    ];
    if (calc.profit > 0 || calc.profit_margin_percent > 0) {
      rows.push(["Profit margin", calc.profit_daily, calc.profit, ratePct(calc.profit_margin_percent)]);
    }
    rows.push([
      "Resulting resource charge daily rate",
      calc.resulting_charge_daily,
      calc.resulting_charge_annual,
      `${money(calc.resulting_charge_hourly, 2)}/hr`,
    ]);
    body.innerHTML = rows
      .map(([label, daily, annual, rate], i) => {
        const isTotal = i === 0 || i === rows.length - 1;
        const cls = isTotal ? " nc-rcalc-loaded" : "";
        return `<tr><td>${esc(label)}</td><td class="${cls.trim()}">${money(daily, 0)}</td><td class="${cls.trim()}">${money(
          annual,
          0
        )}</td><td>${rate === "—" || String(rate).includes("%") || rate === "Charge rate" ? esc(String(rate)) : esc(String(rate))}</td></tr>`;
      })
      .join("");
  }

  function renderAllStates(rows, inputs) {
    const body = el("rcalc-all-body");
    if (!body) return;
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="8" class="nc-rcalc-empty">Enter a contractor daily rate to populate the rate card.</td></tr>`;
      return;
    }
    const highlight = inputs.work_state;
    body.innerHTML = rows
      .map((r) => {
        const selected = r.work_state === highlight;
        return `<tr class="${selected ? "nc-rcalc-row-selected" : ""}">
          <td><strong>${esc(r.work_state)}</strong></td>
          <td class="nc-rcalc-loaded">${money(r.loaded_daily, 0)}</td>
          <td>${money(r.resulting_charge_daily, 0)}</td>
          <td>${money(r.super_daily, 0)}</td>
          <td>${money(r.payroll_tax_daily, 0)}</td>
          <td>${money(r.workers_comp_daily, 0)}</td>
          <td>${money(r.loaded_annual, 0)}</td>
          <td>${pct(r.margin_percent)}</td>
        </tr>`;
      })
      .join("");
  }

  function updatePrintMeta(inputs, calc) {
    const meta = el("rcalc-print-meta");
    const dateNode = el("rcalc-print-date");
    if (dateNode) {
      dateNode.textContent = new Date().toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    }
    if (!meta) return;
    if (!calc || !calc.ok) {
      meta.textContent = "Enter a contractor daily rate and select a state.";
      return;
    }
    meta.textContent = [
      `Jurisdiction: ${calc.work_state}`,
      `Contractor daily: ${money(inputs.loaded_daily, 0)}`,
      `Casual daily: ${money(calc.resulting_charge_daily, 0)} (${money(calc.resulting_charge_hourly, 2)}/hr)`,
      `Billable days: ${inputs.days_per_year}/year`,
      `Tax & obligations: ${money(calc.margin_value_daily, 0)}/day`,
    ].join("  ·  ");
  }

  function recalculate() {
    const inputs = readInputs();
    updateOverridePlaceholders(inputs.work_state);
    const selected = calculateSelected(inputs);
    const allRows = calculateAllStates(inputs);
    renderKpis(selected);
    renderBreakdown(selected);
    renderAllStates(allRows, inputs);
    updatePrintMeta(inputs, selected);
  }

  function resetOverrides() {
    ["rcalc-ov-super", "rcalc-ov-payroll", "rcalc-ov-wc", "rcalc-ov-profit"].forEach((id) => {
      const node = el(id);
      if (node) node.value = "";
    });
    recalculate();
  }

  function initDaysDefault() {
    const days = el("rcalc-days");
    if (days && !days.value) days.value = String(settings.days_per_year || 220);
  }

  ["rcalc-daily", "rcalc-state", "rcalc-days", "rcalc-ov-super", "rcalc-ov-payroll", "rcalc-ov-wc", "rcalc-ov-profit"].forEach((id) => {
    el(id)?.addEventListener("input", recalculate);
    el(id)?.addEventListener("change", recalculate);
  });

  el("rcalc-reset-overrides")?.addEventListener("click", resetOverrides);

  function endPrintMode() {
    document.body.classList.remove("rcalc-print-mode");
    const header = el("rcalc-print-header");
    const footnote = el("rcalc-print-footnote");
    if (header) {
      header.hidden = true;
      header.setAttribute("aria-hidden", "true");
    }
    if (footnote) {
      footnote.hidden = true;
      footnote.setAttribute("aria-hidden", "true");
    }
  }

  function beginPrintMode() {
    document.body.classList.add("rcalc-print-mode");
    const header = el("rcalc-print-header");
    const footnote = el("rcalc-print-footnote");
    if (header) {
      header.hidden = false;
      header.setAttribute("aria-hidden", "false");
    }
    if (footnote) {
      footnote.hidden = false;
      footnote.setAttribute("aria-hidden", "false");
    }
    recalculate();
  }

  el("rcalc-print")?.addEventListener("click", () => {
    beginPrintMode();
    const savedTitle = document.title;
    document.title = " ";
    window.print();
    document.title = savedTitle;
  });

  window.addEventListener("afterprint", endPrintMode);

  renderStateSelect();
  initDaysDefault();
  updateOverridePlaceholders("");
  recalculate();
})();
