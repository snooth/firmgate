  const MODULES = [
    { key: "home", label: "Home" },
    { key: "news", label: "Blogs" },
    { key: "events", label: "Events" },
    { key: "wiki", label: "Wiki" },
    { key: "team_chat", label: "Team Chat" },
    { key: "directory", label: "Workforce" },
    { key: "workforce_dashboard", label: "Workforce Dashboard" },
    { key: "security_training", label: "Security Training" },
    { key: "documents", label: "Documents" },
    { key: "about", label: "About Company" },
    { key: "game", label: "Games" },
    { key: "admin", label: "Administration" },
  ];

  let modulesState = null;

  function ensureModulesState() {
    modulesState = modulesState || { modules: {} };
    modulesState.modules = modulesState.modules || {};
    return modulesState;
  }

  function syncModulesUiToState() {
    const wrap = document.getElementById("admin-modules-wrap");
    if (!wrap) return;
    const st = ensureModulesState();
    MODULES.forEach((m) => {
      const k = m.key;
      const enEl = wrap.querySelector(`.nc-mod-enabled[data-mod="${CSS.escape(k)}"]`);
      const rEl = wrap.querySelector(`.nc-mod-restrict[data-mod="${CSS.escape(k)}"]`);
      const cur = st.modules[k] || { allowed_user_ids: [], enabled: true, restricted: false };
      if (enEl) cur.enabled = !!enEl.checked;
      if (rEl) cur.restricted = !!rEl.checked && cur.enabled !== false;
      st.modules[k] = cur;
    });
  }

  function mergePendingModuleUserSelections() {
    const wrap = document.getElementById("admin-modules-wrap");
    if (!wrap) return;
    const st = ensureModulesState();
    MODULES.forEach((m) => {
      const k = m.key;
      const sel = wrap.querySelector(`select.nc-mod-user-sel[data-mod="${CSS.escape(k)}"]`);
      if (!sel) return;
      const pending = Array.from(sel.selectedOptions)
        .map((o) => String(o.value || ""))
        .filter(Boolean);
      if (!pending.length) return;
      const cur = st.modules[k] || { allowed_user_ids: [], enabled: true, restricted: false };
      const merged = new Set((Array.isArray(cur.allowed_user_ids) ? cur.allowed_user_ids : []).map(String));
      pending.forEach((id) => merged.add(String(id)));
      cur.allowed_user_ids = Array.from(merged);
      st.modules[k] = cur;
    });
  }

  function renderModules() {
    const wrap = document.getElementById("admin-modules-wrap");
    if (!wrap) return;
    const cfg = (modulesState && modulesState.modules) || {};
    const uById = new Map((users || []).map((u) => [String(u.id), u]));
    const allUsers = (users || [])
      .slice()
      .sort((a, b) =>
        String(a.full_name || a.username || a.email || "").localeCompare(
          String(b.full_name || b.username || b.email || ""),
          undefined,
          { sensitivity: "base" }
        )
      );
    wrap.innerHTML = MODULES.map((m) => moduleRowHtml(m, cfg, uById, allUsers)).join("");
  }

  function moduleRowHtml(m, cfg, uById, allUsers) {
    const row = cfg[m.key] || {};
    const enabled = row.enabled !== false;
    const restricted = !!row.restricted;
    const allowed = Array.isArray(row.allowed_user_ids) ? row.allowed_user_ids.map(String) : [];
    const chips = allowed
      .map((id) => {
        const u = uById.get(String(id));
        const name = u ? u.full_name || u.username || u.email || `User ${id}` : `User ${id}`;
        const hint = u ? u.email || u.username || "" : "";
        return `<button type="button" class="nc-chip nc-mod-chip" data-mod="${escapeHtml(m.key)}" data-id="${escapeHtml(
          String(id)
        )}" title="Remove ${escapeHtml(hint)}">× ${escapeHtml(name)}</button>`;
      })
      .join("");

    return `<div class="nc-admin-card nc-mod-card${enabled ? "" : " nc-mod-card--off"}" style="margin-top:0.75rem;" data-mod="${escapeHtml(
      m.key
    )}">
        <div style="display:flex; justify-content:space-between; gap:1rem; align-items:flex-start; flex-wrap:wrap;">
          <div>
            <div style="font-weight:950; letter-spacing:-0.02em;">${escapeHtml(m.label)}</div>
            <div class="nc-detail-muted" style="margin-top:0.15rem;">Module key: <code style="font-size:0.9em;">${escapeHtml(m.key)}</code></div>
          </div>
          <div style="display:flex; flex-direction:column; align-items:flex-end; gap:0.55rem;">
            <div style="display:flex; align-items:center; gap:0.5rem;">
              <span class="nc-detail-muted" style="font-size:0.82rem; white-space:nowrap;">Enabled</span>
              <label class="nc-switch" title="Show in Firmgate navigation (for eligible users)">
                <input type="checkbox" class="nc-mod-enabled" data-mod="${escapeHtml(m.key)}" ${enabled ? "checked" : ""}>
                <span class="nc-switch-ui"></span>
              </label>
            </div>
            <div style="display:flex; align-items:center; gap:0.5rem;">
              <span class="nc-detail-muted" style="font-size:0.82rem; white-space:nowrap;">Restricted</span>
              <label class="nc-switch" title="Limit to admins + allowed users (when enabled)">
                <input type="checkbox" class="nc-mod-restrict" data-mod="${escapeHtml(m.key)}" ${restricted ? "checked" : ""} ${
      enabled ? "" : "disabled"
    }>
                <span class="nc-switch-ui"></span>
              </label>
            </div>
          </div>
        </div>
        <div class="nc-detail-muted" style="margin-top:0.55rem;">
          ${
            !enabled
              ? "<b>Disabled</b> — hidden from the Firmgate menu for everyone (portal admins still see <b>Administration</b>)."
              : `<b>${restricted ? "Restricted" : "Visible to everyone"}</b>${
                  restricted ? " — only admins + allowed users will see this submenu." : ""
                }`
          }
        </div>
        <div class="nc-mod-restricted" data-mod="${escapeHtml(m.key)}" style="margin-top:0.75rem; ${
      enabled && restricted ? "" : "display:none;"
    }">
          <div style="margin-top:0.65rem;">
            <label class="nc-detail-label">Allowed users</label>
            <p class="nc-detail-muted" style="margin:0.25rem 0 0.35rem; font-size:0.82rem;">Select one or more users (Ctrl/Cmd+click), then <b>Save</b> below.</p>
            <div class="nc-share-add-row nc-mod-user-pick-row" style="margin-top:0.35rem; align-items:stretch;">
              <select multiple class="nc-detail-select nc-mod-user-sel" data-mod="${escapeHtml(m.key)}" size="7" style="flex:1; min-height:8.5rem;">
                ${allUsers
                  .filter((u) => !allowed.includes(String(u.id)))
                  .slice(0, 600)
                  .map((u) => {
                    const name = u.full_name || u.username || u.email || `User ${u.id}`;
                    const hint = u.email ? ` · ${u.email}` : u.username ? ` · ${u.username}` : "";
                    return `<option value="${escapeHtml(String(u.id))}">${escapeHtml(name + hint)}</option>`;
                  })
                  .join("")}
              </select>
              <button type="button" class="nc-btn nc-btn-secondary nc-mod-user-add" data-mod="${escapeHtml(m.key)}" style="align-self:flex-start;">Add to list</button>
            </div>
            <div class="nc-mod-chips" style="margin-top:0.5rem; display:flex; gap:0.4rem; flex-wrap:wrap;">${chips ||
              `<span class="nc-detail-muted">No users selected yet.</span>`}</div>
          </div>
        </div>
      </div>`;
  }

  async function loadModulesSettings() {
    const r = await api("/api/settings/modules", { method: "GET" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return setStatus("admin-modules-status", j.error || "Failed to load modules settings");
    modulesState = j;
    renderModules();
    setStatus("admin-modules-status", "");
  }

  let modulesSaveTimer = null;
  let modulesSaveInFlight = false;

  async function saveModulesSettings({ quiet = false } = {}) {
    syncModulesUiToState();
    mergePendingModuleUserSelections();
    const st = ensureModulesState();
    const modules = {};
    MODULES.forEach((m) => {
      const k = m.key;
      const cur = st.modules[k] || { allowed_user_ids: [], enabled: true, restricted: false };
      modules[k] = {
        enabled: cur.enabled !== false,
        restricted: !!cur.restricted && cur.enabled !== false,
        allowed_user_ids: Array.isArray(cur.allowed_user_ids) ? cur.allowed_user_ids.map(String) : [],
      };
    });
    if (!quiet) setStatus("admin-modules-status", "Saving…");
    const rr = await api("/api/settings/modules", { method: "PUT", body: JSON.stringify({ modules }) });
    const jj = await rr.json().catch(() => ({}));
    if (!rr.ok) throw new Error(jj.error || "Save failed");
    modulesState = jj;
    renderModules();
    setStatus("admin-modules-status", quiet ? "" : "Modules saved.");
  }

  function scheduleModulesAutoSave() {
    if (modulesSaveTimer) window.clearTimeout(modulesSaveTimer);
    modulesSaveTimer = window.setTimeout(() => {
      modulesSaveTimer = null;
      if (modulesSaveInFlight) return;
      modulesSaveInFlight = true;
      saveModulesSettings({ quiet: true })
        .catch((err) =>
          setStatus("admin-modules-status", String(err && err.message ? err.message : err) || "Save failed")
        )
        .finally(() => {
          modulesSaveInFlight = false;
        });
    }, 350);
  }
