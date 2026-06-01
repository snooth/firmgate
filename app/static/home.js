(function () {
  const raw = document.getElementById("nc-home-announcements-data");
  const viewer = document.getElementById("nc-home-ann-viewer");
  const btnClose = document.getElementById("nc-home-ann-viewer-close");
  const elTitle = document.getElementById("nc-home-ann-viewer-title");
  const elCat = document.getElementById("nc-home-ann-viewer-cat");
  const elH = document.getElementById("nc-home-ann-viewer-h");
  const elContent = document.getElementById("nc-home-ann-viewer-content");
  if (!raw || !viewer) return;

  let announcements = [];
  try {
    announcements = JSON.parse(raw.textContent || "[]") || [];
  } catch {
    announcements = [];
  }

  function openAnnouncement(idx) {
    const a = announcements[idx];
    if (!a || !a.is_snippet || !a.body_html_full) return;
    const title = String(a.title || "Announcement").trim();
    const cat = String(a.category || "General").trim();
    if (elTitle) elTitle.textContent = title;
    if (elCat) elCat.textContent = cat;
    if (elH) elH.textContent = title;
    if (elContent) elContent.innerHTML = String(a.body_html_full || "");
    viewer.hidden = false;
    document.body.style.overflow = "hidden";
    try {
      btnClose && btnClose.focus();
    } catch (_) {}
  }

  function closeViewer() {
    viewer.hidden = true;
    document.body.style.overflow = "";
    if (elContent) elContent.innerHTML = "";
  }

  document.querySelectorAll(".nc-intranet-ann--expandable").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target && e.target.closest && e.target.closest("a")) return;
      const idx = Number(el.getAttribute("data-ann-idx"));
      if (!Number.isFinite(idx)) return;
      openAnnouncement(idx);
    });
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      const idx = Number(el.getAttribute("data-ann-idx"));
      if (!Number.isFinite(idx)) return;
      openAnnouncement(idx);
    });
  });

  if (btnClose) btnClose.addEventListener("click", closeViewer);
  viewer.addEventListener("click", (e) => {
    if (e.target === viewer) closeViewer();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !viewer.hidden) closeViewer();
  });
})();
