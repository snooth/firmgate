(function () {
  const closeEl = document.querySelector(".nc-onlyoffice-close");
  if (!closeEl) return;

  async function syncBack() {
    if (closeEl.dataset.canSync !== "1") return true;
    const url = (closeEl.dataset.syncUrl || "").trim();
    const token = (closeEl.dataset.syncToken || "").trim();
    if (!url || !token) return true;
    try {
      const r = await fetch(url, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) {
        window.alert(j.error || "Could not save changes back to the intranet.");
        return false;
      }
    } catch (e) {
      window.alert(String(e && e.message ? e.message : e) || "Could not save changes.");
      return false;
    }
    return true;
  }

  closeEl.addEventListener("click", async (e) => {
    e.preventDefault();
    closeEl.setAttribute("aria-busy", "true");
    const ok = await syncBack();
    closeEl.removeAttribute("aria-busy");
    if (ok) window.location.href = closeEl.getAttribute("href") || "/";
  });
})();
