(function () {
  function readEvents() {
    try {
      const raw = document.getElementById("intranet-cal-events");
      if (raw && raw.textContent.trim()) {
        const j = JSON.parse(raw.textContent);
        return Array.isArray(j) ? j : [];
      }
    } catch (_) {
      /* ignore */
    }
    return [];
  }

  /** Text nodes as event.target cannot use .closest; normalize to Element. */
  function eventTargetElement(ev) {
    const t = ev && ev.target;
    if (!t || t.nodeType == null) return null;
    if (t.nodeType === 3 && t.parentElement) return t.parentElement;
    return t instanceof Element ? t : null;
  }

  function escapeAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function fmtMonthSafe(d) {
    try {
      return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    } catch (_) {
      try {
        return d.toLocaleString(undefined, { month: "long", year: "numeric" });
      } catch (_) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      }
    }
  }

  function fmtDayLongSafe(d) {
    try {
      return d.toLocaleDateString(undefined, {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    } catch (_) {
      try {
        return d.toLocaleString();
      } catch (_) {
        return d.toDateString();
      }
    }
  }

  function fmtShortSafe(d) {
    try {
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    } catch (_) {
      try {
        return d.toLocaleString(undefined, { month: "short", day: "numeric" });
      } catch (_) {
        return `${d.getMonth() + 1}/${d.getDate()}`;
      }
    }
  }

  function fmtMonthNameSafe(monthIndexZeroBased, year) {
    try {
      return new Intl.DateTimeFormat(undefined, { month: "long" }).format(new Date(year, monthIndexZeroBased, 1));
    } catch (_) {
      return new Date(year, monthIndexZeroBased, 1).toLocaleDateString(undefined, { month: "long" });
    }
  }

  function bootCalendar() {
    const root = document.getElementById("intranet-calendar-app");
    if (!root) return;
    if (root.dataset && root.dataset.calBooted === "1") return;
    try {
      if (root.dataset) root.dataset.calBooted = "1";
    } catch (_) {
      /* ignore */
    }

    let events = readEvents();

    function dateKey(d) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    }

    function parseLocalDate(str) {
      if (!str || typeof str !== "string") return null;
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str.trim());
      if (!m) return null;
      return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    }

    function startOfDay(d) {
      return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }

    function addDays(d, n) {
      const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      x.setDate(x.getDate() + n);
      return x;
    }

    function addMonths(d, n) {
      const day = d.getDate();
      const x = new Date(d.getFullYear(), d.getMonth() + n, 1);
      const last = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate();
      x.setDate(Math.min(day, last));
      return x;
    }

    function addYears(d, n) {
      return addMonths(d, n * 12);
    }

    function eventsForDay(day) {
      const k = dateKey(day);
      return events.filter((ev) => (ev.date || "").trim() === k);
    }

    function parseStartHour(ev) {
      if (ev.allDay) return null;
      const s = (ev.start || "").trim();
      const m = /^(\d{1,2}):(\d{2})/.exec(s);
      if (!m) return null;
      return Number(m[1]);
    }

    let view = "month";
    const cy = parseInt(String(root.getAttribute("data-cal-year") || ""), 10);
    const cm = parseInt(String(root.getAttribute("data-cal-month") || ""), 10);
    let focused;
    if (Number.isFinite(cy) && Number.isFinite(cm) && cm >= 1 && cm <= 12) {
      const now = new Date();
      if (now.getFullYear() === cy && now.getMonth() === cm - 1) {
        focused = startOfDay(now);
      } else {
        focused = new Date(cy, cm - 1, 1);
      }
    } else {
      focused = startOfDay(new Date());
    }

    const elLabel = document.getElementById("cal-range-label");
    const btnPrev = document.getElementById("cal-prev");
    const btnNext = document.getElementById("cal-next");
    const btnToday = document.getElementById("cal-today");
    const btnAdd = document.getElementById("cal-add-event");
    const canEdit = (root.getAttribute("data-can-edit") || "") === "1";

    const dlg = document.getElementById("cal-event-dlg");
    const form = document.getElementById("cal-event-form");
    const fId = document.getElementById("cal-ev-id");
    const dlgHeading = document.getElementById("cal-ev-heading");
    const fTitle = document.getElementById("cal-ev-title");
    const fDate = document.getElementById("cal-ev-date");
    const fAllDay = document.getElementById("cal-ev-allday");
    const fStart = document.getElementById("cal-ev-start");
    const fEnd = document.getElementById("cal-ev-end");
    const fLoc = document.getElementById("cal-ev-loc");
    const fNotes = document.getElementById("cal-ev-notes");
    const stEl = document.getElementById("cal-ev-status");
    const btnCancel = document.getElementById("cal-ev-cancel");
    const btnDelete = document.getElementById("cal-ev-delete");
    const btnShare = document.getElementById("cal-ev-share");
    const btnSave = document.getElementById("cal-ev-save");
    const sharedRow = document.getElementById("cal-ev-shared-row");
    const sharedChips = document.getElementById("cal-ev-shared");

    // Share dialog
    const shareDlg = document.getElementById("cal-share-dlg");
    const shareForm = document.getElementById("cal-share-form");
    const shareQ = document.getElementById("cal-share-q");
    const shareList = document.getElementById("cal-share-list");
    const shareStatus = document.getElementById("cal-share-status");
    const shareCancel = document.getElementById("cal-share-cancel");

    let peopleCache = null; // [{id,name,email,username}]
    let shareEventId = null;
    let shareSelectedUserIds = new Set();

    // History: calendar navigation + opening dialogs should be back-navigable.
    const NAV_HISTORY_KEY = "calNav";
    const EV_HISTORY_KEY = "calEv";
    function evStateFromHistory(st) {
      try {
        const s = st && typeof st === "object" ? st : history.state;
        return s && s[EV_HISTORY_KEY] ? s[EV_HISTORY_KEY] : null;
      } catch (_) {
        return null;
      }
    }
    function pushEvState(payload) {
      try {
        const base = history.state && typeof history.state === "object" ? history.state : {};
        history.pushState({ ...base, [EV_HISTORY_KEY]: payload }, "", window.location.href);
      } catch (_) {}
    }

    function navSnapshot() {
      return { view: String(view || "month"), focused: dateKey(focused) };
    }

    function pushNavState(payload, { replace = false } = {}) {
      try {
        const base = history.state && typeof history.state === "object" ? history.state : {};
        const next = { ...base, [NAV_HISTORY_KEY]: payload };
        if (replace) history.replaceState(next, "", window.location.href);
        else history.pushState(next, "", window.location.href);
      } catch (_) {}
    }
    function closeEventDialog(opts = {}) {
      const { popHistory = true } = opts || {};
      try {
        dlg && dlg.close();
      } catch (_) {}
      if (popHistory && history.state && history.state[EV_HISTORY_KEY]) history.back();
    }
    function applyViewAndFocusFromState(st) {
      if (!st) return;
      try {
        if (st.view) setView(String(st.view));
      } catch (_) {}
      const fk = st.focused ? String(st.focused) : "";
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fk);
      if (m) {
        const y = Number(m[1]);
        const mo = Number(m[2]);
        const d = Number(m[3]);
        if (Number.isFinite(y) && Number.isFinite(mo) && Number.isFinite(d)) focused = new Date(y, mo - 1, d);
      }
    }

    // Click outside the dialog content (backdrop) to dismiss.
    if (dlg) {
      dlg.addEventListener("click", (ev) => {
        // For native <dialog>, clicks on the backdrop target the dialog element itself.
        if (ev.target === dlg) closeEventDialog();
      });
      dlg.addEventListener("cancel", (ev) => {
        // ESC should behave like back-close (stay on Events page).
        ev.preventDefault();
        closeEventDialog();
      });
    }

    function mountEl() {
      return document.getElementById("cal-render");
    }

    function setView(v) {
      const next = typeof v === "string" ? v.trim().toLowerCase() : "month";
      view = next === "day" || next === "month" || next === "year" ? next : "month";
      root.querySelectorAll(".nc-cal-view-btn").forEach((b) => {
        const name = (
          typeof b.dataset !== "undefined" && b.dataset.view != null
            ? String(b.dataset.view)
            : b.getAttribute("data-view") || ""
        ).toLowerCase();
        const on = name === view;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-selected", String(on));
      });
      render();
    }

    function setFormEnabled(on) {
      if (btnSave) btnSave.disabled = !on;
      if (fTitle) fTitle.disabled = !on;
      if (fDate) fDate.disabled = !on;
      if (fAllDay) fAllDay.disabled = !on;
      if (fStart) fStart.disabled = !on;
      if (fEnd) fEnd.disabled = !on;
      if (fLoc) fLoc.disabled = !on;
      if (fNotes) fNotes.disabled = !on;
    }

    function syncAllDayUi() {
      const on = !!(fAllDay && fAllDay.checked);
      if (fStart) fStart.disabled = on;
      if (fEnd) fEnd.disabled = on;
    }

    function openAddDialog(opts = {}) {
      if (!canEdit) return;
      if (!dlg) return;
      const { pushHistory = true } = opts || {};
      if (btnSave) btnSave.hidden = false;
      setFormEnabled(true);
      if (stEl) stEl.textContent = "";
      if (fId) fId.value = "";
      if (dlgHeading) dlgHeading.textContent = "Add event";
      if (fTitle) fTitle.value = "";
      if (fAllDay) fAllDay.checked = false;
      if (fStart) fStart.value = "";
      if (fEnd) fEnd.value = "";
      if (fLoc) fLoc.value = "";
      if (fNotes) fNotes.value = "";
      if (fDate) fDate.value = dateKey(focused);
      syncAllDayUi();
      if (btnDelete) btnDelete.hidden = true;
      if (btnShare) btnShare.hidden = true;
      if (sharedRow) sharedRow.hidden = true;
      dlg.showModal();
      if (pushHistory) pushEvState({ mode: "add", view, focused: dateKey(focused) });
      try {
        (fTitle || fDate || btnSave).focus();
      } catch (_) {}
    }

    function openAddDialogPrefill({ date, start, end } = {}, opts = {}) {
      if (!canEdit) return;
      openAddDialog(opts);
      if (date && fDate) fDate.value = String(date);
      if (fAllDay) fAllDay.checked = false;
      syncAllDayUi();
      if (start && fStart) fStart.value = String(start);
      if (end && fEnd) fEnd.value = String(end);
    }

    function openPublicHolidayDialog(ev, opts = {}) {
      if (!dlg || !ev) return;
      const { pushHistory = true } = opts || {};
      if (stEl) stEl.textContent = "";
      if (btnSave) btnSave.hidden = true;
      if (btnDelete) btnDelete.hidden = true;
      if (btnShare) btnShare.hidden = true;
      if (sharedRow) sharedRow.hidden = true;
      setFormEnabled(false);
      if (fId) fId.value = String(ev.id || "");
      if (dlgHeading) dlgHeading.textContent = "Public holiday";
      if (fTitle) fTitle.value = String(ev.title || "");
      if (fDate) fDate.value = String(ev.date || dateKey(focused));
      if (fAllDay) fAllDay.checked = !!ev.allDay;
      if (fStart) fStart.value = String(ev.start || "");
      if (fEnd) fEnd.value = String(ev.end || "");
      if (fLoc) fLoc.value = String(ev.location || "");
      if (fNotes) fNotes.value = String(ev.notes || "");
      syncAllDayUi();
      dlg.showModal();
      if (pushHistory)
        pushEvState({
          mode: "holiday",
          id: String(ev.id || ""),
          view,
          focused: String(ev.date || dateKey(focused)),
        });
      try {
        (btnCancel || fTitle || fDate).focus();
      } catch (_) {}
    }

    function openEditDialog(ev, opts = {}) {
      if (!dlg || !ev) return;
      if (ev.publicHoliday) {
        openPublicHolidayDialog(ev, opts);
        return;
      }
      if (!canEdit) return;
      const { pushHistory = true } = opts || {};
      if (btnSave) btnSave.hidden = false;
      setFormEnabled(true);
      if (stEl) stEl.textContent = "";
      if (fId) fId.value = String(ev.id || "");
      if (dlgHeading) dlgHeading.textContent = "Edit event";
      if (fTitle) fTitle.value = String(ev.title || "");
      if (fDate) fDate.value = String(ev.date || dateKey(focused));
      if (fAllDay) fAllDay.checked = !!ev.allDay;
      if (fStart) fStart.value = String(ev.start || "");
      if (fEnd) fEnd.value = String(ev.end || "");
      if (fLoc) fLoc.value = String(ev.location || "");
      if (fNotes) fNotes.value = String(ev.notes || "");
      syncAllDayUi();
      const mine = !!ev.mine;
      if (btnDelete) btnDelete.hidden = !mine;
      if (btnShare) btnShare.hidden = !mine;
      renderSharedChips(ev);
      dlg.showModal();
      if (pushHistory) pushEvState({ mode: "edit", id: String(ev.id || ""), view, focused: String(ev.date || dateKey(focused)) });
      try {
        (fTitle || fDate || btnSave).focus();
      } catch (_) {}
    }

    async function fetchYearEvents(year) {
      try {
        const r = await fetch(`/intranet/api/events?year=${encodeURIComponent(String(year))}`, {
          credentials: "same-origin",
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return false;
        events = Array.isArray(j.events) ? j.events : [];
        return true;
      } catch (_) {
        return false;
      }
    }

    async function saveEvent() {
      if (!form) return;
      const id = fId && fId.value ? Number(fId.value) : null;
      if (id != null && Number.isFinite(id) && id < 0) return;
      const title = fTitle ? String(fTitle.value || "").trim() : "";
      const date = fDate ? String(fDate.value || "").trim() : "";
      const allDay = !!(fAllDay && fAllDay.checked);
      const start = fStart ? String(fStart.value || "").trim() : "";
      const end = fEnd ? String(fEnd.value || "").trim() : "";
      const location = fLoc ? String(fLoc.value || "").trim() : "";
      const notes = fNotes ? String(fNotes.value || "").trim() : "";
      if (!title) {
        if (stEl) stEl.textContent = "Title is required.";
        return;
      }
      if (!date) {
        if (stEl) stEl.textContent = "Date is required.";
        return;
      }
      setFormEnabled(false);
      if (stEl) stEl.textContent = "Saving…";
      try {
        const r = await fetch(id ? `/intranet/api/events/${encodeURIComponent(String(id))}` : "/intranet/api/events", {
          method: id ? "PATCH" : "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, date, allDay, start, end, location, notes }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || "Save failed");
        const y = Number(String(date).slice(0, 4));
        if (Number.isFinite(y)) await fetchYearEvents(y);
        // Keep focus on the day we just added to.
        const pd = parseLocalDate(date);
        if (pd) focused = pd;
        render();
        if (dlg) dlg.close();
      } catch (e) {
        if (stEl) stEl.textContent = String(e && e.message ? e.message : e) || "Save failed";
      } finally {
        setFormEnabled(true);
      }
    }

    function updateLabel() {
      if (!elLabel) return;
      try {
        if (view === "day") elLabel.textContent = fmtDayLongSafe(focused);
        else if (view === "month") elLabel.textContent = fmtMonthSafe(focused);
        else elLabel.textContent = String(focused.getFullYear());
      } catch (_) {
        elLabel.textContent = fmtMonthSafe(focused);
      }
    }

    function step(delta) {
      const prevYear = focused.getFullYear();
      if (view === "day") focused = addDays(focused, delta);
      else if (view === "month") focused = addMonths(focused, delta);
      else focused = addYears(focused, delta);
      const nextYear = focused.getFullYear();
      if (nextYear !== prevYear) {
        fetchYearEvents(nextYear).then(() => {
          render();
          pushNavState(navSnapshot());
        });
        return;
      }
      render();
      pushNavState(navSnapshot());
    }

    function renderDay(mount) {
      const dayEvents = eventsForDay(focused);
      const allDay = dayEvents.filter((e) => e.allDay);
      const timed = dayEvents.filter((e) => !e.allDay).sort((a, b) => (a.start || "").localeCompare(b.start || ""));
      let html = '<div class="nc-cal-day-inner">';
      if (allDay.length) {
        html += '<div class="nc-cal-allday"><div class="nc-cal-allday-label">All day</div><div class="nc-cal-allday-list">';
        for (const ev of allDay) {
          html += `<div class="nc-cal-event nc-cal-event--day" data-ev-id="${escapeAttr(String(ev.id || ""))}">${escapeHtml(ev.title || "(Untitled)")}</div>`;
        }
        html += "</div></div>";
      }

      html += '<div class="nc-cal-hours" id="nc-cal-hours">';
      for (let h = 0; h < 24; h++) {
        const label = `${String(h).padStart(2, "0")}:00`;
        const inHour = timed.filter((ev) => parseStartHour(ev) === h);
        const pills = inHour.length
          ? inHour
              .map(
                (ev) =>
                  `<span class="nc-cal-hour-event" data-ev-id="${escapeAttr(String(ev.id || ""))}">${escapeHtml(ev.title || "(Untitled)")}${
                    ev.shared_count && ev.mine ? ` <span class="nc-cal-invitees">Shared · ${escapeHtml(String(ev.shared_count))}</span>` : ""
                  }${ev.start ? ` <span class="nc-cal-hour-time">${escapeHtml(ev.start)}</span>` : ""}</span>`
              )
              .join("")
          : '<span class="nc-cal-hour-empty">—</span>';
        html += `<div class="nc-cal-hour-row" data-hour="${h}"><div class="nc-cal-hour-label">${label}</div><div class="nc-cal-hour-cell" data-hour="${h}">${pills}</div></div>`;
      }
      html += "</div></div>";
      mount.innerHTML = html;

      // Drag-to-create (select time range) in Day view
      const hoursEl = mount.querySelector("#nc-cal-hours");
      if (!hoursEl) return;
      let selecting = false;
      let startMin = null;
      let curMin = null;
      let selEl = null;
      const stepMin = 15;
      let activePointerId = null;

      function clamp(n, a, b) {
        return Math.max(a, Math.min(b, n));
      }

      function roundToStep(min) {
        return Math.round(min / stepMin) * stepMin;
      }

      function minsToTime(m) {
        const mm = clamp(roundToStep(m), 0, 24 * 60);
        const h = Math.floor(mm / 60);
        const mi = mm % 60;
        return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
      }

      function minuteFromEvent(ev) {
        const tEl = eventTargetElement(ev);
        const cell = tEl && tEl.closest ? tEl.closest(".nc-cal-hour-cell[data-hour]") : null;
        if (!cell || !hoursEl.contains(cell)) return null;
        // Ignore starting a selection on an existing event pill.
        if (tEl && tEl.closest && tEl.closest(".nc-cal-hour-event")) return null;
        const h = Number(cell.getAttribute("data-hour"));
        if (!Number.isFinite(h)) return null;
        const rect = cell.getBoundingClientRect();
        const y = clamp(ev.clientY - rect.top, 0, rect.height);
        const perMin = rect.height / 60;
        const minsInHour = perMin > 0 ? y / perMin : 0;
        return h * 60 + minsInHour;
      }

      function ensureSelEl() {
        if (selEl) return selEl;
        selEl = document.createElement("div");
        selEl.className = "nc-cal-select";
        hoursEl.appendChild(selEl);
        return selEl;
      }

      function updateSelection() {
        if (!selecting || startMin == null || curMin == null) return;
        const a = clamp(roundToStep(Math.min(startMin, curMin)), 0, 24 * 60);
        const b = clamp(roundToStep(Math.max(startMin, curMin)), 0, 24 * 60);
        const minSpan = 15;
        const end = b === a ? a + minSpan : b;
        const topMin = clamp(a, 0, 24 * 60);
        const endMin = clamp(end, 0, 24 * 60);
        const pxPerMin = (hoursEl.getBoundingClientRect().height || 1) / (24 * 60);
        const topPx = topMin * pxPerMin;
        const hPx = Math.max(1, (endMin - topMin) * pxPerMin);
        const el = ensureSelEl();
        el.style.top = `${topPx}px`;
        el.style.height = `${hPx}px`;
      }

      function clearSelection() {
        if (selEl && selEl.parentNode) selEl.parentNode.removeChild(selEl);
        selEl = null;
        hoursEl.classList.remove("is-selecting");
        selecting = false;
        startMin = null;
        curMin = null;
        activePointerId = null;
      }

      function onDown(ev) {
        if (ev.button != null && ev.button !== 0) return;
        if (activePointerId != null) return;
        const m = minuteFromEvent(ev);
        if (m == null) return;
        selecting = true;
        startMin = m;
        curMin = m;
        hoursEl.classList.add("is-selecting");
        updateSelection();
        try {
          activePointerId = ev.pointerId != null ? ev.pointerId : null;
          if (activePointerId != null && hoursEl.setPointerCapture) hoursEl.setPointerCapture(activePointerId);
        } catch (_) {
          /* ignore */
        }
        ev.preventDefault();
      }

      function onMove(ev) {
        if (!selecting) return;
        if (activePointerId != null && ev.pointerId != null && ev.pointerId !== activePointerId) return;
        const m = minuteFromEvent(ev);
        if (m == null) return;
        curMin = m;
        updateSelection();
        ev.preventDefault();
      }

      function onUp(ev) {
        if (!selecting) return;
        if (activePointerId != null && ev.pointerId != null && ev.pointerId !== activePointerId) return;
        const a = clamp(roundToStep(Math.min(startMin, curMin)), 0, 24 * 60);
        const b = clamp(roundToStep(Math.max(startMin, curMin)), 0, 24 * 60);
        const end = b === a ? a + stepMin : b;
        clearSelection();
        // Prefill dialog on mouse release.
        openAddDialogPrefill({
          date: dateKey(focused),
          start: minsToTime(a),
          end: minsToTime(end),
        });
        ev.preventDefault();
      }

      // Use pointer events so this is repeatable and works across devices.
      hoursEl.addEventListener("pointerdown", onDown);
      hoursEl.addEventListener("pointermove", onMove);
      hoursEl.addEventListener("pointerup", onUp);
      hoursEl.addEventListener("pointercancel", () => clearSelection());

      function hitFromDayEventTarget(tEl) {
        if (!tEl || !mount.contains(tEl)) return null;
        const evEl = tEl.closest ? tEl.closest("[data-ev-id]") : null;
        if (!evEl || !mount.contains(evEl)) return null;
        const id = evEl.getAttribute("data-ev-id");
        return (events || []).find((x) => String(x.id) === String(id)) || null;
      }

      // Left-click an event for details (public holidays are read-only for everyone).
      mount.addEventListener("click", (ev) => {
        if (view !== "day") return;
        const tEl = eventTargetElement(ev);
        const hit = hitFromDayEventTarget(tEl);
        if (!hit) return;
        if (!hit.publicHoliday && !canEdit) return;
        ev.preventDefault();
        openEditDialog(hit);
      });

      // Right-click an existing event to edit/delete/share.
      mount.addEventListener("contextmenu", (ev) => {
        if (view !== "day") return;
        const tEl = eventTargetElement(ev);
        const hit = hitFromDayEventTarget(tEl);
        if (!hit) return;
        ev.preventDefault();
        openEditDialog(hit);
      });
    }

    function dowOffsetMonFirst(d) {
      const js = d.getDay();
      return (js + 6) % 7;
    }

    function monthCellPreview(dateKeyStr) {
      const dayEvs = (events || []).filter((ev) => (ev.date || "").trim() === dateKeyStr);
      if (!dayEvs.length) return [];
      dayEvs.sort((a, b) => {
        const ah = a.publicHoliday ? 0 : 1;
        const bh = b.publicHoliday ? 0 : 1;
        if (ah !== bh) return ah - bh;
        return String(a.title || "").localeCompare(String(b.title || ""), undefined, { sensitivity: "base" });
      });
      const maxLines = 2;
      const ph = "[Public holiday] ";
      const out = [];
      for (let i = 0; i < Math.min(dayEvs.length, maxLines); i++) {
        const e = dayEvs[i];
        let t = String(e.title || "").trim() || "(Untitled)";
        if (t.startsWith(ph)) t = t.slice(ph.length);
        if (t.length > 34) t = t.slice(0, 33) + "…";
        out.push({ text: t, holiday: !!e.publicHoliday });
      }
      if (dayEvs.length > maxLines) {
        out.push({ text: `+${dayEvs.length - maxLines} more`, holiday: false });
      }
      return out;
    }

    function renderMonth(mount) {
      const y = focused.getFullYear();
      const m = focused.getMonth();
      const first = new Date(y, m, 1);
      const lead = dowOffsetMonFirst(first);
      const daysInMonth = new Date(y, m + 1, 0).getDate();
      const totalCells = Math.ceil((lead + daysInMonth) / 7) * 7;

      const dows = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
      let html = '<div class="nc-cal-month"><div class="nc-cal-dow-row">';
      for (const w of dows) html += `<div class="nc-cal-dow">${w}</div>`;
      html += '</div><div class="nc-cal-daygrid">';

      for (let i = 0; i < totalCells; i++) {
        const dayNum = i - lead + 1;
        if (dayNum < 1 || dayNum > daysInMonth) {
          html += '<div class="nc-cal-cell nc-cal-cell--muted"><span class="nc-cal-cell-num">&nbsp;</span></div>';
          continue;
        }
        const cellDate = new Date(y, m, dayNum);
        const k = dateKey(cellDate);
        const isToday = k === dateKey(startOfDay(new Date()));
        const isSel = k === dateKey(focused);
        const cnt = eventsForDay(cellDate).length;
        const preview = cnt ? monthCellPreview(k) : [];
        const cls = ["nc-cal-cell"];
        if (isToday) cls.push("nc-cal-cell--today");
        if (isSel && view === "month") cls.push("nc-cal-cell--selected");
        let ariaBits = `${fmtShortSafe(cellDate)}`;
        if (cnt) ariaBits += `, ${cnt} event(s)`;
        if (preview.length) ariaBits += "; " + preview.map((p) => p.text).join("; ");
        html += `<button type="button" class="${cls.join(" ")}" data-cal-date="${k}" aria-label="${escapeAttr(ariaBits)}">`;
        html += '<div class="nc-cal-cell-head">';
        html += `<span class="nc-cal-cell-num">${dayNum}</span>`;
        if (cnt && !preview.length) {
          html += `<span class="nc-cal-cell-dots" aria-hidden="true">${"●".repeat(Math.min(cnt, 3))}</span>`;
        }
        html += "</div>";
        if (preview.length) {
          html += '<div class="nc-cal-cell-events">';
          for (const p of preview) {
            const evCls = p.holiday ? "nc-cal-cell-ev nc-cal-cell-ev--holiday" : "nc-cal-cell-ev";
            html += `<span class="${evCls}">${escapeHtml(p.text)}</span>`;
          }
          html += "</div>";
        }
        html += "</button>";
      }
      html += "</div></div>";
      mount.innerHTML = html;

      mount.querySelectorAll(".nc-cal-cell[data-cal-date]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const k2 = btn.getAttribute("data-cal-date");
          const pd = parseLocalDate(k2);
          if (pd) {
            focused = pd;
            setView("day");
          }
        });
      });
    }

    function renderYear(mount) {
      const y = focused.getFullYear();
      let html = '<div class="nc-cal-year-grid">';
      for (let mo = 0; mo < 12; mo++) {
        const title = fmtMonthNameSafe(mo, y);
        const first = new Date(y, mo, 1);
        const lead = dowOffsetMonFirst(first);
        const dim = new Date(y, mo + 1, 0).getDate();
        const dows = ["M", "T", "W", "T", "F", "S", "S"];
        html += `<div class="nc-cal-minimonth" data-cal-year="${y}" data-cal-month="${mo}"><div class="nc-cal-minimonth-title">${escapeHtml(title)}</div>`;
        html += '<div class="nc-cal-mini-dow">';
        for (const w of dows) html += `<span>${w}</span>`;
        html += '</div><div class="nc-cal-mini-grid">';
        const cells = Math.ceil((lead + dim) / 7) * 7;
        for (let i = 0; i < cells; i++) {
          const dn = i - lead + 1;
          if (dn < 1 || dn > dim) {
            html += '<span class="nc-cal-mini-cell nc-cal-mini-cell--pad"></span>';
          } else {
            const cellDate = new Date(y, mo, dn);
            const k = dateKey(cellDate);
            const dayList = eventsForDay(cellDate);
            const has = dayList.length > 0;
            const isToday = k === dateKey(startOfDay(new Date()));
            const cl = ["nc-cal-mini-cell"];
            if (isToday) cl.push("nc-cal-mini-cell--today");
            if (has) cl.push("nc-cal-mini-cell--has");
            const ph = "[Public holiday] ";
            const tip = has
              ? dayList
                  .slice(0, 6)
                  .map((e) => {
                    let t = String(e.title || "").trim() || "(Untitled)";
                    if (t.startsWith(ph)) t = t.slice(ph.length);
                    return t;
                  })
                  .join(" · ")
              : "";
            const tipAttr = tip ? ` title="${escapeAttr(tip.length > 180 ? tip.slice(0, 177) + "…" : tip)}"` : "";
            html += `<span class="${cl.join(" ")}" data-cal-date="${k}"${tipAttr}>${dn}</span>`;
          }
        }
        html += "</div></div>";
      }
      html += "</div>";
      mount.innerHTML = html;
    }

    function render() {
      const mount = mountEl();
      if (!mount) return;
      try {
        if (view === "day") renderDay(mount);
        else if (view === "month") renderMonth(mount);
        else renderYear(mount);
        updateLabel();
      } catch (err) {
        mount.innerHTML =
          `<p class="nc-detail-muted">Calendar could not render in this browser. ${escapeHtml(String(err && err.message ? err.message : err || "unknown error"))}</p>`;
      }
    }

    // View buttons: wire direct handlers (more robust than delegated clicks in some browsers/extensions).
    root.querySelectorAll(".nc-cal-view-btn[data-view]").forEach((b) => {
      b.addEventListener("click", (ev) => {
        ev.preventDefault();
        const dv = b.getAttribute("data-view") || (b.dataset && b.dataset.view);
        setView(typeof dv === "string" ? dv : "month");
        pushNavState(navSnapshot());
      });
    });

    // Month cells: support SSR markup by delegating on the mount.
    const mount = mountEl();
    if (mount) {
      mount.addEventListener("click", (ev) => {
        if (view !== "month") return;
        const tEl = eventTargetElement(ev);
        if (!tEl) return;
        const btn = typeof tEl.closest === "function" ? tEl.closest(".nc-cal-cell[data-cal-date]") : null;
        if (!btn || !mount.contains(btn)) return;
        ev.preventDefault();
        const pd = parseLocalDate(btn.getAttribute("data-cal-date") || "");
        if (pd) {
          focused = pd;
          setView("day");
          pushNavState(navSnapshot());
        }
      });

      // Right-click a day cell to add an event for that day.
      mount.addEventListener("contextmenu", (ev) => {
        if (view !== "month") return;
        const tEl = eventTargetElement(ev);
        if (!tEl) return;
        const btn = typeof tEl.closest === "function" ? tEl.closest(".nc-cal-cell[data-cal-date]") : null;
        if (!btn || !mount.contains(btn)) return;
        ev.preventDefault();
        const k = btn.getAttribute("data-cal-date") || "";
        if (k) openAddDialogPrefill({ date: k });
      });
    }

    /** Year-grid clicks: delegate once — renderYear replaces innerHTML and must not add listeners repeatedly. */
    const calMountPersist = mountEl();
    if (calMountPersist) {
      calMountPersist.addEventListener("click", (ev) => {
        if (view !== "year") return;
        const tEl = eventTargetElement(ev);
        if (!tEl || !calMountPersist.contains(tEl)) return;
        const mm = typeof tEl.closest === "function" ? tEl.closest(".nc-cal-minimonth") : null;
        if (!mm || !calMountPersist.contains(mm)) return;
        const cell = typeof tEl.closest === "function" ? tEl.closest(".nc-cal-mini-cell[data-cal-date]") : null;
        if (cell && mm.contains(cell)) {
          ev.preventDefault();
          const pd = parseLocalDate(cell.getAttribute("data-cal-date") || "");
          if (pd) {
            focused = pd;
            setView("day");
            pushNavState(navSnapshot());
          }
          return;
        }
        const ys = mm.getAttribute("data-cal-year");
        const mos = mm.getAttribute("data-cal-month");
        const yNum = ys == null ? NaN : Number(ys);
        const moNum = mos == null ? NaN : Number(mos);
        if (!Number.isNaN(yNum) && !Number.isNaN(moNum) && moNum >= 0 && moNum <= 11) {
          ev.preventDefault();
          focused = new Date(yNum, moNum, Math.min(focused.getDate(), new Date(yNum, moNum + 1, 0).getDate()));
          setView("month");
          pushNavState(navSnapshot());
        }
      });

      // Right-click a mini day to add an event for that date.
      calMountPersist.addEventListener("contextmenu", (ev) => {
        if (view !== "year") return;
        const tEl = eventTargetElement(ev);
        if (!tEl || !calMountPersist.contains(tEl)) return;
        const cell = typeof tEl.closest === "function" ? tEl.closest(".nc-cal-mini-cell[data-cal-date]") : null;
        if (!cell || !calMountPersist.contains(cell)) return;
        ev.preventDefault();
        const k = cell.getAttribute("data-cal-date") || "";
        if (k) openAddDialogPrefill({ date: k });
      });
    }
    if (btnPrev) btnPrev.addEventListener("click", () => step(-1));
    if (btnNext) btnNext.addEventListener("click", () => step(1));
    if (btnToday) {
      btnToday.addEventListener("click", () => {
        const prevYear = focused.getFullYear();
        focused = startOfDay(new Date());
        const nextYear = focused.getFullYear();
        if (nextYear !== prevYear) {
          fetchYearEvents(nextYear).then(() => {
            render();
            pushNavState(navSnapshot());
          });
          return;
        }
        render();
        pushNavState(navSnapshot());
      });
    }

    if (btnAdd) btnAdd.addEventListener("click", openAddDialog);
    if (fAllDay) fAllDay.addEventListener("change", syncAllDayUi);
    if (btnCancel) btnCancel.addEventListener("click", () => closeEventDialog());
    if (btnDelete)
      btnDelete.addEventListener("click", async () => {
        const id = fId && fId.value ? Number(fId.value) : null;
        if (!id || id < 0) return;
        const ok = window.confirm("Delete this event? This cannot be undone.");
        if (!ok) return;
        setFormEnabled(false);
        if (stEl) stEl.textContent = "Deleting…";
        try {
          const r = await fetch(`/intranet/api/events/${encodeURIComponent(String(id))}`, {
            method: "DELETE",
            credentials: "same-origin",
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || "Delete failed");
          const y = focused.getFullYear();
          await fetchYearEvents(y);
          render();
          closeEventDialog();
        } catch (e) {
          if (stEl) stEl.textContent = String(e && e.message ? e.message : e) || "Delete failed";
        } finally {
          setFormEnabled(true);
        }
      });
    if (btnShare)
      btnShare.addEventListener("click", async () => {
        const id = fId && fId.value ? Number(fId.value) : null;
        if (!id || id < 0) return;
        openShareDialog(id);
      });

    function renderSharedChips(ev) {
      if (!sharedRow || !sharedChips) return;
      const mine = !!(ev && ev.mine);
      const ids = ev && Array.isArray(ev.shared_user_ids) ? ev.shared_user_ids : [];
      if (!mine || !ids.length) {
        sharedRow.hidden = true;
        sharedChips.innerHTML = "";
        return;
      }
      sharedRow.hidden = false;
      const people = Array.isArray(peopleCache) ? peopleCache : [];
      const byId = new Map(people.map((p) => [String(p.id), p]));
      sharedChips.innerHTML = ids
        .map((id) => {
          const p = byId.get(String(id));
          const name = p ? p.name : `User ${id}`;
          const hint = p ? (p.email || p.username || "") : "";
          return `<span class="nc-cal-chip" title="${escapeAttr(hint)}">${escapeHtml(name)}</span>`;
        })
        .join("");
    }

    async function loadPeople() {
      if (Array.isArray(peopleCache)) return peopleCache;
      const r = await fetch("/intranet/api/people", { credentials: "same-origin" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Could not load people");
      const rows = Array.isArray(j.people) ? j.people : [];
      peopleCache = rows;
      return rows;
    }

    function setShareStatus(msg) {
      if (shareStatus) shareStatus.textContent = msg || "";
    }

    function renderShareList() {
      if (!shareList) return;
      const q = (shareQ && shareQ.value ? String(shareQ.value) : "").trim().toLowerCase();
      const rows = Array.isArray(peopleCache) ? peopleCache : [];
      const filtered = q
        ? rows.filter((p) => {
            const n = String(p.name || "").toLowerCase();
            const e = String(p.email || "").toLowerCase();
            const u = String(p.username || "").toLowerCase();
            return n.includes(q) || e.includes(q) || u.includes(q);
          })
        : rows;
      shareList.innerHTML = filtered
        .slice(0, 500)
        .map((p) => {
          const checked = shareSelectedUserIds.has(Number(p.id)) ? "checked" : "";
          const hint = p.email || p.username || "";
          return `<label class="nc-cal-shareitem">
            <input type="checkbox" data-user-id="${escapeAttr(String(p.id))}" ${checked}>
            <span class="nc-cal-sharemeta">
              <span class="nc-cal-sharename">${escapeHtml(p.name || "")}</span>
              <span class="nc-cal-sharehint">${escapeHtml(hint)}</span>
            </span>
          </label>`;
        })
        .join("");
    }

    async function openShareDialog(eventId) {
      if (!shareDlg) return;
      const n = Number(eventId);
      if (!Number.isFinite(n) || n < 0) return;
      shareEventId = n;
      setShareStatus("");
      try {
        await loadPeople();
      } catch (e) {
        setShareStatus(String(e && e.message ? e.message : e) || "Could not load people");
        return;
      }
      // Seed selection from current event (owner view)
      const hit = (events || []).find((x) => Number(x.id) === Number(shareEventId));
      shareSelectedUserIds = new Set((hit && Array.isArray(hit.shared_user_ids) ? hit.shared_user_ids : []).map(Number));
      if (shareQ) shareQ.value = "";
      renderShareList();
      shareDlg.showModal();
      try {
        shareQ && shareQ.focus();
      } catch (_) {}
    }

    function closeShareDialog() {
      try {
        shareDlg && shareDlg.close();
      } catch (_) {}
    }

    if (shareCancel) shareCancel.addEventListener("click", closeShareDialog);
    if (shareDlg) {
      shareDlg.addEventListener("click", (ev) => {
        if (ev.target === shareDlg) closeShareDialog();
      });
    }
    if (shareQ) shareQ.addEventListener("input", renderShareList);
    if (shareList) {
      shareList.addEventListener("change", (ev) => {
        const t = ev.target;
        if (!t || !t.getAttribute) return;
        const id = Number(t.getAttribute("data-user-id"));
        if (!Number.isFinite(id)) return;
        if (t.checked) shareSelectedUserIds.add(id);
        else shareSelectedUserIds.delete(id);
      });
    }
    if (shareForm) {
      shareForm.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        if (!shareEventId) return;
        setShareStatus("Saving…");
        try {
          const r = await fetch(`/intranet/api/events/${encodeURIComponent(String(shareEventId))}/share`, {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ users: Array.from(shareSelectedUserIds).map(String), groups: [] }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || "Share failed");
          closeShareDialog();
          const y = focused.getFullYear();
          await fetchYearEvents(y);
          render();
          // Update chips in the edit dialog if it's open for this event
          const hit = (events || []).find((x) => Number(x.id) === Number(shareEventId));
          if (hit) renderSharedChips(hit);
        } catch (e) {
          setShareStatus(String(e && e.message ? e.message : e) || "Share failed");
        }
      });
    }
    if (form) {
      form.addEventListener("submit", (ev) => {
        ev.preventDefault();
        saveEvent();
      });
    }

    setView("month");
    // Ensure the initial calendar state is the baseline for Back/Forward within Events.
    pushNavState(navSnapshot(), { replace: true });

    // Back/forward should close/reopen the event dialog (so Back returns to the calendar view).
    window.addEventListener("popstate", (e) => {
      const navSt = evStateFromHistory(e && e.state); // event state (dialog)
      const calSt = (() => {
        try {
          const s = (e && e.state) || null;
          return s && s[NAV_HISTORY_KEY] ? s[NAV_HISTORY_KEY] : null;
        } catch (_) {
          return null;
        }
      })();

      // Restore calendar nav state first (view/focus) when present.
      if (calSt && calSt.view && calSt.focused) {
        applyViewAndFocusFromState(calSt);
        render();
      }

      const st = navSt;
      const wantOpen = st && (st.mode === "add" || st.mode === "edit" || st.mode === "holiday");
      const isOpen = !!(dlg && dlg.open);

      if (isOpen && !wantOpen) {
        closeEventDialog({ popHistory: false });
        return;
      }
      if (!isOpen && wantOpen) {
        applyViewAndFocusFromState(st);
        if (st.mode === "add") openAddDialog({ pushHistory: false });
        else {
          const hit = (events || []).find((x) => String(x.id) === String(st.id || ""));
          if (hit) openEditDialog(hit, { pushHistory: false });
        }
      }
    });
  }

  // Ensure calendar boots even if script loads early.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootCalendar, { once: true });
  } else {
    bootCalendar();
  }
})();
