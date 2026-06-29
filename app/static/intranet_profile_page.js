(function () {
  const PHOTO_STORAGE_KEY = "dir.employeePhotos.v1";

  function loadPhotoStore() {
    try {
      const raw = window.localStorage.getItem(PHOTO_STORAGE_KEY);
      const j = raw ? JSON.parse(raw) : {};
      return j && typeof j === "object" ? j : {};
    } catch (_) {
      return {};
    }
  }

  function getPhotoFor(id, store) {
    const k = String(id || "");
    const v = store && typeof store === "object" ? String(store[k] || "") : "";
    return v && v.startsWith("data:image/") ? v : "";
  }

  function applyAvatarPhoto(el, id) {
    if (!el) return;
    const dataUrl = getPhotoFor(id, loadPhotoStore());
    if (dataUrl) {
      el.classList.add("has-photo");
      el.style.backgroundImage = `url("${dataUrl}")`;
      el.textContent = "";
    }
  }

  const cfg = window.__NC_PROFILE_PAGE__ || {};
  const userId = cfg.userId;
  const av = document.getElementById("nc-profile-hero-avatar");
  if (av && userId != null) applyAvatarPhoto(av, userId);

  const api = (cfg.api || "").trim();
  if (!api) return;

  const form = document.getElementById("nc-profile-form");
  const statusEl = document.getElementById("nc-profile-status");
  const elEmail = document.getElementById("nc-profile-email");
  const elFullName = document.getElementById("nc-profile-full-name");
  const elUsername = document.getElementById("nc-profile-username");
  const elPhone = document.getElementById("nc-profile-phone");
  const elPw = document.getElementById("nc-profile-password");
  const elPw2 = document.getElementById("nc-profile-password2");

  if (!form || !elEmail || !elUsername) return;

  function setStatus(msg, isErr) {
    if (!statusEl) return;
    statusEl.hidden = !msg;
    statusEl.textContent = msg || "";
    statusEl.classList.toggle("nc-status--error", Boolean(isErr && msg));
  }

  async function refreshFromServer() {
    const r = await fetch(api, { method: "GET", credentials: "same-origin" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      setStatus(data.error || "Could not load profile.", true);
      return;
    }
    const u = data.user || {};
    elEmail.value = u.email || "";
    elFullName.value = u.full_name || "";
    elUsername.value = u.username || "";
    elPhone.value = u.phone || "";
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    setStatus("");
    const email = (elEmail.value || "").trim();
    const full_name = (elFullName.value || "").trim();
    const username = (elUsername.value || "").trim();
    const phone = (elPhone.value || "").trim();
    const password = (elPw && elPw.value) || "";
    const password2 = (elPw2 && elPw2.value) || "";

    if (!email) {
      setStatus("Email address is required.", true);
      elEmail.focus();
      return;
    }
    if (!username) {
      setStatus("Username is required.", true);
      elUsername.focus();
      return;
    }

    const saveBtn = document.getElementById("nc-profile-save");
    if (saveBtn) saveBtn.disabled = true;
    try {
      const r = await fetch(api, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, full_name, username, phone, password, password2 }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setStatus(data.error || "Could not save profile.", true);
        const f = data.field;
        if (f === "email") elEmail.focus();
        else if (f === "username") elUsername.focus();
        else if (f === "password" && elPw) elPw.focus();
        return;
      }
      setStatus("Profile saved.");
      if (elPw) elPw.value = "";
      if (elPw2) elPw2.value = "";
      const u = data.user || {};
      if (u.email != null) elEmail.value = u.email;
      if (u.full_name != null) elFullName.value = u.full_name;
      if (u.username != null) elUsername.value = u.username;
      if (u.phone != null) elPhone.value = u.phone;

      const nameEl = document.querySelector(".nc-intranet-user-name");
      if (nameEl && (u.full_name != null || u.username != null)) {
        nameEl.textContent = (u.full_name || u.username || "").trim() || nameEl.textContent;
      }
      const subEl = document.querySelector(".nc-intranet-usermenu-sub");
      if (subEl && (u.email != null || u.username != null)) {
        subEl.textContent = (u.email || u.username || "").trim() || subEl.textContent;
      }
      const menuTitle = document.querySelector(".nc-intranet-usermenu-title");
      if (menuTitle && (u.full_name != null || u.username != null)) {
        menuTitle.textContent = (u.full_name || u.username || "").trim() || menuTitle.textContent;
      }
      const heroEmail = document.querySelector(".nc-profile-hero-email");
      if (heroEmail && u.email != null) heroEmail.textContent = u.email;
      const h1 = document.querySelector(".nc-profile-page h1");
      if (h1 && (u.full_name != null || u.username != null)) {
        const sub = h1.parentElement && h1.parentElement.querySelector(".nc-intranet-muted");
        if (sub) sub.textContent = (u.full_name || u.username || "").trim();
      }
      const topAv = document.querySelector(".nc-intranet-user-avatar");
      if (topAv && u.username) {
        const t = String(u.username).trim();
        topAv.textContent = t ? t.slice(0, 2).toUpperCase() : topAv.textContent;
      }
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  });

  refreshFromServer();
})();
