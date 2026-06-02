(function () {
  const TAG_SIZE_STORAGE_KEY = "workforce.tagSize.v1";
  const TAG_LAYOUT_STORAGE_KEY = "workforce.tagLayout.v1";
  const dirPage = document.querySelector(".nc-dir-page");

  function getTagSize() {
    try {
      return window.localStorage.getItem(TAG_SIZE_STORAGE_KEY) === "small" ? "small" : "large";
    } catch (_) {
      return "large";
    }
  }

  function applyTagSize(size) {
    const small = size === "small";
    if (dirPage) {
      dirPage.classList.toggle("nc-dir-tags--small", small);
      dirPage.classList.toggle("nc-dir-tags--large", !small);
    }
    document.querySelectorAll(".nc-dir-tag-size-btn[data-tag-size]").forEach((btn) => {
      const on = btn.getAttribute("data-tag-size") === size;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function setTagSize(size) {
    const next = size === "small" ? "small" : "large";
    try {
      window.localStorage.setItem(TAG_SIZE_STORAGE_KEY, next);
    } catch (_) {}
    applyTagSize(next);
  }

  applyTagSize(getTagSize());
  document.querySelectorAll(".nc-dir-tag-size-btn[data-tag-size]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setTagSize(btn.getAttribute("data-tag-size") || "large");
    });
  });

  function getTagLayout() {
    try {
      return window.localStorage.getItem(TAG_LAYOUT_STORAGE_KEY) === "vertical" ? "vertical" : "horizontal";
    } catch (_) {
      return "horizontal";
    }
  }

  function applyTagLayout(layout) {
    const vertical = layout === "vertical";
    if (dirPage) {
      dirPage.classList.toggle("nc-dir-layout--vertical", vertical);
      dirPage.classList.toggle("nc-dir-layout--horizontal", !vertical);
    }
    document.querySelectorAll(".nc-dir-tag-layout-btn[data-tag-layout]").forEach((btn) => {
      const on = btn.getAttribute("data-tag-layout") === layout;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function setTagLayout(layout) {
    const next = layout === "vertical" ? "vertical" : "horizontal";
    try {
      window.localStorage.setItem(TAG_LAYOUT_STORAGE_KEY, next);
    } catch (_) {}
    applyTagLayout(next);
  }

  applyTagLayout(getTagLayout());
  document.querySelectorAll(".nc-dir-tag-layout-btn[data-tag-layout]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setTagLayout(btn.getAttribute("data-tag-layout") || "horizontal");
    });
  });

  const grid = document.getElementById("nc-dir-grid");
  const raw = document.getElementById("directory-people-data");
  if (!grid || !raw) return;

  let people = [];
  try {
    people = JSON.parse(raw.textContent || "[]");
  } catch (_) {
    people = [];
  }
  const byId = new Map(people.map((p) => [String(p.id), p]));

  /** Full-roster entries from server; falls back to embedded grid list if JSON is missing or fails to parse. */
  let resolvePeople = [];
  try {
    const rawResolve = document.getElementById("directory-people-resolve");
    const parsed = JSON.parse(rawResolve ? rawResolve.textContent || "[]" : "[]");
    resolvePeople = Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    resolvePeople = [];
  }
  const byIdResolve = new Map(resolvePeople.map((p) => [String(p.id), p]));
  people.forEach((p) => {
    const id = String(p.id);
    if (!byIdResolve.has(id)) byIdResolve.set(id, p);
  });

  let userIdAliases = {};
  try {
    const rawAlias = document.getElementById("directory-user-id-aliases");
    const parsed = JSON.parse(rawAlias ? rawAlias.textContent || "{}" : "{}");
    userIdAliases = parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    userIdAliases = {};
  }

  function canonicalPersonId(rawId) {
    let id = String(rawId ?? "").trim();
    if (!id) return id;
    const seen = new Set();
    while (userIdAliases[id] != null && String(userIdAliases[id]).trim() !== "" && !seen.has(id)) {
      seen.add(id);
      id = String(userIdAliases[id]).trim();
    }
    return id;
  }

  function personById(rawId) {
    const id = canonicalPersonId(rawId);
    if (!id) return null;
    return byId.get(id) || byIdResolve.get(id) || null;
  }

  function canEditProjects() {
    try {
      const el = document.getElementById("directory-can-edit-projects");
      if (!el) return false;
      return JSON.parse(el.textContent || "false") === true;
    } catch (_) {
      return false;
    }
  }

  function canDeleteProjects() {
    try {
      const el = document.getElementById("directory-can-delete-projects");
      if (!el) return false;
      return JSON.parse(el.textContent || "false") === true;
    } catch (_) {
      return false;
    }
  }

  const vTime = null;

  const editDlg = document.getElementById("nc-dir-edit-dlg");
  const editForm = document.getElementById("nc-dir-edit-form");
  const editCancel = document.getElementById("nc-dir-edit-cancel");
  const editSave = document.getElementById("nc-dir-edit-save");
  const editStatus = document.getElementById("nc-dir-edit-status");
  const efFirstName = document.getElementById("nc-dir-edit-firstname");
  const efSurname = document.getElementById("nc-dir-edit-surname");
  const efEmail = document.getElementById("nc-dir-edit-email");
  const efPhone = document.getElementById("nc-dir-edit-phone");
  const efDept = document.getElementById("nc-dir-edit-dept");
  const efProject = document.getElementById("nc-dir-edit-project");
  const newProjectFields = document.getElementById("nc-dir-new-project-fields");
  const newProjectName = document.getElementById("nc-dir-new-project-name");
  const newProjectDirector = document.getElementById("nc-dir-new-project-director");
  const newProjectContractEnd = document.getElementById("nc-dir-new-project-contract-end");
  const efTitle = document.getElementById("nc-dir-edit-title");
  const efLocSelect = document.getElementById("nc-dir-edit-location-select");
  const efLocOtherWrap = document.getElementById("nc-dir-edit-location-other-wrap");
  const efLocOther = document.getElementById("nc-dir-edit-location-other");
  const efRep = document.getElementById("nc-dir-edit-reports");
  const efStart = document.getElementById("nc-dir-edit-start");
  const efContractSign = document.getElementById("nc-dir-edit-contract-sign");
  const efContractStart = document.getElementById("nc-dir-edit-contract-start");
  const efContractEnd = document.getElementById("nc-dir-edit-contract-end");
  const contractFields = document.getElementById("nc-dir-contract-fields");
  const efTz = document.getElementById("nc-dir-edit-tz");
  const editX = document.getElementById("nc-dir-edit-x");
  const efIsContractor = document.getElementById("nc-dir-edit-is-contractor");
  const createAccountWrap = document.getElementById("nc-dir-create-account-wrap");
  const intranetAccountFields = document.getElementById("nc-dir-intranet-account-fields");
  const accountEmailEl = document.getElementById("nc-dir-account-email");
  const accountNameEl = document.getElementById("nc-dir-account-name");
  const accountPhoneDisplayEl = document.getElementById("nc-dir-account-phone-display");
  const accountPwDisplayEl = document.getElementById("nc-dir-account-password-display");
  const accountPwCopyBtn = document.getElementById("nc-dir-account-password-copy");
  const accountRequirePwEl = document.getElementById("nc-dir-account-require-pw");
  let accountPhoneDisplayDirty = false;
  const modeEditBtn = document.getElementById("nc-dir-mode-edit");
  const addNewBtn = document.getElementById("nc-dir-add-new");
  const createProjectBtn = document.getElementById("nc-dir-create-project");
  const createProjectDlg = document.getElementById("nc-dir-create-project-dlg");
  const createProjectForm = document.getElementById("nc-dir-create-project-form");
  const createProjectErr = document.getElementById("nc-dir-create-project-err");
  const modalNewProjectName = document.getElementById("nc-dir-modal-new-project-name");
  const modalNewProjectDirector = document.getElementById("nc-dir-modal-new-project-director");
  const modalNewProjectContractEnd = document.getElementById("nc-dir-modal-new-project-contract-end");
  const createProjectCancel = document.getElementById("nc-dir-create-project-cancel");
  const createProjectX = document.getElementById("nc-dir-create-project-x");
  const createProjectScrim = document.getElementById("nc-dir-create-project-scrim");
  const topTitle = document.getElementById("nc-dir-edit-top-title");

  // Notes (chat) inside edit overlay
  const notesList = document.getElementById("nc-dir-notes-list");
  const noteText = document.getElementById("nc-dir-note-text");
  const noteSend = document.getElementById("nc-dir-note-send");
  const chatMeta = document.getElementById("nc-dir-chat-meta");
  const noteAttach = document.getElementById("nc-dir-note-attach");
  const noteAttachImg = document.getElementById("nc-dir-note-attach-img");
  const noteAttachX = document.getElementById("nc-dir-note-attach-x");
  const noteCompose = document.getElementById("nc-dir-note-compose");
  const notePending = document.getElementById("nc-dir-note-pending");
  const imgViewer = document.getElementById("nc-dir-img-viewer");
  const imgViewerEl = document.getElementById("nc-dir-img-el");
  const imgViewerClose = document.getElementById("nc-dir-img-close");
  const imgViewerTitle = document.getElementById("nc-dir-img-title");

  // Photo upload (edit overlay)
  const photoInput = document.getElementById("nc-dir-photo-input");
  const photoChoose = document.getElementById("nc-dir-photo-choose");
  const photoRemove = document.getElementById("nc-dir-photo-remove");
  const photoPreview = document.getElementById("nc-dir-photo-preview");

  const companyFields = document.getElementById("nc-dir-company-fields");
  const companySelect = document.getElementById("nc-dir-company-select");
  const companyNameRow = document.getElementById("nc-dir-company-name-row");
  const companyNameNew = document.getElementById("nc-dir-company-name-new");
  const companyAbn = document.getElementById("nc-dir-company-abn");
  const companyAcn = document.getElementById("nc-dir-company-acn");
  const companyRep = document.getElementById("nc-dir-company-rep");
  const docPiplInput = document.getElementById("nc-dir-doc-pipl");
  const docWcInput = document.getElementById("nc-dir-doc-wc");
  const docPiplStatus = document.getElementById("nc-dir-doc-pipl-status");
  const docWcStatus = document.getElementById("nc-dir-doc-wc-status");
  const docPiplLink = document.getElementById("nc-dir-doc-pipl-link");
  const docWcLink = document.getElementById("nc-dir-doc-wc-link");

  const ccListEl = document.getElementById("directory-contractor-companies-data");
  let contractorCompanies = [];
  try {
    const parsed = JSON.parse(ccListEl ? ccListEl.textContent || "[]" : "[]");
    contractorCompanies = Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    contractorCompanies = [];
  }

  let pendingCompanyDocs = { pi_pl_insurance: null, workcover: null };

  let timeTimer = null;
  let presenceTimer = null;
  let selectedId = null;
  let viewMode = "view"; // view | edit
  let isCreating = false;

  const EDIT_HISTORY_KEY = "dirEdit";
  const IMG_HISTORY_KEY = "dirImg";
  const NOTE_STORAGE_KEY = "dir.employeeNotes.v1";
  const PHOTO_STORAGE_KEY = "dir.employeePhotos.v1";
  const PROJECTS_STORAGE_KEY = "dir.contractorProjects.v1";
  const PROJECT_META_KEY = "dir.projectMeta.v1";
  const CURRENT_USER = (document.querySelector("#intranet-user-btn .nc-intranet-user-name")?.textContent || "Member").trim();

  function escAttr(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/</g, "&lt;");
  }

  function normProjectName(s) {
    const out = String(s ?? "").trim().replace(/\s+/g, " ");
    return out.length > 120 ? out.slice(0, 120) : out;
  }

  /** Match server `_canonical_directory_project_label`: strip repeated leading "project:" (case-insensitive). */
  function stripProjectPrefix(s) {
    let t = String(s ?? "").trim().replace(/\s+/g, " ");
    while (t.length >= 8 && t.slice(0, 8).toLowerCase() === "project:") {
      t = t.slice(8).trim();
    }
    return t.length > 120 ? t.slice(0, 120) : t;
  }

  function canonicalProjectName(s) {
    return normProjectName(stripProjectPrefix(s));
  }

  /** Normalize stored date strings to YYYY-MM-DD for `<input type="date">`, or "" if unknown. */
  function parseContractEndToIsoDate(s) {
    let v = String(s ?? "").trim();
    if (v.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(v)) v = v.slice(0, 10);
    if (!v) return "";
    let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (m) {
      const y = +m[1],
        mo = +m[2],
        d = +m[3];
      if (y >= 1900 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${m[1]}-${m[2]}-${m[3]}`;
    }
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
    if (m) {
      const dd = String(m[1]).padStart(2, "0");
      const mm = String(m[2]).padStart(2, "0");
      return `${m[3]}-${mm}-${dd}`;
    }
    m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(v);
    if (m) {
      const dd = String(m[1]).padStart(2, "0");
      const mm = String(m[2]).padStart(2, "0");
      return `${m[3]}-${mm}-${dd}`;
    }
    return "";
  }

  /** Readable label for project header (ISO or legacy text). */
  function formatContractEndDisplay(stored) {
    const raw = String(stored ?? "").trim();
    if (!raw) return "";
    const iso = parseContractEndToIsoDate(raw);
    if (!iso) return raw;
    try {
      const [y, mo, d] = iso.split("-").map(Number);
      const dt = new Date(Date.UTC(y, mo - 1, d));
      return dt.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });
    } catch (_) {
      return iso;
    }
  }

  function loadProjectStore() {
    try {
      const j = JSON.parse(window.localStorage.getItem(PROJECTS_STORAGE_KEY) || "[]");
      return Array.isArray(j) ? j.map(normProjectName).filter(Boolean).slice(0, 200) : [];
    } catch (_) {
      return [];
    }
  }

  function saveProjectStore(arr) {
    try {
      window.localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify((arr || []).slice(0, 200)));
    } catch (_) {}
  }

  function saveProjectMembers(_obj) {
    /* Project membership is persisted via PATCH workforce_project; dir.projectMembers.v1 is not used. */
  }

  function loadProjectMeta() {
    try {
      const j = JSON.parse(window.localStorage.getItem(PROJECT_META_KEY) || "{}") || {};
      return j && typeof j === "object" ? j : {};
    } catch (_) {
      return {};
    }
  }

  function saveProjectMeta(obj) {
    try {
      window.localStorage.setItem(PROJECT_META_KEY, JSON.stringify(obj || {}));
    } catch (_) {}
  }

  let projectMeta = loadProjectMeta();

  function migrateProjectMeta(fromKey, toKey) {
    if (!fromKey || !toKey || fromKey === toKey) return;
    const fromM = projectMeta[fromKey];
    if (!fromM || typeof fromM !== "object") {
      delete projectMeta[fromKey];
      saveProjectMeta(projectMeta);
      return;
    }
    const toM = projectMeta[toKey];
    projectMeta[toKey] = {
      director: String((toM && toM.director) || fromM.director || "").trim().slice(0, 120),
      contractEnd: String((toM && toM.contractEnd) || fromM.contractEnd || "").trim().slice(0, 80),
    };
    delete projectMeta[fromKey];
    saveProjectMeta(projectMeta);
  }

  function refreshProjectMetaDisplay(sec) {
    if (!sec || !sec.querySelector) return;
    const raw = canonicalProjectName(sec.getAttribute("data-project") || "");
    const pk = keyForProject(raw);
    const m = (pk && projectMeta[pk]) || {};
    const dirEl = sec.querySelector('[data-project-director="1"]');
    const endEl = sec.querySelector('[data-project-contract-end="1"]');
    const d = String(m.director || "").trim();
    const ce = String(m.contractEnd || "").trim();
    const ceShow = ce ? formatContractEndDisplay(ce) || ce : "";
    if (dirEl) {
      dirEl.textContent = d || "—";
      dirEl.classList.toggle("nc-dir-project-field-value--muted", !d);
    }
    if (endEl) {
      endEl.textContent = ceShow || "—";
      endEl.classList.toggle("nc-dir-project-field-value--muted", !ce);
    }
  }

  /** Stable LS map key — must match canonical `data-project` / workforce_dashboard.js. */
  function keyForProject(name) {
    return canonicalProjectName(name).toLowerCase();
  }

  let SERVER_WORKFORCE_PROJECT_OPTIONS = [];
  try {
    const _wpoEl = document.getElementById("workforce-project-options");
    const _wpoParsed = JSON.parse(_wpoEl ? _wpoEl.textContent || "[]" : "[]");
    SERVER_WORKFORCE_PROJECT_OPTIONS = Array.isArray(_wpoParsed) ? _wpoParsed : [];
  } catch (_) {
    SERVER_WORKFORCE_PROJECT_OPTIONS = [];
  }

  let WORKFORCE_PROJECT_CATALOG_FROM_SERVER = [];
  try {
    const _wcatEl = document.getElementById("directory-projects-catalog");
    const _wcatParsed = JSON.parse(_wcatEl ? _wcatEl.textContent || "[]" : "[]");
    WORKFORCE_PROJECT_CATALOG_FROM_SERVER = Array.isArray(_wcatParsed) ? _wcatParsed : [];
  } catch (_) {
    WORKFORCE_PROJECT_CATALOG_FROM_SERVER = [];
  }

  function applyServerProjectCatalogToMeta() {
    for (const row of WORKFORCE_PROJECT_CATALOG_FROM_SERVER) {
      const name = canonicalProjectName(row.name || "");
      const k = keyForProject(name);
      if (!k) continue;
      const director = String(row.director || "").trim().slice(0, 120);
      const contractEnd = String(row.contract_end || row.contractEnd || "").trim().slice(0, 80);
      const prev = projectMeta[k] || {};
      projectMeta[k] = {
        director: director || prev.director || "",
        contractEnd: contractEnd || prev.contractEnd || "",
      };
    }
    saveProjectMeta(projectMeta);
  }

  function allKnownProjectLabels() {
    const map = new Map();
    for (const p of SERVER_WORKFORCE_PROJECT_OPTIONS) {
      const c = canonicalProjectName(p);
      if (c) map.set(keyForProject(c), c);
    }
    for (const row of WORKFORCE_PROJECT_CATALOG_FROM_SERVER) {
      const c = canonicalProjectName(row.name || "");
      if (c) map.set(keyForProject(c), c);
    }
    for (const p of loadProjectStore()) {
      const c = canonicalProjectName(p);
      if (c) map.set(keyForProject(c), c);
    }
    return [...map.values()].sort((a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: "base" }));
  }

  function rebuildProjectSelect(selectedRaw) {
    if (!efProject) return;
    const names = allKnownProjectLabels();
    const want = selectedRaw ? canonicalProjectName(selectedRaw) : "";
    efProject.innerHTML = "";
    const o0 = document.createElement("option");
    o0.value = "";
    o0.textContent = "— None —";
    efProject.appendChild(o0);
    for (const n of names) {
      const o = document.createElement("option");
      o.value = n;
      o.textContent = n;
      efProject.appendChild(o);
    }
    if (want && !names.some((n) => keyForProject(n) === keyForProject(want))) {
      const ox = document.createElement("option");
      ox.value = want;
      ox.textContent = want;
      efProject.appendChild(ox);
    }
    const oNew = document.createElement("option");
    oNew.value = "__create_new__";
    oNew.textContent = "+ Create new project…";
    efProject.appendChild(oNew);
    if (want && [...efProject.options].some((opt) => opt.value === want)) {
      efProject.value = want;
    } else {
      efProject.value = "";
    }
    if (efProject.value !== "__create_new__") setNewProjectFieldsVisible(false);
  }

  function clearNewProjectDraftInputs() {
    if (newProjectName) newProjectName.value = "";
    if (newProjectDirector) newProjectDirector.value = "";
    if (newProjectContractEnd) newProjectContractEnd.value = "";
  }

  function setNewProjectFieldsVisible(show) {
    if (newProjectFields) newProjectFields.hidden = !show;
    if (!show) clearNewProjectDraftInputs();
  }

  efProject?.addEventListener("change", () => {
    if (!efProject) return;
    if (efProject.value === "__create_new__") {
      setNewProjectFieldsVisible(true);
      try {
        newProjectName?.focus();
      } catch (_) {}
      return;
    }
    setNewProjectFieldsVisible(false);
  });

  /** Merge legacy keys (e.g. `project: ict2222`) into canonical keys (`ict2222`). */
  function normalizeProjectMembersStorage(pm) {
    const out = {};
    Object.keys(pm || {}).forEach((oldKey) => {
      const arr = pm[oldKey];
      if (!Array.isArray(arr)) return;
      const nk = canonicalProjectName(String(oldKey)).toLowerCase();
      if (!nk) return;
      out[nk] = uniqIds([...(out[nk] || []), ...arr.map((x) => String(x))]);
    });
    return out;
  }

  function normalizeProjectMetaStorage(meta) {
    const out = {};
    Object.keys(meta || {}).forEach((oldKey) => {
      const v = meta[oldKey];
      if (!v || typeof v !== "object") return;
      const nk = canonicalProjectName(String(oldKey)).toLowerCase();
      if (!nk) return;
      const director = String(v.director || "").trim().slice(0, 120);
      const contractEnd = String(v.contractEnd || "").trim().slice(0, 80);
      if (!out[nk]) {
        out[nk] = { director, contractEnd };
      } else {
        out[nk] = {
          director: String(out[nk].director || director || "").trim().slice(0, 120),
          contractEnd: String(out[nk].contractEnd || contractEnd || "").trim().slice(0, 80),
        };
      }
    });
    return out;
  }

  function uniqIds(arr) {
    const out = [];
    const seen = new Set();
    for (const x of arr || []) {
      const id = String(x || "").trim();
      if (!id) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  function isUnassignedSeedProjectLabel(proj) {
    const c = canonicalProjectName(proj || "");
    if (!c) return true;
    return keyForProject(c) === keyForProject("Unassigned");
  }

  /** Same roster grouping as the server seed (`project_members_seed`); excludes Unassigned so bench stays visible. */
  function parseProjectMembersSeed() {
    const el = document.getElementById("directory-project-members-seed");
    if (!el) return {};
    try {
      const seed = JSON.parse(el.textContent || "{}");
      if (!seed || typeof seed !== "object") return {};
      const next = {};
      Object.keys(seed).forEach((proj) => {
        if (isUnassignedSeedProjectLabel(proj)) return;
        const k = keyForProject(proj);
        if (!k) return;
        const ids = seed[proj];
        if (!Array.isArray(ids) || !ids.length) return;
        next[k] = uniqIds(ids.map((x) => String(x)));
      });
      return next;
    } catch (_) {
      return {};
    }
  }

  let projectMembers = normalizeProjectMembersStorage(parseProjectMembersSeed());
  projectMeta = normalizeProjectMetaStorage(projectMeta);
  saveProjectMeta(projectMeta);
  applyServerProjectCatalogToMeta();

  function getProjectMembersByName(projectName) {
    const k = keyForProject(projectName);
    return Array.isArray(projectMembers[k]) ? projectMembers[k].slice() : [];
  }

  /** All member IDs for this project across every LS key that canonicalizes to the same bucket (fixes split legacy keys). */
  function memberIdsForProjectCanonical(projDisplay) {
    const want = keyForProject(projDisplay);
    if (!want) return [];
    const acc = [];
    Object.keys(projectMembers || {}).forEach((sk) => {
      const nk = keyForProject(canonicalProjectName(sk));
      if (nk === want) acc.push(...(projectMembers[sk] || []));
    });
    return uniqIds(acc.map(String));
  }

  function projectMembersSignature(pm) {
    const o = {};
    Object.keys(pm || {})
      .sort()
      .forEach((k) => {
        o[k] = uniqIds((pm[k] || []).map(String)).sort();
      });
    return JSON.stringify(o);
  }

  /** Collapse duplicate LS keys into one canonical key per project (same as load normalize; safe to repeat). */
  function flattenProjectMembersToCanonicalKeys() {
    const merged = {};
    Object.keys(projectMembers || {}).forEach((sk) => {
      const nk = keyForProject(canonicalProjectName(sk));
      if (!nk) return;
      merged[nk] = uniqIds([...(merged[nk] || []), ...(projectMembers[sk] || []).map(String)]);
    });
    if (projectMembersSignature(merged) !== projectMembersSignature(projectMembers)) {
      projectMembers = merged;
      saveProjectMembers(projectMembers);
    }
  }

  function setProjectMembersByName(projectName, ids) {
    const k = keyForProject(projectName);
    if (!k) return;
    projectMembers[k] = uniqIds(ids || []);
    saveProjectMembers(projectMembers);
  }

  function removeFromAllProjects(userId) {
    const id = String(userId || "").trim();
    if (!id) return;
    Object.keys(projectMembers || {}).forEach((k) => {
      projectMembers[k] = (projectMembers[k] || []).filter((x) => String(x) !== id);
    });
    saveProjectMembers(projectMembers);
  }

  function assignedIdsSet() {
    const s = new Set();
    try {
      Object.keys(projectMembers || {}).forEach((k) => {
        const arr = Array.isArray(projectMembers[k]) ? projectMembers[k] : [];
        arr.forEach((id) => {
          const v = String(id || "").trim();
          if (v) s.add(v);
        });
      });
    } catch (_) {}
    return s;
  }

  function syncEmployeeDirectoryVisibility() {
    // If a resource is assigned to any project, it should not also appear in the Workforce Directory grid.
    if (!grid) return;
    const assigned = assignedIdsSet();
    grid.querySelectorAll(".nc-dir-card[data-person-id]").forEach((card) => {
      const id = String(card.getAttribute("data-person-id") || "").trim();
      const hide = id && assigned.has(id);
      card.classList.toggle("is-hidden", !!hide);
    });
    try {
      const el = document.getElementById("nc-bench-count");
      if (el) {
        const n = grid.querySelectorAll('.nc-dir-card[data-person-id]:not(.is-hidden)').length;
        el.textContent = `${n} resource${n === 1 ? "" : "s"}`;
      }
    } catch (_) {}
  }

  function moveToProject(userId, projectName) {
    if (!canEditProjects()) return;
    const id = String(userId || "").trim();
    const proj = canonicalProjectName(projectName);
    if (!id || !proj) return;
    removeFromAllProjects(id);
    const cur = getProjectMembersByName(proj);
    cur.push(id);
    setProjectMembersByName(proj, cur);
    syncEmployeeDirectoryVisibility();
    void persistWorkforceProjectToServer(id, proj);
  }

  function applyPersonWorkforceProjectToMembers(person) {
    const id = String(person?.id ?? "").trim();
    if (!id) return;
    removeFromAllProjects(id);
    const raw = String(person.workforce_project || "").trim();
    if (!raw) {
      syncEmployeeDirectoryVisibility();
      return;
    }
    const wp = canonicalProjectName(raw);
    if (!wp || keyForProject(wp) === keyForProject("Unassigned")) {
      syncEmployeeDirectoryVisibility();
      return;
    }
    const cur = getProjectMembersByName(wp);
    cur.push(id);
    setProjectMembersByName(wp, cur);
    syncEmployeeDirectoryVisibility();
  }

  async function persistWorkforceProjectToServer(userId, canonicalProj) {
    const id = String(userId || "").trim();
    if (!id) return false;
    const trimmed = canonicalProj ? String(canonicalProj).trim().slice(0, 120) : "";
    const body = trimmed ? { workforce_project: trimmed } : { workforce_project: "" };
    try {
      const r = await fetch(`/intranet/api/users/${encodeURIComponent(id)}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.user) {
        const sid = String(j.user.id != null ? j.user.id : "");
        if (sid) {
          if (byId.has(sid)) byId.set(sid, j.user);
          if (byIdResolve.has(sid)) byIdResolve.set(sid, j.user);
        }
        applyPersonWorkforceProjectToMembers(j.user);
      }
      return r.ok;
    } catch (_) {
      return false;
    }
  }

  function renameProject(oldName, newName) {
    if (!canEditProjects()) return false;
    const from = canonicalProjectName(oldName);
    const to = canonicalProjectName(newName);
    if (!from || !to) return false;
    const fromKey = keyForProject(from);
    const toKey = keyForProject(to);
    if (!fromKey || !toKey) return false;
    if (fromKey === toKey) return false;

    // Move members list to new key (merge if target exists).
    const fromMembers = Array.isArray(projectMembers[fromKey]) ? projectMembers[fromKey] : [];
    const toMembers = Array.isArray(projectMembers[toKey]) ? projectMembers[toKey] : [];
    projectMembers[toKey] = uniqIds([...toMembers, ...fromMembers]);
    delete projectMembers[fromKey];
    saveProjectMembers(projectMembers);

    migrateProjectMeta(fromKey, toKey);

    // Also rename in project list store.
    try {
      const cur = loadProjectStore();
      const next = cur.map((x) => (keyForProject(x) === fromKey ? to : x));
      saveProjectStore(uniqIds(next));
    } catch (_) {}

    // Update any DOM sections that still use old data-project.
    try {
      document.querySelectorAll('.nc-dir-project[data-project]').forEach((sec) => {
        const nm = canonicalProjectName(sec.getAttribute('data-project') || '');
        if (keyForProject(nm) !== fromKey) return;
        sec.setAttribute('data-project', to);
        const lbl = sec.querySelector('[data-project-name="1"]');
        if (lbl) lbl.textContent = to;
      });
    } catch (_) {}

    return true;
  }

  async function refreshPersonFromServer(rawId) {
    const sid = String(rawId || "").trim();
    if (!sid) return;
    try {
      const r = await fetch(`/intranet/api/users/${encodeURIComponent(sid)}`, { credentials: "same-origin" });
      if (!r.ok) return;
      const j = await r.json().catch(() => ({}));
      if (!j.user) return;
      const uid = String(j.user.id != null ? j.user.id : "");
      if (!uid) return;
      byId.set(uid, j.user);
      byIdResolve.set(uid, j.user);
      updateCardFromPerson(j.user);
    } catch (_) {}
  }

  function promptDeletionJustification(title) {
    let text = "";
    for (;;) {
      text = window.prompt(
        `${title}\n\nAudit log — enter justification (required, minimum 10 characters):`,
        ""
      );
      if (text === null) return null;
      text = String(text).trim();
      if (text.length >= 10) return text;
      window.alert("Justification must be at least 10 characters.");
    }
  }

  /**
   * Remove project from client maps, bulk-unassign on server (catalog + all roster matches), caller removes DOM section.
   */
  async function deleteProjectCanonical(displayName, justificationText) {
    if (!canDeleteProjects()) return false;
    const name = canonicalProjectName(displayName);
    if (!name) return false;
    const pk = keyForProject(name);
    if (!pk) return false;
    const justification = String(justificationText || "").trim();
    if (justification.length < 10) {
      alert("A justification of at least 10 characters is required to delete a project.");
      return false;
    }

    try {
      const r = await fetch("/intranet/api/workforce-projects/remove", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, justification }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        alert(String(j.error || "Could not remove this project on the server."));
        return false;
      }
      if (j.projects && Array.isArray(j.projects)) {
        WORKFORCE_PROJECT_CATALOG_FROM_SERVER = j.projects;
        applyServerProjectCatalogToMeta();
      }
      const clearedIds = Array.isArray(j.cleared_ids) ? j.cleared_ids : [];
      await Promise.all(clearedIds.map((id) => refreshPersonFromServer(id)));
    } catch (_) {
      alert("Could not remove this project. Check your connection and try again.");
      return false;
    }

    flattenProjectMembersToCanonicalKeys();
    const nextPm = { ...(projectMembers || {}) };
    Object.keys(nextPm).forEach((k) => {
      if (keyForProject(canonicalProjectName(k)) === pk) delete nextPm[k];
    });
    projectMembers = nextPm;
    saveProjectMembers(projectMembers);

    if (projectMeta[pk]) {
      delete projectMeta[pk];
      saveProjectMeta(projectMeta);
    }

    try {
      const cur = loadProjectStore();
      saveProjectStore(cur.filter((x) => keyForProject(x) !== pk));
    } catch (_) {}

    return true;
  }

  async function syncWorkforceProjectsCatalogToServer() {
    if (!canEditProjects()) return;
    const projects = [];
    document.querySelectorAll(".nc-dir-project[data-project]").forEach((sec) => {
      const name = canonicalProjectName(sec.getAttribute("data-project") || "");
      if (!name) return;
      const pk = keyForProject(name);
      const m = (pk && projectMeta[pk]) || {};
      projects.push({
        name,
        director: String(m.director || "").trim(),
        contract_end: String(m.contractEnd || "").trim(),
      });
    });
    projects.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" }));
    try {
      const r = await fetch("/intranet/api/workforce-projects", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projects }),
      });
      if (!r.ok) return;
      const j = await r.json().catch(() => ({}));
      if (j.projects && Array.isArray(j.projects)) {
        WORKFORCE_PROJECT_CATALOG_FROM_SERVER = j.projects;
      }
    } catch (_) {}
  }

  function cardHtmlForPerson(p) {
    const id = String(p && p.id != null ? p.id : "");
    const isContractor = !!(p && p.is_contractor);
    const cls = isContractor ? "is-contractor" : "is-employee";
    const initials = String(p && p.initials ? p.initials : "").trim();
    const tone = String(p && p.tone ? p.tone : "").trim();
    const name = esc(p && p.name ? p.name : p && p.full_name ? p.full_name : "");
    const title = esc(p && p.job_title ? p.job_title : "");
    const email = p && p.email ? String(p.email) : "";
    const emailDisplay = esc(p && p.email_display ? p.email_display : "");
    const phone = esc(p && p.phone ? p.phone : "");
    return `<article class="nc-dir-card ${cls}" draggable="true" data-person-id="${escAttr(id)}" role="button" tabindex="0" aria-haspopup="dialog" aria-label="Open profile for ${escAttr(name)}">
      <div class="nc-dir-avatar" data-tone="${escAttr(tone)}" aria-hidden="true">${esc(initials)}</div>
      <div class="nc-dir-card-name">${name}</div>
      <div class="nc-dir-card-title">${title}</div>
      ${
        email
          ? `<a class="nc-dir-card-email" href="mailto:${escAttr(email)}" onclick="event.stopPropagation();">${esc(email)}</a>`
          : `<div class="nc-dir-card-email">${emailDisplay}</div>`
      }
      ${phone ? `<div class="nc-dir-card-phone">${phone}</div>` : ``}
    </article>`;
  }

  function cardHtmlPlaceholderPerson(id) {
    const sid = String(id || "").trim();
    return `<article class="nc-dir-card is-employee" draggable="true" data-person-id="${escAttr(sid)}" role="button" tabindex="0" aria-haspopup="dialog" aria-label="Open profile for user ${escAttr(sid)}">
      <div class="nc-dir-avatar" data-tone="0" aria-hidden="true">?</div>
      <div class="nc-dir-card-name">Loading profile…</div>
      <div class="nc-dir-card-title">User #${esc(sid)}</div>
      <div class="nc-dir-card-email nc-detail-muted">Tap to load details</div>
    </article>`;
  }

  function renderProjectSection(sec) {
    const proj = getProjectDisplayName(sec);
    if (!proj) return;
    const ids = memberIdsForProjectCanonical(proj);
    const bodyGrid = sec.querySelector(".nc-dir-project-body .nc-dir-grid");
    if (!bodyGrid) return;
    if (!ids.length) {
      bodyGrid.innerHTML = `<p class="nc-detail-muted nc-dir-empty">No resources in this project yet.</p>`;
    } else {
      const html = ids
        .map((id) => {
          const p = personById(id);
          return p ? cardHtmlForPerson(p) : cardHtmlPlaceholderPerson(id);
        })
        .join("");
      bodyGrid.innerHTML = html;
      try {
        bodyGrid.querySelectorAll(".nc-dir-card[data-person-id] .nc-dir-avatar").forEach((av) => {
          const card = av.closest(".nc-dir-card[data-person-id]");
          const pid = card ? card.getAttribute("data-person-id") : "";
          applyAvatarPhoto(av, pid);
        });
      } catch (_) {}
    }
    // Update count label in header.
    try {
      const meta = sec.querySelector(".nc-dir-project-meta");
      const muted = meta ? meta.querySelector(".nc-detail-muted") : null;
      if (muted) {
        const n = ids.length;
        muted.textContent = `${n} resource${n === 1 ? "" : "s"}`;
      }
    } catch (_) {}
  }

  function renderAllProjects() {
    flattenProjectMembersToCanonicalKeys();
    document.querySelectorAll(".nc-dir-project[data-project]").forEach((sec) => renderProjectSection(sec));
  }

  function existingProjectNamesFromDom() {
    const out = new Set();
    document.querySelectorAll(".nc-dir-project[data-project]").forEach((sec) => {
      const p = canonicalProjectName(sec.getAttribute("data-project") || "");
      const k = keyForProject(p);
      if (k) out.add(k);
    });
    return out;
  }

  function getProjectDisplayName(sec) {
    if (!sec) return "";
    const raw = sec.getAttribute("data-project") || "";
    return canonicalProjectName(raw);
  }

  function insertEmptyProjectSection(projectName) {
    const projectsWrap = document.querySelector(".nc-dir-projects");
    if (!projectsWrap) return;
    const name = canonicalProjectName(projectName);
    if (!name) return;
    const key = keyForProject(name);
    if (existingProjectNamesFromDom().has(key)) return;

    const sec = document.createElement("section");
    sec.className = "nc-dir-project";
    sec.setAttribute("data-project", name);
    sec.innerHTML = `
      <div class="nc-dir-project-head">
        <div class="nc-dir-project-title nc-dir-project-title--stack">
          <span class="nc-dir-project-ic" aria-hidden="true">📁</span>
          <div class="nc-dir-project-fields">
            <div class="nc-dir-project-fieldline">
              <span class="nc-dir-project-field-label">Project:</span>
              <span class="nc-dir-project-field-value" data-project-name="1">${esc(name)}</span>
            </div>
            <div class="nc-dir-project-fieldline">
              <span class="nc-dir-project-field-label">Director:</span>
              <span class="nc-dir-project-field-value nc-dir-project-field-value--muted" data-project-director="1">—</span>
            </div>
            <div class="nc-dir-project-fieldline">
              <span class="nc-dir-project-field-label">Contract End:</span>
              <span class="nc-dir-project-field-value nc-dir-project-field-value--muted" data-project-contract-end="1">—</span>
            </div>
          </div>
        </div>
        <div class="nc-dir-project-actions">
          ${
            canEditProjects()
              ? `<button type="button" class="nc-dir-project-edit" data-project-edit="1" aria-label="Edit project details">Edit project</button>`
              : ""
          }
          <div class="nc-dir-project-meta">
            <span class="nc-detail-muted">0 contractors</span>
            <button type="button" class="nc-dir-project-toggle" data-toggle="1" aria-label="Collapse project">▾</button>
          </div>
        </div>
      </div>
      <div class="nc-dir-project-body">
        <div class="nc-dir-grid nc-dir-grid--contractors" role="list">
          <p class="nc-detail-muted nc-dir-empty">No contractors in this project yet.</p>
        </div>
      </div>
    `;
    projectsWrap.prepend(sec);
  }

  async function assignResourceToProject(userId, projectName) {
    if (!canEditProjects()) return;
    // Client-side grouping only: never flips employee/contractor status.
    const pid = String(userId || "").trim();
    const proj = canonicalProjectName(projectName);
    if (!pid || !proj) return;
    if (!personById(pid)) throw new Error("Unknown resource.");
    moveToProject(pid, proj);
    renderAllProjects();
  }

  let notesByUserId = {};
  try {
    notesByUserId = JSON.parse(window.localStorage.getItem(NOTE_STORAGE_KEY) || "{}") || {};
  } catch (_) {
    notesByUserId = {};
  }

  let pendingImageData = "";
  let pendingImageName = "";
  let pendingAttachment = null; // {url,name,size,is_image}

  let photosByUserId = {};
  try {
    photosByUserId = JSON.parse(window.localStorage.getItem(PHOTO_STORAGE_KEY) || "{}") || {};
  } catch (_) {
    photosByUserId = {};
  }

  function savePhotoStore() {
    try {
      window.localStorage.setItem(PHOTO_STORAGE_KEY, JSON.stringify(photosByUserId || {}));
    } catch (_) {}
  }

  function getPhotoFor(id) {
    const k = String(id || "");
    const v = photosByUserId && typeof photosByUserId === "object" ? String(photosByUserId[k] || "") : "";
    return v && v.startsWith("data:image/") ? v : "";
  }

  function setPhotoFor(id, dataUrl) {
    const k = String(id || "");
    if (!photosByUserId || typeof photosByUserId !== "object") photosByUserId = {};
    const v = String(dataUrl || "");
    if (!v) delete photosByUserId[k];
    else photosByUserId[k] = v;
    savePhotoStore();
  }

  function applyAvatarPhoto(el, id) {
    if (!el) return;
    const dataUrl = getPhotoFor(id);
    if (dataUrl) {
      el.classList.add("has-photo");
      el.style.backgroundImage = `url("${dataUrl}")`;
      el.textContent = "";
    } else {
      el.classList.remove("has-photo");
      el.style.backgroundImage = "";
    }
  }

  function applyPhotosToAllCards() {
    document.querySelectorAll(".nc-dir-card[data-person-id]").forEach((card) => {
      const id = card.getAttribute("data-person-id") || "";
      const av = card.querySelector(".nc-dir-avatar");
      if (av) applyAvatarPhoto(av, id);
    });
  }

  function saveNotesStore() {
    try {
      window.localStorage.setItem(NOTE_STORAGE_KEY, JSON.stringify(notesByUserId || {}));
    } catch (_) {}
  }

  function getNotesFor(id) {
    const k = String(id || "");
    const arr = notesByUserId && Array.isArray(notesByUserId[k]) ? notesByUserId[k] : [];
    return arr.slice(0, 500);
  }

  function setNotesFor(id, notes) {
    const k = String(id || "");
    if (!notesByUserId || typeof notesByUserId !== "object") notesByUserId = {};
    notesByUserId[k] = Array.isArray(notes) ? notes.slice(0, 500) : [];
    saveNotesStore();
  }

  function setPendingImage(dataUrl, name = "") {
    pendingImageData = String(dataUrl || "");
    pendingImageName = String(name || "");
    if (noteAttach && noteAttachImg) {
      if (pendingImageData) {
        noteAttach.hidden = false;
        noteAttachImg.src = pendingImageData;
      } else {
        noteAttach.hidden = true;
        noteAttachImg.removeAttribute("src");
      }
    }
  }

  function setPendingAttachment(att) {
    pendingAttachment = att && att.url ? att : null;
    if (pendingAttachment && pendingAttachment.is_image) {
      setPendingImage(String(pendingAttachment.url || ""), String(pendingAttachment.name || ""));
    }
    renderNotePending();
  }

  function renderNotes() {
    if (!notesList) return;
    if (!selectedId) {
      notesList.innerHTML = `<div class="nc-sc2-chat-bubble">Select an employee to post notes.</div>`;
      return;
    }
    const notes = getNotesFor(selectedId);
    if (!notes.length) {
      notesList.innerHTML = `<div class="nc-sc2-chat-bubble">No notes yet.</div>`;
      return;
    }
    notesList.innerHTML = notes
      .map((n) => {
        const by = esc(n.by || "");
        const at = n.at ? new Date(n.at).toLocaleString() : "";
        const text = esc(n.text || "");
        const img = n && n.image_data ? String(n.image_data) : "";
        const att = n && n.attachment && n.attachment.url ? n.attachment : null;
        const isMe = String(n.by || "") === CURRENT_USER;
        const attHtml = att
          ? att.is_image
            ? `<div class="nc-sc2-chat-imgwrap"><img class="nc-sc2-chat-img" data-fullimg="1" alt="Attachment image" src="${esc(
                att.url
              )}"></div>`
            : `<div class="nc-sc2-chat-imgwrap"><a href="${esc(att.url)}" target="_blank" rel="noreferrer">${esc(
                att.name || "Attachment"
              )}</a></div>`
          : ``;
        return `<div class="nc-sc2-chat-bubble ${isMe ? "is-me" : ""}">
          <div><span class="nc-sc2-chat-by">${by}</span><span class="nc-sc2-chat-at">${esc(at)}</span></div>
          ${text ? `<div class="nc-sc2-chat-text">${text}</div>` : ``}
          ${img ? `<div class="nc-sc2-chat-imgwrap"><img class="nc-sc2-chat-img" data-fullimg="1" alt="Pasted image" src="${img}"></div>` : ``}
          ${attHtml}
        </div>`;
      })
      .join("");
    notesList.scrollTop = notesList.scrollHeight;
  }

  /** Keeps dept/q filters; syncs overlay with ?user_id= or ?new_resource=1 for reliable browser Back. */
  function buildDirectoryOverlayUrl(userId, mode) {
    const u = new URL(window.location.href);
    u.searchParams.delete("user_id");
    u.searchParams.delete("new_resource");
    if (mode === "create") {
      u.searchParams.set("new_resource", "1");
    } else if (userId) {
      u.searchParams.set("user_id", String(userId));
    }
    return u.pathname + u.search + u.hash;
  }

  function stripDirectoryOverlayFromUrl() {
    try {
      const u = new URL(window.location.href);
      const hadUrlOverlay = u.searchParams.has("user_id") || u.searchParams.get("new_resource") === "1";
      u.searchParams.delete("user_id");
      u.searchParams.delete("new_resource");
      const next = u.pathname + u.search + u.hash;

      const st = history.state;
      const hadStateOverlay = !!(st && typeof st === "object" && Object.prototype.hasOwnProperty.call(st, EDIT_HISTORY_KEY));
      let nextState = null;
      if (st && typeof st === "object") {
        nextState = { ...st };
        delete nextState[EDIT_HISTORY_KEY];
        if (!Object.keys(nextState).length) nextState = null;
      }

      if (!hadUrlOverlay && !hadStateOverlay) return;
      history.replaceState(nextState, "", next);
    } catch (_) {}
  }

  function pushEditState(userId, mode) {
    try {
      const base = history.state && typeof history.state === "object" ? history.state : {};
      const m = mode === "create" ? "create" : "edit";
      const id = String(userId || "");
      const payload = { ...base, [EDIT_HISTORY_KEY]: { id, mode: m } };
      const url = buildDirectoryOverlayUrl(m === "create" ? "" : id, m);
      const cur = window.location.pathname + window.location.search + window.location.hash;
      if (url === cur) {
        history.replaceState(payload, "", url);
      } else {
        history.pushState(payload, "", url);
      }
    } catch (_) {}
  }

  /** Must use only the popstate event's state — never fall back to history.state (stale overlay state breaks Back). */
  function editStateFromHistory(st) {
    try {
      if (!st || typeof st !== "object") return null;
      const v = st[EDIT_HISTORY_KEY];
      return v != null ? v : null;
    } catch (_) {
      return null;
    }
  }

  function imgStateFromHistory(st) {
    try {
      if (!st || typeof st !== "object") return null;
      const v = st[IMG_HISTORY_KEY];
      return v != null ? v : null;
    } catch (_) {
      return null;
    }
  }

  function openImgViewer(src, title = "Image", opts = {}) {
    if (!imgViewer || !imgViewerEl) return;
    const { pushHistory = true } = opts || {};
    try {
      if (window.ncSyncViewerOffsets) window.ncSyncViewerOffsets();
    } catch (_) {}
    if (imgViewerTitle) imgViewerTitle.textContent = title;
    imgViewerEl.src = String(src || "");
    imgViewer.hidden = false;
    document.body.style.overflow = "hidden";
    if (pushHistory) {
      try {
        const base = history.state && typeof history.state === "object" ? history.state : {};
        history.pushState({ ...base, [IMG_HISTORY_KEY]: { title, src: String(src || "") } }, "", window.location.href);
      } catch (_) {}
    }
  }

  function closeImgViewer(opts = {}) {
    if (!imgViewer || !imgViewerEl) return;
    const { popHistory = true } = opts || {};
    imgViewer.hidden = true;
    imgViewerEl.removeAttribute("src");
    document.body.style.overflow = "";
    if (popHistory && history.state && history.state[IMG_HISTORY_KEY]) {
      history.back();
    }
  }

  function openEditShell() {
    if (!editDlg) return;
    try {
      if (window.ncSyncViewerOffsets) window.ncSyncViewerOffsets();
    } catch (_) {}
    editDlg.hidden = false;
    editDlg.setAttribute("aria-hidden", "false");
    setFormMode(viewMode);

    if (noteText) noteText.disabled = false;
    if (noteSend) noteSend.disabled = false;
    if (chatMeta) chatMeta.textContent = `Posting about ${String(selectedId || "")} as ${CURRENT_USER}`;
    renderNotes();

    // Photo preview
    try {
      const u = selectedId ? getPhotoFor(selectedId) : "";
      if (photoPreview) photoPreview.style.backgroundImage = u ? `url("${u}")` : "";
      if (photoInput) photoInput.value = "";
    } catch (_) {}
  }

  function closeEditShell() {
    if (!editDlg) return;
    editDlg.hidden = true;
    editDlg.setAttribute("aria-hidden", "true");

    if (noteText) noteText.value = "";
    setPendingImage("", "");
    pendingAttachment = null;
    renderNotePending();
    if (photoInput) photoInput.value = "";
    stripDirectoryOverlayFromUrl();
  }

  function closeEditShellViaHistory() {
    if (!editDlg || editDlg.hidden) return;
    const sp = new URLSearchParams(window.location.search || "");
    const urlHasOverlay = sp.has("user_id") || sp.get("new_resource") === "1";
    const stateHasOverlay = !!(history.state && typeof history.state === "object" && history.state[EDIT_HISTORY_KEY]);
    if (urlHasOverlay || stateHasOverlay) {
      try {
        history.back();
        return;
      } catch (_) {}
    }
    closeEditShell();
  }

  function setFormMode(mode) {
    viewMode = mode === "edit" ? "edit" : "view";
    const isEdit = viewMode === "edit";
    const inputs = editForm ? editForm.querySelectorAll("input, select, textarea, button") : [];
    inputs.forEach((el) => {
      const id = el.id || "";
      if (id === "nc-dir-edit-x" || id === "nc-dir-mode-edit") return;
      if (id === "nc-dir-photo-choose" || id === "nc-dir-photo-remove") return;
      if (id === "nc-dir-note-send" || id === "nc-dir-note-text" || id === "nc-dir-note-attach-x") return;
      if (el === editSave || el === editCancel) return;
      if (el === photoInput) return;
      if (el.tagName === "BUTTON" && (el === noteSend || el === photoChoose || el === photoRemove)) return;
      if (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA") {
        el.disabled = !isEdit;
      }
    });
    if (editSave) editSave.hidden = !isEdit;
    if (modeEditBtn) modeEditBtn.hidden = isEdit;
    if (editCancel) editCancel.textContent = isEdit ? "Cancel" : "Close";
    try {
      if (isEdit) (efFirstName || efEmail || efDept || editSave).focus();
    } catch (_) {}
  }

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function companyPayloadFields() {
    return {
      abn: companyAbn ? companyAbn.value.trim() : "",
      acn: companyAcn ? companyAcn.value.trim() : "",
      company_rep: companyRep ? companyRep.value.trim() : "",
    };
  }

  function companyBySelectId(id) {
    return contractorCompanies.find((c) => String(c.id) === String(id));
  }

  function rebuildCompanySelect(preserveValue) {
    if (!companySelect) return;
    const prev = preserveValue != null ? String(preserveValue) : companySelect.value;
    companySelect.innerHTML =
      '<option value="">— Select company —</option>' +
      contractorCompanies
        .map((c) => `<option value="${escAttr(String(c.id))}">${esc(c.name)}</option>`)
        .join("") +
      '<option value="__new__">Add new company…</option>';
    if (prev && [...companySelect.options].some((o) => o.value === prev)) companySelect.value = prev;
  }

  function syncCompanyDocLinks(cc) {
    const docs = cc && cc.documents ? cc.documents : {};
    function one(kind, statusEl, linkEl) {
      const d = docs[kind];
      if (statusEl) statusEl.textContent = d && d.original_name ? d.original_name : "";
      if (linkEl) {
        if (d && d.url) {
          linkEl.href = d.url;
          linkEl.hidden = false;
        } else {
          linkEl.hidden = true;
          linkEl.removeAttribute("href");
        }
      }
    }
    one("pi_pl_insurance", docPiplStatus, docPiplLink);
    one("workcover", docWcStatus, docWcLink);
  }

  function applyCompanySelectionFromDropdown() {
    if (!companySelect) return;
    const v = companySelect.value;
    if (v === "__new__") {
      if (companyNameRow) companyNameRow.hidden = false;
      if (companyAbn) companyAbn.value = "";
      if (companyAcn) companyAcn.value = "";
      if (companyRep) companyRep.value = "";
      if (companyNameNew) companyNameNew.value = "";
      syncCompanyDocLinks(null);
      return;
    }
    if (companyNameRow) companyNameRow.hidden = true;
    if (!v) {
      if (companyAbn) companyAbn.value = "";
      if (companyAcn) companyAcn.value = "";
      if (companyRep) companyRep.value = "";
      syncCompanyDocLinks(null);
      return;
    }
    const co = companyBySelectId(v);
    if (companyAbn) companyAbn.value = co ? co.abn || "" : "";
    if (companyAcn) companyAcn.value = co ? co.acn || "" : "";
    if (companyRep) companyRep.value = co ? co.company_rep || "" : "";
    syncCompanyDocLinks(co || null);
  }

  function syncContractorSections() {
    const on = !!(efIsContractor && efIsContractor.checked);
    if (contractFields) contractFields.hidden = !on;
    if (companyFields) companyFields.hidden = !on;
  }

  function splitLegacyFullName(full) {
    const s = String(full || "").trim();
    if (!s) return { first: "", surname: "" };
    const i = s.indexOf(" ");
    if (i < 0) return { first: s, surname: "" };
    return { first: s.slice(0, i).trim(), surname: s.slice(i + 1).trim() };
  }

  function composePersonDisplayName() {
    const a = String(efFirstName ? efFirstName.value : "").trim();
    const b = String(efSurname ? efSurname.value : "").trim();
    return [a, b].filter(Boolean).join(" ").trim();
  }

  function syncLocationFieldsUi() {
    if (!efLocSelect || !efLocOtherWrap) return;
    const v = efLocSelect.value || "";
    efLocOtherWrap.hidden = v !== "Other";
    if (v !== "Other" && efLocOther) efLocOther.value = "";
  }

  function applyEditLocationFromPerson(edit) {
    if (!efLocSelect) return;
    const loc = String(edit.location || "").trim();
    const detail = String(edit.location_detail || "").trim();
    const allowed = new Set(["Melbourne", "Sydney", "Canberra", "South Australia", "Queensland", "Other"]);
    let canon = loc;
    let od = detail;
    const m = /^Other\s*\((.+)\)\s*$/.exec(loc);
    if (m) {
      canon = "Other";
      od = m[1].trim();
    }
    if (canon && allowed.has(canon)) {
      efLocSelect.value = canon;
      if (canon === "Other" && efLocOther) efLocOther.value = od;
    } else if (canon) {
      efLocSelect.value = "Other";
      if (efLocOther) efLocOther.value = od || canon;
    } else {
      efLocSelect.value = "";
      if (efLocOther) efLocOther.value = "";
    }
    syncLocationFieldsUi();
  }

  function readLocationPayload() {
    const sel = efLocSelect ? String(efLocSelect.value || "").trim() : "";
    const other = efLocOther ? String(efLocOther.value || "").trim().slice(0, 120) : "";
    if (!sel) return { location: "", location_detail: "" };
    if (sel === "Other") return { location: "Other", location_detail: other };
    return { location: sel, location_detail: "" };
  }

  efLocSelect?.addEventListener("change", syncLocationFieldsUi);

  function generateIntranetPassword() {
    try {
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
      const arr = new Uint8Array(18);
      crypto.getRandomValues(arr);
      let out = "";
      for (let i = 0; i < 18; i++) out += chars[arr[i] % chars.length];
      return `${out}!a`;
    } catch (_) {
      return `Tmp${Date.now().toString(36)}!x9`;
    }
  }

  function refreshGeneratedPasswordDisplay() {
    if (!accountPwDisplayEl) return;
    const pw = generateIntranetPassword();
    accountPwDisplayEl.textContent = pw;
    accountPwDisplayEl.dataset.password = pw;
  }

  function syncAccountNameToPhoneDisplay() {
    if (!accountPhoneDisplayEl || accountPhoneDisplayDirty) return;
    const src = accountNameEl && String(accountNameEl.value || "").trim()
      ? accountNameEl.value
      : composePersonDisplayName();
    accountPhoneDisplayEl.value = String(src || "").trim();
  }

  function syncCreateAccountVisibility() {
    if (!createAccountWrap || !intranetAccountFields) return;
    const isCreate = !!isCreating;
    createAccountWrap.hidden = !isCreate;
    const yesRadio = document.querySelector('input[name="nc-dir-create-account"][value="yes"]');
    const yes = !!(yesRadio && yesRadio.checked);
    intranetAccountFields.hidden = !isCreate || !yes;
    if (isCreate && yes) {
      refreshGeneratedPasswordDisplay();
      if (accountEmailEl && efEmail) accountEmailEl.value = String(efEmail.value || "").trim();
    }
  }

  function resetIntranetAccountForm() {
    accountPhoneDisplayDirty = false;
    if (accountEmailEl) accountEmailEl.value = "";
    if (accountNameEl) accountNameEl.value = "";
    if (accountPhoneDisplayEl) accountPhoneDisplayEl.value = "";
    if (accountRequirePwEl) accountRequirePwEl.checked = true;
    const noRadio = document.querySelector('input[name="nc-dir-create-account"][value="no"]');
    if (noRadio) noRadio.checked = true;
    if (accountPwDisplayEl) {
      accountPwDisplayEl.textContent = "—";
      delete accountPwDisplayEl.dataset.password;
    }
    syncCreateAccountVisibility();
  }

  async function uploadCompanyDocument(companyId, kind, file) {
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch(`/intranet/api/contractor-companies/${encodeURIComponent(String(companyId))}/documents/${kind}`, {
      method: "POST",
      credentials: "same-origin",
      body: fd,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.company) throw new Error(j.error || "Upload failed");
    const ix = contractorCompanies.findIndex((c) => String(c.id) === String(j.company.id));
    if (ix >= 0) contractorCompanies[ix] = j.company;
    else contractorCompanies.push(j.company);
    syncCompanyDocLinks(j.company);
    return j.company;
  }

  function clearPendingCompanyDocsState() {
    pendingCompanyDocs = { pi_pl_insurance: null, workcover: null };
    if (docPiplInput) docPiplInput.value = "";
    if (docWcInput) docWcInput.value = "";
  }

  function pendingFileIcon(name) {
    const ext = String(name || "")
      .split(".")
      .pop()
      .toLowerCase();
    if (ext === "pdf") return "📕";
    if (["ppt", "pptx", "pps", "ppsx", "odp", "key"].includes(ext)) return "📊";
    if (["xls", "xlsx", "csv", "numbers"].includes(ext)) return "📗";
    if (["doc", "docx", "rtf", "txt", "md"].includes(ext)) return "📘";
    if (["zip", "rar", "7z", "gz", "tgz"].includes(ext)) return "🗜️";
    if (["mp4", "mov", "webm", "mkv"].includes(ext)) return "🎬";
    if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "🖼️";
    return "📎";
  }

  function renderNotePending() {
    if (!notePending) return;
    const att = pendingAttachment && pendingAttachment.url && !pendingAttachment.is_image ? pendingAttachment : null;
    if (!att) {
      notePending.hidden = true;
      notePending.innerHTML = "";
      return;
    }
    const fn = esc(att.name || "Attachment");
    const ic = pendingFileIcon(att.name);
    notePending.hidden = false;
    notePending.innerHTML = `<div class="nc-sc2-chat-pending-item nc-sc2-chat-pending-item--file" style="flex-direction:row;align-items:center;min-height:3rem;">
      <button type="button" class="nc-sc2-chat-pending-x" aria-label="Remove file attachment">&times;</button>
      <div class="nc-dir-pending-file-inner">
        <span class="nc-dir-pending-file-ic" aria-hidden="true">${ic}</span>
        <div style="min-width:0;">
          <div class="nc-sc2-chat-pending-fn">${fn}</div>
          <div class="nc-sc2-chat-pending-meta">Ready to attach — Post or Enter</div>
        </div>
      </div>
    </div>`;
  }

  function formatLocalTime(tz) {
    const z = tz && String(tz).trim() ? String(tz).trim() : "Australia/Melbourne";
    try {
      return new Intl.DateTimeFormat(undefined, {
        timeZone: z,
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(new Date());
    } catch (_) {
      return new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    }
  }

  function updateLocalTimeClock(tz) {
    if (vTime) vTime.textContent = formatLocalTime(tz);
  }

  function selectCard(id) {
    document.querySelectorAll(".nc-dir-card.is-selected").forEach((c) => c.classList.remove("is-selected"));
    const card = document.querySelector('.nc-dir-card[data-person-id="' + id + '"]');
    if (card) card.classList.add("is-selected");
  }

  function applyPresence(presence) {
    const st = presence && presence.status ? String(presence.status) : "offline";
    const label = presence && presence.label ? String(presence.label) : "Offline";
    if (elStatus) elStatus.textContent = label;
    const dot = panel.querySelector(".nc-dir-online-dot");
    if (dot) {
      dot.classList.toggle("is-away", st === "away");
      dot.classList.toggle("is-offline", st === "offline");
    }
  }

  async function pingPresence() {
    try {
      await fetch("/intranet/api/presence/ping", { method: "POST", credentials: "same-origin" });
    } catch (_) {}
  }

  async function refreshPresence() {
    await pingPresence();
    const ids = [];
    document.querySelectorAll(".nc-dir-card[data-person-id]").forEach((c) => {
      const id = c.getAttribute("data-person-id");
      if (id) ids.push(id);
    });
    if (selectedId && !ids.includes(selectedId)) ids.push(selectedId);
    if (!ids.length) return;
    try {
      const r = await fetch(`/intranet/api/presence/status?ids=${encodeURIComponent(ids.join(","))}`, {
        credentials: "same-origin",
      });
      if (!r.ok) return;
      const j = await r.json().catch(() => ({}));
      const items = j.items || [];
      const by = new Map(items.map((x) => [String(x.id), x]));
      if (selectedId) applyPresence(by.get(String(selectedId)));
    } catch (_) {}
  }

  async function ensurePersonLoaded(rawId) {
    const sid = String(rawId || "").trim();
    if (!sid) return null;
    let person = personById(sid);
    if (person) return person;
    try {
      const r = await fetch(`/intranet/api/users/${encodeURIComponent(sid)}`, { credentials: "same-origin" });
      if (!r.ok) return null;
      const j = await r.json().catch(() => ({}));
      if (j.user) {
        const uid = String(j.user.id);
        byId.set(uid, j.user);
        byIdResolve.set(uid, j.user);
        return j.user;
      }
    } catch (_) {}
    return null;
  }

  function openViewDialog(person) {
    if (!person) return;
    viewMode = "view";
    isCreating = false;
    openEditDialog(person);
    setFormMode("view");
  }

  function updateCardFromPerson(person) {
    const card = document.querySelector('.nc-dir-card[data-person-id="' + String(person.id) + '"]');
    if (!card) return;
    const ct = !!(person && person.is_contractor);
    card.classList.toggle("is-employee", !ct);
    card.classList.toggle("is-contractor", ct);
    const nameEl = card.querySelector(".nc-dir-card-name");
    if (nameEl) nameEl.textContent = person.name || "";
    const titleEl = card.querySelector(".nc-dir-card-title");
    if (titleEl) titleEl.textContent = person.job_title || "";
    const deptPill = card.querySelector(".nc-dir-dept-pill");
    if (deptPill) deptPill.textContent = person.department || "";
    const emailEl = card.querySelector(".nc-dir-card-email");
    if (emailEl) emailEl.textContent = person.email || person.email_display || "";
    const phoneEl = card.querySelector(".nc-dir-card-phone");
    if (phoneEl) phoneEl.textContent = person.phone || "";
    const av = card.querySelector(".nc-dir-avatar");
    if (av) {
      av.textContent = person.initials || "?";
      av.setAttribute("data-tone", String(person.tone != null ? person.tone : 0));
      applyAvatarPhoto(av, person.id);
    }
  }

  function openEditDialog(person, opts = {}) {
    if (!editDlg || !person) return;
    const { pushHistory = true } = opts || {};
    selectedId = String(person.id);
    isCreating = false;
    const e = person.edit || {};
    let fn = String(e.first_name || "").trim();
    let sn = String(e.surname || "").trim();
    if (!fn && !sn && e.full_name) {
      const sp = splitLegacyFullName(e.full_name);
      fn = sp.first;
      sn = sp.surname;
    }
    if (efFirstName) efFirstName.value = fn;
    if (efSurname) efSurname.value = sn;
    if (efEmail) efEmail.value = e.email || person.email || "";
    if (efPhone) efPhone.value = e.phone || person.phone || "";
    if (efDept) efDept.value = e.department || "";
    rebuildProjectSelect(e.workforce_project || "");
    setNewProjectFieldsVisible(false);
    if (efTitle) efTitle.value = e.job_title || "";
    applyEditLocationFromPerson(e);
    if (efRep) efRep.value = e.reports_to || "";
    if (efStart) efStart.value = parseContractEndToIsoDate(e.start_date || "") || "";
    if (efContractSign) efContractSign.value = parseContractEndToIsoDate(e.contract_sign_date || "") || "";
    if (efContractStart) efContractStart.value = parseContractEndToIsoDate(e.contract_start_date || "") || "";
    if (efContractEnd) efContractEnd.value = parseContractEndToIsoDate(e.contract_end_date || "") || "";
    if (efTz) efTz.value = e.timezone || "";
    if (efIsContractor) efIsContractor.checked = !!e.is_contractor;
    if (editStatus) editStatus.textContent = "";
    if (topTitle) topTitle.textContent = "Edit Resource";
    rebuildCompanySelect();
    clearPendingCompanyDocsState();
    if (companySelect) {
      const cid = e.contractor_company_id != null ? String(e.contractor_company_id) : "";
      companySelect.value = cid && [...companySelect.options].some((o) => o.value === cid) ? cid : "";
    }
    if (companyNameRow) companyNameRow.hidden = true;
    if (companyNameNew) companyNameNew.value = "";
    applyCompanySelectionFromDropdown();
    if (e.contractor_company) syncCompanyDocLinks(e.contractor_company);
    syncContractorSections();
    if (createAccountWrap) createAccountWrap.hidden = true;
    if (intranetAccountFields) intranetAccountFields.hidden = true;
    if (pushHistory) pushEditState(person.id, "edit");
    openEditShell();
  }

  function openCreateDialog(opts = {}) {
    if (!editDlg) return;
    const { pushHistory = true } = opts || {};
    selectedId = null;
    isCreating = true;
    viewMode = "edit";
    setFormMode("edit");
    if (efFirstName) efFirstName.value = "";
    if (efSurname) efSurname.value = "";
    if (efEmail) efEmail.value = "";
    if (efPhone) efPhone.value = "";
    if (efDept) efDept.value = "";
    rebuildProjectSelect("");
    setNewProjectFieldsVisible(false);
    if (efTitle) efTitle.value = "";
    applyEditLocationFromPerson({});
    if (efRep) efRep.value = "";
    if (efStart) efStart.value = "";
    if (efContractSign) efContractSign.value = "";
    if (efContractStart) efContractStart.value = "";
    if (efContractEnd) efContractEnd.value = "";
    if (efTz) efTz.value = "";
    if (efIsContractor) efIsContractor.checked = false;
    if (editStatus) editStatus.textContent = "";
    setPendingImage("", "");
    if (topTitle) topTitle.textContent = "Add Resource";
    rebuildCompanySelect();
    clearPendingCompanyDocsState();
    if (companySelect) companySelect.value = "";
    if (companyNameRow) companyNameRow.hidden = true;
    if (companyNameNew) companyNameNew.value = "";
    if (companyAbn) companyAbn.value = "";
    if (companyAcn) companyAcn.value = "";
    if (companyRep) companyRep.value = "";
    syncCompanyDocLinks(null);
    syncContractorSections();
    resetIntranetAccountForm();
    // Ensure browser back returns to the directory page (closes this overlay).
    if (pushHistory) pushEditState("", "create");
    openEditShell();
    try {
      if (efFirstName) efFirstName.focus();
    } catch (_) {}
  }

  async function saveEdits() {
    const person = selectedId ? personById(selectedId) : null;
    if (editSave) editSave.disabled = true;
    if (editStatus) editStatus.textContent = "Saving…";
    try {
      const isContractor = efIsContractor ? !!efIsContractor.checked : false;
      let resolvedCompanyId = null;

      if (isContractor) {
        const sel = companySelect ? companySelect.value : "";
        if (!sel || sel === "") {
          throw new Error('Select a company or choose "Add new company".');
        }
        if (sel === "__new__") {
          const nm = companyNameNew ? companyNameNew.value.trim() : "";
          if (!nm) throw new Error("Enter the new company legal name.");
          const cr = await fetch("/intranet/api/contractor-companies", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: nm, ...companyPayloadFields() }),
          });
          const cj = await cr.json().catch(() => ({}));
          if (!cr.ok || !cj.company) throw new Error(cj.error || "Could not create company");
          resolvedCompanyId = cj.company.id;
          const ix = contractorCompanies.findIndex((c) => String(c.id) === String(cj.company.id));
          if (ix >= 0) contractorCompanies[ix] = cj.company;
          else contractorCompanies.push(cj.company);
          rebuildCompanySelect(String(resolvedCompanyId));
        } else {
          resolvedCompanyId = parseInt(sel, 10);
          if (Number.isNaN(resolvedCompanyId)) throw new Error("Invalid company");
          const cur = companyBySelectId(sel);
          const pack = companyPayloadFields();
          if (
            cur &&
            (pack.abn !== (cur.abn || "") ||
              pack.acn !== (cur.acn || "") ||
              pack.company_rep !== (cur.company_rep || ""))
          ) {
            const pr = await fetch(`/intranet/api/contractor-companies/${encodeURIComponent(String(resolvedCompanyId))}`, {
              method: "PATCH",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(pack),
            });
            const pj = await pr.json().catch(() => ({}));
            if (!pr.ok) throw new Error(pj.error || "Company update failed");
            if (pj.company) {
              const i2 = contractorCompanies.findIndex((c) => String(c.id) === String(pj.company.id));
              if (i2 >= 0) contractorCompanies[i2] = pj.company;
            }
          }
        }
      }

      const createIntranetAccount =
        !!isCreating &&
        !!document.querySelector('input[name="nc-dir-create-account"][value="yes"]')?.checked;

      let workforceProjectVal = efProject ? efProject.value : "";
      if (workforceProjectVal === "__create_new__") {
        const nm = newProjectName ? canonicalProjectName(newProjectName.value) : "";
        if (!nm) throw new Error("Enter the new project name.");
        const k = keyForProject(nm);
        const taken = allKnownProjectLabels().some((n) => keyForProject(n) === k);
        if (taken) throw new Error("A project with that name already exists.");
        const directorVal = String((newProjectDirector && newProjectDirector.value) || "").trim().slice(0, 120);
        const contractEndVal = String((newProjectContractEnd && newProjectContractEnd.value) || "").trim().slice(0, 32);
        const cur = loadProjectStore();
        if (!cur.map((x) => keyForProject(x)).includes(k)) {
          cur.push(nm);
          cur.sort((a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: "base" }));
          saveProjectStore(cur);
        }
        projectMeta[k] = { director: directorVal, contractEnd: contractEndVal };
        saveProjectMeta(projectMeta);
        rebuildProjectSelect(nm);
        if (efProject) efProject.value = nm;
        workforceProjectVal = nm;
        setNewProjectFieldsVisible(false);
        try {
          insertEmptyProjectSection(nm);
          document.querySelectorAll(".nc-dir-project[data-project]").forEach((s) => {
            if (keyForProject(s.getAttribute("data-project") || "") === k) refreshProjectMetaDisplay(s);
          });
          renderAllProjects();
          syncEmployeeDirectoryVisibility();
          syncWorkforceProjectsCatalogToServer();
        } catch (_) {}
      }

      const locPack = readLocationPayload();
      const fn = efFirstName ? efFirstName.value.trim() : "";
      const sn = efSurname ? efSurname.value.trim() : "";
      const composed = composePersonDisplayName();
      const resourceEmail = efEmail ? efEmail.value.trim() : "";
      if (!resourceEmail || !resourceEmail.includes("@")) {
        throw new Error("Email is required as the unique resource identifier.");
      }

      let payload = {
        first_name: fn,
        surname: sn,
        full_name: composed,
        email: resourceEmail,
        phone: efPhone ? efPhone.value : "",
        department: efDept ? efDept.value : "",
        workforce_project: workforceProjectVal,
        job_title: efTitle ? efTitle.value : "",
        location: locPack.location,
        location_detail: locPack.location_detail,
        reports_to: efRep ? efRep.value : "",
        start_date: efStart ? efStart.value : "",
        contract_sign_date: efContractSign ? efContractSign.value : "",
        contract_start_date: efContractStart ? efContractStart.value : "",
        contract_end_date: efContractEnd ? efContractEnd.value : "",
        timezone: efTz ? efTz.value : "",
        is_contractor: isContractor,
      };

      if (isCreating) {
        payload.create_intranet_account = createIntranetAccount;
      }

      if (createIntranetAccount) {
        const nm = accountNameEl ? accountNameEl.value.trim() : "";
        const handle = accountPhoneDisplayEl ? accountPhoneDisplayEl.value.trim() : "";
        const pwRaw =
          (accountPwDisplayEl && accountPwDisplayEl.dataset.password) ||
          (accountPwDisplayEl && accountPwDisplayEl.textContent) ||
          "";
        const pw = String(pwRaw).trim();
        const reqPw = accountRequirePwEl ? !!accountRequirePwEl.checked : true;
        if (!nm) throw new Error("Enter the display name for the intranet account.");
        if (!pw || pw === "—") throw new Error("Generate a password by selecting Yes again.");
        payload.password = pw;
        payload.require_pw_change = reqPw;
        payload.full_name = composed || nm;
        if (handle) payload.handle = handle;
      }
      if (isContractor && resolvedCompanyId != null) {
        payload.contractor_company_id = resolvedCompanyId;
      }
      if (!isContractor) {
        payload.contractor_company_id = null;
      }

      const r = await fetch(
        isCreating ? `/intranet/api/users` : `/intranet/api/users/${encodeURIComponent(String(person.id))}`,
        {
          method: isCreating ? "POST" : "PATCH",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.user) throw new Error(j.error || "Save failed");
      const updated = j.user;

      if (isContractor && resolvedCompanyId != null) {
        const tries = [
          ["pi_pl_insurance", pendingCompanyDocs.pi_pl_insurance, docPiplInput],
          ["workcover", pendingCompanyDocs.workcover, docWcInput],
        ];
        for (const [kind, pend, inp] of tries) {
          const file = pend || (inp && inp.files && inp.files[0]);
          if (file) {
            await uploadCompanyDocument(resolvedCompanyId, kind, file);
          }
        }
      }
      clearPendingCompanyDocsState();

      closeEditShell();
      if (isCreating) {
        // New records affect grouping/layout; easiest is a refresh.
        window.location.reload();
        return;
      }
      byId.set(String(updated.id), updated);
      applyPersonWorkforceProjectToMembers(updated);
      updateCardFromPerson(updated);
      selectCard(String(updated.id));
      renderAllProjects();
      syncEmployeeDirectoryVisibility();
      applyPhotosToAllCards();
    } catch (e) {
      if (editStatus) editStatus.textContent = String(e && e.message ? e.message : e) || "Save failed";
    } finally {
      if (editSave) editSave.disabled = false;
    }
  }

  function closePanel() {
    // legacy no-op (panel removed)
  }

  function wireCardGrid(g) {
    if (!g) return;
    g.addEventListener("click", (e) => {
      const t = e.target;
      if (t && t.closest && t.closest("a.nc-dir-card-email")) return;
      const card = t && t.closest ? t.closest(".nc-dir-card[data-person-id]") : null;
      if (!card || !g.contains(card)) return;
      e.preventDefault();
      const id = card.getAttribute("data-person-id");
      const person = id ? byId.get(String(id)) : null;
      if (person) openViewDialog(person);
    });

    g.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const t = e.target;
      const card = t && t.closest ? t.closest(".nc-dir-card[data-person-id]") : null;
      if (!card || !g.contains(card)) return;
      e.preventDefault();
      const id = card.getAttribute("data-person-id");
      const person = id ? byId.get(String(id)) : null;
      if (person) openViewDialog(person);
    });
  }

  wireCardGrid(grid);
  // Contractors are rendered in multiple project grids now; delegate from document.
  document.addEventListener("click", (e) => {
    const t = e.target;
    if (t && t.closest && t.closest("a.nc-dir-card-email")) return;
    const card = t && t.closest ? t.closest(".nc-dir-card[data-person-id]") : null;
    if (!card) return;
    // If click came from employee grid, wireCardGrid already handled it.
    if (grid && grid.contains(card)) return;
    e.preventDefault();
    const id = card.getAttribute("data-person-id");
    const person = id ? personById(id) : null;
    if (person) {
      openViewDialog(person);
      return;
    }
    if (id)
      ensurePersonLoaded(id).then((p) => {
        if (p) {
          renderAllProjects();
          syncEmployeeDirectoryVisibility();
          openViewDialog(p);
        }
      });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const t = e.target;
    const card = t && t.closest ? t.closest(".nc-dir-card[data-person-id]") : null;
    if (!card) return;
    if (grid && grid.contains(card)) return;
    e.preventDefault();
    const id = card.getAttribute("data-person-id");
    const person = id ? personById(id) : null;
    if (person) {
      openViewDialog(person);
      return;
    }
    if (id)
      ensurePersonLoaded(id).then((p) => {
        if (p) {
          renderAllProjects();
          syncEmployeeDirectoryVisibility();
          openViewDialog(p);
        }
      });
  });

  // Project group collapse toggles
  document.addEventListener("click", (e) => {
    const t = e.target;
    const btn = t && t.closest ? t.closest("button.nc-dir-project-toggle[data-toggle]") : null;
    if (!btn) return;
    const sec = btn.closest(".nc-dir-project");
    if (!sec) return;
    sec.classList.toggle("is-collapsed");
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (createProjectDlg && !createProjectDlg.hidden) {
        closeCreateProjectModal();
        return;
      }
      if (editDlg && !editDlg.hidden) {
        closeEditShellViaHistory();
        return;
      }
    }
  });

  if (modeEditBtn) modeEditBtn.addEventListener("click", () => setFormMode("edit"));
  if (editCancel) editCancel.addEventListener("click", () => closeEditShellViaHistory());
  if (editX) editX.addEventListener("click", () => closeEditShellViaHistory());
  if (editForm) {
    editForm.addEventListener("submit", (e) => {
      e.preventDefault();
      saveEdits();
    });
  }

  if (addNewBtn) addNewBtn.addEventListener("click", () => openCreateDialog({ pushHistory: true }));

  // Project creation + assignment UI
  try {
    // Legacy: browser-only project names not yet on server (admins migrate them on first load via sync below).
    const saved = loadProjectStore();
    const existing = existingProjectNamesFromDom();
    if (canEditProjects()) {
      for (const p of saved) {
        const pk = keyForProject(canonicalProjectName(p));
        if (pk && !existing.has(pk)) insertEmptyProjectSection(p);
      }
    }
    renderAllProjects();
    syncEmployeeDirectoryVisibility();
    document.querySelectorAll(".nc-dir-project[data-project]").forEach((sec) => refreshProjectMetaDisplay(sec));
    if (canEditProjects()) syncWorkforceProjectsCatalogToServer();
  } catch (_) {}

  function setCreateProjectModalError(msg) {
    if (!createProjectErr) return;
    if (!msg) {
      createProjectErr.hidden = true;
      createProjectErr.textContent = "";
      return;
    }
    createProjectErr.hidden = false;
    createProjectErr.textContent = msg;
  }

  function clearCreateProjectModalForm() {
    setCreateProjectModalError("");
    if (modalNewProjectName) modalNewProjectName.value = "";
    if (modalNewProjectDirector) modalNewProjectDirector.value = "";
    if (modalNewProjectContractEnd) modalNewProjectContractEnd.value = "";
  }

  function openCreateProjectModal() {
    if (!createProjectDlg || !canEditProjects()) return;
    clearCreateProjectModalForm();
    createProjectDlg.hidden = false;
    createProjectDlg.setAttribute("aria-hidden", "false");
    try {
      if (window.ncSyncViewerOffsets) window.ncSyncViewerOffsets();
    } catch (_) {}
    try {
      if (modalNewProjectName) modalNewProjectName.focus();
    } catch (_) {}
  }

  function closeCreateProjectModal() {
    if (!createProjectDlg || createProjectDlg.hidden) return;
    createProjectDlg.hidden = true;
    createProjectDlg.setAttribute("aria-hidden", "true");
    clearCreateProjectModalForm();
  }

  function submitCreateProjectModal() {
    if (!canEditProjects()) return;
    setCreateProjectModalError("");
    const nm = modalNewProjectName ? canonicalProjectName(modalNewProjectName.value) : "";
    if (!nm) {
      setCreateProjectModalError("Enter the project name.");
      try {
        if (modalNewProjectName) modalNewProjectName.focus();
      } catch (_) {}
      return;
    }
    const k = keyForProject(nm);
    const taken = allKnownProjectLabels().some((n) => keyForProject(n) === k);
    if (taken) {
      setCreateProjectModalError("A project with that name already exists.");
      try {
        if (modalNewProjectName) modalNewProjectName.focus();
      } catch (_) {}
      return;
    }
    const directorVal = String((modalNewProjectDirector && modalNewProjectDirector.value) || "")
      .trim()
      .slice(0, 120);
    const contractEndVal = String((modalNewProjectContractEnd && modalNewProjectContractEnd.value) || "")
      .trim()
      .slice(0, 32);
    const cur = loadProjectStore();
    if (!cur.map((x) => keyForProject(x)).includes(k)) {
      cur.push(nm);
      cur.sort((a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: "base" }));
      saveProjectStore(cur);
    }
    projectMeta[k] = { director: directorVal, contractEnd: contractEndVal };
    saveProjectMeta(projectMeta);
    try {
      insertEmptyProjectSection(nm);
      document.querySelectorAll(".nc-dir-project[data-project]").forEach((s) => {
        if (keyForProject(s.getAttribute("data-project") || "") === k) refreshProjectMetaDisplay(s);
      });
      renderAllProjects();
      syncEmployeeDirectoryVisibility();
      syncWorkforceProjectsCatalogToServer();
    } catch (_) {}
    const prevSel = efProject ? efProject.value : "";
    rebuildProjectSelect(prevSel);
    try {
      const sec = Array.from(document.querySelectorAll(".nc-dir-project[data-project]")).find(
        (s) => keyForProject(s.getAttribute("data-project") || "") === k
      );
      if (sec) sec.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (_) {}
    closeCreateProjectModal();
  }

  if (createProjectBtn) {
    createProjectBtn.addEventListener("click", () => openCreateProjectModal());
  }
  if (createProjectForm) {
    createProjectForm.addEventListener("submit", (e) => {
      e.preventDefault();
      submitCreateProjectModal();
    });
  }
  if (createProjectCancel) createProjectCancel.addEventListener("click", () => closeCreateProjectModal());
  if (createProjectX) createProjectX.addEventListener("click", () => closeCreateProjectModal());
  if (createProjectScrim) createProjectScrim.addEventListener("click", () => closeCreateProjectModal());

  // Inline project details editor (name, director, contract end)
  document.addEventListener("click", (e) => {
    const t = e.target;
    const btn = t && t.closest ? t.closest("button[data-project-edit]") : null;
    if (!btn) return;
    if (!canEditProjects()) return;
    const sec = btn.closest(".nc-dir-project[data-project]");
    if (!sec) return;
    const oldName = canonicalProjectName(sec.getAttribute("data-project") || "");
    if (!oldName) return;

    const titleWrap = sec.querySelector(".nc-dir-project-title");
    const fieldsEl = sec.querySelector(".nc-dir-project-fields");
    const head = sec.querySelector(".nc-dir-project-head");
    if (!titleWrap || !fieldsEl) return;

    if (titleWrap.querySelector(".nc-dir-project-editpanel")) return;

    const pk = keyForProject(oldName);
    const meta = (pk && projectMeta[pk]) || {};

    const panel = document.createElement("div");
    panel.className = "nc-dir-project-editpanel";
    panel.setAttribute("role", "group");
    panel.setAttribute("aria-label", "Edit project details");

    function labeledRow(label, inputEl) {
      const row = document.createElement("div");
      row.className = "nc-dir-project-editrow";
      const lab = document.createElement("span");
      lab.className = "nc-dir-project-editlabel";
      lab.textContent = label;
      row.appendChild(lab);
      row.appendChild(inputEl);
      return row;
    }

    const inpProj = document.createElement("input");
    inpProj.type = "text";
    inpProj.className = "nc-dir-project-titleedit";
    inpProj.value = stripProjectPrefix(oldName);
    inpProj.setAttribute("aria-label", "Project name");
    inpProj.autocomplete = "off";

    const inpDir = document.createElement("input");
    inpDir.type = "text";
    inpDir.className = "nc-dir-project-titleedit";
    inpDir.value = String(meta.director || "").trim();
    inpDir.setAttribute("aria-label", "Director");
    inpDir.autocomplete = "off";

    const inpEnd = document.createElement("input");
    inpEnd.type = "date";
    inpEnd.className = "nc-dir-project-titleedit nc-dir-project-titleedit--date";
    inpEnd.value = parseContractEndToIsoDate(meta.contractEnd || "") || "";
    inpEnd.setAttribute("aria-label", "Contract end date");

    panel.appendChild(labeledRow("Project:", inpProj));
    panel.appendChild(labeledRow("Director:", inpDir));
    panel.appendChild(labeledRow("Contract End:", inpEnd));

    const actions = document.createElement("div");
    actions.className = "nc-dir-project-editactions";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "nc-dir-project-titleedit-save";
    saveBtn.textContent = "Save";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "nc-dir-project-titleedit-cancel";
    cancelBtn.textContent = "Cancel";

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "nc-dir-project-titleedit-delete";
    deleteBtn.textContent = "Delete project";

    const spacer = document.createElement("span");
    spacer.className = "nc-dir-project-editactions-spacer";
    spacer.setAttribute("aria-hidden", "true");

    if (canDeleteProjects()) {
      actions.appendChild(deleteBtn);
    }
    actions.appendChild(spacer);
    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    panel.appendChild(actions);

    btn.hidden = true;
    fieldsEl.hidden = true;
    titleWrap.appendChild(panel);
    try {
      if (head) head.classList.add("is-editing");
    } catch (_) {}

    saveBtn.addEventListener("mousedown", (ev) => ev.preventDefault());
    cancelBtn.addEventListener("mousedown", (ev) => ev.preventDefault());
    if (canDeleteProjects()) {
      deleteBtn.addEventListener("mousedown", (ev) => ev.preventDefault());
    }

    const cleanup = () => {
      try { panel.remove(); } catch (_) {}
      btn.hidden = false;
      fieldsEl.hidden = false;
      try {
        if (head) head.classList.remove("is-editing");
      } catch (_) {}
    };

    const commit = () => {
      const nextName = canonicalProjectName(inpProj.value);
      const directorVal = String(inpDir.value || "").trim().slice(0, 120);
      const contractEndVal = String(inpEnd.value || "").trim().slice(0, 32);
      if (!nextName) {
        alert("Project name is required.");
        return;
      }
      const existing = existingProjectNamesFromDom();
      const nextKey = keyForProject(nextName);
      const oldKey = keyForProject(oldName);
      if (nextKey !== oldKey && existing.has(nextKey)) {
        alert("A project with that name already exists.");
        return;
      }
      if (nextKey !== oldKey) {
        renameProject(oldName, nextName);
      }
      const nk = keyForProject(nextName);
      if (nk) {
        projectMeta[nk] = { director: directorVal, contractEnd: contractEndVal };
        saveProjectMeta(projectMeta);
      }
      cleanup();
      renderAllProjects();
      syncEmployeeDirectoryVisibility();
      document.querySelectorAll(".nc-dir-project[data-project]").forEach((s) => refreshProjectMetaDisplay(s));
      syncWorkforceProjectsCatalogToServer();
    };

    saveBtn.addEventListener("click", commit);
    cancelBtn.addEventListener("click", cleanup);
    if (canDeleteProjects()) {
      deleteBtn.addEventListener("click", async () => {
        const targetName = canonicalProjectName(sec.getAttribute("data-project") || oldName);
        const n = memberIdsForProjectCanonical(targetName).length;
        const msg = n
          ? `Delete project "${targetName}" and unassign ${n} resource(s)? They will return to the bench and their saved Project field is cleared.`
          : `Delete project "${targetName}"?`;
        if (!window.confirm(msg)) return;
        const justification = promptDeletionJustification(`Deleting workforce project "${targetName}"`);
        if (justification === null) return;
        cleanup();
        const ok = await deleteProjectCanonical(targetName, justification);
        if (!ok) return;
        try {
          if (sec.parentNode) sec.remove();
        } catch (_) {}
        renderAllProjects();
        syncEmployeeDirectoryVisibility();
        try {
          rebuildProjectSelect(efProject ? efProject.value : "");
        } catch (_) {}
        syncWorkforceProjectsCatalogToServer();
      });
    }

    panel.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        commit();
      }
      if (ev.key === "Escape") {
        ev.preventDefault();
        cleanup();
      }
    });

    panel.addEventListener(
      "focusout",
      (ev) => {
        const rt = ev.relatedTarget;
        if (rt instanceof Node && panel.contains(rt)) return;
        window.setTimeout(() => {
          try {
            if (!panel.isConnected) return;
            if (panel.contains(document.activeElement)) return;
          } catch (_) {}
          cleanup();
        }, 0);
      },
      true
    );

    try {
      inpProj.focus();
      inpProj.select();
    } catch (_) {}
  });

  // Drag & drop: drag any resource card onto a project to move placement.
  document.addEventListener("dragstart", (e) => {
    const t = e.target;
    const card = t && t.closest ? t.closest(".nc-dir-card[data-person-id]") : null;
    if (!card) return;
    const id = String(card.getAttribute("data-person-id") || "").trim();
    if (!id) return;
    try {
      e.dataTransfer.setData("application/x-person-id", id);
      e.dataTransfer.setData("text/plain", id);
      e.dataTransfer.effectAllowed = "move";
    } catch (_) {}
  });

  document.addEventListener("dragover", (e) => {
    if (!canEditProjects()) return;
    const t = e.target;
    const sec =
      t && t.closest ? t.closest('.nc-dir-project[data-project], .nc-dir-project[data-bench="1"]') : null;
    if (!sec) return;
    try {
      const has = Array.from(e.dataTransfer.types || []).includes("application/x-person-id") || Array.from(e.dataTransfer.types || []).includes("text/plain");
      if (!has) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      sec.classList.add("is-dropover");
    } catch (_) {}
  });

  document.addEventListener("dragleave", (e) => {
    const t = e.target;
    const sec = t && t.closest ? t.closest(".nc-dir-project.is-dropover") : null;
    if (!sec) return;
    try {
      const rt = e.relatedTarget;
      if (!sec.contains(rt instanceof Node ? rt : null)) sec.classList.remove("is-dropover");
    } catch (_) {
      sec.classList.remove("is-dropover");
    }
  });

  document.addEventListener("drop", (e) => {
    const t = e.target;
    const sec =
      t && t.closest ? t.closest('.nc-dir-project[data-project], .nc-dir-project[data-bench="1"]') : null;
    if (!sec) return;
    if (!canEditProjects()) return;
    sec.classList.remove("is-dropover");
    const isBench = sec.hasAttribute("data-bench");
    const proj = isBench ? "" : sec.getAttribute("data-project") || "";
    let id = "";
    try {
      id = String(e.dataTransfer.getData("application/x-person-id") || e.dataTransfer.getData("text/plain") || "").trim();
    } catch (_) {
      id = "";
    }
    if (!id || !personById(id)) return;
    e.preventDefault();
    try {
      if (isBench) {
        removeFromAllProjects(id);
        void persistWorkforceProjectToServer(id, "");
        renderAllProjects();
        syncEmployeeDirectoryVisibility();
        return;
      }
      moveToProject(id, proj);
      renderAllProjects();
      syncEmployeeDirectoryVisibility();
    } catch (_) {}
  });

  // Notes interactions
  if (noteAttachX) {
    noteAttachX.addEventListener("click", () => {
      setPendingImage("", "");
      if (pendingAttachment && pendingAttachment.is_image) pendingAttachment = null;
      renderNotePending();
    });
  }

  async function processNoteDroppedFiles(files) {
    if (!selectedId) return;
    const file = files && files[0];
    if (!file) return;
    const isImg = String(file.type || "").startsWith("image/");
    const MAX_BYTES = 1_500_000;
    if (isImg && file.size && file.size <= MAX_BYTES) {
      const fr = new FileReader();
      fr.onload = () => {
        const dataUrl = String(fr.result || "");
        if (!dataUrl.startsWith("data:image/")) return;
        setPendingImage(dataUrl, String(file.name || "dropped-image"));
      };
      fr.onerror = () => alert("Could not read dropped image.");
      fr.readAsDataURL(file);
      return;
    }
    const fd = new FormData();
    fd.append("file", file, file.name || "file.bin");
    if (noteSend) noteSend.disabled = true;
    try {
      const r = await fetch("/intranet/api/chat/upload-file", { method: "POST", credentials: "same-origin", body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.url) throw new Error(j.error || "Upload failed");
      setPendingAttachment({
        url: String(j.url),
        name: String(j.name || file.name || "Attachment"),
        size: Number(j.size) || file.size || 0,
        is_image: isImg,
      });
    } catch (err) {
      alert(String(err && err.message ? err.message : err) || "Upload failed.");
    } finally {
      if (noteSend) noteSend.disabled = false;
    }
  }

  function noteDragOver(e) {
    try {
      if (!selectedId) return;
      if (!e.dataTransfer) return;
      const hasFiles = Array.from(e.dataTransfer.types || []).includes("Files");
      if (!hasFiles) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    } catch (_) {}
  }
  if (noteSend) {
    noteSend.addEventListener("click", () => {
      if (!selectedId) return;
      const text = String(noteText && noteText.value ? noteText.value : "").trim();
      const img = String(pendingImageData || "");
      const att = pendingAttachment && pendingAttachment.url ? pendingAttachment : null;
      if (!text && !img && !att) return;
      const notes = getNotesFor(selectedId);
      const note = { by: CURRENT_USER, at: new Date().toISOString(), text };
      if (img) {
        note.image_data = img;
        note.image_name = pendingImageName || "pasted-image";
      }
      if (att) note.attachment = att;
      notes.push(note);
      setNotesFor(selectedId, notes);
      if (noteText) noteText.value = "";
      setPendingImage("", "");
      pendingAttachment = null;
      renderNotePending();
      renderNotes();
    });
  }

  if (notePending) {
    notePending.addEventListener("click", (e) => {
      const x = e.target && e.target.closest ? e.target.closest(".nc-sc2-chat-pending-x") : null;
      if (!x || !notePending.contains(x)) return;
      pendingAttachment = null;
      renderNotePending();
    });
  }

  if (noteText) {
    noteText.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      if (e.shiftKey) return;
      e.preventDefault();
      if (noteSend && !noteSend.disabled) noteSend.click();
    });

    noteText.addEventListener("paste", (e) => {
      try {
        if (!selectedId) return;
        const cd = e.clipboardData;
        if (!cd || !cd.items || !cd.items.length) return;
        const items = [...cd.items];
        const imgItem = items.find((it) => it.kind === "file" && String(it.type || "").startsWith("image/"));
        if (!imgItem) return;
        const file = imgItem.getAsFile();
        if (!file) return;
        e.preventDefault();
        const MAX_BYTES = 1_500_000;
        if (file.size && file.size > MAX_BYTES) {
          alert("Image is too large to store in notes. Please upload the file and link it instead.");
          return;
        }
        const fr = new FileReader();
        fr.onload = () => {
          const dataUrl = String(fr.result || "");
          if (!dataUrl.startsWith("data:image/")) return;
          setPendingImage(dataUrl, String(file.name || "pasted-image"));
        };
        fr.onerror = () => alert("Could not read pasted image.");
        fr.readAsDataURL(file);
      } catch (_) {}
    });

    noteText.addEventListener("dragover", noteDragOver);

    noteText.addEventListener("drop", async (e) => {
      try {
        if (!selectedId) return;
        if (!e.dataTransfer) return;
        const files = Array.from(e.dataTransfer.files || []);
        if (!files.length) return;
        e.preventDefault();
        noteCompose && noteCompose.classList.remove("is-dragover");
        await processNoteDroppedFiles(files);
      } catch (_) {}
    });
  }

  if (noteCompose) {
    noteCompose.addEventListener("dragenter", (e) => {
      try {
        if (!selectedId) return;
        if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes("Files")) return;
        e.preventDefault();
        noteCompose.classList.add("is-dragover");
      } catch (_) {}
    });
    noteCompose.addEventListener("dragover", (e) => {
      noteDragOver(e);
      if (Array.from(e.dataTransfer && e.dataTransfer.types ? e.dataTransfer.types : []).includes("Files")) {
        try {
          e.preventDefault();
        } catch (_) {}
      }
    });
    noteCompose.addEventListener("dragleave", (e) => {
      try {
        const rt = e.relatedTarget;
        if (!noteCompose.contains(rt instanceof Node ? rt : null)) noteCompose.classList.remove("is-dragover");
      } catch (_) {
        noteCompose.classList.remove("is-dragover");
      }
    });
    noteCompose.addEventListener("drop", async (e) => {
      try {
        if (!selectedId) return;
        if (!e.dataTransfer) return;
        const files = Array.from(e.dataTransfer.files || []);
        if (!files.length) return;
        e.preventDefault();
        noteCompose.classList.remove("is-dragover");
        await processNoteDroppedFiles(files);
      } catch (_) {}
    });
  }

  if (efIsContractor) {
    efIsContractor.addEventListener("change", () => {
      syncContractorSections();
      // Color/type is driven by is_contractor; only this checkbox should change it.
      if (topTitle && editDlg && !editDlg.hidden) topTitle.textContent = isCreating ? "Add Resource" : "Edit Resource";
    });
  }

  document.querySelectorAll('input[name="nc-dir-create-account"]').forEach((r) => {
    r.addEventListener("change", () => {
      const yes = !!document.querySelector('input[name="nc-dir-create-account"][value="yes"]')?.checked;
      if (yes) {
        accountPhoneDisplayDirty = false;
        if (accountNameEl && !String(accountNameEl.value || "").trim()) {
          accountNameEl.value = composePersonDisplayName();
        }
        if (accountEmailEl && efEmail) accountEmailEl.value = String(efEmail.value || "").trim();
        syncAccountNameToPhoneDisplay();
      }
      syncCreateAccountVisibility();
    });
  });
  if (accountNameEl) accountNameEl.addEventListener("input", syncAccountNameToPhoneDisplay);
  if (efFirstName) efFirstName.addEventListener("input", () => syncAccountNameToPhoneDisplay());
  if (efSurname) efSurname.addEventListener("input", () => syncAccountNameToPhoneDisplay());
  if (efEmail) {
    efEmail.addEventListener("input", () => {
      if (!isCreating) return;
      const yes = !!document.querySelector('input[name="nc-dir-create-account"][value="yes"]')?.checked;
      if (yes && accountEmailEl) accountEmailEl.value = String(efEmail.value || "").trim();
    });
  }
  if (accountPhoneDisplayEl) {
    accountPhoneDisplayEl.addEventListener("input", () => {
      accountPhoneDisplayDirty = true;
    });
  }
  if (accountPwCopyBtn) {
    accountPwCopyBtn.addEventListener("click", async () => {
      const t = (accountPwDisplayEl?.dataset?.password || accountPwDisplayEl?.textContent || "").trim();
      if (!t || t === "—") return;
      try {
        await navigator.clipboard.writeText(t);
        if (editStatus) {
          editStatus.textContent = "Password copied to clipboard.";
          window.setTimeout(() => {
            if (editStatus && editStatus.textContent === "Password copied to clipboard.") editStatus.textContent = "";
          }, 2500);
        }
      } catch (_) {}
    });
  }

  if (companySelect) {
    companySelect.addEventListener("change", () => applyCompanySelectionFromDropdown());
  }

  document.querySelectorAll(".nc-dir-doc-upload").forEach((btn) => {
    btn.addEventListener("click", () => {
      const kind = btn.getAttribute("data-doc-kind");
      const inp = kind === "pi_pl_insurance" ? docPiplInput : kind === "workcover" ? docWcInput : null;
      if (inp) inp.click();
    });
  });

  function queueOrUploadDoc(kind, file) {
    if (!file) return;
    const sel = companySelect ? companySelect.value : "";
    let cid = null;
    if (sel && sel !== "__new__" && sel !== "") cid = parseInt(sel, 10);
    if (cid && !Number.isNaN(cid)) {
      uploadCompanyDocument(cid, kind, file).catch((err) => {
        if (editStatus) editStatus.textContent = String(err && err.message ? err.message : err) || "Upload failed";
      });
      return;
    }
    pendingCompanyDocs[kind] = file;
    const label = file.name || "file";
    if (kind === "pi_pl_insurance" && docPiplStatus) docPiplStatus.textContent = `Ready: ${label} (uploads after save)`;
    if (kind === "workcover" && docWcStatus) docWcStatus.textContent = `Ready: ${label} (uploads after save)`;
  }

  if (docPiplInput) {
    docPiplInput.addEventListener("change", () => {
      const f = docPiplInput.files && docPiplInput.files[0];
      queueOrUploadDoc("pi_pl_insurance", f || null);
    });
  }
  if (docWcInput) {
    docWcInput.addEventListener("change", () => {
      const f = docWcInput.files && docWcInput.files[0];
      queueOrUploadDoc("workcover", f || null);
    });
  }

  if (notesList) {
    notesList.addEventListener("click", (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      const img = t.closest('img[data-fullimg="1"]');
      if (!img) return;
      const src = img.getAttribute("src") || "";
      if (src) openImgViewer(src, "Image");
    });
  }

  if (imgViewerClose) imgViewerClose.addEventListener("click", () => closeImgViewer());

  function openCurrentProfilePhoto() {
    if (!selectedId) return;
    const src = getPhotoFor(selectedId);
    if (!src) return;
    openImgViewer(src, "Profile photo");
  }

  if (photoPreview) {
    photoPreview.addEventListener("click", () => openCurrentProfilePhoto());
    photoPreview.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openCurrentProfilePhoto();
      }
    });
  }

  if (elAvatar) {
    elAvatar.addEventListener("click", () => openCurrentProfilePhoto());
  }

  // Photo upload events
  function readPhotoFile(file) {
    if (!file || !file.type || !String(file.type).startsWith("image/")) return;
    const MAX_BYTES = 1_500_000;
    if (file.size && file.size > MAX_BYTES) {
      alert("Photo is too large. Please choose a smaller image.");
      return;
    }
    const fr = new FileReader();
    fr.onload = () => {
      const dataUrl = String(fr.result || "");
      if (!dataUrl.startsWith("data:image/")) return;
      if (!selectedId) return;
      setPhotoFor(selectedId, dataUrl);
      if (photoPreview) photoPreview.style.backgroundImage = `url("${dataUrl}")`;
      // Live-update avatars
      const p = selectedId ? personById(selectedId) : null;
      if (p) {
        const card = document.querySelector('.nc-dir-card[data-person-id="' + String(p.id) + '"]');
        const av = card ? card.querySelector(".nc-dir-avatar") : null;
        if (av) applyAvatarPhoto(av, p.id);
        applyAvatarPhoto(elAvatar, p.id);
      }
    };
    fr.onerror = () => alert("Could not read photo.");
    fr.readAsDataURL(file);
  }

  if (photoChoose && photoInput) photoChoose.addEventListener("click", () => photoInput.click());
  if (photoInput) {
    photoInput.addEventListener("change", () => {
      const f = photoInput.files && photoInput.files[0] ? photoInput.files[0] : null;
      if (f) readPhotoFile(f);
    });
  }
  if (photoRemove) {
    photoRemove.addEventListener("click", () => {
      if (!selectedId) return;
      setPhotoFor(selectedId, "");
      if (photoPreview) photoPreview.style.backgroundImage = "";
      const p = personById(selectedId);
      if (p) {
        const card = document.querySelector('.nc-dir-card[data-person-id="' + String(p.id) + '"]');
        const av = card ? card.querySelector(".nc-dir-avatar") : null;
        if (av) {
          av.textContent = p.initials || "?";
          av.setAttribute("data-tone", String(p.tone != null ? p.tone : 0));
          applyAvatarPhoto(av, p.id);
        }
        if (elAvatar) {
          elAvatar.textContent = p.initials || "?";
          elAvatar.setAttribute("data-tone", String(p.tone != null ? p.tone : 0));
          applyAvatarPhoto(elAvatar, p.id);
        }
      }
    });
  }

  window.addEventListener("popstate", (e) => {
    const spPop = new URLSearchParams(window.location.search || "");
    const urlHasOverlay = spPop.has("user_id") || spPop.get("new_resource") === "1";

    // If navigating away from an image state, close viewer without another back().
    const imgSt = imgStateFromHistory(e && e.state);
    if (imgViewer && !imgViewer.hidden && (!imgSt || !imgSt.src)) {
      closeImgViewer({ popHistory: false });
    }
    // If navigating into an image state, restore it.
    if (imgSt && imgSt.src) {
      openImgViewer(imgSt.src, imgSt.title || "Image", { pushHistory: false });
      return;
    }

    // URL wins over history.state: Back from ?user_id=… must close the shell even if state still has dirEdit.
    if (!urlHasOverlay && editDlg && !editDlg.hidden) {
      closeEditShell();
      return;
    }

    const st = editStateFromHistory(e && e.state);
    if (st) {
      const mode = String(st.mode || "edit");
      const id = String(st.id || "");
      if (mode === "create") {
        // Restore the create overlay when navigating forward.
        openCreateDialog({ pushHistory: false });
        return;
      }
      if (id) {
        const person = personById(id);
        if (person) {
          openEditDialog(person, { pushHistory: false });
          return;
        }
        ensurePersonLoaded(id).then((p) => {
          if (p) openEditDialog(p, { pushHistory: false });
          else if (editDlg && !editDlg.hidden) closeEditShell();
        });
        return;
      }
    }
    if (editDlg && !editDlg.hidden) closeEditShell();
  });

  window.addEventListener("resize", () => {
    try {
      if (editDlg && !editDlg.hidden && window.ncSyncViewerOffsets) window.ncSyncViewerOffsets();
    } catch (_) {}
  });

  // Deep-link support: /intranet/directory?user_id=<id> (and search → directory links)
  try {
    const sp = new URLSearchParams(window.location.search || "");
    const userId = sp.get("user_id");
    if (userId) {
      ensurePersonLoaded(userId).then((person) => {
        if (person) openViewDialog(person);
      });
    }
  } catch (_) {}

  // Apply any stored photos on initial render.
  applyPhotosToAllCards();
})();
