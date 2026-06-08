(function () {
  const root = document.querySelector(".nc-intranet-shell");
  const api = root && root.getAttribute("data-profile-api");
  if (!api) return;

  const backdrop = document.getElementById("intranet-profile-modal");
  const openBtn = document.getElementById("intranet-profile-open");
  const closeBtn = document.getElementById("intranet-profile-close");
  const saveBtn = document.getElementById("intranet-profile-save");
  const statusEl = document.getElementById("intranet-profile-status");
  const menu = document.getElementById("intranet-user-menu");
  const menuBtn = document.getElementById("intranet-user-btn");

  const elEmail = document.getElementById("intranet-profile-email");
  const elFullName = document.getElementById("intranet-profile-full-name");
  const elUsername = document.getElementById("intranet-profile-username");
  const elPhone = document.getElementById("intranet-profile-phone");
  const elPw = document.getElementById("intranet-profile-password");
  const elPw2 = document.getElementById("intranet-profile-password2");

  if (!backdrop || !openBtn || !elEmail || !elUsername) return;

  function setStatus(msg, isErr) {
    if (!statusEl) return;
    statusEl.textContent = msg || "";
    statusEl.classList.toggle("nc-status--error", Boolean(isErr && msg));
  }

  function closeMenu() {
    if (menu && menuBtn) {
      menu.hidden = true;
      menuBtn.setAttribute("aria-expanded", "false");
    }
  }

  function openModal() {
    backdrop.hidden = false;
    setStatus("");
  }

  function closeModal() {
    backdrop.hidden = true;
    setStatus("");
  }

  async function loadProfile() {
    setStatus("");
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
    if (elPw) elPw.value = "";
    if (elPw2) elPw2.value = "";
    openModal();
  }

  openBtn.addEventListener("click", () => {
    closeMenu();
    loadProfile();
  });

  if (closeBtn) closeBtn.addEventListener("click", closeModal);

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeModal();
  });

  document.addEventListener(
    "keydown",
    (e) => {
      if (backdrop.hidden || e.key !== "Escape") return;
      closeModal();
      e.stopPropagation();
    },
    false
  );

  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
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

      const body = { email, full_name, username, phone, password, password2 };
      const r = await fetch(api, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
      const av = document.querySelector(".nc-intranet-user-avatar");
      if (av && u.username) {
        const t = String(u.username).trim();
        av.textContent = t ? t.slice(0, 2).toUpperCase() : av.textContent;
      }
    });
  }
})();
