(function () {
  const root = document.getElementById("admin-app");
  if (!root) return;

  const PREFIX = (root.dataset.prefix || "/admin").replace(/\/$/, "");
  const u = (p) => PREFIX + p;
  const currentUserId = Number(root.dataset.currentUserId || "") || null;
  const FULL_ADMIN = root.dataset.fullAdmin === "1";
  const CAN_ACCESS_USERS = root.dataset.canAccessUsers === "1";
  const CAN_CREATE_USERS = root.dataset.canCreateUsers === "1";
  const CAN_EDIT_USERS = root.dataset.usersEdit === "1";
  const CAN_DELETE_USERS = root.dataset.usersDelete === "1";
  const CAN_USER_PASSWORD = root.dataset.usersPassword === "1";
  const CAN_USER_ROLE = root.dataset.usersRole === "1";
  const CAN_RESET_MFA = root.dataset.usersResetMfa === "1";
  const CAN_USER_MFA = root.dataset.usersMfa === "1";
  const CAN_APPROVE_REGISTRATIONS = root.dataset.canApproveRegistrations === "1";
  const CAN_MANAGE_REG_NOTIFICATIONS = root.dataset.canManageRegistrationNotifications === "1";

  let users = [];
  let roles = [];
  let groups = [];
  let permissions = [];
  const usersTableWrap = document.getElementById("users-table-wrap");
  let selectedGroupId = null;
  const TAB_STORAGE_KEY = "admin.activeTab";

  function setStatus(which, msg) {
    const el = document.getElementById(which);
    if (el) el.textContent = msg || "";
  }

  async function api(path, opts = {}) {
    const r = await fetch(u(path), {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      ...opts,
    });
    return r;
  }

  function setActiveTab(name, { persist = true } = {}) {
    const norm = String(name || "").trim();
    const tabs = [...document.querySelectorAll(".nc-admin-nav-item")];
    const tabNames = new Set(tabs.map((t) => t.dataset.tab).filter(Boolean));
    const chosen = tabNames.has(norm) ? norm : "users";

    tabs.forEach((t) => {
      const isOn = t.dataset.tab === chosen;
      t.classList.toggle("is-active", isOn);
      t.setAttribute("aria-selected", String(isOn));
    });

    const setHidden = (id, on) => {
      const el = document.getElementById(id);
      if (el) el.hidden = !on;
    };
    setHidden("admin-tab-users", chosen === "users");
    setHidden("admin-tab-registrations", chosen === "registrations");
    setHidden("admin-tab-activity", chosen === "activity");
    setHidden("admin-tab-groups", chosen === "groups");
    setHidden("admin-tab-roles", chosen === "roles");
    setHidden("admin-tab-time", chosen === "time");
    setHidden("admin-tab-recycle", chosen === "recycle");
    setHidden("admin-tab-integrations", chosen === "integrations");
    setHidden("admin-tab-email", chosen === "email");
    setHidden("admin-tab-portal", chosen === "portal");
    setHidden("admin-tab-timesheets", chosen === "timesheets");
    setHidden("admin-tab-security_clearance", chosen === "security_clearance");
    setHidden("admin-tab-security_training", chosen === "security_training");
    setHidden("admin-tab-security_encryption", chosen === "security_encryption");
    setHidden("admin-tab-modules", chosen === "modules");
    setHidden("admin-tab-backup_restore", chosen === "backup_restore");
    setHidden("admin-tab-version", chosen === "version");
    if (chosen === "version") loadSoftwareVersion();
    if (chosen === "security_clearance") loadSecurityClearanceSettings();
    if (chosen === "security_training") loadSecurityTrainingSettings();
    if (chosen === "activity") {
      loadAuditSyslogSettings();
      loadAdminActivity();
    }
    if (chosen === "backup_restore") wireBackupRestoreOnce();
    if (chosen === "modules") void loadModulesSettings();
    if (chosen === "security_encryption") loadEncryptionSettings();
    if (chosen === "roles") refreshAccessControlMatrix();
    if (chosen === "email") loadEmailSettings();
    if (chosen === "portal") loadPortalSettings();
    if (chosen === "timesheets") loadTimesheetSettings();
    if (chosen === "registrations") loadRegistrations();

    if (persist) {
      try {
        window.localStorage.setItem(TAB_STORAGE_KEY, chosen);
      } catch (e) {}
      try {
        const url = new URL(window.location.href);
        url.searchParams.set("tab", chosen);
        window.history.replaceState({}, "", url.toString());
      } catch (e) {}
    }
    syncAdminMobileSelect(chosen);
  }

  const adminMobileNav = document.getElementById("nc-admin-mobile-tab");
  const adminMobileNavWrap = document.querySelector(".nc-admin-mobile-nav");

  function rebuildAdminMobileNav() {
    if (!adminMobileNav) return;
    const tabs = [...document.querySelectorAll(".nc-admin-nav-item:not([hidden])")];
    const current =
      tabs.find((t) => t.classList.contains("is-active"))?.dataset.tab ||
      adminMobileNav.value ||
      "users";
    adminMobileNav.replaceChildren();
    for (const tab of tabs) {
      const opt = document.createElement("option");
      opt.value = tab.dataset.tab || "";
      opt.textContent = (tab.textContent || "").trim();
      adminMobileNav.appendChild(opt);
    }
    syncAdminMobileSelect(current);
    if (adminMobileNavWrap) adminMobileNavWrap.hidden = tabs.length === 0;
  }

  function syncAdminMobileSelect(tabName) {
    if (!adminMobileNav || !adminMobileNav.options.length) return;
    const chosen = String(tabName || "").trim();
    if ([...adminMobileNav.options].some((o) => o.value === chosen)) {
      adminMobileNav.value = chosen;
    }
  }

  function applyLimitedAdminChrome() {
    if (FULL_ADMIN) return;
    document.querySelectorAll(".nc-admin-nav-item").forEach((btn) => {
      const t = btn.dataset.tab;
      if (t === "users") btn.hidden = !CAN_ACCESS_USERS;
      else if (t === "registrations") btn.hidden = !CAN_APPROVE_REGISTRATIONS;
      else btn.hidden = true;
    });
    const settingsBtn = document.getElementById("btn-admin-settings");
    if (settingsBtn) settingsBtn.hidden = true;
    rebuildAdminMobileNav();
  }

  function updateRegistrationSelfRegChrome(settings) {
    const cb = document.getElementById("reg-self-enabled");
    const hint = document.getElementById("reg-self-enabled-hint");
    if (!cb) return;
    const isExtranet = settings?.portal_theme === "non_core_team";
    if (hint) hint.hidden = !!isExtranet;
    if (!isExtranet) {
      cb.checked = false;
    } else if (settings) {
      cb.checked = !!settings.self_registration_enabled;
    }
  }

  function readRegNotifyForm() {
    return {
      admin_notify_enabled: !!document.getElementById("reg-notify-admin-enabled")?.checked,
      admin_notify_emails_text: (document.getElementById("reg-notify-admin-emails")?.value || "").trim(),
      admin_subject: (document.getElementById("reg-notify-admin-subject")?.value || "").trim(),
      admin_body: (document.getElementById("reg-notify-admin-body")?.value || "").trim(),
      registrant_notify_enabled: !!document.getElementById("reg-notify-registrant-enabled")?.checked,
      registrant_subject: (document.getElementById("reg-notify-registrant-subject")?.value || "").trim(),
      registrant_body: (document.getElementById("reg-notify-registrant-body")?.value || "").trim(),
      approval_notify_enabled: !!document.getElementById("reg-notify-approval-enabled")?.checked,
      approval_subject: (document.getElementById("reg-notify-approval-subject")?.value || "").trim(),
      approval_body: (document.getElementById("reg-notify-approval-body")?.value || "").trim(),
    };
  }

  function fillRegNotifyForm(n) {
    if (!n) return;
    const adminOn = document.getElementById("reg-notify-admin-enabled");
    const adminEmails = document.getElementById("reg-notify-admin-emails");
    const adminSub = document.getElementById("reg-notify-admin-subject");
    const adminBody = document.getElementById("reg-notify-admin-body");
    const regOn = document.getElementById("reg-notify-registrant-enabled");
    const regSub = document.getElementById("reg-notify-registrant-subject");
    const regBody = document.getElementById("reg-notify-registrant-body");
    const approvalOn = document.getElementById("reg-notify-approval-enabled");
    const approvalSub = document.getElementById("reg-notify-approval-subject");
    const approvalBody = document.getElementById("reg-notify-approval-body");
    const ph = document.getElementById("reg-notify-placeholders");
    if (adminOn) adminOn.checked = !!n.admin_notify_enabled;
    if (adminEmails) adminEmails.value = n.admin_notify_emails_text || (n.admin_notify_emails || []).join("\n");
    if (adminSub) adminSub.value = n.admin_subject || n.defaults?.admin_subject || "";
    if (adminBody) adminBody.value = n.admin_body || n.defaults?.admin_body || "";
    if (regOn) regOn.checked = !!n.registrant_notify_enabled;
    if (regSub) regSub.value = n.registrant_subject || n.defaults?.registrant_subject || "";
    if (regBody) regBody.value = n.registrant_body || n.defaults?.registrant_body || "";
    if (approvalOn) approvalOn.checked = n.approval_notify_enabled !== false;
    if (approvalSub) approvalSub.value = n.approval_subject || n.defaults?.approval_subject || "";
    if (approvalBody) approvalBody.value = n.approval_body || n.defaults?.approval_body || "";
    if (ph && Array.isArray(n.placeholders)) {
      ph.textContent = `Placeholders: ${n.placeholders.join(", ")}`;
    }
  }

  async function loadRegNotificationSettings() {
    if (!CAN_MANAGE_REG_NOTIFICATIONS) return;
    const r = await api("/api/settings/registration/notifications", { method: "GET" });
    const j = await r.json().catch(() => ({}));
    if (r.ok) fillRegNotifyForm(j);
  }

  function setRegNotifyStatus(msg) {
    const el = document.getElementById("reg-notify-status");
    if (el) el.textContent = msg || "";
  }

  function wireRegistrationsChrome() {
    const navBtn = document.querySelector('.nc-admin-nav-item[data-tab="registrations"]');
    if (navBtn) navBtn.hidden = !CAN_APPROVE_REGISTRATIONS;
    rebuildAdminMobileNav();
    const regSettingsWrap = document.getElementById("reg-self-enabled-wrap");
    if (regSettingsWrap) regSettingsWrap.hidden = !(FULL_ADMIN || CAN_CREATE_USERS);
    const regEnabled = document.getElementById("reg-self-enabled");
    if (regEnabled && (FULL_ADMIN || CAN_CREATE_USERS)) {
      regEnabled.addEventListener("change", async () => {
        const r = await api("/api/settings/registration", {
          method: "PUT",
          body: JSON.stringify({ self_registration_enabled: regEnabled.checked }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          setStatus("registrations-status", j.error || "Could not save registration setting.");
          await loadRegistrations();
          return;
        }
        updateRegistrationSelfRegChrome(j);
        const on = !!j.self_registration_available;
        setStatus(
          "registrations-status",
          on
            ? "Self-service registration is enabled (Extranet theme)."
            : j.portal_theme === "non_core_team"
              ? "Self-service registration is disabled."
              : "Self-service registration is off while the portal theme is Firmgate."
        );
      });
    }
    const regNotifySave = document.getElementById("reg-notify-save");
    if (regNotifySave && CAN_MANAGE_REG_NOTIFICATIONS) {
      regNotifySave.addEventListener("click", async () => {
        setRegNotifyStatus("Saving…");
        const r = await api("/api/settings/registration/notifications", {
          method: "PUT",
          body: JSON.stringify(readRegNotifyForm()),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          setRegNotifyStatus(j.error || "Save failed.");
          return;
        }
        fillRegNotifyForm(j);
        setRegNotifyStatus("Notification settings saved.");
      });
    }
    const testAdmin = document.getElementById("reg-notify-test-admin");
    const testReg = document.getElementById("reg-notify-test-registrant");
    const testApproval = document.getElementById("reg-notify-test-approval");
    async function sendRegNotifyTest(which) {
      setRegNotifyStatus("Sending test…");
      const to = (document.getElementById("reg-notify-test-to")?.value || "").trim();
      const r = await api("/api/settings/registration/notifications/test", {
        method: "POST",
        body: JSON.stringify({ to: to || undefined, which }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        setRegNotifyStatus(j.error || "Test email failed.");
        return;
      }
      setRegNotifyStatus(j.message || "Test email sent.");
    }
    if (testAdmin) testAdmin.addEventListener("click", () => sendRegNotifyTest("admin"));
    if (testReg) testReg.addEventListener("click", () => sendRegNotifyTest("registrant"));
    if (testApproval) testApproval.addEventListener("click", () => sendRegNotifyTest("approval"));
  }

  function formatRegDate(iso) {
    if (!iso) return "—";
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      return d.toLocaleString();
    } catch (e) {
      return iso;
    }
  }

  function renderRegistrationsList(items) {
    const wrap = document.getElementById("registrations-list");
    if (!wrap) return;
    if (!items.length) {
      wrap.innerHTML = '<p class="nc-detail-muted">No pending registrations.</p>';
      return;
    }
    wrap.innerHTML = items
      .map((row) => {
        const mfa = row.mfa_enrolled
          ? '<span class="nc-badge nc-badge--ok">MFA ready</span>'
          : '<span class="nc-badge">MFA incomplete</span>';
        const approveDisabled = row.mfa_enrolled ? "" : " disabled";
        const nameLine = row.display_name
          ? `<span class="nc-detail-muted">${escapeHtml(row.display_name)}</span>`
          : "";
        return `<article class="nc-admin-reg-row" data-reg-id="${row.id}">
          <div class="nc-admin-reg-row-main">
            <strong>${escapeHtml(row.email || row.username)}</strong>
            ${nameLine}
            <span class="nc-detail-muted">Submitted ${escapeHtml(formatRegDate(row.submitted_at))}</span>
            ${mfa}
          </div>
          <div class="nc-admin-reg-row-actions">
            <button type="button" class="nc-btn nc-btn-primary nc-reg-approve"${approveDisabled}>Approve</button>
            <button type="button" class="nc-btn nc-btn-secondary nc-reg-reject">Reject</button>
          </div>
        </article>`;
      })
      .join("");
    wrap.querySelectorAll(".nc-reg-approve").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const row = btn.closest("[data-reg-id]");
        const id = Number(row?.dataset.regId || 0);
        if (!id) return;
        btn.disabled = true;
        const r = await api(`/api/registrations/${id}/approve`, { method: "POST", body: "{}" });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          setStatus("registrations-status", j.error || "Approve failed.");
          btn.disabled = false;
          return;
        }
        let msg = "User approved.";
        const notify = j.approval_notification;
        if (notify && notify.skipped === "disabled") {
          msg += " Approval email is disabled in notification settings.";
        } else if (notify && notify.ok === false) {
          msg += ` Approval email failed: ${notify.message || "unknown error"}.`;
        } else if (notify && notify.ok) {
          msg += " Approval email sent.";
        }
        setStatus("registrations-status", msg);
        await loadRegistrations();
        await loadAll();
      });
    });
    wrap.querySelectorAll(".nc-reg-reject").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const row = btn.closest("[data-reg-id]");
        const id = Number(row?.dataset.regId || 0);
        if (!id) return;
        if (!window.confirm("Reject this registration? The email can register again later.")) return;
        btn.disabled = true;
        const r = await api(`/api/registrations/${id}/reject`, { method: "POST", body: "{}" });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          setStatus("registrations-status", j.error || "Reject failed.");
          btn.disabled = false;
          return;
        }
        setStatus("registrations-status", "Registration rejected.");
        await loadRegistrations();
      });
    });
  }

  async function loadRegistrations() {
    if (!CAN_APPROVE_REGISTRATIONS) return;
    await loadRegNotificationSettings();
    const rs = await api("/api/registrations");
    if (!rs.ok) {
      setStatus("registrations-status", "Failed to load registrations.");
      return;
    }
    const data = await rs.json();
    renderRegistrationsList(data.registrations || []);
    let sj = null;
    if (FULL_ADMIN || CAN_CREATE_USERS) {
      const settings = await api("/api/settings/registration");
      sj = settings.ok ? await settings.json() : null;
      if (sj) updateRegistrationSelfRegChrome(sj);
    }
    const n = (data.registrations || []).length;
    const pendingMsg = n ? `${n} pending` : "No pending registrations";
    if (sj && sj.portal_theme !== "non_core_team") {
      setStatus(
        "registrations-status",
        `${pendingMsg}. Self-service sign-up is disabled while the portal theme is Firmgate.`
      );
      return;
    }
    setStatus("registrations-status", pendingMsg);
  }

  async function loadAll() {
    if (!CAN_ACCESS_USERS) {
      setStatus("admin-users-status", "You do not have permission to manage users.");
      return;
    }
    if (FULL_ADMIN) {
      const [ru, rr, rg, rp] = await Promise.all([
        api("/api/users"),
        api("/api/roles"),
        api("/api/groups"),
        api("/api/permissions"),
      ]);
      if (!ru.ok || !rr.ok || !rg.ok || !rp.ok) {
        setStatus("admin-users-status", "Failed to load data (are you logged in as an administrator?).");
        return;
      }
      const ruj = await ru.json();
      const rrj = await rr.json();
      const rgj = await rg.json();
      const rpj = await rp.json();
      users = ruj.users || [];
      roles = rrj.roles || [];
      groups = rgj.groups || [];
      permissions = Array.isArray(rrj.permissions) && rrj.permissions.length ? rrj.permissions : rpj.permissions || [];
    } else {
      const [ru, rr] = await Promise.all([api("/api/users"), api("/api/roles")]);
      if (!ru.ok || !rr.ok) {
        setStatus("admin-users-status", "Failed to load user data.");
        return;
      }
      const ruj = await ru.json();
      const rrj = await rr.json();
      users = ruj.users || [];
      roles = rrj.roles || [];
      groups = [];
      permissions = [];
    }
    applyLimitedAdminChrome();
    renderUsers();
    renderNewUserForm();
    if (FULL_ADMIN) {
      renderGroupSidebar();
      renderGroups();
      renderRolesMatrix();
    } else {
      renderGroupSidebar();
    }
  }

  async function refreshAccessControlMatrix() {
    const rr = await api("/api/roles");
    if (!rr.ok) return;
    const rrj = await rr.json().catch(() => ({}));
    roles = rrj.roles || roles;
    permissions = Array.isArray(rrj.permissions) && rrj.permissions.length ? rrj.permissions : permissions;
    if (!permissions.length) {
      const rp = await api("/api/permissions");
      if (rp.ok) {
        const rpj = await rp.json().catch(() => ({}));
        permissions = rpj.permissions || [];
      }
    }
    renderRolesMatrix();
    const n = permissions.length;
    // Catalog expects ~17 rows; only admin.all ⇒ UI stays empty without cache-busted JS or synced DB.
    if (n > 0 && n < 10) {
      setStatus(
        "admin-roles-status",
        `Only ${n} permission row(s) loaded. Try a hard refresh (Ctrl/Cmd+Shift+R). If this persists, restart the app.`
      );
    } else {
      setStatus("admin-roles-status", "");
    }
  }

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function renderCheckboxGrid(container, prefix, items, selectedIds) {
    container.innerHTML = "";
    const sel = new Set(selectedIds || []);
    for (const it of items) {
      const id = `${prefix}-${it.id}`;
      const lab = document.createElement("label");
      lab.className = "nc-inline-check";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = String(it.id);
      cb.checked = sel.has(it.id);
      cb.dataset.id = String(it.id);
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(" " + (it.name || it.username || "")));
      container.appendChild(lab);
    }
  }

  function renderNewUserForm() {
    // Users tab is intentionally simplified (screenshot-style) and doesn't
    // expose role/group/phone on each row. Those are managed via the other tabs.
  }

  function collectCheckboxIds(container) {
    return [...container.querySelectorAll('input[type="checkbox"]:checked')].map((c) => Number(c.value));
  }

  // --- New user modal (Nextcloud-style) ---
  const newUserModal = document.getElementById("new-user-modal");
  const nuClose = document.getElementById("new-user-close");
  const nuCancel = document.getElementById("new-user-cancel");
  const nuCreate = document.getElementById("new-user-create");
  const nuStatus = document.getElementById("new-user-status");
  const nuUsername = document.getElementById("nu-username");
  const nuFullName = document.getElementById("nu-full-name");
  const nuEmail = document.getElementById("nu-email");
  const nuPhone = document.getElementById("nu-phone");
  const nuPw1 = document.getElementById("nu-password");
  const nuPw2 = document.getElementById("nu-password2");
  const nuRequireChange = document.getElementById("nu-require-change");
  const nuActive = document.getElementById("nu-active");
  const nuMfa = document.getElementById("nu-mfa");
  const nuMfaHelp = document.getElementById("nu-mfa-help");
  const nuMfaResetWrap = document.getElementById("nu-mfa-reset-wrap");
  const nuMfaReset = document.getElementById("nu-mfa-reset");
  const nuRoleCards = document.getElementById("nu-role-cards");
  const nuTitle = document.getElementById("new-user-title");
  const nuDeleteUserBtn = document.getElementById("nu-delete-user");
  let nuRoleId = null;
  let nuEditingUserId = null;
  let nuUsernameDirty = false;

  const deleteUserModal = document.getElementById("delete-user-modal");
  const deleteUserClose = document.getElementById("delete-user-close");
  const deleteUserCancel = document.getElementById("delete-user-cancel");
  const deleteUserConfirm = document.getElementById("delete-user-confirm");
  const deleteUserJustification = document.getElementById("delete-user-justification");
  const deleteUserStatus = document.getElementById("delete-user-status");
  const deleteUserLead = document.getElementById("delete-user-lead");
  let pendingDeleteUserId = null;

  function setNuStatus(msg) {
    if (nuStatus) nuStatus.textContent = msg || "";
  }

  function updateNuMfaHelp(usr) {
    if (!nuMfaHelp) return;
    if (!nuMfa?.checked) {
      nuMfaHelp.textContent = "Enforce Google or Microsoft Authenticator (TOTP) on sign-in";
    } else if (usr?.mfa_enrolled) {
      nuMfaHelp.textContent = "Authenticator enrolled — user enters a 6-digit code at sign-in";
    } else {
      nuMfaHelp.textContent = "User will scan a QR code on first sign-in after you save";
    }
    updateNuMfaResetVisibility(usr);
  }

  function updateNuMfaResetVisibility(usr) {
    if (!nuMfaResetWrap) return;
    const show =
      CAN_RESET_MFA && !!nuEditingUserId && !!usr?.mfa_enrolled && !!nuMfa?.checked;
    nuMfaResetWrap.hidden = !show;
    if (nuMfaReset) nuMfaReset.disabled = !show;
  }

  function applyUserModalFieldGates() {
    const editing = !!nuEditingUserId;
    const setFieldEnabled = (el, enabled) => {
      if (!el) return;
      el.disabled = !enabled;
      const lab = el.closest("label");
      if (lab) lab.classList.toggle("is-disabled", !enabled);
    };
    setFieldEnabled(nuFullName, !editing || CAN_EDIT_USERS);
    setFieldEnabled(nuEmail, !editing || CAN_EDIT_USERS);
    setFieldEnabled(nuPhone, !editing || CAN_EDIT_USERS);
    setFieldEnabled(nuActive, !editing || CAN_EDIT_USERS);
    setFieldEnabled(nuUsername, !editing || CAN_EDIT_USERS);
    setFieldEnabled(nuPw1, editing ? CAN_USER_PASSWORD : CAN_CREATE_USERS);
    setFieldEnabled(nuPw2, editing ? CAN_USER_PASSWORD : CAN_CREATE_USERS);
    setFieldEnabled(nuRequireChange, editing ? CAN_USER_PASSWORD : CAN_CREATE_USERS);
    setFieldEnabled(nuMfa, CAN_USER_MFA);
    if (nuRoleCards) {
      nuRoleCards.querySelectorAll(".nc-role-card").forEach((btn) => {
        btn.disabled = !CAN_USER_ROLE;
        btn.classList.toggle("is-disabled", !CAN_USER_ROLE);
      });
    }
    if (nuDeleteUserBtn) {
      nuDeleteUserBtn.hidden = !editing || !CAN_DELETE_USERS;
      nuDeleteUserBtn.disabled = !CAN_DELETE_USERS;
    }
  }

  function nameFromEmail(email) {
    const s = (email || "").trim();
    if (!s.includes("@")) return "";
    return s.split("@")[0];
  }

  function defaultStandardRoleId() {
    return (roleByKey("standard") || {}).id || null;
  }

  function roleByKey(key) {
    const k = String(key || "").toLowerCase();
    const exact = roles.find((r) => String(r.name || "").toLowerCase() === k);
    if (exact) return exact;
    if (k === "standard") {
      return roles.find((r) => String(r.name || "").toLowerCase() === "viewer") || null;
    }
    if (k === "power") {
      return roles.find((r) => String(r.name || "").toLowerCase() === "editor") || null;
    }
    return null;
  }

  function userPrimaryRoleId(usr) {
    if (!usr) return defaultStandardRoleId();
    if (usr.primary_role_id != null && usr.primary_role_id !== "") {
      return Number(usr.primary_role_id);
    }
    const ids = (usr.role_ids || []).map(Number).filter(Boolean);
    for (const key of ["admin", "standard", "viewer", "power", "editor"]) {
      const r = roleByKey(key);
      if (r && ids.includes(Number(r.id))) return Number(r.id);
    }
    return defaultStandardRoleId() || ids[0] || null;
  }

  function groupIdFromCompanionRoleName(name) {
    const m = /^__group_id_(\d+)__$/.exec(String(name || "").trim());
    return m ? Number(m[1]) : null;
  }

  function renderRoleCards() {
    if (!nuRoleCards) return;
    const isCreate = !nuEditingUserId;
    const roleSection = nuRoleCards.closest(".nc-modal-section");
    if (roleSection) {
      roleSection.hidden = isCreate || !FULL_ADMIN || !CAN_USER_ROLE;
    }
    if (isCreate || !FULL_ADMIN || !CAN_USER_ROLE) {
      nuRoleCards.innerHTML = "";
      return;
    }
    const mkDesc = (name) => {
      const n = (name || "").toLowerCase();
      if (n.includes("admin")) return ["Admin", "Full access including", "user management"];
      if (n.includes("power") || n.includes("editor")) return ["Power User", "Create and manage", "content + events"];
      return ["Standard User", "Read-only access to", "shared content"];
    };
    const adminRole = roleByKey("admin");
    const powerRole = roleByKey("power");
    const standardRole = roleByKey("standard");
    const rolesToShow = [adminRole, powerRole, standardRole].filter(Boolean);
    if (!nuRoleId && standardRole) nuRoleId = standardRole.id;
    nuRoleCards.innerHTML = "";
    for (const r of rolesToShow) {
      const [title, l1, l2] = mkDesc(r.name);
      const b = document.createElement("button");
      b.type = "button";
      b.className = "nc-role-card" + (String(nuRoleId) === String(r.id) ? " is-selected" : "");
      b.innerHTML = `<div class="nc-role-card-title">${escapeHtml(title)}</div>
        <div class="nc-role-card-sub">${escapeHtml(l1)}<br>${escapeHtml(l2)}</div>`;
      b.addEventListener("click", () => {
        nuRoleId = r.id;
        renderRoleCards();
      });
      nuRoleCards.appendChild(b);
    }
  }

  function openNewUserModal() {
    if (!newUserModal || !CAN_CREATE_USERS) return;
    nuEditingUserId = null;
    nuUsernameDirty = false;
    setNuStatus("");
    if (nuEmail) nuEmail.value = "";
    if (nuPhone) nuPhone.value = "";
    if (nuFullName) nuFullName.value = "";
    if (nuPw1) nuPw1.value = "";
    if (nuPw2) nuPw2.value = "";
    if (nuRequireChange) nuRequireChange.checked = true;
    if (nuActive) nuActive.checked = true;
    if (nuMfa) nuMfa.checked = true;
    updateNuMfaHelp(null);
    updateNuMfaResetVisibility(null);
    if (nuUsername) nuUsername.value = "";
    nuRoleId = defaultStandardRoleId();
    renderRoleCards();
    if (roleByKey("standard")) nuRoleId = roleByKey("standard").id;
    if (nuTitle) nuTitle.textContent = "New user";
    if (nuCreate) nuCreate.textContent = "Create user";
    if (nuDeleteUserBtn) nuDeleteUserBtn.hidden = true;
    applyUserModalFieldGates();
    newUserModal.hidden = false;
    setTimeout(() => nuFullName?.focus(), 50);
  }

  function openEditUserModal(userId) {
    if (!CAN_EDIT_USERS && !CAN_USER_PASSWORD && !CAN_USER_ROLE && !CAN_USER_MFA) return;
    const usr = users.find((x) => Number(x.id) === Number(userId));
    if (!usr || !newUserModal) return;
    nuEditingUserId = Number(userId);
    nuUsernameDirty = false;
    setNuStatus("");
    if (nuEmail) nuEmail.value = usr.email || "";
    if (nuPhone) nuPhone.value = usr.phone || "";
    if (nuFullName) nuFullName.value = usr.full_name || "";
    if (nuPw1) nuPw1.value = "";
    if (nuPw2) nuPw2.value = "";
    const attrs = usr.attributes || {};
    if (nuRequireChange) nuRequireChange.checked = !!attrs.require_pw_change;
    if (nuActive) nuActive.checked = !!usr.is_active;
    if (nuMfa) nuMfa.checked = !!attrs.mfa_required;
    updateNuMfaHelp(usr);
    if (nuUsername) nuUsername.value = (attrs.handle || "").trim() || nameFromEmail(usr.email || usr.username || "");
    nuRoleId = userPrimaryRoleId(usr);
    renderRoleCards();
    if (nuTitle) nuTitle.textContent = "Edit profile";
    if (nuCreate) nuCreate.textContent = "Save changes";
    if (nuDeleteUserBtn) {
      nuDeleteUserBtn.hidden =
        !CAN_DELETE_USERS ||
        !nuEditingUserId ||
        (currentUserId != null && Number(nuEditingUserId) === Number(currentUserId));
    }
    applyUserModalFieldGates();
    newUserModal.hidden = false;
    setTimeout(() => nuFullName?.focus(), 50);
  }

  function closeNewUserModal() {
    if (!newUserModal) return;
    newUserModal.hidden = true;
  }

  if (newUserModal) {
    newUserModal.addEventListener("click", (e) => {
      if (e.target === newUserModal) closeNewUserModal();
    });
  }
  nuClose?.addEventListener("click", closeNewUserModal);
  nuCancel?.addEventListener("click", closeNewUserModal);
  nuMfa?.addEventListener("change", () => {
    const usr = nuEditingUserId ? users.find((x) => Number(x.id) === Number(nuEditingUserId)) : null;
    updateNuMfaHelp(usr);
  });

  nuMfaReset?.addEventListener("click", async () => {
    if (!CAN_RESET_MFA) return;
    const uid = nuEditingUserId;
    if (!uid) return;
    const usr = users.find((x) => Number(x.id) === Number(uid));
    if (!usr?.mfa_enrolled) return;
    const label = (usr.full_name || usr.email || usr.username || "this user").trim();
    if (
      !window.confirm(
        `Reset authenticator for ${label}?\n\nThey will need to scan a new QR code on next sign-in.`
      )
    ) {
      return;
    }
    setNuStatus("Resetting authenticator…");
    nuMfaReset.disabled = true;
    try {
      const r = await api(`/api/users/${encodeURIComponent(String(uid))}/reset-mfa`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNuStatus(j.error || "Could not reset authenticator");
        return;
      }
      if (j.user) {
        const idx = users.findIndex((x) => Number(x.id) === Number(uid));
        if (idx >= 0) users[idx] = j.user;
        updateNuMfaHelp(j.user);
      }
      setNuStatus("Authenticator reset. User will enroll again on next sign-in.");
    } catch {
      setNuStatus("Could not reset authenticator");
    } finally {
      updateNuMfaResetVisibility(users.find((x) => Number(x.id) === Number(uid)) || null);
    }
  });
  function closeDeleteUserModal() {
    if (!deleteUserModal) return;
    deleteUserModal.hidden = true;
    pendingDeleteUserId = null;
    if (deleteUserJustification) deleteUserJustification.value = "";
    if (deleteUserStatus) deleteUserStatus.textContent = "";
  }

  function openDeleteUserConfirm(userId) {
    const uid = Number(userId);
    if (!uid || !deleteUserModal) return;
    if (currentUserId != null && uid === currentUserId) {
      setStatus("admin-users-status", "You cannot delete your own account.");
      return;
    }
    const usr = users.find((x) => Number(x.id) === uid);
    pendingDeleteUserId = uid;
    if (deleteUserStatus) deleteUserStatus.textContent = "";
    if (deleteUserJustification) deleteUserJustification.value = "";
    const label = (usr && (usr.full_name || usr.email || usr.username)) || `User #${uid}`;
    if (deleteUserLead) {
      deleteUserLead.innerHTML = "";
      deleteUserLead.appendChild(document.createTextNode("This permanently removes "));
      const strong = document.createElement("strong");
      strong.textContent = label;
      deleteUserLead.appendChild(strong);
      deleteUserLead.appendChild(document.createTextNode(". This cannot be undone."));
    }
    deleteUserModal.hidden = false;
    setTimeout(() => deleteUserJustification?.focus(), 50);
  }

  nuDeleteUserBtn?.addEventListener("click", () => {
    if (nuEditingUserId) openDeleteUserConfirm(nuEditingUserId);
  });

  deleteUserModal?.addEventListener("click", (e) => {
    if (e.target === deleteUserModal) closeDeleteUserModal();
  });
  deleteUserClose?.addEventListener("click", closeDeleteUserModal);
  deleteUserCancel?.addEventListener("click", closeDeleteUserModal);

  deleteUserConfirm?.addEventListener("click", async () => {
    if (!pendingDeleteUserId) return;
    const text = (deleteUserJustification?.value || "").trim();
    if (text.length < 10) {
      if (deleteUserStatus) deleteUserStatus.textContent = "Enter at least 10 characters for the justification.";
      return;
    }
    if (deleteUserStatus) deleteUserStatus.textContent = "Deleting…";
    const r = await api(`/api/users/${pendingDeleteUserId}`, {
      method: "DELETE",
      body: JSON.stringify({ justification: text }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (deleteUserStatus) deleteUserStatus.textContent = j.error || "Delete failed.";
      setStatus("admin-users-status", j.error || "Delete failed.");
      return;
    }
    closeDeleteUserModal();
    closeNewUserModal();
    setStatus("admin-users-status", "User deleted.");
    await loadAll();
  });

  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (deleteUserModal && !deleteUserModal.hidden) {
      closeDeleteUserModal();
      return;
    }
    if (newUserModal && !newUserModal.hidden) closeNewUserModal();
  });
  nuEmail?.addEventListener("input", () => {
    if (nuUsername && !nuUsernameDirty) nuUsername.value = nameFromEmail(nuEmail.value);
  });
  nuUsername?.addEventListener("input", () => {
    nuUsernameDirty = true;
  });

  nuCreate?.addEventListener("click", async () => {
    if (nuEditingUserId) {
      if (!CAN_EDIT_USERS && !CAN_USER_PASSWORD && !CAN_USER_ROLE && !CAN_USER_MFA) return;
    } else if (!CAN_CREATE_USERS) {
      return;
    }
    setNuStatus("");
    const full_name = (nuFullName?.value || "").trim();
    const email = (nuEmail?.value || "").trim();
    const phone = (nuPhone?.value || "").trim();
    const handle = (nuUsername?.value || "").trim();
    const password = nuPw1?.value || "";
    const password2 = nuPw2?.value || "";
    const is_active = !!nuActive?.checked;
    const require_pw_change = !!nuRequireChange?.checked;
    const mfa_required = CAN_USER_MFA && !!nuMfa?.checked;
    const role_ids =
      nuEditingUserId && FULL_ADMIN && CAN_USER_ROLE && nuRoleId != null ? [Number(nuRoleId)] : [];

    if (!email || !email.includes("@")) {
      setNuStatus("Email address is required.");
      return;
    }
    if (!nuEditingUserId && password.length < 8) {
      setNuStatus("Password must be at least 8 characters.");
      return;
    }
    if (nuEditingUserId && password.length > 0 && !CAN_USER_PASSWORD) {
      setNuStatus("You do not have permission to change passwords.");
      return;
    }
    if (nuEditingUserId && password.length > 0 && password.length < 8) {
      setNuStatus("Password must be at least 8 characters.");
      return;
    }
    if (password2 && password2 !== password) {
      setNuStatus("Passwords do not match.");
      return;
    }

    const baseAttrs =
      nuEditingUserId && users.find((x) => Number(x.id) === Number(nuEditingUserId))
        ? { ...((users.find((x) => Number(x.id) === Number(nuEditingUserId)).attributes || {})) }
        : {};
    const body = {};
    if (!nuEditingUserId || CAN_EDIT_USERS) {
      body.full_name = full_name || null;
      body.is_active = is_active;
      body.email = email;
      body.phone = phone || null;
    }
    if (nuEditingUserId && FULL_ADMIN && CAN_USER_ROLE) body.role_ids = role_ids;
    const attrs = { ...baseAttrs };
    if (CAN_USER_MFA) attrs.mfa_required = mfa_required;
    if (CAN_EDIT_USERS) attrs.handle = handle || null;
    if (nuEditingUserId ? CAN_USER_PASSWORD : CAN_CREATE_USERS) {
      attrs.require_pw_change = require_pw_change;
    }
    if (Object.keys(attrs).length) body.attributes = attrs;
    if (password.length && (nuEditingUserId ? CAN_USER_PASSWORD : CAN_CREATE_USERS)) {
      body.password = password;
    }

    setNuStatus(nuEditingUserId ? "Saving…" : "Creating user…");
    const r = await api(nuEditingUserId ? `/api/users/${nuEditingUserId}` : "/api/users", {
      method: nuEditingUserId ? "PATCH" : "POST",
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setNuStatus(j.error || (nuEditingUserId ? "Save failed" : "Create failed"));
      return;
    }
    setNuStatus(nuEditingUserId ? "Saved." : "User created.");
    closeNewUserModal();
    setStatus("admin-users-status", nuEditingUserId ? "Saved." : "User created.");
    await loadAll();
  });

  function renderUsers() {
    const showUsers = selectedGroupId
      ? users.filter((u) => (u.group_ids || []).includes(selectedGroupId))
      : users;
    const initials = (u) => {
      const src = (u.full_name || u.email || u.username || "").trim();
      const parts = src.split(/\s+/).filter(Boolean);
      const a = (parts[0] || src || "?")[0] || "?";
      const b = parts.length > 1 ? (parts[parts.length - 1][0] || "") : (src[1] || "");
      return (a + b).toUpperCase();
    };

    const roleName = (rid) => (roles.find((r) => Number(r.id) === Number(rid)) || {}).name || "";
    const groupName = (gid) => (groups.find((g) => Number(g.id) === Number(gid)) || {}).name || "";

    let html =
      '<table class="nc-table nc-admin-users-table nc-admin-users-table--details"><thead><tr><th>User</th><th>Role</th><th>Group</th><th>Status</th><th></th></tr></thead><tbody>';
    for (const usr of showUsers) {
      const rowMuted = !usr.is_active && usr.factory_bootstrap;
      html += `<tr data-user-id="${usr.id}"${rowMuted ? ' class="nc-admin-user-row--muted"' : ""}>`;
      html += `<td class="col-user">
        <div class="nc-admin-usercell">
          <div class="nc-admin-avatar">${escapeHtml(initials(usr))}</div>
          <div class="nc-admin-usertext">
            <div class="nc-admin-name">${escapeHtml(usr.full_name || usr.username || "")}</div>
            <div class="nc-admin-uid">${escapeHtml((usr.email || usr.username || "").toLowerCase())}</div>
          </div>
        </div>
      </td>`;
      const curRole = userPrimaryRoleId(usr) || "";
      const curGroup = (usr.group_ids || [])[0] || "";
      html += `<td class="col-role">${escapeHtml(roleName(curRole) || "—")}</td>`;
      html += `<td class="col-group">${escapeHtml(groupName(curGroup) || "—")}</td>`;
      html += `<td class="col-status">${
        usr.is_active
          ? '<span class="nc-pill nc-pill-ok">Active</span>'
          : `<span class="nc-pill">Inactive</span>${
              usr.factory_bootstrap
                ? ' <span class="nc-detail-muted" style="font-size:0.8em" title="Default install account; sign-in disabled.">(factory)</span>'
                : ""
            }`
      }</td>`;
      const canRowEdit =
        CAN_EDIT_USERS || CAN_USER_PASSWORD || CAN_USER_ROLE || CAN_USER_MFA || CAN_DELETE_USERS;
      if (canRowEdit) {
        html += `<td class="col-actions">
          <button type="button" class="nc-btn nc-btn-secondary btn-user-edit" data-id="${usr.id}">Edit profile</button>
        </td>`;
      } else {
        html += `<td class="col-actions"></td>`;
      }
      html += `</tr>`;
    }
    html += "</tbody></table>";
    usersTableWrap.innerHTML = html;

    usersTableWrap.querySelectorAll(".btn-user-edit").forEach((btn) => {
      btn.addEventListener("click", () => openEditUserModal(Number(btn.dataset.id)));
    });
  }

  function renderGroupSidebar() {
    const el = document.getElementById("admin-group-list");
    if (!el) return;
    const mk = (id, label, count) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "nc-admin-group-pill" + (selectedGroupId === id ? " is-active" : "");
      b.innerHTML = `<span>${escapeHtml(label)}</span><span class="nc-admin-count">${count}</span>`;
      b.addEventListener("click", () => {
        selectedGroupId = id;
        renderGroupSidebar();
        renderUsers();
      });
      return b;
    };
    el.innerHTML = "";
    const allCount = users.length;
    el.appendChild(mk(null, "Everyone", allCount));
    for (const g of groups) {
      const count = users.filter((u) => (u.group_ids || []).includes(g.id)).length;
      el.appendChild(mk(g.id, g.name, count));
    }
  }

  // Editing users is done via the modal.

  let groupsSearchQ = "";
  let rolesAccessSearchQ = "";
  /** Open role permission modal: target role id and whether UI is read-only (admin role). */
  let roleAcModalCtx = { roleId: null, readOnly: false };
  let roleAcModalWired = false;
  let groupRowMenuForId = null;
  let groupModalCtx = {
    gid: null,
    memberIds: [],
    roleIds: [],
    serverMemberIds: new Set(),
    pendingAddIds: new Set(),
  };

  function closeGroupRowMenu() {
    const m = document.getElementById("admin-group-row-menu");
    if (m) m.hidden = true;
    groupRowMenuForId = null;
  }

  function openGroupRowMenu(groupId, anchorBtn) {
    const menu = document.getElementById("admin-group-row-menu");
    if (!menu || !anchorBtn) return;
    groupRowMenuForId = Number(groupId);
    const r = anchorBtn.getBoundingClientRect();
    const mw = 220;
    let left = r.right - mw;
    if (left < 8) left = 8;
    if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
    menu.style.top = `${Math.round(r.bottom + 4)}px`;
    menu.style.left = `${Math.round(left)}px`;
    menu.hidden = false;
  }

  function groupRoleLabel(r) {
    const n = String((r && r.name) || "").toLowerCase();
    if (n.includes("admin")) return "Admin";
    if (n.includes("power") || n.includes("editor")) return "Power User";
    return "Standard User";
  }

  function rolesToShowInGroupModal() {
    return [roleByKey("admin"), roleByKey("power"), roleByKey("standard")].filter(Boolean);
  }

  function userById(uid) {
    return users.find((u) => Number(u.id) === Number(uid));
  }

  function groupById(gid) {
    return groups.find((g) => Number(g.id) === Number(gid));
  }

  function rebuildGmDatalist() {
    const dl = document.getElementById("gm-user-datalist");
    if (!dl) return;
    const taken = new Set(groupModalCtx.memberIds.map(Number));
    const parts = [];
    for (const u of users) {
      if (!u || taken.has(Number(u.id))) continue;
      const em = String(u.email || u.username || "").trim();
      if (!em) continue;
      const nm = String(u.full_name || u.username || "").trim();
      parts.push(`<option value="${escapeHtml(em)}">${escapeHtml(nm)}</option>`);
    }
    dl.innerHTML = parts.join("");
  }

  function renderGmMemberRows() {
    const host = document.getElementById("gm-member-rows");
    if (!host) return;
    if (!groupModalCtx.memberIds.length) {
      host.innerHTML = `<div class="nc-detail-muted" style="padding:0.35rem 0;">No members yet. Add someone below.</div>`;
      return;
    }
    const rows = groupModalCtx.memberIds
      .map((uid) => {
        const u = userById(uid);
        if (!u) return "";
        const nm = escapeHtml(String(u.full_name || u.username || "User"));
        const em = escapeHtml(String(u.email || u.username || ""));
        const pending = groupModalCtx.pendingAddIds.has(Number(uid));
        const saveBtn = pending
          ? `<button type="button" class="nc-btn nc-btn-primary nc-btn-sm js-gm-row-save" data-uid="${u.id}">Save</button>`
          : `<button type="button" class="nc-btn nc-btn-secondary nc-btn-sm js-gm-row-save" data-uid="${u.id}" disabled title="Already saved">Save</button>`;
        return `<div class="nc-admin-gm-member-row" data-uid="${u.id}">
          <div class="nc-admin-gm-member-meta">
            <div class="nc-admin-gm-member-name">${nm}</div>
            <div class="nc-admin-gm-member-email">${em}</div>
          </div>
          <div class="nc-admin-gm-member-actions">
            ${saveBtn}
            <button type="button" class="nc-btn nc-btn-secondary nc-btn-sm js-gm-row-remove" data-uid="${u.id}">Remove</button>
          </div>
        </div>`;
      })
      .join("");
    host.innerHTML = rows;

    host.querySelectorAll(".js-gm-row-remove").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const uid = Number(btn.getAttribute("data-uid"));
        const wasServer = groupModalCtx.serverMemberIds.has(uid);
        groupModalCtx.memberIds = groupModalCtx.memberIds.filter((x) => Number(x) !== uid);
        groupModalCtx.pendingAddIds.delete(uid);
        if (wasServer) {
          const r = await api(`/api/groups/${groupModalCtx.gid}/members`, {
            method: "PUT",
            body: JSON.stringify({ user_ids: groupModalCtx.memberIds.map(Number) }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) {
            setStatus("group-manage-status", j.error || "Could not remove member.");
            await loadAll();
            closeGroupManageModal();
            return;
          }
          if (j.group && Array.isArray(j.group.user_ids)) {
            groupModalCtx.memberIds = j.group.user_ids.map(Number);
            groupModalCtx.serverMemberIds = new Set(groupModalCtx.memberIds);
          } else {
            groupModalCtx.serverMemberIds = new Set(groupModalCtx.memberIds);
          }
          setStatus("group-manage-status", "Member removed.");
          await loadAll();
        }
        renderGmMemberRows();
        rebuildGmDatalist();
      });
    });

    host.querySelectorAll(".js-gm-row-save").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const uid = Number(btn.getAttribute("data-uid"));
        if (!groupModalCtx.pendingAddIds.has(uid)) return;
        const r = await api(`/api/groups/${groupModalCtx.gid}/members`, {
          method: "PUT",
          body: JSON.stringify({ user_ids: groupModalCtx.memberIds.map(Number) }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          setStatus("group-manage-status", j.error || "Save failed");
          return;
        }
        groupModalCtx.pendingAddIds.delete(uid);
        if (j.group && Array.isArray(j.group.user_ids)) {
          groupModalCtx.memberIds = j.group.user_ids.map(Number);
        }
        groupModalCtx.serverMemberIds = new Set(groupModalCtx.memberIds);
        setStatus("group-manage-status", "Member saved to group.");
        renderGmMemberRows();
        rebuildGmDatalist();
        await loadAll();
      });
    });
  }

  function renderGmRoleChecks() {
    const host = document.getElementById("gm-role-checks");
    if (!host) return;
    const rolesToShow = rolesToShowInGroupModal();
    let html = "";
    for (const r of rolesToShow) {
      const on = groupModalCtx.roleIds.includes(r.id);
      html += `<label class="nc-inline-check"><input type="checkbox" class="gm-role-cb" value="${r.id}" ${on ? "checked" : ""}> ${escapeHtml(groupRoleLabel(r))}</label>`;
    }
    host.innerHTML = html;
  }

  function openGroupManageModal(gid) {
    const g = groupById(gid);
    if (!g) return;
    closeGroupRowMenu();
    const modal = document.getElementById("group-manage-modal");
    const title = document.getElementById("group-manage-title");
    const pick = document.getElementById("gm-user-pick");
    if (title) title.textContent = `Members — ${g.name}`;
    groupModalCtx.gid = Number(gid);
    groupModalCtx.memberIds = [...(g.user_ids || [])].map(Number);
    groupModalCtx.roleIds = [...(g.role_ids || [])].map(Number);
    groupModalCtx.serverMemberIds = new Set(groupModalCtx.memberIds);
    groupModalCtx.pendingAddIds = new Set();
    if (pick) pick.value = "";
    setStatus("group-manage-status", "");
    rebuildGmDatalist();
    renderGmMemberRows();
    renderGmRoleChecks();
    if (modal) modal.hidden = false;
  }

  function closeGroupManageModal() {
    const modal = document.getElementById("group-manage-modal");
    if (groupModalCtx.pendingAddIds.size) {
      if (!window.confirm("Discard members you added but have not saved with “Save” on their row or “Save all”?")) return;
    }
    if (modal) modal.hidden = true;
    groupModalCtx.gid = null;
    groupModalCtx.memberIds = [];
    groupModalCtx.roleIds = [];
    groupModalCtx.serverMemberIds = new Set();
    groupModalCtx.pendingAddIds = new Set();
  }

  async function gmSaveAllFromModal() {
    if (!groupModalCtx.gid) return;
    setStatus("group-manage-status", "Saving…");
    const role_ids = [...document.querySelectorAll("#gm-role-checks .gm-role-cb:checked")].map((c) => Number(c.value));
    let r = await api(`/api/groups/${groupModalCtx.gid}/members`, {
      method: "PUT",
      body: JSON.stringify({ user_ids: groupModalCtx.memberIds.map(Number) }),
    });
    const jm = await r.json().catch(() => ({}));
    if (!r.ok) {
      setStatus("group-manage-status", jm.error || "Failed to save members");
      return;
    }
    r = await api(`/api/groups/${groupModalCtx.gid}/roles`, { method: "PUT", body: JSON.stringify({ role_ids }) });
    const jr = await r.json().catch(() => ({}));
    if (!r.ok) {
      setStatus("group-manage-status", jr.error || "Failed to save roles");
      return;
    }
    groupModalCtx.pendingAddIds.clear();
    groupModalCtx.serverMemberIds = new Set(groupModalCtx.memberIds);
    groupModalCtx.roleIds = role_ids;
    setStatus("group-manage-status", "Saved.");
    await loadAll();
    closeGroupManageModal();
  }

  function tryAddMemberFromPickInput() {
    const pick = document.getElementById("gm-user-pick");
    if (!pick || !groupModalCtx.gid) return;
    const raw = String(pick.value || "").trim();
    if (!raw) return;
    const low = raw.toLowerCase();
    const u = users.find(
      (x) =>
        String(x.email || "")
          .trim()
          .toLowerCase() === low ||
        String(x.username || "")
          .trim()
          .toLowerCase() === low ||
        String(x.full_name || "")
          .trim()
          .toLowerCase() === low
    );
    if (!u) {
      setStatus("group-manage-status", "No user matches that email or name.");
      return;
    }
    if (groupModalCtx.memberIds.map(Number).includes(Number(u.id))) {
      setStatus("group-manage-status", "That user is already in this group.");
      return;
    }
    groupModalCtx.memberIds.push(Number(u.id));
    groupModalCtx.pendingAddIds.add(Number(u.id));
    pick.value = "";
    setStatus("group-manage-status", "Added — click Save on the row or Save all.");
    renderGmMemberRows();
    rebuildGmDatalist();
  }

  function renderGroups() {
    const el = document.getElementById("groups-editor");
    const countEl = document.getElementById("groups-count");
    if (!el) return;

    const q = String(groupsSearchQ || "")
      .trim()
      .toLowerCase();
    const filtered = !q
      ? groups.slice()
      : groups.filter((g) => {
          const blob = `${g.name || ""} ${g.description || ""}`.toLowerCase();
          return blob.includes(q);
        });

    if (countEl) countEl.textContent = `${filtered.length} group${filtered.length === 1 ? "" : "s"}`;

    if (!filtered.length) {
      el.innerHTML = q
        ? `<div class="nc-detail-muted" style="padding:1rem;">No groups match your search.</div>`
        : `<div class="nc-detail-muted" style="padding:1rem;">No groups yet. Create one above.</div>`;
      return;
    }

    const palette = ["#10b981", "#3b82f6", "#eab308", "#a855f7", "#f97316", "#14b8a6", "#6366f1", "#ec4899"];
    let html = `<div class="nc-admin-groups-table">`;
    filtered.forEach((g, idx) => {
      const memberCount = users.filter((u) => (u.group_ids || []).includes(g.id)).length;
      const roleCount = (g.role_ids || []).length;
      const initial = String(g.name || "G")
        .trim()
        .charAt(0)
        .toUpperCase();
      const col = palette[idx % palette.length];
      const desc = escapeHtml(String(g.description || "").trim()) || "—";
      html += `<div class="nc-admin-group-row" data-group-id="${g.id}">`;
      html += `<div class="nc-admin-group-ic" style="background:${col}" aria-hidden="true">${escapeHtml(initial)}</div>`;
      html += `<div><div class="nc-admin-group-main-title">${escapeHtml(g.name)}</div>`;
      html += `<div class="nc-admin-group-main-sub">${desc}</div></div>`;
      html += `<div class="nc-admin-group-stat">${memberCount} member${memberCount === 1 ? "" : "s"}</div>`;
      html += `<div class="nc-admin-group-stat2">${roleCount} role${roleCount === 1 ? "" : "s"}</div>`;
      html += `<div><span class="nc-admin-group-pilltag">Active</span></div>`;
      html += `<button type="button" class="nc-admin-group-kebab js-group-menu-btn" aria-haspopup="menu" aria-expanded="false" title="Group actions">⋮</button>`;
      html += `</div>`;
    });
    html += `</div>`;
    el.innerHTML = html;

    el.querySelectorAll(".js-group-menu-btn").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const row = btn.closest(".nc-admin-group-row");
        const gid = row && row.dataset ? Number(row.dataset.groupId) : 0;
        if (!gid) return;
        openGroupRowMenu(gid, btn);
        btn.setAttribute("aria-expanded", "true");
      });
    });
  }

  const ACCESS_MATRIX_SECTIONS = [
    {
      title: "Documents",
      items: [
        ["files.list", "List files"],
        ["files.read", "Read files"],
        ["files.create_folders", "Creating folders"],
        ["files.write", "Upload / edit files"],
        ["files.move", "Move files"],
        ["files.delete", "Delete files"],
        ["files.share", "Share files"],
        ["files.versions", "File versions"],
        ["files.admin", "Documents admin"],
      ],
    },
    {
      title: "Blogs",
      items: [
        ["blogs.write", "Create / edit blog posts"],
        ["blogs.delete", "Delete blog posts"],
      ],
    },
    {
      title: "Events",
      items: [
        ["events.write", "Create / edit events"],
        ["events.delete", "Delete events"],
      ],
    },
    {
      title: "Wiki",
      items: [
        ["wiki.read", "Read wiki"],
        ["wiki.write", "Create / edit wiki pages"],
        ["wiki.delete", "Delete wiki pages"],
        ["wiki.feedback", "Wiki helpful votes"],
      ],
    },
    {
      title: "Security clearance",
      items: [
        ["security.read", "View security clearances"],
        ["security.write", "Create / edit security clearance entries"],
        ["security.delete", "Delete security clearance entries"],
      ],
    },
    {
            items: [
      ],
    },
    {
      title: "Workforce",
      items: [
        ["workforce.read", "View Workforce entries"],
        ["workforce.create", "Create / edit Workforce entries"],
        ["workforce.delete", "Delete Workforce entries"],
      ],
    },
    {
      title: "Users",
      items: [
        ["users.create", "Create users"],
        ["users.edit", "Edit user profile"],
        ["users.delete", "Delete users"],
        ["users.password", "Change user password"],
        ["users.role", "Change user role"],
        ["users.reset_mfa", "Reset MFA authenticator"],
        ["users.mfa", "Enable / disable MFA"],
        ["users.registrations", "Approve / reject registrations"],
        ["users.registration_notifications", "Change registration email notification settings"],
      ],
    },
    {
      title: "Administration",
      items: [["admin.all", "Full admin access"]],
    },
    {
      title: "Audit",
      items: [["audit.read", "View audit log"]],
    },
  ];

  function permissionCatalogTotal() {
    return Array.isArray(permissions) ? permissions.length : 0;
  }

  function permissionByNameMap() {
    return new Map((permissions || []).map((p) => [String(p.name), p]));
  }

  function countMatrixGrants(role) {
    const permIds = new Set((role && role.permission_ids) || []);
    const byPermName = permissionByNameMap();
    let n = 0;
    for (const g of ACCESS_MATRIX_SECTIONS) {
      for (const [permName] of g.items) {
        const p = byPermName.get(permName);
        if (p && permIds.has(p.id)) n++;
      }
    }
    return n;
  }

  function renderPermissionMatrix(role) {
    const byPermName = permissionByNameMap();
    const permIds = new Set((role && role.permission_ids) || []);
    const roleLc = String((role && role.name) || "").toLowerCase();
    const isAdminRoleCard = roleLc === "admin";
    const isAdmin = role && roleLc === "admin";
    const rid = role ? Number(role.id) : null;
    const disabled = !rid || isAdmin;
    const adminAllLocked = !isAdminRoleCard;

    let html = "";
    for (const g of ACCESS_MATRIX_SECTIONS) {
      html += `<div class="nc-ac-group">
          <div class="nc-ac-group-title">${escapeHtml(g.title)}</div>`;
      for (const [permName, label] of g.items) {
        const p = byPermName.get(permName);
        if (!p) {
          html += `<div class="nc-ac-item nc-ac-item-missing">
            <span>
              <div class="nc-ac-item-title">${escapeHtml(label)}</div>
              <div class="nc-ac-item-sub">${escapeHtml(permName)} — missing from database. Restart the app to sync permissions.</div>
            </span>
          </div>`;
          continue;
        }
        const on = permIds.has(p.id);
        const forbidAdminAll = permName === "admin.all" && adminAllLocked;
        const cbDis = disabled || forbidAdminAll ? "disabled" : "";
        const effectiveOn = forbidAdminAll ? false : on;
        html += `<label class="nc-ac-item">
            <input type="checkbox" class="ac-perm" data-perm="${p.id}" ${effectiveOn ? "checked" : ""} ${cbDis}>
            <span>
              <div class="nc-ac-item-title">${escapeHtml(label)}</div>
              <div class="nc-ac-item-sub">${escapeHtml(permName)}</div>
            </span>
          </label>`;
      }
      html += `</div>`;
    }
    return html;
  }

  /** Groups whose names mirror builtin roles — companion row hidden (use Standard / Power / Admin rows). */
  function isReservedBuiltinMirrorGroup(grp) {
    if (!grp) return false;
    const n = String(grp.name || "").trim().toLowerCase();
    if (n === "standard users" || n === "standard user") return true;
    if (n === "power users" || n === "power user") return true;
    if (
      n === "admins" ||
      n === "admin" ||
      n === "administrator" ||
      n === "administrators"
    ) {
      return true;
    }
    return false;
  }

  function buildAccessControlEntries() {
    const out = [];
    const rStd = roleByKey("standard");
    const rPow = roleByKey("power");
    const rAdm = roleByKey("admin");
    const groupRows = Array.isArray(groups) ? groups : [];

    if (rStd) {
      out.push({
        role: rStd,
        badge: "Standard",
        title: "Standard User",
        subtitle: "Baseline access for accounts set to Standard User.",
        accent: "is-standard",
        icBg: "#10b981",
      });
    }
    if (rPow) {
      out.push({
        role: rPow,
        badge: "Power",
        title: "Power User",
        subtitle: "Baseline access for accounts set to Power User.",
        accent: "is-power",
        icBg: "#6366f1",
      });
    }
    if (rAdm) {
      out.push({
        role: rAdm,
        badge: "Admin",
        title: "Administrator",
        subtitle:
          "Full portal administration via admin.all. Checkbox editing for this role is disabled here for safety.",
        accent: "is-admin",
        icBg: "#dc2626",
      });
    }

    const companions = [];
    for (const r of roles || []) {
      const gid = groupIdFromCompanionRoleName(r.name);
      if (gid == null) continue;
      const grp = groupRows.find((x) => Number(x.id) === Number(gid));
      if (isReservedBuiltinMirrorGroup(grp)) continue;
      const title = grp ? `Group: ${grp.name}` : `Group #${gid}`;
      const subtitle =
        grp && String(grp.description || "").trim()
          ? String(grp.description).trim().slice(0, 140)
          : "Extra permissions for everyone in this group (in addition to their user role).";
      companions.push({
        role: r,
        badge: "Group",
        title,
        subtitle,
        accent: "is-group",
        icBg: null,
      });
    }
    companions.sort((a, b) => String(a.title).localeCompare(String(b.title)));
    const palette = ["#0ea5e9", "#a855f7", "#f97316", "#14b8a6", "#eab308", "#ec4899"];
    companions.forEach((c, idx) => {
      c.icBg = palette[idx % palette.length];
      out.push(c);
    });
    return out;
  }

  function openRoleAccessModal(entry) {
    const backdrop = document.getElementById("role-ac-backdrop");
    const titleEl = document.getElementById("role-ac-title");
    const subEl = document.getElementById("role-ac-sub");
    const inner = document.getElementById("role-ac-inner");
    const saveBtn = document.getElementById("role-ac-save");
    if (!backdrop || !inner || !entry || !entry.role) return;

    roleAcModalCtx.roleId = Number(entry.role.id);
    const roleLc = String(entry.role.name || "").toLowerCase();
    roleAcModalCtx.readOnly = roleLc === "admin";

    if (titleEl) titleEl.textContent = entry.title || "Edit permissions";
    if (subEl) subEl.textContent = entry.subtitle || "";

    inner.innerHTML = `<div class="nc-ac-card ${entry.accent || ""} nc-ac-card--embedded"><div class="nc-ac-modal-matrix">${renderPermissionMatrix(entry.role)}</div></div>`;

    if (saveBtn) saveBtn.disabled = !!roleAcModalCtx.readOnly;

    backdrop.hidden = false;
    try {
      document.body.style.overflow = "hidden";
    } catch (e) {}
  }

  function closeRoleAccessModal() {
    const backdrop = document.getElementById("role-ac-backdrop");
    if (backdrop) backdrop.hidden = true;
    try {
      document.body.style.overflow = "";
    } catch (e) {}
    roleAcModalCtx.roleId = null;
    roleAcModalCtx.readOnly = false;
  }

  function wireRoleAccessModalOnce() {
    if (roleAcModalWired) return;
    roleAcModalWired = true;

    const backdrop = document.getElementById("role-ac-backdrop");
    const btnX = document.getElementById("role-ac-close");
    const btnCancel = document.getElementById("role-ac-cancel");
    const btnSave = document.getElementById("role-ac-save");

    const onClose = () => closeRoleAccessModal();

    if (btnX) btnX.addEventListener("click", onClose);
    if (btnCancel) btnCancel.addEventListener("click", onClose);

    if (backdrop) {
      backdrop.addEventListener("click", (ev) => {
        if (ev.target === backdrop) onClose();
      });
    }

    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      const bd = document.getElementById("role-ac-backdrop");
      if (bd && !bd.hidden) onClose();
    });

    if (btnSave) {
      btnSave.addEventListener("click", async () => {
        const rid = roleAcModalCtx.roleId;
        if (!rid || roleAcModalCtx.readOnly) return;
        const inner = document.getElementById("role-ac-inner");
        if (!inner) return;
        const permission_ids = [...inner.querySelectorAll(".ac-perm:checked")].map((c) =>
          Number(c.getAttribute("data-perm"))
        );
        const r = await api(`/api/roles/${rid}/permissions`, {
          method: "PUT",
          body: JSON.stringify({ permission_ids }),
        });
        const j = await r.json().catch(() => ({}));
        setStatus("admin-roles-status", r.ok ? "Access control saved." : j.error || "Failed");
        if (r.ok) {
          closeRoleAccessModal();
          await loadAll();
        }
      });
    }
  }

  function renderRolesMatrix() {
    wireRoleAccessModalOnce();

    const listEl = document.getElementById("roles-ac-list");
    if (!listEl) return;

    const entries = buildAccessControlEntries();
    const q = String(rolesAccessSearchQ || "")
      .trim()
      .toLowerCase();
    const filtered = !q
      ? entries
      : entries.filter((e) => {
          const blob = `${e.title || ""} ${e.subtitle || ""} ${e.badge || ""}`.toLowerCase();
          return blob.includes(q);
        });

    const countEl = document.getElementById("roles-ac-count");
    if (countEl) countEl.textContent = `${filtered.length} role${filtered.length === 1 ? "" : "s"}`;

    const totalPerms = permissionCatalogTotal();

    if (!filtered.length) {
      listEl.innerHTML = q
        ? `<div class="nc-detail-muted" style="padding:1rem;">No roles match your search.</div>`
        : `<div class="nc-detail-muted" style="padding:1rem;">No roles to configure.</div>`;
      return;
    }

    let html = `<div class="nc-admin-groups-table">`;
    filtered.forEach((e) => {
      const grants = countMatrixGrants(e.role);
      const initial = String(e.title || "R")
        .replace(/^Group:\s*/i, "")
        .trim()
        .charAt(0)
        .toUpperCase();
      const col = e.icBg || "#64748b";
      const desc = escapeHtml(String(e.subtitle || "").trim()) || "—";
      html += `<div class="nc-admin-group-row nc-ac-role-row" data-role-id="${e.role.id}">`;
      html += `<div class="nc-admin-group-ic" style="background:${col}" aria-hidden="true">${escapeHtml(initial)}</div>`;
      html += `<div><div class="nc-admin-group-main-title">${escapeHtml(e.title)}</div>`;
      html += `<div class="nc-admin-group-main-sub">${desc}</div></div>`;
      html += `<div class="nc-admin-group-stat">${grants} / ${totalPerms}</div>`;
      html += `<div class="nc-admin-group-stat2">permissions</div>`;
      html += `<div class="nc-ac-role-meta-badge"><span class="nc-admin-group-pilltag">${escapeHtml(e.badge)}</span></div>`;
      html += `<button type="button" class="nc-btn nc-btn-secondary nc-ac-role-edit">Edit permissions</button>`;
      html += `</div>`;
    });
    html += `</div>`;
    listEl.innerHTML = html;

    listEl.querySelectorAll(".nc-ac-role-edit").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const row = btn.closest(".nc-admin-group-row");
        const rid = row && row.dataset ? Number(row.dataset.roleId) : 0;
        const entry = entries.find((x) => Number(x.role.id) === rid);
        if (entry) openRoleAccessModal(entry);
      });
    });
  }


  document.querySelectorAll(".nc-admin-nav-item").forEach((tab) => {
    tab.addEventListener("click", () => {
      const name = tab.dataset.tab;
      setActiveTab(name, { persist: true });
    });
  });

  adminMobileNav?.addEventListener("change", () => {
    setActiveTab(adminMobileNav.value, { persist: true });
  });

  rebuildAdminMobileNav();

  let backupWired = false;
  function wireBackupRestoreOnce() {
    if (backupWired) return;
    backupWired = true;
    const st = document.getElementById("admin-backup-status");
    const set = (msg) => {
      if (st) st.textContent = msg || "";
    };

    const btnDl = document.getElementById("admin-backup-download");
    const file = document.getElementById("admin-backup-file");
    const btnRestore = document.getElementById("admin-backup-restore");

    if (btnDl) {
      btnDl.addEventListener("click", () => {
        const themeSel = document.querySelector('input[name="portal-theme"]:checked');
        const variant =
          themeSel && themeSel.value === "non_core_team" ? "extranet" : "intranet";
        set("Preparing backup…");
        window.location.href = u(
          `/api/backup/download?variant=${encodeURIComponent(variant)}`
        );
        set("Downloading…");
      });
    }

    if (btnRestore) {
      btnRestore.addEventListener("click", async () => {
        const f = file && file.files && file.files[0] ? file.files[0] : null;
        if (!f) return set("Choose a zip file first.");
        btnRestore.disabled = true;
        set("Restoring… this may take a minute.");
        try {
          const fd = new FormData();
          fd.append("file", f, f.name || "backup.zip");
          const r = await fetch(u("/api/backup/restore"), { method: "POST", credentials: "same-origin", body: fd });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || "Restore failed");
          set("Restore completed. Reloading…");
          window.location.reload();
        } catch (e) {
          set(String(e && e.message ? e.message : e) || "Restore failed");
        } finally {
          btnRestore.disabled = false;
        }
      });
    }

    const FACTORY_RESET_PHRASE = "FACTORY RESET";
    const btnFactory = document.getElementById("admin-factory-reset");
    const factoryConfirm = document.getElementById("admin-factory-reset-confirm");
    const btnDemo = document.getElementById("admin-demo-data-add");
    const demoProgress = document.getElementById("admin-demo-data-progress");

    async function loadDemoDataStatus() {
      if (!demoProgress && !btnDemo) return;
      try {
        const r = await fetch(u("/api/backup/demo-data"), {
          method: "GET",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return;
        const pct = typeof j.overall_percent === "number" ? j.overall_percent : 0;
        if (demoProgress) {
          demoProgress.textContent = j.complete
            ? `Overall fill: ${pct}% (complete).`
            : `Overall fill: ${pct}%. Click again to add ~20% more in each section.`;
        }
        if (btnDemo) btnDemo.disabled = !!j.complete;
      } catch (_) {}
    }

    if (btnDemo) {
      btnDemo.addEventListener("click", async () => {
        btnDemo.disabled = true;
        set("Adding demo data…");
        try {
          const r = await fetch(u("/api/backup/demo-data"), {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: "{}",
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || "Demo data failed");
          set(j.message || "Demo data added.");
          await loadDemoDataStatus();
        } catch (e) {
          set(String(e && e.message ? e.message : e) || "Demo data failed");
          btnDemo.disabled = false;
        }
      });
    }

    loadDemoDataStatus();

    if (btnFactory) {
      btnFactory.addEventListener("click", async () => {
        const phrase = (factoryConfirm && factoryConfirm.value ? factoryConfirm.value : "").trim();
        if (phrase !== FACTORY_RESET_PHRASE) {
          return set(`Type ${FACTORY_RESET_PHRASE} in the confirmation box to proceed.`);
        }
        if (
          !window.confirm(
            "This permanently deletes ALL portal data: users, documents, settings, uploads (including document files), and branding.\n\nThe portal will be restored to a fresh install with admin@example.com / admin.\n\nThis cannot be undone. Proceed?"
          )
        ) {
          return;
        }
        btnFactory.disabled = true;
        set("Factory reset in progress… do not close this page.");
        try {
          const r = await fetch(u("/api/backup/factory-reset"), {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ confirm_phrase: phrase }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || "Factory reset failed");
          set(j.message || "Factory reset completed. Redirecting to sign in…");
          window.location.href = j.redirect || "/login";
        } catch (e) {
          set(String(e && e.message ? e.message : e) || "Factory reset failed");
          btnFactory.disabled = false;
        }
      });
    }
  }

  // Modules visibility (intranet menu control)
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


  document.addEventListener("click", (e) => {
    const t = e.target;
    if (!t) return;
    const chip = t.closest ? t.closest("button.nc-mod-chip[data-mod][data-id]") : null;
    if (chip) {
      const mod = chip.getAttribute("data-mod");
      const id = chip.getAttribute("data-id");
      if (!mod || !id) return;
      syncModulesUiToState();
      const st = ensureModulesState();
      const cur = st.modules[mod] || { allowed_user_ids: [], enabled: true, restricted: false };
      const arr = Array.isArray(cur.allowed_user_ids) ? cur.allowed_user_ids.map(String) : [];
      cur.allowed_user_ids = arr.filter((x) => String(x) !== String(id));
      st.modules[mod] = cur;
      renderModules();
      return;
    }

    const addBtn = t.closest ? t.closest("button.nc-mod-user-add[data-mod]") : null;
    if (addBtn) {
      const mod = addBtn.getAttribute("data-mod") || "";
      if (!mod) return;
      syncModulesUiToState();
      mergePendingModuleUserSelections();
      const st = ensureModulesState();
      const cur = st.modules[mod] || { allowed_user_ids: [], enabled: true, restricted: false };
      st.modules[mod] = cur;
      renderModules();
      setStatus("admin-modules-status", "");
      return;
    }

    const saveBtn = t.closest ? t.closest("#admin-modules-save") : null;
    if (saveBtn) {
      setStatus("admin-modules-status", "Saving…");
      saveBtn.disabled = true;
      saveModulesSettings()
        .catch((err) => setStatus("admin-modules-status", String(err && err.message ? err.message : err) || "Save failed"))
        .finally(() => (saveBtn.disabled = false));
    }
  });

  document.addEventListener("change", (e) => {
    const t = e.target;
    if (!t) return;
    if (t.classList && t.classList.contains("nc-mod-enabled")) {
      const mod = t.getAttribute("data-mod") || "";
      const restrict = document.querySelector(`.nc-mod-restrict[data-mod="${CSS.escape(mod)}"]`);
      const box = document.querySelector(`.nc-mod-restricted[data-mod="${CSS.escape(mod)}"]`);
      const card = document.querySelector(`.nc-mod-card[data-mod="${CSS.escape(mod)}"]`);
      if (restrict) restrict.disabled = !t.checked;
      if (!t.checked) {
        if (box) box.style.display = "none";
        if (card) card.classList.add("nc-mod-card--off");
      } else {
        if (card) card.classList.remove("nc-mod-card--off");
        if (restrict && box) box.style.display = restrict.checked ? "" : "none";
      }
      syncModulesUiToState();
      scheduleModulesAutoSave();
      return;
    }
    if (t.classList && t.classList.contains("nc-mod-restrict")) {
      const mod = t.getAttribute("data-mod") || "";
      const enabledEl = document.querySelector(`.nc-mod-enabled[data-mod="${CSS.escape(mod)}"]`);
      if (enabledEl && !enabledEl.checked) {
        t.checked = false;
        return;
      }
      const box = document.querySelector(`.nc-mod-restricted[data-mod="${CSS.escape(mod)}"]`);
      if (box) box.style.display = t.checked ? "" : "none";
      syncModulesUiToState();
      scheduleModulesAutoSave();
    }
  });

  // (Replaced Enter-to-add text input with an explicit user dropdown + Add button)

  // Security Training upload access
  let securityTrainingState = null; // {allowed_user_ids, page_intro_html, ...}
  let stIntroEditorWired = false;
  const ST_INTRO_EMOJIS = [
    "✅", "⚠️", "📎", "📷", "💡", "🔒", "📋", "🎓", "👍", "❗", "⭐", "📧",
  ];

  function looksLikeHtmlFragment(s) {
    return /<\s*\/?\s*(?:!--|[a-zA-Z])/.test(String(s || ""));
  }

  function applyStIntroEditor(htmlOrPlain) {
    const editor = document.getElementById("st-admin-intro-editor");
    if (!editor) return;
    const rawStr = String(htmlOrPlain || "").trim();
    if (!rawStr) {
      editor.innerHTML = "";
      return;
    }
    if (looksLikeHtmlFragment(rawStr)) {
      editor.innerHTML = rawStr;
    } else {
      const esc = escapeHtml(rawStr).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
      editor.innerHTML = esc.map((line) => `<p>${line || "<br>"}</p>`).join("");
    }
  }

  function runStIntroCmd(cmd, val) {
    const editor = document.getElementById("st-admin-intro-editor");
    if (!editor) return;
    try {
      editor.focus();
      if (cmd === "bold") document.execCommand("bold");
      else if (cmd === "italic") document.execCommand("italic");
      else if (cmd === "underline") document.execCommand("underline");
      else if (cmd === "strikeThrough") document.execCommand("strikeThrough");
      else if (cmd === "justifyLeft") document.execCommand("justifyLeft");
      else if (cmd === "justifyCenter") document.execCommand("justifyCenter");
      else if (cmd === "justifyRight") document.execCommand("justifyRight");
      else if (cmd === "justifyFull") document.execCommand("justifyFull");
      else if (cmd === "ul") document.execCommand("insertUnorderedList");
      else if (cmd === "ol") document.execCommand("insertOrderedList");
      else if (cmd === "h1") document.execCommand("formatBlock", false, "h1");
      else if (cmd === "h2") document.execCommand("formatBlock", false, "h2");
      else if (cmd === "h3") document.execCommand("formatBlock", false, "h3");
      else if (cmd === "p") document.execCommand("formatBlock", false, "p");
      else if (cmd === "blockquote") document.execCommand("formatBlock", false, "blockquote");
      else if (cmd === "hr") document.execCommand("insertHorizontalRule");
      else if (cmd === "removeFormat") document.execCommand("removeFormat");
      else if (cmd === "link") {
        const url = window.prompt("Link URL");
        if (url) document.execCommand("createLink", false, url);
      } else if (cmd === "img") {
        const url = window.prompt("Image URL (or paste an image into the editor)");
        if (url) document.execCommand("insertImage", false, url);
      } else if (cmd === "fontName" && val) document.execCommand("fontName", false, val);
      else if (cmd === "fontSize" && val) document.execCommand("fontSize", false, val);
    } catch (_) {
      /* ignore */
    }
  }

  async function uploadStIntroImage(file) {
    const fd = new FormData();
    fd.append("file", file, file.name || "image.png");
    const r = await fetch("/intranet/api/blogs/upload-image", { method: "POST", credentials: "same-origin", body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.url) throw new Error(j.error || "Upload failed");
    return String(j.url);
  }

  function wireSecurityTrainingIntroEditor() {
    if (stIntroEditorWired) return;
    const editor = document.getElementById("st-admin-intro-editor");
    const toolbar = document.getElementById("st-admin-intro-toolbar");
    if (!editor) return;
    stIntroEditorWired = true;

    const emojiBar = document.getElementById("st-admin-intro-emoji");
    if (emojiBar) {
      emojiBar.innerHTML = ST_INTRO_EMOJIS.map(
        (em) =>
          `<button type="button" class="nc-st-admin-emoji" data-emoji="${escapeHtml(em)}" title="Insert ${escapeHtml(em)}">${em}</button>`
      ).join("");
      emojiBar.querySelectorAll("[data-emoji]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const em = btn.getAttribute("data-emoji") || "";
          editor.focus();
          try {
            document.execCommand("insertText", false, em);
          } catch {
            editor.appendChild(document.createTextNode(em));
          }
        });
      });
    }

    if (toolbar) {
      toolbar.addEventListener("mousedown", (e) => {
        const b = e.target && e.target.closest ? e.target.closest("button[data-st-cmd]") : null;
        if (b) e.preventDefault();
      });
      toolbar.addEventListener("click", (e) => {
        const b = e.target && e.target.closest ? e.target.closest("button[data-st-cmd]") : null;
        if (!b) return;
        e.preventDefault();
        runStIntroCmd(b.getAttribute("data-st-cmd"));
      });
    }

    const fontSel = document.getElementById("st-admin-intro-font");
    const sizeSel = document.getElementById("st-admin-intro-size");
    if (fontSel) {
      fontSel.addEventListener("change", () => {
        const v = fontSel.value || "";
        if (v) runStIntroCmd("fontName", v);
        fontSel.selectedIndex = 0;
      });
    }
    if (sizeSel) {
      sizeSel.addEventListener("change", () => {
        const v = sizeSel.value || "";
        if (v) runStIntroCmd("fontSize", v);
        sizeSel.selectedIndex = 0;
      });
    }

    editor.addEventListener("paste", async (e) => {
      const dt = e.clipboardData;
      if (!dt || !dt.items) return;
      const items = Array.from(dt.items || []);
      const imgItem = items.find((it) => it && it.kind === "file" && String(it.type || "").startsWith("image/"));
      if (!imgItem) return;
      const file = imgItem.getAsFile ? imgItem.getAsFile() : null;
      if (!file) return;
      e.preventDefault();
      try {
        setStatus("admin-security-training-status", "Uploading image…");
        const url = await uploadStIntroImage(file);
        editor.focus();
        document.execCommand("insertImage", false, url);
        setStatus("admin-security-training-status", "");
      } catch (err) {
        setStatus("admin-security-training-status", String(err && err.message ? err.message : err) || "Image upload failed");
      }
    });

    document.getElementById("st-admin-intro-save")?.addEventListener("click", async () => {
      const btn = document.getElementById("st-admin-intro-save");
      const html = (editor.innerHTML || "").trim();
      if (btn) btn.disabled = true;
      setStatus("admin-security-training-status", "Saving introduction…");
      try {
        const r = await api("/api/settings/security-training", {
          method: "PUT",
          body: JSON.stringify({ page_intro_html: html }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || "Save failed");
        securityTrainingState = j;
        applyStIntroEditor(j.page_intro_html || "");
        setStatus("admin-security-training-status", "Introduction saved.");
      } catch (err) {
        setStatus("admin-security-training-status", String(err && err.message ? err.message : err) || "Save failed");
      } finally {
        if (btn) btn.disabled = false;
      }
    });

    document.getElementById("st-admin-intro-reset")?.addEventListener("click", () => {
      const plain =
        (securityTrainingState && securityTrainingState.default_page_intro_plain) ||
        "Training packs, PDFs, Office documents, presentations, and videos from the Security Training folder.";
      if (!window.confirm("Reset the introduction to the default text?")) return;
      applyStIntroEditor(plain);
      setStatus("admin-security-training-status", "Default text loaded — click Save introduction to apply.");
    });
  }

  function renderSecurityTrainingUsers() {
    const sel = document.getElementById("st-admin-user-sel");
    const chips = document.getElementById("st-admin-chips");
    if (!sel || !chips) return;
    const ids = Array.isArray(securityTrainingState && securityTrainingState.allowed_user_ids)
      ? securityTrainingState.allowed_user_ids.map(String)
      : [];
    const uById = new Map((users || []).map((u) => [String(u.id), u]));
    const allUsers = (users || [])
      .slice()
      .sort((a, b) =>
        String(a.full_name || a.username || a.email || "").localeCompare(String(b.full_name || b.username || b.email || ""), undefined, {
          sensitivity: "base",
        })
      );

    sel.innerHTML =
      `<option value="">Select a user…</option>` +
      allUsers
        .filter((u) => !ids.includes(String(u.id)))
        .slice(0, 800)
        .map((u) => {
          const name = u.full_name || u.username || u.email || `User ${u.id}`;
          const hint = u.email ? ` · ${u.email}` : u.username ? ` · ${u.username}` : "";
          return `<option value="${escapeHtml(String(u.id))}">${escapeHtml(name + hint)}</option>`;
        })
        .join("");

    const chipHtml = ids
      .map((id) => {
        const u = uById.get(String(id));
        const name = u ? (u.full_name || u.username || u.email || `User ${id}`) : `User ${id}`;
        const hint = u ? (u.email || u.username || "") : "";
        return `<button type="button" class="nc-chip st-admin-chip" data-id="${escapeHtml(String(id))}" title="Remove ${escapeHtml(
          hint
        )}">× ${escapeHtml(name)}</button>`;
      })
      .join("");
    chips.innerHTML = chipHtml || `<span class="nc-detail-muted">No users selected.</span>`;
  }

  async function loadSecurityTrainingSettings() {
    const r = await api("/api/settings/security-training", { method: "GET" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return setStatus("admin-security-training-status", j.error || "Failed to load security training settings");
    securityTrainingState = j;
    wireSecurityTrainingIntroEditor();
    const introRaw = j.page_intro_html || j.default_page_intro_plain || "";
    applyStIntroEditor(introRaw);
    renderSecurityTrainingUsers();
    setStatus("admin-security-training-status", "");
  }

  async function saveSecurityTrainingSettings() {
    const ids = Array.isArray(securityTrainingState && securityTrainingState.allowed_user_ids)
      ? securityTrainingState.allowed_user_ids.map((x) => Number(x))
      : [];
    const r = await api("/api/settings/security-training", { method: "PUT", body: JSON.stringify({ allowed_user_ids: ids }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Save failed");
    securityTrainingState = j;
    renderSecurityTrainingUsers();
    setStatus("admin-security-training-status", "Saved.");
  }

  document.addEventListener("click", (e) => {
    const t = e.target;
    if (!t) return;

    const rm = t.closest ? t.closest("button.st-admin-chip[data-id]") : null;
    if (rm) {
      const id = rm.getAttribute("data-id");
      if (!id) return;
      securityTrainingState = securityTrainingState || { allowed_user_ids: [] };
      const arr = Array.isArray(securityTrainingState.allowed_user_ids) ? securityTrainingState.allowed_user_ids.map(String) : [];
      securityTrainingState.allowed_user_ids = arr.filter((x) => String(x) !== String(id));
      renderSecurityTrainingUsers();
      setStatus("admin-security-training-status", "");
      return;
    }

    const add = t.closest ? t.closest("#st-admin-user-add") : null;
    if (add) {
      const sel = document.getElementById("st-admin-user-sel");
      const id = sel ? String(sel.value || "") : "";
      if (!id) return;
      securityTrainingState = securityTrainingState || { allowed_user_ids: [] };
      const arr = Array.isArray(securityTrainingState.allowed_user_ids) ? securityTrainingState.allowed_user_ids.map(String) : [];
      if (!arr.includes(String(id))) arr.push(String(id));
      securityTrainingState.allowed_user_ids = arr;
      renderSecurityTrainingUsers();
      setStatus("admin-security-training-status", "");
      return;
    }

    const saveBtn = t.closest ? t.closest("#st-admin-save") : null;
    if (saveBtn) {
      setStatus("admin-security-training-status", "Saving…");
      saveBtn.disabled = true;
      saveSecurityTrainingSettings()
        .catch((err) => setStatus("admin-security-training-status", String(err && err.message ? err.message : err) || "Save failed"))
        .finally(() => (saveBtn.disabled = false));
    }
  });

  function syncEncryptionPublicKeyUi() {
    const modeSel = document.getElementById("enc-mode");
    const card = document.getElementById("enc-public-key-card");
    const ta = document.getElementById("enc-public-key-pem");
    if (!card) return;
    const mode = modeSel ? String(modeSel.value || "off") : "off";
    const show = mode === "public_key";
    card.hidden = !show;
    if (ta && !show) {
      /* don’t wipe while switching away; user may return */
    }
  }

  async function loadEncryptionSettings() {
    const modeSel = document.getElementById("enc-mode");
    const lines = document.getElementById("enc-status-lines");
    const btnSave = document.getElementById("enc-save");
    const ta = document.getElementById("enc-public-key-pem");
    if (!modeSel || !lines) return;
    try {
      const r = await api("/api/settings/security-encryption", { method: "GET" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Failed to load");
      modeSel.value = j.mode || "off";
      const fp = j.public_key_fingerprint ? ` · Key fingerprint: ${j.public_key_fingerprint}` : "";
      const active =
        j.storage_encryption_active === true
          ? " · Blob encryption: active"
          : " · Blob encryption: not active (see note below key)";
      lines.textContent = `Mode: ${String(j.mode || "off")}${
        j.enabled_for_new_files ? " · Flag: encryption preference on" : " · Flag: off"
      }${fp}${active}`;
      if (ta) {
        if (j.public_key_pem && String(j.public_key_pem).trim()) ta.value = j.public_key_pem;
        else if (!String(ta.value || "").trim()) {
          ta.placeholder =
            j.has_public_key && j.public_key_fingerprint
              ? `(Public key on file — fingerprint ${j.public_key_fingerprint}. Paste to replace.)`
              : ta.placeholder;
        }
      }
      syncEncryptionPublicKeyUi();
      if (btnSave) btnSave.disabled = false;
      setStatus("admin-enc-status", "");
    } catch (e) {
      lines.textContent = "Could not load encryption settings.";
      setStatus("admin-enc-status", String(e && e.message ? e.message : e) || "Failed");
    }
  }

  document.addEventListener("click", (e) => {
    const t = e.target;
    const btn = t && t.closest ? t.closest("#enc-save") : null;
    if (!btn) return;
    const modeSel = document.getElementById("enc-mode");
    if (!modeSel) return;
    const mode = String(modeSel.value || "off");
    setStatus("admin-enc-status", "Saving…");
    btn.disabled = true;
    api("/api/settings/security-encryption", { method: "PUT", body: JSON.stringify({ mode }) })
      .then((r) => r.json().then((j) => ({ r, j })))
      .then(({ r, j }) => {
        if (!r.ok) throw new Error(j.error || "Save failed");
        setStatus("admin-enc-status", "Saved.");
        loadEncryptionSettings();
      })
      .catch((err) => setStatus("admin-enc-status", String(err && err.message ? err.message : err) || "Save failed"))
      .finally(() => (btn.disabled = false));
  });

  document.addEventListener("click", (e) => {
    const t = e.target;
    const saveKey = t && t.closest ? t.closest("#enc-save-key") : null;
    const clearKey = t && t.closest ? t.closest("#enc-clear-key") : null;
    const ta = document.getElementById("enc-public-key-pem");
    if (saveKey) {
      const pem = ta ? String(ta.value || "").trim() : "";
      if (!pem) {
        setStatus("admin-enc-status", "Paste a PEM public key first.");
        return;
      }
      setStatus("admin-enc-status", "Saving public key…");
      api("/api/settings/security-encryption", { method: "PUT", body: JSON.stringify({ mode: "public_key", public_key_pem: pem }) })
        .then((r) => r.json().then((j) => ({ r, j })))
        .then(({ r, j }) => {
          if (!r.ok) throw new Error(j.error || "Save failed");
          setStatus("admin-enc-status", "Public key saved.");
          const ms = document.getElementById("enc-mode");
          if (ms) ms.value = "public_key";
          loadEncryptionSettings();
        })
        .catch((err) => setStatus("admin-enc-status", String(err && err.message ? err.message : err) || "Save failed"));
      return;
    }
    if (clearKey) {
      setStatus("admin-enc-status", "Clearing…");
      api("/api/settings/security-encryption", { method: "PUT", body: JSON.stringify({ mode: "public_key", clear_public_key: true }) })
        .then((r) => r.json().then((j) => ({ r, j })))
        .then(({ r, j }) => {
          if (!r.ok) throw new Error(j.error || "Clear failed");
          if (ta) ta.value = "";
          setStatus("admin-enc-status", "Public key cleared.");
          loadEncryptionSettings();
        })
        .catch((err) => setStatus("admin-enc-status", String(err && err.message ? err.message : err) || "Clear failed"));
    }
  });

  document.addEventListener("change", (e) => {
    const modeSel = document.getElementById("enc-mode");
    if (e.target === modeSel) syncEncryptionPublicKeyUi();
  });

  function fmtDeployTs(iso) {
    if (!iso || typeof iso !== "string") return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }

  function shortSha(commit) {
    if (!commit || typeof commit !== "string") return "—";
    return commit.length <= 12 ? commit : commit.slice(0, 12);
  }

  function renderDeployList(items) {
    const root = document.getElementById("sw-deploy-list");
    if (!root) return;
    const rows = Array.isArray(items) ? items : [];
    if (!rows.length) {
      root.innerHTML = `<div class="nc-detail-muted">No deployments recorded yet.</div>`;
      return;
    }
    root.innerHTML = rows
      .slice(0, 20)
      .map((d) => {
        const at = fmtDeployTs(d.at);
        const act =
          d.action === "rollback"
            ? "Rollback"
            : d.action === "package_upgrade"
              ? "Package"
              : "Upgrade";
        const from = d.from_version || (d.from_commit ? shortSha(d.from_commit) : "—");
        const to = d.to_version || (d.to_commit ? shortSha(d.to_commit) : "—");
        return `<div class="nc-sw-deploy-item">
          <div class="nc-sw-deploy-item-top">
            <span class="nc-sw-deploy-pill">${escapeHtml(act)}</span>
            <span class="nc-detail-muted">${escapeHtml(at)}</span>
          </div>
          <div class="nc-sw-deploy-item-main"><b>${escapeHtml(from)}</b> → <b>${escapeHtml(to)}</b></div>
        </div>`;
      })
      .join("");
  }

  function changelogActionLabel(action) {
    const a = String(action || "").toLowerCase();
    if (a === "rollback") return "Rollback";
    if (a === "package_upgrade") return "Package upgrade";
    if (a === "recorded") return "Recorded";
    return "Upgrade";
  }

  function renderChangelog(cl) {
    const root = document.getElementById("sw-changelog-root");
    if (!root) return;
    const info = cl && typeof cl === "object" ? cl : { available: false, segments: [] };
    if (!info.available) {
      root.innerHTML = `<div class="nc-detail-muted">Change log uses Git between stored commits. This deploy path has no <code style="font-size:0.9em;">.git</code> directory, so per-version commit lists are not available.</div>`;
      return;
    }
    const segs = Array.isArray(info.segments) ? info.segments : [];
    if (!segs.length) {
      root.innerHTML = `<div class="nc-detail-muted">No deployment transitions with valid commit ids yet. After the next successful upgrade or rollback, summaries will appear here.</div>`;
      return;
    }
    root.innerHTML = segs
      .map((row) => {
        const at = fmtDeployTs(row.at);
        const act = changelogActionLabel(row.action);
        const fv = row.from_version || (row.from_commit ? shortSha(row.from_commit) : "—");
        const tv = row.to_version || (row.to_commit ? shortSha(row.to_commit) : "—");
        const title = `${escapeHtml(at)} <span class="nc-sw-changelog-meta">·</span> ${escapeHtml(act)} <span class="nc-sw-changelog-meta">·</span> ${escapeHtml(fv)} → ${escapeHtml(tv)}`;
        if (row.error) {
          return `<div class="nc-sw-changelog-block"><div class="nc-sw-changelog-block-title">${title}</div><p class="nc-detail-muted" style="margin:0;">${escapeHtml(row.error)}</p></div>`;
        }
        const commits = Array.isArray(row.commits) ? row.commits : [];
        if (!commits.length) {
          return `<div class="nc-sw-changelog-block"><div class="nc-sw-changelog-block-title">${title}</div><p class="nc-detail-muted" style="margin:0;">No commits in this range (already at target, or history not available in this clone).</p></div>`;
        }
        const more = row.truncated
          ? `<p class="nc-detail-muted" style="margin:0.5rem 0 0;">Showing the first ${commits.length} commits only.</p>`
          : "";
        const lis = commits.map((line) => `<li>${escapeHtml(line)}</li>`).join("");
        return `<div class="nc-sw-changelog-block"><div class="nc-sw-changelog-block-title">${title}</div><ul class="nc-sw-changelog-ul">${lis}</ul>${more}</div>`;
      })
      .join("");
  }

  async function loadSoftwareVersion() {
    const r = await api("/api/settings/software-version", { method: "GET" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return;
    const verEl = document.getElementById("sw-display-version");
    const dv = j.display_version || "—";
    if (verEl) verEl.textContent = dv;
    const urlEl = document.getElementById("sw-git-url");
    if (urlEl != null && (urlEl.dataset.dirty !== "1")) urlEl.value = j.git_url || "";
    const upBtn = document.getElementById("sw-upgrade");
    const rbBtn = document.getElementById("sw-rollback");
    const pkgBtn = document.getElementById("sw-package-upgrade");
    const upgradable = !!(j.upgrade_enabled && j.is_git_repo);
    const packageUpgradable = !!j.package_upgrade_enabled;

    const disHint = document.getElementById("sw-upgrade-disabled-hint");
    if (disHint) {
      let msg = "";
      if (!j.upgrade_enabled)
        msg = "Git upgrades are disabled (set ENABLE_SOFTWARE_GIT_UPGRADE=1 if this server should manage its own checkout).";
      disHint.style.display = msg ? "block" : "none";
      disHint.textContent = msg;
    }

    const pkgHint = document.getElementById("sw-package-disabled-hint");
    if (pkgHint) {
      const msg = !packageUpgradable
        ? "Package upload upgrades are disabled (set ENABLE_SOFTWARE_PACKAGE_UPGRADE=1 to allow)."
        : "";
      pkgHint.style.display = msg ? "block" : "none";
      pkgHint.textContent = msg;
    }

    const topHint = document.getElementById("sw-deploy-hints");
    const bits = [];
    if (!j.is_git_repo)
      bits.push("This path is not a Git clone — use Upgrade from package, or deploy a Git checkout for Git-based updates.");
    if (j.live_head && j.current_commit && j.live_head !== j.current_commit)
      bits.push("Live HEAD differs from recorded current commit — record may be stale until you upgrade again.");

    if (topHint) {
      topHint.textContent = bits.join(" ");
      topHint.style.display = bits.filter(Boolean).length ? "block" : "none";
    }

    if (upBtn) upBtn.disabled = !upgradable;
    if (rbBtn) rbBtn.disabled = !(upgradable && j.rollback_available);
    if (pkgBtn) pkgBtn.disabled = !packageUpgradable;

    const pel = document.getElementById("sw-prev-deployed");
    const cel = document.getElementById("sw-cur-deployed");
    const pc = document.getElementById("sw-prev-version");
    const cc = document.getElementById("sw-cur-version");
    if (pel) pel.textContent = fmtDeployTs(j.previous_deployed_at);
    if (cel) cel.textContent = fmtDeployTs(j.current_deployed_at);
    if (pc) pc.textContent = j.previous_version || (j.previous_commit ? shortSha(j.previous_commit) : "—");
    if (cc) cc.textContent = j.current_version || (j.current_commit ? shortSha(j.current_commit) : "—");

    renderDeployList(j.deployments || []);
    renderChangelog(j.changelog);

    setStatus("sw-upgrade-status", "");
    setStatus("sw-rollback-status", "");
    setStatus("sw-package-status", "");
  }

  const swUpgradeBtn = document.getElementById("sw-upgrade");
  if (swUpgradeBtn) {
    swUpgradeBtn.addEventListener("click", async () => {
      const urlEl = document.getElementById("sw-git-url");
      const git_url = urlEl ? (urlEl.value || "").trim() : "";
      if (!git_url) {
        setStatus("sw-upgrade-status", "Enter a Git repository URL.");
        return;
      }
      setStatus("sw-upgrade-status", "Updating code (preserving instance/ and .env)…");
      const r = await api("/api/settings/software-version/upgrade", {
        method: "POST",
        body: JSON.stringify({ git_url }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setStatus("sw-upgrade-status", j.error || "Upgrade failed.");
        await loadSoftwareVersion();
        return;
      }
      setStatus("sw-upgrade-status", j.message || "Upgrade complete.");
      if (urlEl) urlEl.dataset.dirty = "";
      await loadSoftwareVersion();
    });
  }

  const swGitSaveBtn = document.getElementById("sw-git-url-save");
  if (swGitSaveBtn) {
    swGitSaveBtn.addEventListener("click", async () => {
      const urlEl = document.getElementById("sw-git-url");
      const git_url = urlEl ? (urlEl.value || "").trim() : "";
      setStatus("sw-upgrade-status", "Saving…");
      const r = await api("/api/settings/software-version/git-url", {
        method: "PUT",
        body: JSON.stringify({ git_url }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setStatus("sw-upgrade-status", j.error || "Save failed.");
        return;
      }
      if (urlEl) urlEl.dataset.dirty = "";
      setStatus("sw-upgrade-status", "Saved.");
      await loadSoftwareVersion();
    });
  }

  const swPkgBtn = document.getElementById("sw-package-upgrade");
  if (swPkgBtn) {
    swPkgBtn.addEventListener("click", async () => {
      const fileEl = document.getElementById("sw-package-file");
      const f = fileEl && fileEl.files && fileEl.files[0] ? fileEl.files[0] : null;
      if (!f) {
        setStatus("sw-package-status", "Choose a release zip file first.");
        return;
      }
      if (
        !window.confirm(
          "Upload and apply this release package?\n\nThe server keeps instance/, .env, and .venv. Python dependencies are reinstalled from requirements.txt. A light backup of .env and the database is taken first.\n\nContinue?"
        )
      ) {
        return;
      }
      swPkgBtn.disabled = true;
      setStatus("sw-package-status", "Uploading and applying package… this may take several minutes.");
      try {
        const fd = new FormData();
        fd.append("file", f, f.name || "release.zip");
        const r = await fetch(u("/api/settings/software-version/package-upgrade"), {
          method: "POST",
          credentials: "same-origin",
          body: fd,
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          setStatus("sw-package-status", j.error || "Package upgrade failed.");
          return;
        }
        setStatus("sw-package-status", j.message || "Package upgrade complete.");
        if (fileEl) fileEl.value = "";
      } catch (e) {
        setStatus("sw-package-status", String(e && e.message ? e.message : e) || "Package upgrade failed.");
      } finally {
        await loadSoftwareVersion();
      }
    });
  }

  const swRb = document.getElementById("sw-rollback");
  if (swRb) {
    swRb.addEventListener("click", async () => {
      if (
        !window.confirm(
          "Rollback runs git reset --hard to the recorded previous commit.\nRestart the application process afterward.\n\nContinue?"
        )
      )
        return;
      setStatus("sw-rollback-status", "Rolling back…");
      const r = await api("/api/settings/software-version/rollback", {
        method: "POST",
        body: JSON.stringify({}),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setStatus("sw-rollback-status", j.error || "Rollback failed.");
        await loadSoftwareVersion();
        return;
      }
      setStatus("sw-rollback-status", j.message || "Rollback complete.");
      await loadSoftwareVersion();
    });
  }

  const swUrl = document.getElementById("sw-git-url");
  if (swUrl) {
    swUrl.addEventListener("input", () => {
      swUrl.dataset.dirty = "1";
    });
  }

  async function loadRecycleSettings() {
    const r = await api("/api/settings/recycle", { method: "GET" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return;
    const inp = document.getElementById("recycle-retention-days");
    if (inp) inp.value = String(j.retention_days ?? 1);
  }

  // Flat Activity view (no iframe)
  let adminAuditPage = 1;
  let adminAuditPerPage = 10;
  let adminAuditLoadedActions = false;

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function normalizeIso(iso) {
    const s = String(iso || "");
    if (!s) return s;
    if (/[zZ]$/.test(s)) return s;
    if (/[+-]\d\d:\d\d$/.test(s)) return s;
    return s + "Z";
  }

  function fmtAuditTime(iso) {
    if (!iso) return "";
    try {
      return new Date(normalizeIso(iso)).toLocaleString();
    } catch {
      return String(iso);
    }
  }

  function fmtResource(row) {
    const t = row.resource_type || "";
    const id = row.resource_id || "";
    const path = row.details && row.details.path ? row.details.path : null;
    if (path) return `${esc(t)} <span class="nc-audit-muted">${esc(path)}</span>`;
    return `${esc(t)} ${esc(id)}`.trim();
  }

  function initialsFromUser(row) {
    const raw = String(row.username || "").trim();
    if (!raw) return "?";
    const base = raw.includes("@") ? raw.split("@")[0] : raw;
    const parts = base.split(/[.\s_+-]+/).filter(Boolean);
    const a = (parts[0] || base)[0] || "?";
    const b = parts.length > 1 ? (parts[parts.length - 1][0] || "") : (base[1] || "");
    return (a + b).toUpperCase();
  }

  function fmtUser(row) {
    const u = row.username || row.user_id || "";
    const ini = initialsFromUser(row);
    return `<div class="nc-audit-user">
      <div class="nc-audit-avatar">${esc(ini)}</div>
      <div class="nc-audit-username">${esc(u)}</div>
    </div>`;
  }

  function fmtAction(row) {
    const a = row.action || "";
    const d = row.details || {};
    const res = row.details && row.details.path ? String(row.details.path) : `${row.resource_type || ""} ${row.resource_id || ""}`.trim();
    const line = (title, meta) =>
      `<div class="nc-audit-action-title">${esc(title)}</div>` + (meta ? `<div class="nc-audit-action-meta">${esc(meta)}</div>` : "");
    const countMeta = d.count != null ? `${d.count} item(s)` : "";

    if (a === "files.open") return line(`Opened folder: ${res}`, countMeta);
    if (a === "files.list") return line(`Viewed folder listing: ${res}`, countMeta);
    if (a === "files.upload") return line(`Uploaded file: ${d.path || res}`, "");
    if (a === "files.download") return line(`Downloaded file: ${d.path || res}`, d.version != null ? `version v${d.version}` : "");
    if (a === "auth.login") return line("Signed in", row.success ? "" : "failed");
    if (a === "auth.logout") return line("Signed out", "");
    // Fallback
    let meta = "";
    try {
      const keys = Object.keys(d || {});
      if (keys.length) meta = JSON.stringify(d);
    } catch {}
    return line(`${a}: ${res}`.trim(), meta);
  }

  async function loadAdminActivity({ resetPage = false } = {}) {
    const tbody = document.getElementById("admin-audit-rows");
    const pageLabel = document.getElementById("admin-audit-page");
    const perPageSel = document.getElementById("admin-audit-perpage");
    if (!tbody || !pageLabel || !perPageSel) return;
    if (resetPage) adminAuditPage = 1;
    adminAuditPerPage = Number(perPageSel.value || 10) || 10;

    const params = new URLSearchParams({ page: String(adminAuditPage), per_page: String(adminAuditPerPage) });
    const qv = (document.getElementById("admin-audit-q")?.value || "").trim();
    const uv = (document.getElementById("admin-audit-user")?.value || "").trim();
    const av = document.getElementById("admin-audit-action")?.value || "";
    const sv = document.getElementById("admin-audit-sort")?.value || "newest";
    if (qv) params.set("q", qv);
    if (uv) params.set("user", uv);
    if (av) params.set("action", av);
    if (sv) params.set("sort", sv);

    const r = await fetch(`/audit/api?${params.toString()}`, { credentials: "same-origin" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      tbody.innerHTML = `<tr><td colspan="5">Forbidden or error</td></tr>`;
      setStatus("admin-audit-status", j.error || "Failed to load activity.");
      return;
    }

    const total = Number(j.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / adminAuditPerPage));
    pageLabel.textContent = `Page ${adminAuditPage} of ${totalPages} — ${total.toLocaleString()} rows`;

    tbody.innerHTML = (j.items || [])
      .map(
        (row) => `<tr>
          <td class="td-time">${esc(fmtAuditTime(row.timestamp))}</td>
          <td class="td-user">${fmtUser(row)}</td>
          <td class="td-action">${fmtAction(row)}</td>
          <td class="td-resource">${fmtResource(row)}</td>
          <td class="td-ip">${esc(row.ip_address || "")}</td>
        </tr>`
      )
      .join("");

    const prev = document.getElementById("admin-audit-prev");
    const next = document.getElementById("admin-audit-next");
    if (prev) prev.disabled = adminAuditPage <= 1;
    if (next) next.disabled = adminAuditPage >= totalPages;

    // Load action dropdown once (from current items)
    if (!adminAuditLoadedActions) {
      const sel = document.getElementById("admin-audit-action");
      if (sel) {
        const acts = new Set();
        (j.items || []).forEach((it) => acts.add(String(it.action || "")));
        const opts = [...acts].filter(Boolean).sort();
        // keep first option "All actions"
        opts.forEach((a) => {
          const o = document.createElement("option");
          o.value = a;
          o.textContent = a;
          sel.appendChild(o);
        });
        adminAuditLoadedActions = true;
      }
    }
    setStatus("admin-audit-status", "");
  }

  async function loadOnlyOfficeSettings() {
    const r = await api("/api/settings/onlyoffice", { method: "GET" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return;
    const urlEl = document.getElementById("oo-url");
    const jwtEl = document.getElementById("oo-jwt");
    const appUrlEl = document.getElementById("oo-app-url");
    const skipTlsEl = document.getElementById("oo-skip-tls");
    if (urlEl) urlEl.value = j.url || "";
    if (jwtEl) jwtEl.value = j.jwt_secret || "";
    if (appUrlEl) appUrlEl.value = j.app_url || "";
    if (skipTlsEl) skipTlsEl.checked = !!j.skip_tls_verify;
  }

    function updateDocumentEditorCards(provider) {
    const p = (provider || "onlyoffice").trim().toLowerCase();
    const ooCard = document.getElementById("integrations-onlyoffice-card");
    if (ooCard) ooCard.style.opacity = p === "onlyoffice" ? "1" : "0.72";
  }

  async function loadDocumentEditorSettings() {
    const r = await api("/api/settings/document-editor", { method: "GET" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return;
    const sel = document.getElementById("doc-editor-provider");
    if (sel) sel.value = j.provider || "onlyoffice";
    updateDocumentEditorCards(j.provider || "onlyoffice");
  }


  async function testOnlyOffice() {
    setStatus("admin-integrations-status", "Testing OnlyOffice connection…");
    const r = await api("/api/settings/onlyoffice/test", { method: "GET" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) {
      const hints = (j.hints || []).length ? `
${(j.hints || []).join(" ")}` : "";
      setStatus("admin-integrations-status", (j.error || "OnlyOffice test failed") + hints);
      return;
    }
    setStatus("admin-integrations-status", "OnlyOffice connected: healthcheck OK, editor API OK.");
  }

  const ooSave = document.getElementById("oo-save");
  if (ooSave) {
    ooSave.addEventListener("click", async () => {
      const url = (document.getElementById("oo-url").value || "").trim();
      const jwt_secret = (document.getElementById("oo-jwt").value || "").trim();
      const app_url = (document.getElementById("oo-app-url").value || "").trim();
      const skip_tls_verify = !!(document.getElementById("oo-skip-tls") && document.getElementById("oo-skip-tls").checked);
      const r = await api("/api/settings/onlyoffice", {
        method: "PUT",
        body: JSON.stringify({ url, jwt_secret, app_url, skip_tls_verify }),
      });
      const j = await r.json().catch(() => ({}));
      setStatus("admin-integrations-status", r.ok ? "Saved." : j.error || "Save failed");
      await loadOnlyOfficeSettings();
      if (r.ok) await testOnlyOffice();
    });
  }
  const ooTest = document.getElementById("oo-test");
  if (ooTest) ooTest.addEventListener("click", () => testOnlyOffice());

  const docEditorSave = document.getElementById("doc-editor-save");
  const docEditorProvider = document.getElementById("doc-editor-provider");
  if (docEditorProvider) {
    docEditorProvider.addEventListener("change", () => updateDocumentEditorCards(docEditorProvider.value));
  }
  if (docEditorSave) {
    docEditorSave.addEventListener("click", async () => {
      const provider = (document.getElementById("doc-editor-provider").value || "onlyoffice").trim();
      const r = await api("/api/settings/document-editor", {
        method: "PUT",
        body: JSON.stringify({ provider }),
      });
      const j = await r.json().catch(() => ({}));
      setStatus("admin-doc-editor-status", r.ok ? "Saved." : j.error || "Save failed");
      if (r.ok) {
        updateDocumentEditorCards(provider);
        await loadDocumentEditorSettings();
      }
    });
  }

  let emailProviderCatalog = {};

  function readEmailForm() {
    return {
      provider: document.getElementById("email-provider")?.value || "custom",
      enabled: !!(document.getElementById("email-enabled") && document.getElementById("email-enabled").checked),
      smtp_host: (document.getElementById("email-smtp-host")?.value || "").trim(),
      smtp_port: Number(document.getElementById("email-smtp-port")?.value || 587),
      use_tls: !!(document.getElementById("email-use-tls") && document.getElementById("email-use-tls").checked),
      use_ssl: !!(document.getElementById("email-use-ssl") && document.getElementById("email-use-ssl").checked),
      skip_tls_verify: !!(document.getElementById("email-skip-tls") && document.getElementById("email-skip-tls").checked),
      username: (document.getElementById("email-username")?.value || "").trim(),
      password: (document.getElementById("email-password")?.value || "").trim(),
      from_email: (document.getElementById("email-from")?.value || "").trim(),
      from_name: (document.getElementById("email-from-name")?.value || "").trim(),
      default_reply_to: (document.getElementById("email-reply-to")?.value || "").trim(),
    };
  }

  function renderEmailProviderHelp(providerId) {
    const box = document.getElementById("email-provider-help");
    if (!box) return;
    const preset = emailProviderCatalog[providerId];
    const help = preset?.help || [];
    if (!help.length) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    box.hidden = false;
    box.innerHTML = `<strong>${escapeHtml(preset.label || providerId)} setup</strong><ul>${help
      .map((line) => `<li>${escapeHtml(line)}</li>`)
      .join("")}</ul>`;
  }

  function applyEmailProviderPreset(providerId, { fillHostOnly } = { fillHostOnly: false }) {
    const preset = emailProviderCatalog[providerId];
    if (!preset || providerId === "custom") {
      renderEmailProviderHelp(providerId);
      return;
    }
    const hostEl = document.getElementById("email-smtp-host");
    const portEl = document.getElementById("email-smtp-port");
    const tlsEl = document.getElementById("email-use-tls");
    const sslEl = document.getElementById("email-use-ssl");
    if (!fillHostOnly) {
      if (hostEl) hostEl.value = preset.smtp_host || "";
      if (portEl) portEl.value = String(preset.smtp_port != null ? preset.smtp_port : 587);
      if (tlsEl) tlsEl.checked = preset.use_tls !== false;
      if (sslEl) sslEl.checked = !!preset.use_ssl;
      if (preset.use_ssl && tlsEl) tlsEl.checked = false;
    }
    renderEmailProviderHelp(providerId);
  }

  async function loadEmailSettings() {
    const r = await api("/api/settings/email", { method: "GET" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return;
    emailProviderCatalog = Object.fromEntries((j.providers || []).map((p) => [p.id, p]));
    const providerEl = document.getElementById("email-provider");
    const enabledEl = document.getElementById("email-enabled");
    const hostEl = document.getElementById("email-smtp-host");
    const portEl = document.getElementById("email-smtp-port");
    const userEl = document.getElementById("email-username");
    const pwEl = document.getElementById("email-password");
    const tlsEl = document.getElementById("email-use-tls");
    const sslEl = document.getElementById("email-use-ssl");
    const skipEl = document.getElementById("email-skip-tls");
    const fromEl = document.getElementById("email-from");
    const fromNameEl = document.getElementById("email-from-name");
    const replyEl = document.getElementById("email-reply-to");
    const testToEl = document.getElementById("email-test-to");
    if (providerEl) providerEl.value = j.provider || "custom";
    if (enabledEl) enabledEl.checked = !!j.enabled;
    if (hostEl) hostEl.value = j.smtp_host || "";
    if (portEl) portEl.value = j.smtp_port != null ? String(j.smtp_port) : "587";
    if (userEl) userEl.value = j.username || "";
    if (pwEl) {
      pwEl.value = "";
      pwEl.placeholder = j.password_set
        ? "Leave blank to keep saved password"
        : "Mailbox or app password";
    }
    if (tlsEl) tlsEl.checked = j.use_tls !== false;
    if (sslEl) sslEl.checked = !!j.use_ssl;
    if (skipEl) skipEl.checked = !!j.skip_tls_verify;
    if (fromEl) fromEl.value = j.from_email || "";
    if (fromNameEl) fromNameEl.value = j.from_name || "";
    if (replyEl) replyEl.value = j.default_reply_to || "";
    if (testToEl && !testToEl.value.trim() && j.from_email) testToEl.placeholder = j.from_email;
    renderEmailProviderHelp(j.provider || "custom");
  }

  async function testEmailSettings() {
    setStatus("admin-email-status", "Sending test email…");
    const to = (document.getElementById("email-test-to")?.value || "").trim();
    const r = await api("/api/settings/email/test", {
      method: "POST",
      body: JSON.stringify({ to: to || undefined }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) {
      setStatus("admin-email-status", j.error || "Test email failed.");
      return;
    }
    setStatus("admin-email-status", j.message || "Test email sent.");
  }

  const emailSave = document.getElementById("email-save");
  if (emailSave) {
    emailSave.addEventListener("click", async () => {
      const r = await api("/api/settings/email", {
        method: "PUT",
        body: JSON.stringify(readEmailForm()),
      });
      const j = await r.json().catch(() => ({}));
      setStatus("admin-email-status", r.ok ? "Saved." : j.error || "Save failed");
      if (r.ok) await loadEmailSettings();
    });
  }
  const emailTest = document.getElementById("email-test");
  if (emailTest) emailTest.addEventListener("click", () => testEmailSettings());

  const emailProvider = document.getElementById("email-provider");
  if (emailProvider) {
    emailProvider.addEventListener("change", () => {
      applyEmailProviderPreset(emailProvider.value || "custom");
    });
  }

  const emailUseSsl = document.getElementById("email-use-ssl");
  const emailUseTls = document.getElementById("email-use-tls");
  if (emailUseSsl && emailUseTls) {
    emailUseSsl.addEventListener("change", () => {
      if (emailUseSsl.checked) emailUseTls.checked = false;
    });
    emailUseTls.addEventListener("change", () => {
      if (emailUseTls.checked) emailUseSsl.checked = false;
    });
  }

  const emailFrom = document.getElementById("email-from");
  const emailUsername = document.getElementById("email-username");
  if (emailFrom && emailUsername) {
    emailFrom.addEventListener("blur", () => {
      const provider = document.getElementById("email-provider")?.value || "custom";
      if (provider === "office365" || provider === "gmail") {
        const from = emailFrom.value.trim();
        if (from && !emailUsername.value.trim()) emailUsername.value = from;
      }
    });
  }

  function readAuditSyslogForm() {
    return {
      enabled: !!document.getElementById("audit-syslog-enabled")?.checked,
      host: (document.getElementById("audit-syslog-host")?.value || "").trim(),
      port: Number(document.getElementById("audit-syslog-port")?.value || 514),
      protocol: document.getElementById("audit-syslog-protocol")?.value || "udp",
      facility: document.getElementById("audit-syslog-facility")?.value || "local0",
      app_name: (document.getElementById("audit-syslog-app")?.value || "").trim(),
      hostname: (document.getElementById("audit-syslog-hostname")?.value || "").trim(),
    };
  }

  async function loadAuditSyslogSettings() {
    const r = await api("/api/settings/audit-syslog", { method: "GET" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setStatus("admin-audit-syslog-status", j.error || "Could not load syslog settings.");
      return;
    }
    const en = document.getElementById("audit-syslog-enabled");
    const host = document.getElementById("audit-syslog-host");
    const port = document.getElementById("audit-syslog-port");
    const proto = document.getElementById("audit-syslog-protocol");
    const fac = document.getElementById("audit-syslog-facility");
    const app = document.getElementById("audit-syslog-app");
    const hn = document.getElementById("audit-syslog-hostname");
    if (en) en.checked = !!j.enabled;
    if (host) host.value = j.host || "";
    if (port) port.value = j.port != null ? String(j.port) : "514";
    if (proto) proto.value = j.protocol === "tcp" ? "tcp" : "udp";
    if (fac) fac.value = j.facility || "local0";
    if (app) app.value = j.app_name || "firmgate";
    if (hn) hn.value = j.hostname || "";
    setStatus("admin-audit-syslog-status", "");
  }

  const auditSyslogSave = document.getElementById("audit-syslog-save");
  if (auditSyslogSave) {
    auditSyslogSave.addEventListener("click", async () => {
      const r = await api("/api/settings/audit-syslog", {
        method: "PUT",
        body: JSON.stringify(readAuditSyslogForm()),
      });
      const j = await r.json().catch(() => ({}));
      setStatus("admin-audit-syslog-status", r.ok ? "Saved." : j.error || "Save failed");
      if (r.ok) await loadAuditSyslogSettings();
    });
  }
  const auditSyslogTest = document.getElementById("audit-syslog-test");
  if (auditSyslogTest) {
    auditSyslogTest.addEventListener("click", async () => {
      setStatus("admin-audit-syslog-status", "Sending test message…");
      const r = await api("/api/settings/audit-syslog/test", {
        method: "POST",
        body: JSON.stringify(readAuditSyslogForm()),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        setStatus("admin-audit-syslog-status", j.error || "Test failed.");
        return;
      }
      setStatus("admin-audit-syslog-status", j.message || "Test message sent.");
    });
  }
  const auditSyslogReplay = document.getElementById("audit-syslog-replay");
  if (auditSyslogReplay) {
    auditSyslogReplay.addEventListener("click", async () => {
      if (
        !confirm(
          "Forward all stored activity log entries to the configured syslog endpoint? This may take a while on large databases."
        )
      ) {
        return;
      }
      setStatus("admin-audit-syslog-status", "Forwarding stored activity…");
      auditSyslogReplay.disabled = true;
      try {
        const r = await api("/api/settings/audit-syslog/replay", {
          method: "POST",
          body: JSON.stringify({ max_rows: 50000 }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) {
          setStatus("admin-audit-syslog-status", j.error || "Forward failed.");
          return;
        }
        setStatus("admin-audit-syslog-status", j.message || `Forwarded ${j.sent || 0} event(s).`);
      } finally {
        auditSyslogReplay.disabled = false;
      }
    });
  }

  // Activity (flat) events
  const adminAuditApply = document.getElementById("admin-audit-apply");
  const adminAuditClear = document.getElementById("admin-audit-clear");
  const adminAuditPrev = document.getElementById("admin-audit-prev");
  const adminAuditNext = document.getElementById("admin-audit-next");
  const adminAuditGo = document.getElementById("admin-audit-go");
  const adminAuditJump = document.getElementById("admin-audit-jump");
  const adminAuditPerPageSel = document.getElementById("admin-audit-perpage");
  const adminAuditQ = document.getElementById("admin-audit-q");
  const adminAuditUser = document.getElementById("admin-audit-user");
  const adminAuditAction = document.getElementById("admin-audit-action");
  const adminAuditSort = document.getElementById("admin-audit-sort");

  function clearAdminAuditActionOptions() {
    if (!adminAuditAction) return;
    // Keep first option "All actions"
    while (adminAuditAction.options.length > 1) adminAuditAction.remove(1);
    adminAuditLoadedActions = false;
  }

  adminAuditApply?.addEventListener("click", () => loadAdminActivity({ resetPage: true }));
  adminAuditClear?.addEventListener("click", () => {
    if (adminAuditQ) adminAuditQ.value = "";
    if (adminAuditUser) adminAuditUser.value = "";
    if (adminAuditSort) adminAuditSort.value = "newest";
    if (adminAuditPerPageSel) adminAuditPerPageSel.value = "10";
    if (adminAuditJump) adminAuditJump.value = "";
    if (adminAuditAction) adminAuditAction.value = "";
    clearAdminAuditActionOptions();
    loadAdminActivity({ resetPage: true });
  });
  adminAuditPrev?.addEventListener("click", () => {
    adminAuditPage = Math.max(1, adminAuditPage - 1);
    loadAdminActivity();
  });
  adminAuditNext?.addEventListener("click", () => {
    adminAuditPage = adminAuditPage + 1;
    loadAdminActivity();
  });
  adminAuditGo?.addEventListener("click", () => {
    const v = Number(adminAuditJump?.value || 0);
    if (Number.isFinite(v) && v >= 1) {
      adminAuditPage = Math.floor(v);
      loadAdminActivity();
    }
  });
  adminAuditPerPageSel?.addEventListener("change", () => loadAdminActivity({ resetPage: true }));

  const adminAuditEnterToApply = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      loadAdminActivity({ resetPage: true });
    }
  };
  adminAuditQ?.addEventListener("keydown", adminAuditEnterToApply);
  adminAuditUser?.addEventListener("keydown", adminAuditEnterToApply);
  adminAuditJump?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      adminAuditGo?.click();
    }
  });
  adminAuditAction?.addEventListener("change", () => loadAdminActivity({ resetPage: true }));
  adminAuditSort?.addEventListener("change", () => loadAdminActivity({ resetPage: true }));

  async function loadPortalSettings() {
    const r = await api("/api/settings/portal", { method: "GET" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setStatus("admin-portal-status", j.error || "Failed to load portal settings.");
      return;
    }
    const enabled = document.getElementById("portal-logo-enabled");
    const footer = document.getElementById("portal-footer-text");
    const tabTitle = document.getElementById("portal-browser-tab-title");
    const preview = document.getElementById("portal-logo-preview");
    const img = document.getElementById("portal-logo-img");
    if (enabled) enabled.checked = !!j.logo_enabled;
    if (footer) footer.value = j.footer_text || "";
    if (tabTitle) tabTitle.value = j.browser_tab_title || "";
    const theme = j.theme === "non_core_team" ? "non_core_team" : "core_team";
    const rIntranet = document.getElementById("portal-theme-intranet");
    const rExtranet = document.getElementById("portal-theme-extranet");
    if (rIntranet && rExtranet) {
      if (theme === "non_core_team") rExtranet.checked = true;
      else rIntranet.checked = true;
    }
    if (preview && img) {
      if (j.logo_url) {
        img.src = j.logo_url + (j.logo_is_default ? "" : "?t=" + Date.now());
        img.alt = j.logo_is_default ? "Default Firmgate logo" : "Uploaded logo";
        preview.hidden = false;
      } else {
        preview.hidden = true;
      }
    }
  }

  let scAgentOptions = [];

  function renderScAgentList() {
    const root = document.getElementById("sc-agent-list");
    if (!root) return;
    const items = Array.isArray(scAgentOptions) ? scAgentOptions : [];
    if (!items.length) {
      root.innerHTML = `<div class="nc-detail-muted">No names configured yet.</div>`;
      return;
    }
    root.innerHTML = items
      .map(
        (n, idx) => `<div class="nc-share-chip" style="display:inline-flex;align-items:center;gap:0.45rem;margin:0 0.45rem 0.45rem 0;">
          <span>${escapeHtml(String(n || ""))}</span>
          <button type="button" class="nc-btn nc-btn-secondary" data-sc-agent-del="${idx}" style="padding:0.15rem 0.45rem;border-radius:10px;">×</button>
        </div>`
      )
      .join("");

    root.querySelectorAll("[data-sc-agent-del]").forEach((b) => {
      b.addEventListener("click", () => {
        const i = Number(b.getAttribute("data-sc-agent-del"));
        if (!Number.isFinite(i)) return;
        scAgentOptions = scAgentOptions.filter((_, j) => j !== i);
        renderScAgentList();
      });
    });
  }

  let scRestorePayload = null;

  function updateScRecordCount(n) {
    const el = document.getElementById("sc-records-count");
    if (!el) return;
    const num = Number(n);
    if (!Number.isFinite(num)) {
      el.textContent = "Record count unknown.";
      return;
    }
    el.textContent =
      num === 1 ? "1 clearance record stored on the server." : `${num} clearance records stored on the server.`;
  }

  async function fetchScRecordsExport() {
    const r = await fetch("/intranet/api/security-clearance/records/export", {
      method: "GET",
      credentials: "same-origin",
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Export failed (${r.status})`);
    return j;
  }

  async function loadSecurityClearanceSettings() {
    const r = await api("/api/settings/security-clearance", { method: "GET" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setStatus("admin-security-clearance-status", j.error || "Failed to load.");
      return;
    }
    scAgentOptions = Array.isArray(j.agent_request_from_options) ? j.agent_request_from_options : [];
    updateScRecordCount(j.record_count);
    renderScAgentList();
    setStatus("admin-security-clearance-status", "");
  }

  const scRecordsExport = document.getElementById("sc-records-export");
  if (scRecordsExport) {
    scRecordsExport.addEventListener("click", async () => {
      setStatus("admin-security-clearance-status", "Preparing export…");
      try {
        const j = await fetchScRecordsExport();
        const blob = new Blob([JSON.stringify(j, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const stamp = (j.exported_at || new Date().toISOString()).slice(0, 10);
        a.href = url;
        a.download = `security-clearances-backup-${stamp}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setStatus(
          "admin-security-clearance-status",
          `Exported ${j.record_count || 0} record(s) to JSON.`
        );
      } catch (e) {
        setStatus("admin-security-clearance-status", e.message || "Export failed.");
      }
    });
  }

  const scRestoreFile = document.getElementById("sc-records-restore-file");
  if (scRestoreFile) {
    scRestoreFile.addEventListener("change", async () => {
      const file = scRestoreFile.files && scRestoreFile.files[0] ? scRestoreFile.files[0] : null;
      scRestoreFile.value = "";
      scRestorePayload = null;
      if (!file) return;
      try {
        const text = await file.text();
        const j = JSON.parse(text);
        const records = Array.isArray(j.records) ? j.records : Array.isArray(j) ? j : null;
        if (!records || !records.length) {
          setStatus("admin-security-clearance-status", "Backup file has no records array.");
          return;
        }
        scRestorePayload = {
          records,
          agent_request_from_options: Array.isArray(j.agent_request_from_options)
            ? j.agent_request_from_options
            : undefined,
          record_count: records.length,
        };
        setStatus(
          "admin-security-clearance-status",
          `Loaded ${records.length} record(s) from ${file.name}. Click Restore from file.`
        );
      } catch (e) {
        setStatus("admin-security-clearance-status", e.message || "Could not read backup file.");
      }
    });
  }

  const scRestoreBtn = document.getElementById("sc-records-restore");
  if (scRestoreBtn) {
    scRestoreBtn.addEventListener("click", async () => {
      if (!scRestorePayload || !scRestorePayload.records.length) {
        setStatus("admin-security-clearance-status", "Choose a JSON backup file first.");
        return;
      }
      const mode =
        document.getElementById("sc-restore-replace")?.checked ? "replace" : "merge";
      const n = scRestorePayload.records.length;
      const msg =
        mode === "replace"
          ? `Replace ALL clearance records on the server with ${n} record(s) from the backup?`
          : `Merge ${n} record(s) from the backup into existing records (matched by CSID)?`;
      if (!window.confirm(msg)) return;
      setStatus("admin-security-clearance-status", "Restoring…");
      try {
        const body = { mode, records: scRestorePayload.records };
        if (mode === "replace" && scRestorePayload.agent_request_from_options) {
          body.agent_request_from_options = scRestorePayload.agent_request_from_options;
        }
        const r = await fetch("/intranet/api/security-clearance/records/restore", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          setStatus("admin-security-clearance-status", j.error || `Restore failed (${r.status})`);
          return;
        }
        const total = j.total || (j.records && j.records.length) || n;
        if (mode === "merge") {
          setStatus(
            "admin-security-clearance-status",
            `Restored (merge): ${j.added || 0} added, ${j.updated || 0} updated — ${total} total on server.`
          );
        } else {
          setStatus(
            "admin-security-clearance-status",
            `Restored (replace): ${total} record(s) on server. Refresh Security Clearances page.`
          );
        }
        updateScRecordCount(total);
        scRestorePayload = null;
      } catch (e) {
        setStatus("admin-security-clearance-status", e.message || "Restore failed.");
      }
    });
  }

  async function uploadPortalLogoFile(file) {
    if (!file) {
      setStatus("admin-portal-status", "Choose a logo file first.");
      return;
    }
    const fd = new FormData();
    fd.append("logo", file);
    setStatus("admin-portal-status", "Uploading logo…");
    const r = await fetch(u("/api/settings/portal/logo"), { method: "POST", credentials: "same-origin", body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setStatus("admin-portal-status", j.error || `Upload failed (${r.status}).`);
      return;
    }
    setStatus("admin-portal-status", "Logo uploaded.");
    await loadPortalSettings();
    setTimeout(() => window.location.reload(), 250);
  }

  const portalSave = document.getElementById("portal-save");
  if (portalSave) {
    portalSave.addEventListener("click", async () => {
      const logo_enabled = !!document.getElementById("portal-logo-enabled")?.checked;
      const footer_text = (document.getElementById("portal-footer-text")?.value || "").trim();
      const browser_tab_title = (document.getElementById("portal-browser-tab-title")?.value || "").trim();
      const themeSel = document.querySelector('input[name="portal-theme"]:checked');
      const theme = themeSel && themeSel.value === "non_core_team" ? "non_core_team" : "core_team";
      const r = await api("/api/settings/portal", {
        method: "PUT",
        body: JSON.stringify({ logo_enabled, footer_text, browser_tab_title, theme }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setStatus("admin-portal-status", j.error || `Save failed (${r.status}).`);
        return;
      }
      const tabTitle = document.getElementById("portal-browser-tab-title");
      if (tabTitle && typeof j.browser_tab_title === "string") {
        tabTitle.value = j.browser_tab_title;
      }
      setStatus(
        "admin-portal-status",
        browser_tab_title ? `Saved. Browser tab title: ${browser_tab_title}` : "Saved."
      );
      if (r.ok) setTimeout(() => window.location.reload(), 250);
    });
  }

  async function loadTimesheetSettings() {
    const r = await api("/api/settings/timesheets", { method: "GET" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setStatus("admin-timesheets-status", j.error || "Failed to load timesheet settings.");
      return;
    }
    const c1 = document.getElementById("timesheet-company-1");
    const c2 = document.getElementById("timesheet-company-2");
    const c3 = document.getElementById("timesheet-company-3");
    const preview = document.getElementById("timesheet-logo-preview");
    const img = document.getElementById("timesheet-logo-img");
    const dropzone = document.getElementById("timesheet-logo-dropzone");
    if (c1) c1.value = j.company_line_1 || "";
    if (c2) c2.value = j.company_line_2 || "";
    if (c3) c3.value = j.company_line_3 || "";
    if (preview && img) {
      if (j.logo_url) {
        img.src = j.logo_url + "?t=" + Date.now();
        img.alt = "Timesheet company logo";
        preview.hidden = false;
        if (dropzone) dropzone.classList.add("has-logo");
      } else {
        preview.hidden = true;
        if (dropzone) dropzone.classList.remove("has-logo");
      }
    }
    setStatus("admin-timesheets-status", "");
    await loadTimesheetNotificationSettings();
    await loadTimesheetCollectionGroups();
  }

  let tsColGroupUsers = [];
  let tsColGroups = [];

  function setTsColGroupsStatus(msg) {
    const el = document.getElementById("ts-col-groups-status");
    if (el) el.textContent = msg || "";
  }

  function renderTsColGroups() {
    const list = document.getElementById("ts-col-groups-list");
    if (!list) return;
    if (!tsColGroups.length) {
      list.innerHTML =
        '<p class="nc-detail-muted" style="margin:0;">No project groups yet. Add one to organize Timesheet Collection.</p>';
      return;
    }
    list.innerHTML = tsColGroups
      .map((g, idx) => {
        const memberSet = new Set((g.user_ids || []).map(Number));
        const checks = tsColGroupUsers.length
          ? tsColGroupUsers
              .map((u) => {
                const checked = memberSet.has(Number(u.id)) ? " checked" : "";
                return `<label class="nc-ts-col-group-user"><input type="checkbox" data-group-idx="${idx}" data-user-id="${u.id}"${checked}> ${escapeHtml(u.label)}</label>`;
              })
              .join("")
          : '<span class="nc-detail-muted">No active users.</span>';
        return `<div class="nc-ts-col-group-card" data-group-idx="${idx}">
          <div class="nc-share-add-row" style="align-items:center;justify-content:space-between;gap:0.5rem;margin-bottom:0.45rem;">
            <span class="nc-detail-label" style="margin:0;">Project name</span>
            <button type="button" class="nc-btn nc-btn-secondary nc-btn-sm js-ts-col-group-remove" data-group-idx="${idx}">Delete group</button>
          </div>
          <input type="text" class="nc-detail-input js-ts-col-group-name" data-group-idx="${idx}" value="${escapeHtml(g.name || "")}" maxlength="120" placeholder="Project name" style="margin-bottom:0.55rem;">
          <div class="nc-detail-label" style="margin-bottom:0.35rem;">Members</div>
          <div class="nc-ts-col-group-users">${checks}</div>
        </div>`;
      })
      .join("");
  }

  function collectTsColGroupsFromDom() {
    return tsColGroups.map((g, idx) => {
      const nameEl = document.querySelector(`.js-ts-col-group-name[data-group-idx="${idx}"]`);
      const name = ((nameEl && nameEl.value) || g.name || "").trim();
      const userIds = [];
      document
        .querySelectorAll(`input[type=checkbox][data-group-idx="${idx}"][data-user-id]:checked`)
        .forEach((cb) => {
          userIds.push(Number(cb.dataset.userId));
        });
      return { id: g.id || "", name, user_ids: userIds };
    });
  }

  async function loadTimesheetCollectionGroups() {
    const list = document.getElementById("ts-col-groups-list");
    if (!list) return;
    const r = await api("/api/settings/timesheets/collection-groups", { method: "GET" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setTsColGroupsStatus(j.error || "Failed to load project groups.");
      return;
    }
    tsColGroups = (j.groups || []).map((g) => ({
      id: g.id || "",
      name: g.name || "",
      user_ids: (g.user_ids || []).map(Number),
    }));
    tsColGroupUsers = j.users || [];
    renderTsColGroups();
    setTsColGroupsStatus("");
  }

  function setTimesheetNotifyStatus(msg) {
    const el = document.getElementById("ts-notify-status");
    if (el) el.textContent = msg || "";
  }

  function syncTimesheetNotifyScheduleUi(mode) {
    const onceWrap = document.getElementById("ts-notify-once-wrap");
    const intervalWrap = document.getElementById("ts-notify-interval-wrap");
    const isOnce = mode !== "interval";
    if (onceWrap) onceWrap.hidden = !isOnce;
    if (intervalWrap) intervalWrap.hidden = isOnce;
  }

  function ensureTimesheetNotifySelects() {
    const dayEl = document.getElementById("ts-notify-once-day");
    if (dayEl && !dayEl.options.length) {
      for (let d = 1; d <= 28; d += 1) {
        const opt = document.createElement("option");
        opt.value = String(d);
        opt.textContent = String(d);
        dayEl.appendChild(opt);
      }
    }
    const hourEl = document.getElementById("ts-notify-send-hour");
    if (hourEl && !hourEl.options.length) {
      for (let h = 0; h <= 23; h += 1) {
        const opt = document.createElement("option");
        const label = `${String(h).padStart(2, "0")}:00`;
        opt.value = String(h);
        opt.textContent = label;
        hourEl.appendChild(opt);
      }
    }
  }

  async function loadTimesheetNotificationSettings() {
    ensureTimesheetNotifySelects();
    const r = await api("/api/settings/timesheets/notifications", { method: "GET" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setTimesheetNotifyStatus(j.error || "Failed to load notification settings.");
      return;
    }
    const enabledEl = document.getElementById("ts-notify-enabled");
    const onceEl = document.getElementById("ts-notify-schedule-once");
    const intervalEl = document.getElementById("ts-notify-schedule-interval");
    const dayEl = document.getElementById("ts-notify-once-day");
    const intervalDaysEl = document.getElementById("ts-notify-interval-days");
    const hourEl = document.getElementById("ts-notify-send-hour");
    const subjectEl = document.getElementById("ts-notify-subject");
    const bodyEl = document.getElementById("ts-notify-body");
    const placeholdersEl = document.getElementById("ts-notify-placeholders");
    const lastRunEl = document.getElementById("ts-notify-last-run");
    if (enabledEl) enabledEl.checked = !!j.enabled;
    const mode = j.schedule_mode === "interval" ? "interval" : "once";
    if (onceEl) onceEl.checked = mode === "once";
    if (intervalEl) intervalEl.checked = mode === "interval";
    syncTimesheetNotifyScheduleUi(mode);
    if (dayEl) dayEl.value = String(j.once_day_of_month != null ? j.once_day_of_month : 25);
    if (intervalDaysEl) intervalDaysEl.value = String(j.interval_days != null ? j.interval_days : 7);
    if (hourEl) hourEl.value = String(j.send_hour_local != null ? j.send_hour_local : 9);
    if (subjectEl) subjectEl.value = j.subject || j.defaults?.subject || "";
    if (bodyEl) bodyEl.value = j.body || j.defaults?.body || "";
    if (placeholdersEl && Array.isArray(j.placeholders)) {
      placeholdersEl.textContent = `Placeholders: ${j.placeholders.join(", ")}`;
    }
    if (lastRunEl) {
      const summary = j.last_run_summary && typeof j.last_run_summary === "object" ? j.last_run_summary : null;
      if (summary && summary.at) {
        const sent = summary.sent != null ? summary.sent : 0;
        const failed = summary.failed != null ? summary.failed : 0;
        const pending = summary.pending != null ? summary.pending : "—";
        lastRunEl.textContent = `Last run ${summary.at}: sent ${sent}, failed ${failed}, pending ${pending}.`;
        lastRunEl.hidden = false;
      } else if (j.last_run_at) {
        lastRunEl.textContent = `Last run: ${j.last_run_at}`;
        lastRunEl.hidden = false;
      } else {
        lastRunEl.hidden = true;
        lastRunEl.textContent = "";
      }
    }
    setTimesheetNotifyStatus("");
  }

  function collectTimesheetNotificationPayload() {
    const mode =
      document.getElementById("ts-notify-schedule-interval")?.checked ? "interval" : "once";
    return {
      enabled: !!document.getElementById("ts-notify-enabled")?.checked,
      schedule_mode: mode,
      once_day_of_month: Number(document.getElementById("ts-notify-once-day")?.value || 25),
      interval_days: Number(document.getElementById("ts-notify-interval-days")?.value || 7),
      send_hour_local: Number(document.getElementById("ts-notify-send-hour")?.value || 9),
      subject: (document.getElementById("ts-notify-subject")?.value || "").trim(),
      body: (document.getElementById("ts-notify-body")?.value || "").trim(),
    };
  }

  ["ts-notify-schedule-once", "ts-notify-schedule-interval"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("change", () => {
      syncTimesheetNotifyScheduleUi(
        document.getElementById("ts-notify-schedule-interval")?.checked ? "interval" : "once"
      );
    });
  });

  const tsNotifySave = document.getElementById("ts-notify-save");
  if (tsNotifySave) {
    tsNotifySave.addEventListener("click", async () => {
      setTimesheetNotifyStatus("Saving…");
      const r = await api("/api/settings/timesheets/notifications", {
        method: "PUT",
        body: JSON.stringify(collectTimesheetNotificationPayload()),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setTimesheetNotifyStatus(j.error || "Save failed.");
        return;
      }
      setTimesheetNotifyStatus("Notification settings saved.");
      await loadTimesheetNotificationSettings();
    });
  }

  const tsNotifyTest = document.getElementById("ts-notify-test");
  if (tsNotifyTest) {
    tsNotifyTest.addEventListener("click", async () => {
      const to = (document.getElementById("ts-notify-test-to")?.value || "").trim();
      if (!to) {
        setTimesheetNotifyStatus("Enter a test recipient email.");
        return;
      }
      setTimesheetNotifyStatus("Sending test email…");
      const r = await api("/api/settings/timesheets/notifications/test", {
        method: "POST",
        body: JSON.stringify({ to }),
      });
      const j = await r.json().catch(() => ({}));
      setTimesheetNotifyStatus(r.ok ? j.message || "Test email sent." : j.error || "Test failed.");
    });
  }

  const tsNotifySendNow = document.getElementById("ts-notify-send-now");
  if (tsNotifySendNow) {
    tsNotifySendNow.addEventListener("click", async () => {
      setTimesheetNotifyStatus("Sending reminders…");
      const r = await api("/api/settings/timesheets/notifications/send-now", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const detail = Array.isArray(j.messages) && j.messages.length ? ` ${j.messages[0]}` : "";
        setTimesheetNotifyStatus((j.error || "Send failed.") + detail);
        return;
      }
      const sent = j.sent != null ? j.sent : 0;
      const failed = j.failed != null ? j.failed : 0;
      setTimesheetNotifyStatus(`Reminders sent: ${sent}. Failed: ${failed}.`);
      await loadTimesheetNotificationSettings();
    });
  }

  const tsColGroupsList = document.getElementById("ts-col-groups-list");
  if (tsColGroupsList) {
    tsColGroupsList.addEventListener("click", (e) => {
      const btn = e.target.closest(".js-ts-col-group-remove");
      if (!btn) return;
      const idx = Number(btn.dataset.groupIdx);
      if (!Number.isFinite(idx)) return;
      if (!window.confirm("Delete this project group?")) return;
      tsColGroups.splice(idx, 1);
      renderTsColGroups();
    });
  }

  const tsColGroupAdd = document.getElementById("ts-col-group-add");
  if (tsColGroupAdd) {
    tsColGroupAdd.addEventListener("click", () => {
      tsColGroups.push({ id: "", name: "", user_ids: [] });
      renderTsColGroups();
      const inputs = document.querySelectorAll(".js-ts-col-group-name");
      const last = inputs[inputs.length - 1];
      if (last) last.focus();
    });
  }

  const tsColGroupsSave = document.getElementById("ts-col-groups-save");
  if (tsColGroupsSave) {
    tsColGroupsSave.addEventListener("click", async () => {
      setTsColGroupsStatus("Saving…");
      const groups = collectTsColGroupsFromDom();
      const r = await api("/api/settings/timesheets/collection-groups", {
        method: "PUT",
        body: JSON.stringify({ groups }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setTsColGroupsStatus(j.error || "Save failed.");
        return;
      }
      tsColGroups = (j.groups || []).map((g) => ({
        id: g.id || "",
        name: g.name || "",
        user_ids: (g.user_ids || []).map(Number),
      }));
      tsColGroupUsers = j.users || tsColGroupUsers;
      renderTsColGroups();
      setTsColGroupsStatus("Project groups saved.");
    });
  }

  async function uploadTimesheetLogoFile(file) {
    if (!file) {
      setStatus("admin-timesheets-status", "Choose a logo file first.");
      return;
    }
    const fd = new FormData();
    fd.append("logo", file);
    setStatus("admin-timesheets-status", "Uploading logo…");
    const r = await fetch(u("/api/settings/timesheets/logo"), {
      method: "POST",
      credentials: "same-origin",
      body: fd,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setStatus("admin-timesheets-status", j.error || `Upload failed (${r.status}).`);
      return;
    }
    setStatus("admin-timesheets-status", "Logo uploaded.");
    await loadTimesheetSettings();
  }

  const timesheetSave = document.getElementById("timesheet-settings-save");
  if (timesheetSave) {
    timesheetSave.addEventListener("click", async () => {
      const body = {
        company_line_1: (document.getElementById("timesheet-company-1")?.value || "").trim(),
        company_line_2: (document.getElementById("timesheet-company-2")?.value || "").trim(),
        company_line_3: (document.getElementById("timesheet-company-3")?.value || "").trim(),
      };
      const r = await api("/api/settings/timesheets", {
        method: "PUT",
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      setStatus("admin-timesheets-status", r.ok ? "Saved." : j.error || "Save failed.");
      if (r.ok) await loadTimesheetSettings();
    });
  }

  const timesheetLogoFile = document.getElementById("timesheet-logo-file");
  if (timesheetLogoFile) {
    timesheetLogoFile.addEventListener("change", async () => {
      const file = timesheetLogoFile.files ? timesheetLogoFile.files[0] : null;
      if (!file) return;
      await uploadTimesheetLogoFile(file);
      timesheetLogoFile.value = "";
    });
  }

  const timesheetLogoUpload = document.getElementById("timesheet-logo-upload");
  if (timesheetLogoUpload) {
    timesheetLogoUpload.addEventListener("click", async () => {
      const fileEl = document.getElementById("timesheet-logo-file");
      const file = fileEl && fileEl.files ? fileEl.files[0] : null;
      await uploadTimesheetLogoFile(file);
    });
  }

  const timesheetLogoDropzone = document.getElementById("timesheet-logo-dropzone");
  if (timesheetLogoDropzone) {
    const highlight = (on) => timesheetLogoDropzone.classList.toggle("is-dragover", !!on);
    ["dragenter", "dragover"].forEach((ev) => {
      timesheetLogoDropzone.addEventListener(ev, (e) => {
        e.preventDefault();
        highlight(true);
      });
    });
    ["dragleave", "drop"].forEach((ev) => {
      timesheetLogoDropzone.addEventListener(ev, (e) => {
        e.preventDefault();
        highlight(false);
      });
    });
    timesheetLogoDropzone.addEventListener("drop", (e) => {
      const file = e.dataTransfer?.files?.[0];
      if (file) void uploadTimesheetLogoFile(file);
    });
  }

  const scAdd = document.getElementById("sc-agent-add");
  if (scAdd) {
    scAdd.addEventListener("click", () => {
      const inp = document.getElementById("sc-agent-new");
      const raw = inp ? String(inp.value || "") : "";
      const s = raw.trim();
      if (!s) return;
      const seen = new Set(scAgentOptions.map((x) => String(x || "").toLowerCase()));
      if (!seen.has(s.toLowerCase())) scAgentOptions = [...scAgentOptions, s];
      if (inp) inp.value = "";
      renderScAgentList();
    });
  }

  const scSave = document.getElementById("sc-agent-save");
  if (scSave) {
    scSave.addEventListener("click", async () => {
      const r = await api("/api/settings/security-clearance", {
        method: "PUT",
        body: JSON.stringify({ agent_request_from_options: scAgentOptions }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setStatus("admin-security-clearance-status", j.error || "Save failed.");
        return;
      }
      scAgentOptions = Array.isArray(j.agent_request_from_options) ? j.agent_request_from_options : scAgentOptions;
      renderScAgentList();
      setStatus("admin-security-clearance-status", "Saved.");
    });
  }

  const portalLogoFile = document.getElementById("portal-logo-file");
  if (portalLogoFile) {
    portalLogoFile.addEventListener("change", async () => {
      const file = portalLogoFile.files ? portalLogoFile.files[0] : null;
      if (!file) return;
      await uploadPortalLogoFile(file);
    });
  }

  const portalUpload = document.getElementById("portal-logo-upload");
  if (portalUpload) {
    portalUpload.addEventListener("click", async () => {
      const fileEl = document.getElementById("portal-logo-file");
      const file = fileEl && fileEl.files ? fileEl.files[0] : null;
      await uploadPortalLogoFile(file);
    });
  }

  const recycleSave = document.getElementById("recycle-save");
  if (recycleSave) {
    recycleSave.addEventListener("click", async () => {
      const inp = document.getElementById("recycle-retention-days");
      const days = inp ? Number(inp.value || "1") : 1;
      const r = await api("/api/settings/recycle", {
        method: "PUT",
        body: JSON.stringify({ retention_days: Number.isFinite(days) ? days : 1 }),
      });
      const j = await r.json().catch(() => ({}));
      setStatus("admin-recycle-status", r.ok ? "Saved." : j.error || "Save failed");
      await loadRecycleSettings();
    });
  }

  async function loadTimeSettings() {
    const r = await api("/api/settings/time", { method: "GET" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return;
    const tz = document.getElementById("time-zone");
    const ntpEnabled = document.getElementById("ntp-enabled");
    const ntpServer = document.getElementById("ntp-server");
    const manEnabled = document.getElementById("manual-enabled");
    const manDt = document.getElementById("manual-dt");
    if (tz) tz.value = j.timezone || "Australia/Melbourne";
    if (ntpEnabled) ntpEnabled.checked = !!j.ntp_enabled;
    if (ntpServer) ntpServer.value = j.ntp_server || "pool.ntp.org";
    if (manEnabled) manEnabled.checked = !!j.manual_enabled;
    if (manDt) {
      const off = Number(j.manual_offset_ms || 0);
      const t = Date.now() + off;
      const d = new Date(t);
      const pad = (n) => String(n).padStart(2, "0");
      manDt.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
  }

  const timeSave = document.getElementById("time-save");
  if (timeSave) {
    timeSave.addEventListener("click", async () => {
      const timezone = (document.getElementById("time-zone")?.value || "").trim() || "Australia/Melbourne";
      const ntp_enabled = !!document.getElementById("ntp-enabled")?.checked;
      const ntp_server = (document.getElementById("ntp-server")?.value || "").trim() || "pool.ntp.org";
      const r = await api("/api/settings/time", { method: "PUT", body: JSON.stringify({ timezone, ntp_enabled, ntp_server }) });
      const j = await r.json().catch(() => ({}));
      setStatus("admin-time-status", r.ok ? "Saved." : j.error || "Save failed");
      if (r.ok) setTimeout(() => window.location.reload(), 250);
    });
  }

  const manualSetNow = document.getElementById("manual-set-now");
  if (manualSetNow) {
    manualSetNow.addEventListener("click", () => {
      const el = document.getElementById("manual-dt");
      if (!el) return;
      const d = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const v = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      el.value = v;
    });
  }

  const manualSave = document.getElementById("manual-save");
  if (manualSave) {
    manualSave.addEventListener("click", async () => {
      const manual_enabled = !!document.getElementById("manual-enabled")?.checked;
      const manual_dt_local = (document.getElementById("manual-dt")?.value || "").trim();
      if (manual_enabled && !manual_dt_local) {
        setStatus("admin-time-status", "Pick a manual date/time first.");
        return;
      }
      const targetMs = manual_dt_local ? new Date(manual_dt_local).getTime() : Date.now();
      const manual_offset_ms = Math.round(targetMs - Date.now());
      const r = await api("/api/settings/time/manual", {
        method: "PUT",
        body: JSON.stringify({ manual_enabled, manual_offset_ms }),
      });
      const j = await r.json().catch(() => ({}));
      setStatus("admin-time-status", r.ok ? "Manual time saved." : j.error || "Save failed");
      if (r.ok) setTimeout(() => window.location.reload(), 250);
    });
  }

  const ntpTest = document.getElementById("ntp-test");
  if (ntpTest) {
    ntpTest.addEventListener("click", async () => {
      setStatus("admin-time-status", "Testing NTP…");
      const server = (document.getElementById("ntp-server")?.value || "").trim() || "pool.ntp.org";
      const r = await api(`/api/settings/time/ntp-test?server=${encodeURIComponent(server)}`, { method: "GET" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setStatus("admin-time-status", j.error || "NTP test failed");
        return;
      }
      setStatus("admin-time-status", `NTP OK. Offset: ${j.offset_ms} ms`);
    });
  }

  const btnUserAdd = document.getElementById("btn-user-add");
  if (btnUserAdd) {
    btnUserAdd.hidden = !CAN_CREATE_USERS;
    btnUserAdd.addEventListener("click", () => openNewUserModal());
  }

  const btnAdminSettings = document.getElementById("btn-admin-settings");
  if (btnAdminSettings) {
    btnAdminSettings.addEventListener("click", () => {
      setStatus("admin-users-status", "Settings coming soon.");
    });
  }

  // New user creation is handled via modal.

  document.getElementById("btn-group-create").addEventListener("click", async () => {
    const name = document.getElementById("new-group-name").value.trim();
    const description = document.getElementById("new-group-desc").value.trim() || null;
    if (!name) return;
    const r = await api("/api/groups", { method: "POST", body: JSON.stringify({ name, description }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setStatus("admin-groups-status", j.error || "Failed");
      return;
    }
    document.getElementById("new-group-name").value = "";
    document.getElementById("new-group-desc").value = "";
    setStatus("admin-groups-status", "Group created.");
    await loadAll();
  });

  const groupsSearchEl = document.getElementById("groups-search");
  if (groupsSearchEl) {
    groupsSearchEl.addEventListener("input", () => {
      groupsSearchQ = groupsSearchEl.value || "";
      renderGroups();
    });
  }

  const rolesAcSearchEl = document.getElementById("roles-ac-search");
  if (rolesAcSearchEl) {
    rolesAcSearchEl.addEventListener("input", () => {
      rolesAccessSearchQ = rolesAcSearchEl.value || "";
      renderRolesMatrix();
    });
  }

  document.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!(t instanceof Element)) return;
    if (t.closest("#admin-group-row-menu")) return;
    if (t.closest(".js-group-menu-btn")) return;
    closeGroupRowMenu();
    document.querySelectorAll(".js-group-menu-btn").forEach((b) => b.setAttribute("aria-expanded", "false"));
  });

  const groupFlyout = document.getElementById("admin-group-row-menu");
  if (groupFlyout) {
    groupFlyout.querySelectorAll("[data-gm-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const act = btn.getAttribute("data-gm-action");
        const gid = groupRowMenuForId;
        closeGroupRowMenu();
        if (!gid) return;
        const g = groupById(gid);
        if (!g) return;
        if (act === "manage") {
          openGroupManageModal(gid);
          return;
        }
        if (act === "rename") {
          const name = window.prompt("Group name", g.name || "");
          if (name === null) return;
          const nm = String(name).trim();
          if (!nm) return;
          const descRaw = window.prompt("Description (optional)", g.description || "");
          if (descRaw === null) return;
          const description = String(descRaw).trim() || null;
          const r = await api(`/api/groups/${gid}`, { method: "PATCH", body: JSON.stringify({ name: nm, description }) });
          const j = await r.json().catch(() => ({}));
          setStatus("admin-groups-status", r.ok ? "Group updated." : j.error || "Failed");
          await loadAll();
          return;
        }
        if (act === "delete") {
          if (!window.confirm("Delete this group? Users keep their direct roles.")) return;
          const r = await api(`/api/groups/${gid}`, { method: "DELETE" });
          setStatus("admin-groups-status", r.ok ? "Group deleted." : "Failed");
          await loadAll();
        }
      });
    });
  }

  const gmX = document.getElementById("group-manage-x");
  const gmClose = document.getElementById("group-manage-close");
  const gmSaveAll = document.getElementById("group-manage-save-all");
  const gmAdd = document.getElementById("gm-add-member");
  const gmPick = document.getElementById("gm-user-pick");
  if (gmX) gmX.addEventListener("click", () => closeGroupManageModal());
  if (gmClose) gmClose.addEventListener("click", () => closeGroupManageModal());
  if (gmSaveAll) gmSaveAll.addEventListener("click", () => void gmSaveAllFromModal());
  if (gmAdd) gmAdd.addEventListener("click", () => tryAddMemberFromPickInput());
  if (gmPick) {
    gmPick.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        tryAddMemberFromPickInput();
      }
    });
  }

  const gmBackdrop = document.getElementById("group-manage-modal");
  if (gmBackdrop) {
    gmBackdrop.addEventListener("click", (ev) => {
      if (ev.target === gmBackdrop) closeGroupManageModal();
    });
  }

  wireRegistrationsChrome();

  (async () => {
    await loadAll();
    const params = new URLSearchParams(window.location.search || "");
    const editUserId = Number(params.get("edit_user_id") || 0);
    const canOpenUserEditor =
      CAN_EDIT_USERS || CAN_USER_PASSWORD || CAN_USER_ROLE || CAN_USER_MFA || CAN_DELETE_USERS;
    if (editUserId && canOpenUserEditor) {
      setActiveTab("users", { persist: false });
      openEditUserModal(editUserId);
      return;
    }

    const urlTab = (params.get("tab") || "").trim();
    let savedTab = "";
    try {
      savedTab = (window.localStorage.getItem(TAB_STORAGE_KEY) || "").trim();
    } catch (e) {}
    const normalizeTab = (t) => t;
    const defaultTab = CAN_ACCESS_USERS ? "users" : CAN_APPROVE_REGISTRATIONS ? "registrations" : "users";
    setActiveTab(normalizeTab(urlTab || savedTab || defaultTab), { persist: false });
  })();
  loadOnlyOfficeSettings();
  loadDocumentEditorSettings();
  loadEmailSettings();
  loadTimeSettings();
  loadRecycleSettings();
  loadSoftwareVersion();

})();
