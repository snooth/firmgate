(function () {
  let root = document.getElementById("file-browser");
  if (!root) return;

  let listUrl = root.dataset.listUrl;
  let searchUrl = (root.dataset.searchUrl || "").trim();
  let mkdirUrl = root.dataset.mkdirUrl;
  let uploadUrl = root.dataset.uploadUrl;
  let moveUrl = root.dataset.moveUrl;
  let copyUrl = root.dataset.copyUrl;
  let shareUrl = root.dataset.shareUrl;
  let API_BASE = listUrl.replace(/\/api\/list\/?$/, "");
  /** Same mount prefix as the files blueprint (e.g. "" or "/myapp") so OnlyOffice works behind SCRIPT_NAME / subpaths. */
  let APP_MOUNT = String(API_BASE || "").replace(/\/files\/?$/i, "");

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

  function documentEditorHref(nodeId, options) {
    const opts = options || {};
    const provider = (root.dataset.documentEditorProvider || "onlyoffice").trim().toLowerCase();
    const prefix = provider === "office365" ? "office365" : "onlyoffice";
    const base = `${APP_MOUNT}/${prefix}/editor/${encodeURIComponent(String(nodeId))}`;
    const params = new URLSearchParams();
    try {
      const path = window.location.pathname || "";
      if (document.body?.classList.contains("nc-page-intranet") && path.startsWith("/intranet/")) {
        params.set("shell", "intranet");
      }
    } catch {
      /* ignore */
    }
    let parentId = opts.parentId;
    if (parentId == null && opts.item && opts.item.parent_id != null) {
      parentId = opts.item.parent_id;
    }
    if (parentId == null && typeof currentParentId !== "undefined" && currentParentId != null) {
      parentId = currentParentId;
    }
    if (parentId != null && Number.isFinite(Number(parentId))) {
      params.set("return_parent_id", String(parentId));
    }
    const nav = opts.nav != null ? opts.nav : typeof leftNavMode !== "undefined" ? leftNavMode : "";
    if (nav && nav !== "all") {
      params.set("return_nav", nav);
    }
    const q = params.toString();
    return q ? `${base}?${q}` : base;
  }

  /** Display timezone (DST-aware). */
  const APP_TIME_ZONE = (root.dataset.timeZone || "Australia/Melbourne").trim() || "Australia/Melbourne";
  const APP_TIME_OFFSET_MS = Number(root.dataset.timeOffsetMs || "0") || 0;
  const APP_LOCALE = "en-AU";
  const DT_DISPLAY = {
    timeZone: APP_TIME_ZONE,
    dateStyle: "medium",
    timeStyle: "short",
    timeZoneName: "short",
  };

  let tbody = document.getElementById("rows");
  let breadcrumbEl = document.getElementById("breadcrumb");
  let status = document.getElementById("status");
  let uploadProgressEl = document.getElementById("upload-progress");
  let uploadProgressFill = document.getElementById("upload-progress-fill");
  let uploadProgressLabel = document.getElementById("upload-progress-label");
  let uploadProgressDetail = document.getElementById("upload-progress-detail");
  let uploadProgressTrack = document.getElementById("upload-progress-track");
  let uploadProgressDismiss = document.getElementById("upload-progress-dismiss");
  let uploadProgressHideTimer = null;

  function refreshUploadProgressRefs() {
    uploadProgressEl = document.getElementById("upload-progress");
    uploadProgressFill = document.getElementById("upload-progress-fill");
    uploadProgressLabel = document.getElementById("upload-progress-label");
    uploadProgressDetail = document.getElementById("upload-progress-detail");
    uploadProgressTrack = document.getElementById("upload-progress-track");
    uploadProgressDismiss = document.getElementById("upload-progress-dismiss");
  }

  function onUploadProgressDismissClick() {
    if (uploadProgressHideTimer) clearTimeout(uploadProgressHideTimer);
    setUploadProgressVisible(false);
    updateUploadProgressUi(0, "Uploading…", "");
  }

  refreshUploadProgressRefs();
  if (uploadProgressDismiss && !uploadProgressDismiss.dataset.ncDismissBound) {
    uploadProgressDismiss.dataset.ncDismissBound = "1";
    uploadProgressDismiss.addEventListener("click", onUploadProgressDismissClick);
  }

  /** Full page navigation tears down in-flight XHR uploads; warn while a transfer is active on this tab. */
  let ncDocsTransferDepth = 0;
  function ncBeforeUnloadWhileUpload(e) {
    e.preventDefault();
    e.returnValue = "";
  }
  function beginBlockingNavDuringTransfer() {
    /* Turbo Drive keeps the main document during intranet visits — no unload prompt. */
    if (typeof window.Turbo !== "undefined") return;
    ncDocsTransferDepth += 1;
    if (ncDocsTransferDepth === 1) {
      window.addEventListener("beforeunload", ncBeforeUnloadWhileUpload);
    }
  }
  function endBlockingNavDuringTransfer() {
    if (typeof window.Turbo !== "undefined") return;
    ncDocsTransferDepth = Math.max(0, ncDocsTransferDepth - 1);
    if (ncDocsTransferDepth === 0) {
      window.removeEventListener("beforeunload", ncBeforeUnloadWhileUpload);
    }
  }

  if (window.__ncFbInstanceAbort) {
    try {
      window.__ncFbInstanceAbort.abort();
    } catch (_) {}
  }
  window.__ncFbInstanceAbort = new AbortController();
  const ncFbSig = window.__ncFbInstanceAbort.signal;
  ncFbSig.addEventListener("abort", () => {
    try {
      window.removeEventListener("beforeunload", ncBeforeUnloadWhileUpload);
    } catch (_) {}
    ncDocsTransferDepth = 0;
  });

  const UPLOAD_WORKER_NAME = "nc_intranet_file_upload_worker";
  const UPLOAD_WORKER_WIN_FEATURES =
    "popup=yes,width=520,height=320,left=80,top=80,scrollbars=yes,resizable=yes";
  /** Large folder jobs are split so postMessage to the upload worker stays reliable. */
  const UPLOAD_WORKER_CHUNK_FILES = 400;

  function intranetUploadManager() {
    return window.ncIntranetUploadManager || null;
  }

  function workerUrlConfigured() {
    return Boolean(document.body.classList.contains("nc-page-intranet") && intranetUploadManager());
  }

  function fileRelativePath(file) {
    if (!file) return "";
    return String(file.webkitRelativePath || file.relativePath || file.name || "").trim();
  }

  function buildUploadWorkerJobs(mode, parentId, files) {
    const list = Array.from(files || []).filter((f) => f && f.name);
    const relativePaths = list.map(fileRelativePath);
    if (mode !== "folder" || list.length <= UPLOAD_WORKER_CHUNK_FILES) {
      return [{ mode, parentId, files: list, relativePaths }];
    }
    const jobs = [];
    const batchCount = Math.ceil(list.length / UPLOAD_WORKER_CHUNK_FILES);
    for (let i = 0; i < list.length; i += UPLOAD_WORKER_CHUNK_FILES) {
      jobs.push({
        mode,
        parentId,
        files: list.slice(i, i + UPLOAD_WORKER_CHUNK_FILES),
        relativePaths: relativePaths.slice(i, i + UPLOAD_WORKER_CHUNK_FILES),
        batchIndex: Math.floor(i / UPLOAD_WORKER_CHUNK_FILES) + 1,
        batchCount,
      });
    }
    return jobs;
  }

  function tryStartIntranetBackgroundUpload(mode, pid, list, totalFiles, totalBytes, sessionTitle) {
    const mgr = intranetUploadManager();
    if (!mgr) return false;

    beginUploadSession(sessionTitle, totalFiles, totalBytes);
    window.__ncBgUploadActive = true;

    const jobs = buildUploadWorkerJobs(mode, pid, list);
    for (const job of jobs) {
      mgr.start({
        mode: job.mode,
        parentId: job.parentId,
        files: job.files,
        relativePaths: job.relativePaths,
        uploadUrl,
        mkdirUrl,
        apiBase: API_BASE,
        batchIndex: job.batchIndex,
        batchCount: job.batchCount,
      });
    }

    const extra = jobs.length > 1 ? ` (${jobs.length} batches)` : "";
    setStatus(`Uploading… you can switch menus; progress stays in the header.${extra}`);
    return true;
  }

  let dropzone = document.getElementById("dropzone");
  let viewList = document.getElementById("view-list");
  let viewGrid = document.getElementById("view-grid");
  const dlgVersions = document.getElementById("dlg-versions");
  const versionsBody = document.getElementById("versions-body");
  const dlgUploadConflict = document.getElementById("dlg-upload-conflict");
  const btnUconflictReplace = document.getElementById("btn-uconflict-replace");
  const btnUconflictKeep = document.getElementById("btn-uconflict-keep");
  const btnUconflictCancel = document.getElementById("btn-uconflict-cancel");
  const uconflictReadonlyHint = document.getElementById("uconflict-readonly-hint");
  const dlgShare = document.getElementById("dlg-share");
  const shareTitle = document.getElementById("share-title");
  const shareSub = document.getElementById("share-sub");
  const shareClose = document.getElementById("share-close");
  const shareReadonly = document.getElementById("share-readonly");
  const shareYourText = document.getElementById("share-your-text");
  const shareManage = document.getElementById("share-manage");
  const shareUsername = document.getElementById("share-username");
  const sharePerm = document.getElementById("share-perm");
  const shareAdd = document.getElementById("share-add");
  const shareInternalList = document.getElementById("share-internal-list");
  const sharePublicLink = document.getElementById("share-public-link");
  const sharePublicLinkResult = document.getElementById("share-public-link-result");
  const sharePublicLinkBox = document.getElementById("share-public-link-box");
  const sharePublicLinkCopy = document.getElementById("share-public-link-copy");
  const sharePublicLinkRemove = document.getElementById("share-public-link-remove");
  const sharePublicLinkCount = document.getElementById("share-public-link-count");
  const shareUserSuggestions = document.getElementById("share-user-suggestions");
  const shareStatus = document.getElementById("share-status");
  const fileInput = document.getElementById("file-upload-input");
  const folderInput = document.getElementById("folder-upload-input");
  const newMenuBtn = document.getElementById("btn-new-menu");
  const newMenuPanel = document.getElementById("new-menu-panel");
  const selectAll = document.getElementById("select-all");
  const selectionBar = document.getElementById("selection-bar");
  const selCount = document.getElementById("sel-count");
  const selClear = document.getElementById("sel-clear");
  const selFavorites = document.getElementById("sel-favorites");
  const selPersonal = document.getElementById("sel-personal");
  const selMove = document.getElementById("sel-move");
  const selRename = document.getElementById("sel-rename");
  const selDownload = document.getElementById("sel-download");
  const selDelete = document.getElementById("sel-delete");
  const footerSummary = document.getElementById("footer-summary");
  const footerSize = document.getElementById("footer-size");
  const rowMenu = document.getElementById("row-menu");
  const rowMenuBackdrop = document.getElementById("row-menu-backdrop");

  const detailPanel = document.getElementById("detail-panel");
  const detailClose = document.getElementById("detail-close");
  const detailTitle = document.getElementById("detail-title");
  const detailSub = document.getElementById("detail-sub");
  const detailTabActivity = document.getElementById("detail-tab-activity");
  const detailTabComments = document.getElementById("detail-tab-comments");
  const detailTabSharing = document.getElementById("detail-tab-sharing");
  const detailTabVersions = document.getElementById("detail-tab-versions");
  const detailActivityList = document.getElementById("detail-activity-list");
  const detailActivityEmpty = document.getElementById("detail-activity-empty");
  const detailCommentsList = document.getElementById("detail-comments-list");
  const detailCommentsEmpty = document.getElementById("detail-comments-empty");
  const detailCommentInput = document.getElementById("detail-comment-input");
  const detailCommentSend = document.getElementById("detail-comment-send");
  const detailVersionsList = document.getElementById("detail-versions-list");
  const detailVersionsEmpty = document.getElementById("detail-versions-empty");
  const detailSharingReadonly = document.getElementById("detail-sharing-readonly");
  const detailYourShareText = document.getElementById("detail-your-share-text");
  const detailSharingManage = document.getElementById("detail-sharing-manage");
  const detailShareUsername = document.getElementById("detail-share-username");
  const detailSharePerm = document.getElementById("detail-share-perm");
  const detailShareAdd = document.getElementById("detail-share-add");
  const detailInternalList = document.getElementById("detail-internal-list");
  const detailPublicLink = document.getElementById("detail-public-link");
  const detailPublicLinkResult = document.getElementById("detail-public-link-result");
  const detailUserSuggestions = document.getElementById("detail-user-suggestions");
  const thSortName = document.getElementById("th-sort-name");
  const pdfViewer = document.getElementById("pdf-viewer");
  const pdfFrame = document.getElementById("pdf-frame");
  const pdfClose = document.getElementById("pdf-close");
  const pdfTitle = document.getElementById("pdf-title");

  const emlViewer = document.getElementById("eml-viewer");
  const emlFrame = document.getElementById("eml-frame");
  const emlClose = document.getElementById("eml-close");
  const emlTitle = document.getElementById("eml-title");

  const drawioViewer = document.getElementById("drawio-viewer");
  const drawioFrame = document.getElementById("drawio-frame");
  const drawioClose = document.getElementById("drawio-close");
  const drawioTitle = document.getElementById("drawio-title");
  let drawioItem = null;
  let drawioLoaded = false;
  let drawioPendingLoad = null; // {it, ext, xml?, dataBase64?}

  const imgViewer = document.getElementById("img-viewer");
  const imgEl = document.getElementById("img-el");
  const imgClose = document.getElementById("img-close");
  const imgTitle = document.getElementById("img-title");

  const vidViewer = document.getElementById("vid-viewer");
  const vidEl = document.getElementById("vid-el");
  const vidClose = document.getElementById("vid-close");
  const vidTitle = document.getElementById("vid-title");

  const model3dViewer = document.getElementById("model3d-viewer");
  const model3dCanvas = document.getElementById("model3d-canvas");
  const model3dClose = document.getElementById("model3d-close");
  const model3dTitle = document.getElementById("model3d-title");
  const model3dStatus = document.getElementById("model3d-status");
  let model3dRuntime = null; // { dispose() }

  const textViewer = document.getElementById("text-viewer");
  const textArea = document.getElementById("text-area");
  const textClose = document.getElementById("text-close");
  const textTitle = document.getElementById("text-title");
  const textStatus = document.getElementById("text-status");

  const dlgMoveCopy = document.getElementById("dlg-movecopy");
  const moveCopyUp = document.getElementById("movecopy-up");
  const moveCopyPath = document.getElementById("movecopy-path");
  const moveCopyFolders = document.getElementById("movecopy-folders");
  const moveCopyEmpty = document.getElementById("movecopy-empty");
  const moveCopyStatus = document.getElementById("movecopy-status");
  const moveCopyCancel = document.getElementById("movecopy-cancel");
  const moveCopyClose = document.getElementById("movecopy-close");
  const moveCopyMove = document.getElementById("movecopy-move");
  const moveCopyCopy = document.getElementById("movecopy-copy");

  let currentParentId = null;
  let lastItems = [];
  /** Last successful `api/list` JSON (used to re-sort without refetch). */
  let lastListPayload = null;
  let listSortDir = "asc";
  let lastBreadcrumb = [{ id: null, name: "All files" }];
  let viewMode = "list";
  let leftNavMode = "all"; // all | personal | favorites | shares | recycle | admin
  let leftSearchQuery = "";
  /** Last normal folder listing JSON (not global search results). Used while search overlay is shown. */
  let baseListPayload = null;
  let searchAbort = null;
  let searchDebounceTimer = null;
  let searchReqSeq = 0;

  function effectiveParentId() {
    // Root listing is a virtual container; uploads/creates should target the user's Home folder.
    if (currentParentId != null) return currentParentId;
    const src = baseListPayload || lastListPayload;
    return src && src.default_parent_id != null ? src.default_parent_id : null;
  }

  function resolveCreateParentId() {
    const pid = effectiveParentId();
    return pid != null ? pid : currentParentId;
  }

  function listApiQuery(parentId) {
    const params = new URLSearchParams();
    if (parentId != null) params.set("parent_id", String(parentId));
    if (leftNavMode === "admin") params.set("scope", "admin");
    const s = params.toString();
    return s ? `?${s}` : "";
  }

  function resolvedSearchUrl() {
    if (searchUrl) return searchUrl;
    return `${API_BASE}/api/search`;
  }

  function cancelPendingSearch() {
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }
    if (searchAbort) {
      try {
        searchAbort.abort();
      } catch {
        /* ignore */
      }
      searchAbort = null;
    }
  }

  function clearLeftSearchInput() {
    const el = document.querySelector(".nc-search-input");
    if (el) el.value = "";
    const clr = document.querySelector(".nc-search-clear");
    if (clr) clr.hidden = true;
    leftSearchQuery = "";
  }

  async function fetchGlobalSearch(q) {
    const query = String(q || "").trim();
    if (!query) return null;
    const seq = ++searchReqSeq;
    cancelPendingSearch();
    searchAbort = new AbortController();
    const u = new URL(resolvedSearchUrl(), window.location.origin);
    u.searchParams.set("q", query);
    u.searchParams.set("limit", "3000");
    const r = await fetch(u.toString(), {
      credentials: "same-origin",
      redirect: "manual",
      signal: searchAbort.signal,
    });
    searchAbort = null;
    if (seq !== searchReqSeq) return null;
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const loc = r.headers.get("Location");
      window.location.href = loc || "/login";
      return null;
    }
    if (!r.ok) return null;
    try {
      return await r.json();
    } catch {
      return null;
    }
  }

  async function refreshMainView() {
    const q = String(leftSearchQuery || "").trim();

    if (leftNavMode === "favorites") {
      const favItems = await refreshFavorites();
      const display = {
        parent: null,
        items: favItems,
        breadcrumb: [{ id: null, name: "Favorites" }],
        shared_with_me: [],
      };
      const filtered = filterPayloadForLeftNav(display);
      lastItems = sortListingItems(filtered.items || []);
      renderBreadcrumb(filtered.breadcrumb || [{ id: null, name: "Favorites" }]);
      renderTableRows(filtered);
      renderGrid(lastItems, filtered, []);
      applyViewMode();
      updateFooter(lastItems);
      syncSortHeaderUi();
      selectAll.checked = false;
      selectAll.indeterminate = false;
      updateSelectionBar();
      return;
    }

    if (leftNavMode === "personal") {
      const pers = await refreshPersonal();
      const display = {
        parent: null,
        items: pers,
        breadcrumb: [{ id: null, name: "Personal files" }],
        shared_with_me: [],
      };
      const filtered = filterPayloadForLeftNav(display);
      lastItems = sortListingItems(filtered.items || []);
      renderBreadcrumb(filtered.breadcrumb || [{ id: null, name: "Personal files" }]);
      renderTableRows(filtered);
      renderGrid(lastItems, filtered, []);
      applyViewMode();
      updateFooter(lastItems);
      syncSortHeaderUi();
      selectAll.checked = false;
      selectAll.indeterminate = false;
      updateSelectionBar();
      return;
    }

    if (leftNavMode === "recycle") {
      const rb = await fetchRecycleBin();
      const items = (rb.items || []).map((it) => ({
        ...it,
        updated_at: it.deleted_at || it.updated_at,
      }));
      const display = {
        parent: null,
        items,
        breadcrumb: [{ id: null, name: "Recycle bin" }],
        shared_with_me: [],
      };
      const filtered = filterPayloadForLeftNav(display);
      lastItems = sortListingItems(filtered.items || []);
      renderBreadcrumb(filtered.breadcrumb || [{ id: null, name: "Recycle bin" }]);
      renderTableRows(filtered);
      renderGrid(lastItems, filtered, []);
      applyViewMode();
      updateFooter(lastItems);
      syncSortHeaderUi();
      selectAll.checked = false;
      selectAll.indeterminate = false;
      updateSelectionBar();
      return;
    }

    if ((leftNavMode === "all" || leftNavMode === "admin") && q) {
      setStatus("Searching…");
      const data = await fetchGlobalSearch(q);
      if (!data) {
        setStatus("Search failed.");
        return;
      }
      lastListPayload = data;
      lastItems = sortListingItems(data.items || []);
      renderBreadcrumb(data.breadcrumb || [{ id: null, name: "All files" }]);
      renderTableRows(data);
      renderGrid(lastItems, data, data.shared_with_me || []);
      applyViewMode();
      updateFooter(lastItems);
      maybeSelectFromUrl();
      const hint =
        data.search && data.search.truncated ? " More matches may exist — try a narrower search." : "";
      setStatus(`Found ${lastItems.length} match(es).${hint}`);
      syncSortHeaderUi();
      selectAll.checked = false;
      selectAll.indeterminate = false;
      updateSelectionBar();
      return;
    }

    if (!baseListPayload && !lastListPayload) return;
    const src = baseListPayload || lastListPayload;
    refreshFavorites();
    refreshPersonal();
    const display = filterPayloadForLeftNav(src);
    lastItems =
      leftNavMode === "favorites" || leftNavMode === "personal"
        ? display.items || []
        : sortListingItems(display.items || []);
    renderBreadcrumb(display.breadcrumb || [{ id: null, name: "All files" }]);
    renderTableRows(display);
    renderGrid(lastItems, display, display.shared_with_me || []);
    applyViewMode();
    updateFooter(lastItems);
    maybeSelectFromUrl();
    setStatus("");
    syncSortHeaderUi();
    selectAll.checked = false;
    selectAll.indeterminate = false;
    updateSelectionBar();
  }

  async function reloadListing() {
    if (!root || !root.isConnected) return;
    const qs = listApiQuery(currentParentId);
    setStatus("Refreshing…");
    const r = await fetch(listUrl + qs, { credentials: "same-origin", redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const loc = r.headers.get("Location");
      window.location.href = loc || "/login";
      return;
    }
    if (!r.ok) {
      setStatus("Failed to refresh.");
      return;
    }
    let data;
    try {
      data = await r.json();
    } catch {
      setStatus("Invalid response from server. Try refreshing the page.");
      return;
    }
    baseListPayload = data;
    lastListPayload = data;
    await refreshMainView();
  }

  function applyViewMode() {
    viewList.hidden = viewMode !== "list";
    viewGrid.hidden = viewMode !== "grid";
    document.getElementById("btn-view-list").setAttribute("aria-pressed", String(viewMode === "list"));
    document.getElementById("btn-view-grid").setAttribute("aria-pressed", String(viewMode === "grid"));
    if (viewMode !== "list") cancelPendingBulkMove();
    updateSelectionBar();
  }
  let detailNodeId = null;
  let lastDetailPayload = null;
  let detailVersionsLoadedFor = null;
  let suggestTimer = null;
  let shareSuggestTimer = null;
  let shareNodeId = null;
  let lastSharePayload = null;
  let pendingBulkMoveIds = null;
  let pendingBulkMoveHandler = null;
  let favoriteIds = new Set(); // server-side favorites (ids as strings)
  let personalIds = new Set(); // server-side personal (owned) ids as strings
  let moveCopyState = null; // { ids:number[], rootId:number|null, stack: {id:number,name:string}[], selectedId:number|null }

  async function refreshFavorites() {
    const r = await fetch(`${API_BASE}/api/favorites`, { credentials: "same-origin" });
    if (!r.ok) return [];
    const j = await r.json().catch(() => ({}));
    const items = j.items || [];
    favoriteIds = new Set(items.map((it) => String(it.id)));
    return items;
  }

  async function refreshPersonal() {
    const r = await fetch(`${API_BASE}/api/personal`, { credentials: "same-origin" });
    if (!r.ok) return [];
    const j = await r.json().catch(() => ({}));
    const items = j.items || [];
    personalIds = new Set(items.map((it) => String(it.id)));
    return items;
  }

  async function fetchRecycleBin() {
    const r = await fetch(`${API_BASE}/api/recycle`, { credentials: "same-origin" });
    if (!r.ok) return { items: [], retention_days: 1 };
    return await r.json().catch(() => ({ items: [], retention_days: 1 }));
  }

  function getSelectedRows() {
    return [...tbody.querySelectorAll("tr[data-id] .row-check:checked")]
      .map((c) => c.closest("tr"))
      .filter(Boolean);
  }

  function syncSelectAllFromRows() {
    const boxes = [...tbody.querySelectorAll("tr[data-id] .row-check")];
    const n = boxes.length;
    const k = boxes.filter((b) => b.checked).length;
    selectAll.checked = n > 0 && k === n;
    selectAll.indeterminate = k > 0 && k < n;
  }

  function updateSelectionBar() {
    if (!selectionBar) return;
    if (viewMode !== "list") {
      selectionBar.hidden = true;
      return;
    }
    const rows = getSelectedRows();
    const n = rows.length;
    selectionBar.hidden = n === 0;
    if (n && selCount) selCount.textContent = n === 1 ? "1 selected" : `${n} selected`;
    if (selRename) selRename.hidden = n !== 1;
    if (selMove) {
      selMove.classList.toggle("is-armed", Boolean(pendingBulkMoveIds));
    }
  }

  function clearAllRowSelection() {
    tbody.querySelectorAll(".row-check").forEach((c) => {
      c.checked = false;
    });
    selectAll.checked = false;
    selectAll.indeterminate = false;
    cancelPendingBulkMove();
    updateSelectionBar();
  }

  function cancelPendingBulkMove() {
    if (pendingBulkMoveHandler) {
      tbody.removeEventListener("click", pendingBulkMoveHandler, true);
      pendingBulkMoveHandler = null;
    }
    pendingBulkMoveIds = null;
    document.removeEventListener("keydown", onPendingBulkMoveEscape, true);
    updateSelectionBar();
  }

  function onPendingBulkMoveEscape(ev) {
    if (ev.key !== "Escape" || !pendingBulkMoveIds) return;
    cancelPendingBulkMove();
    setStatus("Move cancelled.");
  }

  function nodeDetailUrl(id) {
    return `${API_BASE}/api/node/${id}/detail`;
  }
  function nodeShareUserUrl(id) {
    return `${API_BASE}/api/node/${id}/shares/user`;
  }
  function nodeActivityUrl(id) {
    return `${API_BASE}/api/node/${id}/activity`;
  }
  function nodeCommentsUrl(id) {
    return `${API_BASE}/api/node/${id}/comments`;
  }

  async function fetchFolderListing(parentId) {
    const q = listApiQuery(parentId);
    const r = await fetch(listUrl + q, { credentials: "same-origin", redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const loc = r.headers.get("Location");
      window.location.href = loc || "/login";
      return null;
    }
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  }

  function renderMoveCopyFolders(items) {
    if (!moveCopyFolders || !moveCopyEmpty) return;
    moveCopyFolders.innerHTML = "";
    const folders = (items || []).filter((it) => it && it.is_folder);
    moveCopyEmpty.hidden = folders.length > 0;
    if (!folders.length) return;
    for (const f of sortListingItems(folders)) {
      const li = document.createElement("li");
      li.className = "nc-movecopy-item";
      li.dataset.id = String(f.id);
      const selected = moveCopyState && moveCopyState.selectedId === f.id;
      li.classList.toggle("is-selected", Boolean(selected));
      li.innerHTML = `<div class="nc-movecopy-name">${fileIconSvg(true, f.name)}<span>${escapeHtml(
        f.name
      )}</span></div><div class="nc-movecopy-enter">›</div>`;
      li.addEventListener("click", async () => {
        if (!moveCopyState) return;
        moveCopyState.selectedId = f.id;
        if (moveCopyMove) moveCopyMove.disabled = false;
        if (moveCopyCopy) moveCopyCopy.disabled = !copyUrl;
        // Don't re-render on single click; it breaks dblclick detection.
        moveCopyFolders.querySelectorAll(".nc-movecopy-item").forEach((el) => {
          el.classList.toggle("is-selected", el.dataset.id === String(f.id));
        });
      });
      li.addEventListener("dblclick", async () => {
        if (!moveCopyState) return;
        await moveCopyEnterFolder(f.id, f.name);
      });
      moveCopyFolders.appendChild(li);
    }
  }

  function updateMoveCopyPathLabel() {
    if (!moveCopyPath) return;
    if (!moveCopyState) {
      moveCopyPath.textContent = "";
      return;
    }
    const parts = moveCopyState.stack.map((s) => s.name).filter(Boolean);
    moveCopyPath.textContent = parts.length ? parts.join(" / ") : "Home";
  }

  async function moveCopyLoadCurrent() {
    if (!moveCopyState) return;
    updateMoveCopyPathLabel();
    if (moveCopyStatus) moveCopyStatus.textContent = "Loading folders…";
    const cur = moveCopyState.stack.length ? moveCopyState.stack[moveCopyState.stack.length - 1].id : moveCopyState.rootId;
    const data = await fetchFolderListing(cur);
    if (!data) {
      if (moveCopyStatus) moveCopyStatus.textContent = "Could not load folders.";
      renderMoveCopyFolders([]);
      return;
    }
    if (moveCopyStatus) moveCopyStatus.textContent = "Tip: double-click a folder to enter it.";
    renderMoveCopyFolders(data.items || []);
  }

  async function moveCopyEnterFolder(id, name) {
    if (!moveCopyState) return;
    moveCopyState.stack.push({ id, name });
    moveCopyState.selectedId = id;
    if (moveCopyMove) moveCopyMove.disabled = false;
    if (moveCopyCopy) moveCopyCopy.disabled = !copyUrl;
    await moveCopyLoadCurrent();
  }

  async function openMoveCopyDialog(ids) {
    if (!dlgMoveCopy) return;
    // Start at the All files root listing so the user sees the folder tree.
    const rootId = null;
    moveCopyState = { ids, rootId, stack: [], selectedId: null };
    if (moveCopyMove) moveCopyMove.disabled = true;
    if (moveCopyCopy) moveCopyCopy.disabled = true;
    await moveCopyLoadCurrent();
    dlgMoveCopy.showModal();
  }

  async function runMoveOrCopy(kind) {
    if (!moveCopyState) return;
    const destId = moveCopyState.selectedId;
    const ids = moveCopyState.ids || [];
    if (!destId || !ids.length) return;
    if (moveCopyStatus) moveCopyStatus.textContent = kind === "copy" ? "Copying…" : "Moving…";
    let ok = 0;
    for (const nid of ids) {
      if (nid === destId) continue;
      const r = await fetch(kind === "copy" ? copyUrl : moveUrl, {
        method: kind === "copy" ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ node_id: nid, new_parent_id: destId }),
      });
      if (r.ok) ok += 1;
    }
    if (moveCopyStatus) {
      moveCopyStatus.textContent =
        ok === ids.length
          ? `${kind === "copy" ? "Copied" : "Moved"} ${ok} item(s).`
          : `${kind === "copy" ? "Copied" : "Moved"} ${ok} of ${ids.length} item(s).`;
    }
    dlgMoveCopy.close();
    moveCopyState = null;
    clearAllRowSelection();
    await reloadListing();
  }
  function nodeShareUserDeleteUrl(nodeId, shareId) {
    return `${API_BASE}/api/node/${nodeId}/shares/user/${shareId}`;
  }

  function nodeShareDeleteUrl(nodeId, sh) {
    const t = sh.share_type || "user";
    if (t === "group") return `${API_BASE}/api/node/${nodeId}/shares/group/${sh.id}`;
    if (t === "role") return `${API_BASE}/api/node/${nodeId}/shares/role/${sh.id}`;
    return nodeShareUserDeleteUrl(nodeId, sh.id);
  }

  function shareListLabel(sh) {
    const t = sh.share_type || "user";
    if (t === "group") return `Group: ${sh.group_name || "?"}`;
    if (t === "role") return `Role: ${sh.role_name || "?"}`;
    return sh.username || "?";
  }
  function usersSuggestUrl(q) {
    return `${API_BASE}/api/users/suggest?q=${encodeURIComponent(q)}`;
  }

  function groupsSuggestUrl(q) {
    return `${API_BASE}/api/groups/suggest?q=${encodeURIComponent(q)}`;
  }

  function rolesSuggestUrl(q) {
    return `${API_BASE}/api/roles/suggest?q=${encodeURIComponent(q)}`;
  }

  /** @type {Map<string, { kind: "user"|"group"|"role", value: string }>} */
  const shareSuggestMap = new Map();

  function rememberShareSuggestion(kind, value, labels) {
    const v = String(value || "").trim();
    if (!v) return;
    const keys = new Set([v, `@${kind}:${v}`, `${kind}: ${v}`, `${kind}:${v}`]);
    for (const lb of labels || []) {
      if (lb) keys.add(String(lb).trim());
    }
    for (const k of keys) {
      if (k) shareSuggestMap.set(k.toLowerCase(), { kind, value: v });
    }
  }

  function groupNameFromToken(v) {
    return String(v || "").replace(/^@group:\s*/i, "").trim();
  }

  function roleNameFromToken(v) {
    return String(v || "").replace(/^@role:\s*/i, "").trim();
  }

  function parseShareTarget(raw) {
    const s = String(raw || "").trim();
    if (!s) return null;
    const cached = shareSuggestMap.get(s.toLowerCase());
    if (cached) return cached;
    if (/^@group:/i.test(s)) return { kind: "group", value: groupNameFromToken(s) };
    const gm = s.match(/^group:\s*(.+)$/i);
    if (gm) return { kind: "group", value: gm[1].trim() };
    if (/^@role:/i.test(s)) return { kind: "role", value: roleNameFromToken(s) };
    const rm = s.match(/^role:\s*(.+)$/i);
    if (rm) return { kind: "role", value: rm[1].trim() };
    return { kind: "user", value: s };
  }

  function nodeShareGroupUrl(nodeId) {
    return `${API_BASE}/api/node/${nodeId}/shares/group`;
  }

  function nodeShareRoleUrl(nodeId) {
    return `${API_BASE}/api/node/${nodeId}/shares/role`;
  }

  async function populateShareSuggestions(datalistEl, q) {
    if (!datalistEl) return;
    shareSuggestMap.clear();
    const [ru, rg, rr] = await Promise.all([
      fetch(usersSuggestUrl(q), { credentials: "same-origin" }),
      fetch(groupsSuggestUrl(q), { credentials: "same-origin" }),
      fetch(rolesSuggestUrl(q), { credentials: "same-origin" }),
    ]);
    const dataU = ru.ok ? await ru.json().catch(() => ({})) : {};
    const dataG = rg.ok ? await rg.json().catch(() => ({})) : {};
    const dataR = rr.ok ? await rr.json().catch(() => ({})) : {};
    const opts = [];
    for (const g of dataG.groups || []) {
      const token = `@group:${g.name}`;
      rememberShareSuggestion("group", g.name, [`Group: ${g.name}`, token]);
      opts.push(`<option value="${escapeHtml(token)}" label="${escapeHtml(`Group: ${g.name}`)}"></option>`);
    }
    for (const r of dataR.roles || []) {
      const token = `@role:${r.name}`;
      rememberShareSuggestion("role", r.name, [`Role: ${r.name}`, token]);
      opts.push(`<option value="${escapeHtml(token)}" label="${escapeHtml(`Role: ${r.name}`)}"></option>`);
    }
    for (const u of dataU.users || []) {
      const label = u.full_name ? `${u.full_name} (${u.username})` : u.username;
      rememberShareSuggestion("user", u.username, [label, u.email || ""]);
      opts.push(`<option value="${escapeHtml(u.username || "")}" label="${escapeHtml(label)}"></option>`);
    }
    datalistEl.innerHTML = opts.join("");
  }

  async function addShareTarget(nodeId, raw, permission, reportStatus) {
    const target = parseShareTarget(raw);
    if (!target) return false;
    let url = nodeShareUserUrl(nodeId);
    let body;
    if (target.kind === "group") {
      url = nodeShareGroupUrl(nodeId);
      body = JSON.stringify({ group_name: target.value, permission });
    } else if (target.kind === "role") {
      url = nodeShareRoleUrl(nodeId);
      body = JSON.stringify({ role_name: target.value, permission });
    } else {
      body = JSON.stringify({ username: target.value, permission });
    }
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body,
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      reportStatus(err.error || "Could not add share");
      return false;
    }
    if (target.kind === "group" || target.kind === "role") {
      const j = await r.json().catch(() => ({}));
      const sh = j.share || {};
      const label =
        target.kind === "group"
          ? sh.group_name || target.value
          : sh.role_name || target.value;
      reportStatus(`Shared with ${target.kind} “${label}”.`);
    }
    return true;
  }

  function hasFilePayload(dt) {
    if (!dt || !dt.types) return false;
    return dt.types.contains ? dt.types.contains("Files") : [...dt.types].includes("Files");
  }

  function setStatus(msg) {
    const st = document.getElementById("status");
    if (!st) return;
    status = st;
    st.textContent = msg || "";
  }

  function formatUploadBytes(n) {
    const x = Number(n);
    if (!Number.isFinite(x) || x <= 0) return "0 B";
    const u = ["B", "KB", "MB", "GB"];
    let i = 0;
    let v = x;
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i += 1;
    }
    const dec = v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 2;
    return `${v.toFixed(dec)} ${u[i]}`;
  }

  function clampPct(p) {
    const x = Number(p);
    if (!Number.isFinite(x)) return 0;
    return Math.min(100, Math.max(0, x));
  }

  function setUploadProgressVisible(visible) {
    refreshUploadProgressRefs();
    if (!uploadProgressEl) return;
    uploadProgressEl.hidden = !visible;
  }

  function updateUploadProgressUi(pct, label, detail) {
    const p = clampPct(pct);
    if (uploadProgressFill) uploadProgressFill.style.width = `${p}%`;
    if (uploadProgressTrack) uploadProgressTrack.setAttribute("aria-valuenow", String(Math.round(p)));
    if (uploadProgressLabel && label != null) uploadProgressLabel.textContent = label;
    if (uploadProgressDetail) uploadProgressDetail.textContent = detail || "";
  }

  function beginUploadSession(title, totalFiles, totalBytes) {
    refreshUploadProgressRefs();
    if (uploadProgressDismiss && !uploadProgressDismiss.dataset.ncDismissBound) {
      uploadProgressDismiss.dataset.ncDismissBound = "1";
      uploadProgressDismiss.addEventListener("click", onUploadProgressDismissClick);
    }
    if (uploadProgressHideTimer) {
      clearTimeout(uploadProgressHideTimer);
      uploadProgressHideTimer = null;
    }
    setUploadProgressVisible(true);
    const tf = Math.max(0, Number(totalFiles) || 0);
    const tb = Number(totalBytes) || 0;
    const sub =
      tf > 0 && tb > 0
        ? `${tf} file${tf === 1 ? "" : "s"} · ${formatUploadBytes(tb)} total`
        : tf > 0
          ? `${tf} file${tf === 1 ? "" : "s"}`
          : "";
    updateUploadProgressUi(0, title || "Uploading…", sub);
  }

  function scheduleHideUploadProgress(delayMs) {
    if (uploadProgressHideTimer) clearTimeout(uploadProgressHideTimer);
    uploadProgressHideTimer = setTimeout(() => {
      uploadProgressHideTimer = null;
      setUploadProgressVisible(false);
      updateUploadProgressUi(0, "Uploading…", "");
    }, delayMs);
  }

  function showUploadSummaryDialog(stats) {
    if (typeof window.ncShowUploadSummaryDialog !== "function") return;
    window.ncShowUploadSummaryDialog(stats);
  }

  /**
   * Upload one file with XMLHttpRequest so we get upload progress (fetch has no upload progress).
   * Response shape matches fetch enough for existing `r.ok` / `r.json()` callers.
   */
  function uploadSingleFile(parentId, file, onProgress) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", uploadUrl);
      xhr.withCredentials = true;
      xhr.upload.onprogress = (ev) => {
        if (typeof onProgress === "function" && ev.lengthComputable) {
          onProgress(ev.loaded, ev.total || ev.loaded);
        }
      };
      xhr.onload = () => {
        resolve({
          ok: xhr.status >= 200 && xhr.status < 300,
          status: xhr.status,
          json: async () => {
            try {
              return JSON.parse(xhr.responseText || "{}");
            } catch {
              return {};
            }
          },
        });
      };
      xhr.onerror = () => {
        resolve({
          ok: false,
          status: 0,
          json: async () => ({ error: "Network error" }),
        });
      };
      const fd = new FormData();
      fd.append("parent_id", String(parentId));
      fd.append("file", file, file.name);
      xhr.send(fd);
    });
  }

  function setShareStatus(msg) {
    if (shareStatus) shareStatus.textContent = msg || "";
  }

  function clearShareDialog() {
    shareNodeId = null;
    lastSharePayload = null;
    if (shareTitle) shareTitle.textContent = "Sharing";
    if (shareSub) shareSub.textContent = "";
    if (sharePublicLinkResult) {
      sharePublicLinkResult.hidden = true;
      sharePublicLinkResult.value = "";
    }
    if (sharePublicLinkBox) sharePublicLinkBox.hidden = true;
    if (sharePublicLinkRemove) sharePublicLinkRemove.hidden = true;
    if (sharePublicLinkCount) {
      sharePublicLinkCount.hidden = true;
      sharePublicLinkCount.textContent = "";
    }
    if (shareInternalList) shareInternalList.innerHTML = "";
    if (shareUsername) shareUsername.value = "";
    if (shareUserSuggestions) shareUserSuggestions.innerHTML = "";
    if (shareManage) shareManage.hidden = true;
    if (shareReadonly) shareReadonly.hidden = true;
    setShareStatus("");
  }

  function renderShareInternalList(shares, nodeId) {
    if (!shareInternalList) return;
    shareInternalList.innerHTML = "";
    for (const sh of shares || []) {
      const li = document.createElement("li");
      li.innerHTML = `<span><strong>${escapeHtml(shareListLabel(sh))}</strong> — ${escapeHtml(sh.permission)}</span>`;
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "nc-btn nc-btn-secondary";
      rm.textContent = "Remove";
      rm.addEventListener("click", async () => {
        const rr = await fetch(nodeShareDeleteUrl(nodeId, sh), {
          method: "DELETE",
          credentials: "same-origin",
        });
        if (rr.ok) {
          openShareDialog(nodeId);
          await reloadListing();
        }
      });
      li.appendChild(rm);
      shareInternalList.appendChild(li);
    }
  }

  async function openShareDialog(nodeId) {
    if (!dlgShare) return;
    clearShareDialog();
    shareNodeId = nodeId;
    setShareStatus("Loading…");
    const r = await fetch(nodeDetailUrl(nodeId), { credentials: "same-origin" });
    if (!r.ok) {
      setShareStatus("Could not load sharing settings.");
      dlgShare.showModal();
      return;
    }
    const d = await r.json().catch(() => ({}));
    lastSharePayload = d;
    const n = d.node || {};
    if (shareTitle) shareTitle.textContent = `Share: ${n.name || "item"}`;
    if (shareSub) {
      const owner = d.owner_username || "—";
      shareSub.textContent = `Owner ${owner} · You: ${d.role || "viewer"}`;
    }

    if (d.can_manage_sharing) {
      if (shareManage) shareManage.hidden = false;
      renderShareInternalList(d.internal_shares || [], nodeId);
      const nLinks = Number(d.link_shares_count || 0) || 0;
      if (sharePublicLinkRemove) sharePublicLinkRemove.hidden = nLinks <= 0;
      if (sharePublicLinkCount) {
        sharePublicLinkCount.hidden = nLinks <= 0;
        sharePublicLinkCount.textContent = nLinks > 0 ? `${nLinks} link(s) active` : "";
      }
      // Show most recent public link URL (copyable)
      const links = Array.isArray(d.link_shares) ? d.link_shares : [];
      const url = links.length && links[0] && links[0].url ? String(links[0].url) : "";
      if (sharePublicLinkBox) sharePublicLinkBox.hidden = !url;
      if (sharePublicLinkResult) sharePublicLinkResult.value = url;
    } else if (d.your_share) {
      if (shareReadonly) shareReadonly.hidden = false;
      if (shareYourText) {
        shareYourText.textContent = `You have ${d.your_share.permission} access. Shared by ${d.your_share.granted_by_username || "owner"}.`;
      }
    } else {
      if (shareReadonly) shareReadonly.hidden = false;
      if (shareYourText) shareYourText.textContent = "You can view this item. Only the owner can change sharing.";
    }

    setShareStatus("");
    dlgShare.showModal();
  }

  function fmtRelative(iso) {
    if (!iso) return "";
    const now = Date.now() + APP_TIME_OFFSET_MS;
    const t = new Date(normalizeIso(iso)).getTime() + APP_TIME_OFFSET_MS;
    const diffSec = Math.max(0, Math.round((now - t) / 1000));
    if (diffSec < 45) return "just now";
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)} minutes ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} hours ago`;
    if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)} days ago`;
    if (diffSec < 86400 * 30) return `${Math.floor(diffSec / (86400 * 7))} weeks ago`;
    if (diffSec < 86400 * 365) return `${Math.floor(diffSec / (86400 * 30))} months ago`;
    return `${Math.floor(diffSec / (86400 * 365))} years ago`;
  }

  function normalizeIso(iso) {
    // SQLite often drops timezone info even when DateTime(timezone=True).
    // If there's no 'Z' or explicit offset, treat as UTC.
    const s = String(iso || "");
    if (!s) return s;
    if (/[zZ]$/.test(s)) return s;
    if (/[+-]\d\d:\d\d$/.test(s)) return s;
    return s + "Z";
  }

  function fmtSize(n) {
    if (n == null || n === "") return "—";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  function fmtLocalFromMs(ms) {
    if (ms == null || Number.isNaN(ms)) return "—";
    try {
      return new Date(ms).toLocaleString(APP_LOCALE, DT_DISPLAY);
    } catch {
      return "—";
    }
  }

  function fmtLocalFromIso(iso) {
    if (!iso) return "—";
    try {
      return new Date(new Date(normalizeIso(iso)).getTime() + APP_TIME_OFFSET_MS).toLocaleString(APP_LOCALE, DT_DISPLAY);
    } catch {
      return "—";
    }
  }

  function showUploadConflictDialog(existing, file, canReplace) {
    return new Promise((resolve) => {
      const done = (choice) => {
        dlgUploadConflict.close();
        resolve(choice);
      };

      document.getElementById("uconflict-existing-name").textContent = existing.name || "—";
      document.getElementById("uconflict-existing-size").textContent = fmtSize(existing.size_bytes);
      document.getElementById("uconflict-existing-date").textContent =
        `${fmtLocalFromIso(existing.updated_at)} (${fmtRelative(existing.updated_at)})`;

      document.getElementById("uconflict-new-name").textContent = file.name.replace(/^.*[\\/]/, "") || file.name;
      document.getElementById("uconflict-new-size").textContent = fmtSize(file.size);
      document.getElementById("uconflict-new-date").textContent = fmtLocalFromMs(file.lastModified);

      uconflictReadonlyHint.hidden = canReplace;
      btnUconflictReplace.hidden = !canReplace;
      btnUconflictReplace.disabled = !canReplace;

      const onReplace = () => done("replace");
      const onKeep = () => done("keep");
      const onCancel = () => done("cancel");
      const onDlgCancel = () => done("cancel");

      btnUconflictReplace.addEventListener("click", onReplace, { once: true });
      btnUconflictKeep.addEventListener("click", onKeep, { once: true });
      btnUconflictCancel.addEventListener("click", onCancel, { once: true });
      dlgUploadConflict.addEventListener("cancel", onDlgCancel, { once: true });

      dlgUploadConflict.showModal();
    });
  }

  function extOf(name) {
    const i = name.lastIndexOf(".");
    return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
  }

  function isOfficeDoc(name) {
    const ext = extOf(name);
    return [
      "doc",
      "docx",
      "xls",
      "xlsx",
      "ppt",
      "pptx",
      "pps",
      "ppsx",
      "ppsm",
      "pptm",
      "pot",
      "potx",
      "potm",
      "odt",
      "ods",
      "odp",
      "rtf",
    ].includes(ext);
  }

  function isEml(name) {
    const ext = extOf(name);
    return ext === "eml";
  }

  function isImage(name) {
    const ext = extOf(name);
    return ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic", "tif", "tiff"].includes(ext);
  }

  function isVideo(name) {
    const ext = extOf(name);
    return ["mp4", "webm", "ogv", "m4v", "mov"].includes(ext);
  }

  function isPdf(name) {
    return extOf(name) === "pdf";
  }

  function isDrawio(name) {
    const ext = extOf(name);
    return ["drawio", "dio", "vsd", "vsdx"].includes(ext);
  }

  function is3dModel(name) {
    const ext = extOf(name);
    return ["3mf"].includes(ext);
  }

  function isTextLike(name) {
    const ext = extOf(name);
    return [
      "sh",
      "bash",
      "py",
      "java",
      "html",
      "htm",
      "php",
      "c",
      "cpp",
      "cc",
      "cxx",
      "h",
      "hpp",
      "conf",
      "keytab",
      "xml",
      "yaml",
      "yml",
      "json",
      "properties",
      "ps1",
      "pem",
      "crt",
      "cer",
      "key",
      "p12",
      "pfx",
      "ldif",
      "txt",
      "log",
      "md",
      "csv",
    ].includes(ext);
  }

  function baseNameNoExt(name) {
    const n = String(name || "");
    const i = n.lastIndexOf(".");
    return i >= 0 ? n.slice(0, i) : n;
  }

  function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let s = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(s);
  }

  async function fetchFileBytes(nodeId) {
    const r = await fetch(`${API_BASE}/api/view/${encodeURIComponent(String(nodeId))}`, { credentials: "same-origin" });
    if (!r.ok) throw new Error("Could not load file");
    return await r.arrayBuffer();
  }

  function openDrawioViewer(it, opts = {}) {
    if (!drawioViewer || !drawioFrame || !it || !it.id) return;
    const { pushHistory = true } = opts || {};
    try {
      if (window.ncSyncViewerOffsets) window.ncSyncViewerOffsets();
      else if (window.ncSyncViewerOffsetsSoon) window.ncSyncViewerOffsetsSoon();
    } catch (_) {}
    drawioItem = it;
    drawioLoaded = false;
    drawioPendingLoad = null;
    if (drawioTitle) drawioTitle.textContent = it.name || "Diagram";

    // diagrams.net embed with postMessage JSON protocol
    drawioFrame.src = "https://embed.diagrams.net/?embed=1&proto=json&spin=1&ui=min&libraries=1";
    drawioViewer.hidden = false;
    try {
      window.requestAnimationFrame(() => {
        try {
          if (window.ncSyncViewerOffsets) window.ncSyncViewerOffsets();
        } catch (_) {}
      });
    } catch (_) {}
    document.body.style.overflow = "hidden";
    if (pushHistory) {
      const base = history.state && typeof history.state === "object" ? history.state : {};
      history.pushState(
        { ...base, viewer: { kind: "drawio", id: it.id, name: it.name || "Diagram" } },
        "",
        window.location.href
      );
    }

    // Prepare load payload async; actual load happens on "init" from iframe.
    (async () => {
      try {
        const ext = extOf(it.name || "");
        const buf = await fetchFileBytes(it.id);
        if (ext === "drawio" || ext === "dio") {
          const xml = new TextDecoder("utf-8").decode(new Uint8Array(buf));
          drawioPendingLoad = { it, ext, xml };
        } else {
          const dataBase64 = arrayBufferToBase64(buf);
          drawioPendingLoad = { it, ext, dataBase64 };
        }
        if (drawioLoaded) {
          // If init already happened, send load now.
          sendDrawioLoad();
        }
      } catch (e) {
        // If we can't load, close and show error.
        closeDrawioViewer({ popHistory: false });
        alert(String(e && e.message ? e.message : e) || "Could not open in draw.io");
      }
    })();
  }

  function closeDrawioViewer(opts = {}) {
    if (!drawioViewer || !drawioFrame) return;
    const { popHistory = true } = opts || {};
    drawioViewer.hidden = true;
    drawioFrame.src = "about:blank";
    document.body.style.overflow = "";
    drawioItem = null;
    drawioLoaded = false;
    drawioPendingLoad = null;
    if (popHistory && history.state && history.state.viewer && history.state.viewer.kind === "drawio") {
      history.back();
    }
  }

  function sendDrawioLoad() {
    if (!drawioFrame || !drawioFrame.contentWindow || !drawioPendingLoad) return;
    const p = drawioPendingLoad;
    if (p.xml) {
      drawioFrame.contentWindow.postMessage(JSON.stringify({ action: "load", xml: p.xml }), "*");
    } else if (p.dataBase64) {
      // Best-effort binary import (Visio): diagrams.net expects a data URI in the `xml` field.
      const ext = String(p.ext || "").toLowerCase();
      const mime = ext === "vsdx" ? "application/vnd.visio" : "application/vnd.visio";
      const dataUri = `data:${mime};base64,${p.dataBase64}`;
      drawioFrame.contentWindow.postMessage(JSON.stringify({ action: "load", xml: dataUri, filename: p.it.name }), "*");
    }
  }

  function openPdfViewer(it, opts = {}) {
    if (!pdfViewer || !pdfFrame || !it || !it.id) return;
    const { pushHistory = true } = opts || {};
    try {
      if (window.ncSyncViewerOffsets) window.ncSyncViewerOffsets();
      else if (window.ncSyncViewerOffsetsSoon) window.ncSyncViewerOffsetsSoon();
    } catch (_) {}
    if (pdfTitle) pdfTitle.textContent = it.name || "PDF";
    pdfFrame.src = `${API_BASE}/api/view/${it.id}`;
    pdfViewer.hidden = false;
    try {
      window.requestAnimationFrame(() => {
        try {
          if (window.ncSyncViewerOffsets) window.ncSyncViewerOffsets();
        } catch (_) {}
      });
    } catch (_) {}
    document.body.style.overflow = "hidden";
    if (pushHistory) {
      const base = history.state && typeof history.state === "object" ? history.state : {};
      history.pushState({ ...base, viewer: { kind: "pdf", id: it.id, name: it.name || "PDF" } }, "", window.location.href);
    }
  }

  async function openTextViewer(it, opts = {}) {
    if (!textViewer || !textArea || !it || !it.id) return;
    const { pushHistory = true } = opts || {};
    try {
      if (window.ncSyncViewerOffsets) window.ncSyncViewerOffsets();
      else if (window.ncSyncViewerOffsetsSoon) window.ncSyncViewerOffsetsSoon();
    } catch (_) {}
    if (textTitle) textTitle.textContent = it.name || "Text";
    if (textStatus) textStatus.textContent = "Loading…";
    textArea.value = "";
    textViewer.hidden = false;
    try {
      window.requestAnimationFrame(() => {
        try {
          if (window.ncSyncViewerOffsets) window.ncSyncViewerOffsets();
        } catch (_) {}
      });
    } catch (_) {}
    document.body.style.overflow = "hidden";
    if (pushHistory) {
      const base = history.state && typeof history.state === "object" ? history.state : {};
      history.pushState({ ...base, viewer: { kind: "text", id: it.id, name: it.name || "Text" } }, "", window.location.href);
    }
    try {
      const r = await fetch(`${API_BASE}/api/text/${encodeURIComponent(String(it.id))}`, { credentials: "same-origin" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message || j.error || "Could not load text");
      textArea.value = String(j.text || "");
      if (textStatus) {
        const suffix = j.truncated ? " (truncated)" : "";
        textStatus.textContent = `${Number(j.bytes) ? `${fmtSize(Number(j.bytes))}` : ""}${suffix}`;
      }
      try {
        textArea.scrollTop = 0;
      } catch (_) {}
    } catch (e) {
      if (textStatus) textStatus.textContent = String(e && e.message ? e.message : e) || "Could not load text";
    }
  }

  function closeTextViewer(opts = {}) {
    if (!textViewer || !textArea) return;
    const { popHistory = true } = opts || {};
    textViewer.hidden = true;
    textArea.value = "";
    if (textStatus) textStatus.textContent = "";
    document.body.style.overflow = "";
    if (popHistory && history.state && history.state.viewer && history.state.viewer.kind === "text") {
      history.back();
    }
  }

  window.addEventListener(
    "message",
    async (ev) => {
    if (!drawioViewer || drawioViewer.hidden) return;
    let msg = null;
    try {
      msg = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
    } catch {
      msg = null;
    }
    if (!msg) return;

    if (msg.event === "init") {
      drawioLoaded = true;
      sendDrawioLoad();
      return;
    }

    // Save: we upload a .drawio file back into the same folder (versions existing if same name).
    if (msg.event === "save" || msg.event === "export") {
      const xml = msg.xml || msg.data || "";
      if (!xml || !drawioItem) return;
      const ext = extOf(drawioItem.name || "");
      const parentId = drawioItem.parent_id != null ? drawioItem.parent_id : currentParentId;
      if (parentId == null) return;
      const outName =
        ext === "drawio" || ext === "dio" ? drawioItem.name : `${baseNameNoExt(drawioItem.name)}.drawio`;

      beginBlockingNavDuringTransfer();
      try {
        beginUploadSession("Saving diagram…", 1, xml.length);
        const blob = new Blob([String(xml)], { type: "application/xml" });
        const file = new File([blob], outName, { type: "application/xml" });
        const r = await uploadSingleFile(parentId, file, (loaded, total) => {
          const pct = total > 0 ? (loaded / total) * 100 : 0;
          updateUploadProgressUi(pct, "Saving diagram…", outName);
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Save failed");
        scheduleHideUploadProgress(900);
        closeDrawioViewer();
        // Refresh list/detail to show new version if needed.
        refreshMainView().catch(() => {});
      } catch (e) {
        scheduleHideUploadProgress(1500);
        alert(String(e && e.message ? e.message : e) || "Save failed");
      } finally {
        endBlockingNavDuringTransfer();
      }
    }
    },
    { signal: ncFbSig }
  );

  function openEmlViewer(it, opts = {}) {
    if (!emlViewer || !emlFrame || !it || !it.id) return;
    const { pushHistory = true } = opts || {};
    try {
      if (window.ncSyncViewerOffsets) window.ncSyncViewerOffsets();
      else if (window.ncSyncViewerOffsetsSoon) window.ncSyncViewerOffsetsSoon();
    } catch (_) {}
    if (emlTitle) emlTitle.textContent = it.name || "Email";
    // Use embed mode to avoid nested chrome inside iframe.
    emlFrame.src = `${API_BASE}/eml/${encodeURIComponent(String(it.id))}?embed=1`;
    emlViewer.hidden = false;
    try {
      window.requestAnimationFrame(() => {
        try {
          if (window.ncSyncViewerOffsets) window.ncSyncViewerOffsets();
        } catch (_) {}
      });
    } catch (_) {}
    document.body.style.overflow = "hidden";
    if (pushHistory) {
      const base = history.state && typeof history.state === "object" ? history.state : {};
      history.pushState({ ...base, viewer: { kind: "eml", id: it.id, name: it.name || "Email" } }, "", window.location.href);
    }
  }

  function closeEmlViewer(opts = {}) {
    if (!emlViewer || !emlFrame) return;
    const { popHistory = true } = opts || {};
    emlViewer.hidden = true;
    emlFrame.src = "about:blank";
    document.body.style.overflow = "";
    if (popHistory && history.state && history.state.viewer && history.state.viewer.kind === "eml") {
      history.back();
    }
  }

  function closePdfViewer(opts = {}) {
    if (!pdfViewer || !pdfFrame) return;
    const { popHistory = true } = opts || {};
    pdfViewer.hidden = true;
    pdfFrame.src = "about:blank";
    document.body.style.overflow = "";
    if (popHistory && history.state && history.state.viewer && history.state.viewer.kind === "pdf") {
      history.back();
    }
  }

  if (drawioClose) drawioClose.addEventListener("click", () => closeDrawioViewer());
  if (emlClose) emlClose.addEventListener("click", () => closeEmlViewer());
  if (textClose) textClose.addEventListener("click", () => closeTextViewer());

  function openImageViewer(it, opts = {}) {
    if (!imgViewer || !imgEl || !it || !it.id) return;
    const { pushHistory = true } = opts || {};
    try {
      if (window.ncSyncViewerOffsets) window.ncSyncViewerOffsets();
      else if (window.ncSyncViewerOffsetsSoon) window.ncSyncViewerOffsetsSoon();
    } catch (_) {}
    if (imgTitle) imgTitle.textContent = it.name || "Image";
    imgEl.src = `${API_BASE}/api/view/${it.id}`;
    imgViewer.hidden = false;
    try {
      window.requestAnimationFrame(() => {
        try {
          if (window.ncSyncViewerOffsets) window.ncSyncViewerOffsets();
        } catch (_) {}
      });
    } catch (_) {}
    document.body.style.overflow = "hidden";
    if (pushHistory) {
      const base = history.state && typeof history.state === "object" ? history.state : {};
      history.pushState(
        { ...base, viewer: { kind: "image", id: it.id, name: it.name || "Image" } },
        "",
        window.location.href
      );
    }
  }

  function closeImageViewer(opts = {}) {
    if (!imgViewer || !imgEl) return;
    const { popHistory = true } = opts || {};
    imgViewer.hidden = true;
    imgEl.src = "";
    document.body.style.overflow = "";
    if (popHistory && history.state && history.state.viewer && history.state.viewer.kind === "image") {
      history.back();
    }
  }

  function openVideoViewer(it, opts = {}) {
    if (!vidViewer || !vidEl || !it || !it.id) return;
    const { pushHistory = true } = opts || {};
    if (vidTitle) vidTitle.textContent = it.name || "Video";
    // Reset first so seeking state doesn't leak between videos.
    try {
      vidEl.pause();
    } catch {}
    vidEl.src = `${API_BASE}/api/view/${it.id}`;
    vidViewer.hidden = false;
    document.body.style.overflow = "hidden";
    if (pushHistory) {
      const base = history.state && typeof history.state === "object" ? history.state : {};
      history.pushState({ ...base, viewer: { kind: "video", id: it.id, name: it.name || "Video" } }, "", window.location.href);
    }
  }

  function closeVideoViewer(opts = {}) {
    if (!vidViewer || !vidEl) return;
    const { popHistory = true } = opts || {};
    vidViewer.hidden = true;
    try {
      vidEl.pause();
    } catch {}
    vidEl.removeAttribute("src");
    try {
      vidEl.load();
    } catch {}
    document.body.style.overflow = "";
    if (popHistory && history.state && history.state.viewer && history.state.viewer.kind === "video") {
      history.back();
    }
  }

  // --- 3D model viewer wiring (.3mf) ---
  function setModel3dStatus(msg) {
    if (!model3dStatus) return;
    const s = String(msg || "").trim();
    model3dStatus.textContent = s;
    model3dStatus.hidden = !s;
  }

  function ensureScript(src) {
    return new Promise((resolve, reject) => {
      try {
        const existing = document.querySelector(`script[data-src="${src}"]`);
        if (existing) {
          existing.addEventListener("load", () => resolve(), { once: true });
          existing.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)), { once: true });
          // If it already loaded previously, resolve immediately.
          if (existing.getAttribute("data-loaded") === "1") resolve();
          return;
        }
        const s = document.createElement("script");
        s.src = src;
        s.async = true;
        s.defer = true;
        s.setAttribute("data-src", src);
        s.addEventListener("load", () => {
          s.setAttribute("data-loaded", "1");
          resolve();
        });
        s.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)));
        document.head.appendChild(s);
      } catch (e) {
        reject(e);
      }
    });
  }

  async function ensureThree3mfLibs() {
    // Non-module builds so we can keep file_browser.js as classic script.
    // Pins are deliberate to avoid breaking changes.
    await ensureScript("https://unpkg.com/three@0.160.0/build/three.min.js");
    await ensureScript("https://unpkg.com/three@0.160.0/examples/js/controls/OrbitControls.js");
    await ensureScript("https://unpkg.com/three@0.160.0/examples/js/loaders/3MFLoader.js");
    const THREE = window.THREE;
    const Loader = THREE && (THREE.ThreeMFLoader || THREE.ThreeMFLoader);
    if (!THREE || !THREE.OrbitControls || !Loader) throw new Error("3D viewer libraries failed to load.");
  }

  function open3dViewer(it, opts = {}) {
    if (!model3dViewer || !model3dCanvas || !it || !it.id) return;
    const { pushHistory = true } = opts || {};
    try {
      if (window.ncSyncViewerOffsets) window.ncSyncViewerOffsets();
      else if (window.ncSyncViewerOffsetsSoon) window.ncSyncViewerOffsetsSoon();
    } catch (_) {}

    if (model3dTitle) model3dTitle.textContent = it.name || "3D model";
    setModel3dStatus("Loading 3D model…");

    // Close any previous runtime.
    try {
      if (model3dRuntime && typeof model3dRuntime.dispose === "function") model3dRuntime.dispose();
    } catch (_) {}
    model3dRuntime = null;

    model3dViewer.hidden = false;
    document.body.style.overflow = "hidden";
    if (pushHistory) {
      const base = history.state && typeof history.state === "object" ? history.state : {};
      history.pushState({ ...base, viewer: { kind: "3d", id: it.id, name: it.name || "3D model" } }, "", window.location.href);
    }

    (async () => {
      try {
        await ensureThree3mfLibs();
        const THREE = window.THREE;
        const canvas = model3dCanvas;
        const host = canvas.parentElement;
        if (!host) throw new Error("3D viewer host missing.");

        const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: false });
        renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        renderer.setClearColor(0x0b1220, 1);

        const scene = new THREE.Scene();

        const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 2000);
        camera.position.set(0.5, 0.35, 0.6);

        const controls = new THREE.OrbitControls(camera, canvas);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.rotateSpeed = 0.6;
        controls.zoomSpeed = 0.9;
        controls.panSpeed = 0.6;

        // Lights
        const hemi = new THREE.HemisphereLight(0xffffff, 0x223344, 0.9);
        scene.add(hemi);
        const dir = new THREE.DirectionalLight(0xffffff, 0.9);
        dir.position.set(2, 3, 2);
        scene.add(dir);

        // Ground-ish subtle fill
        const amb = new THREE.AmbientLight(0xffffff, 0.15);
        scene.add(amb);

        const r = await fetch(`${API_BASE}/api/view/${it.id}`, { credentials: "same-origin" });
        if (!r.ok) throw new Error(`Could not load model (${r.status})`);
        const buf = await r.arrayBuffer();

        // Parse .3mf
        const Loader = THREE.ThreeMFLoader || THREE.ThreeMFLoader;
        const loader = new Loader();
        const obj = loader.parse(buf);
        scene.add(obj);

        // Fit camera to model bounds
        const box = new THREE.Box3().setFromObject(obj);
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const dist = (maxDim / 2) / Math.tan((camera.fov * Math.PI) / 360);
        const pad = 1.25;
        camera.position.set(center.x + dist * pad, center.y + dist * 0.6 * pad, center.z + dist * pad);
        camera.near = Math.max(0.001, maxDim / 1000);
        camera.far = Math.max(50, maxDim * 50);
        camera.updateProjectionMatrix();
        controls.target.copy(center);
        controls.update();

        function resize() {
          const w = Math.max(1, host.clientWidth || 1);
          const h = Math.max(1, host.clientHeight || 1);
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          renderer.setSize(w, h, false);
        }

        resize();
        const onResize = () => resize();
        window.addEventListener("resize", onResize);

        let raf = 0;
        let stopped = false;
        const tick = () => {
          if (stopped) return;
          controls.update();
          renderer.render(scene, camera);
          raf = window.requestAnimationFrame(tick);
        };
        raf = window.requestAnimationFrame(tick);

        setModel3dStatus("Drag to rotate · Scroll to zoom · Shift+Drag to pan");

        model3dRuntime = {
          dispose() {
            stopped = true;
            try {
              if (raf) window.cancelAnimationFrame(raf);
            } catch (_) {}
            try {
              window.removeEventListener("resize", onResize);
            } catch (_) {}
            try {
              controls.dispose();
            } catch (_) {}
            try {
              // Dispose geometries/materials
              scene.traverse((o) => {
                if (o && o.geometry) {
                  try {
                    o.geometry.dispose();
                  } catch (_) {}
                }
                if (o && o.material) {
                  const m = o.material;
                  if (Array.isArray(m)) m.forEach((x) => x && x.dispose && x.dispose());
                  else if (m && m.dispose) m.dispose();
                }
              });
            } catch (_) {}
            try {
              renderer.dispose();
            } catch (_) {}
            try {
              // Clear canvas
              const gl = renderer.getContext();
              if (gl) gl.getExtension("WEBGL_lose_context")?.loseContext();
            } catch (_) {}
          },
        };
      } catch (e) {
        setModel3dStatus(String(e && e.message ? e.message : e) || "Could not load 3D model.");
      }
    })();
  }

  function close3dViewer(opts = {}) {
    if (!model3dViewer) return;
    const { popHistory = true } = opts || {};
    model3dViewer.hidden = true;
    document.body.style.overflow = "";
    setModel3dStatus("");
    try {
      if (model3dRuntime && typeof model3dRuntime.dispose === "function") model3dRuntime.dispose();
    } catch (_) {}
    model3dRuntime = null;
    if (popHistory && history.state && history.state.viewer && history.state.viewer.kind === "3d") {
      history.back();
    }
  }

  function fileIconSvg(isFolder, name) {
    if (isFolder) {
      return `<svg class="nc-file-icon is-folder" width="32" height="32" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M10 4H4c-1.11 0-2 .89-2 2v12c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2h-8l-2-2z"/></svg>`;
    }
    const ext = extOf(name);
    let fill = "#6a6a6a";
    if (ext === "pdf") fill = "#e74c3c";
    else if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) fill = "#9b59b6";
    else if (["mp4", "webm", "ogv", "m4v", "mov"].includes(ext)) fill = "#111827";
    else if (["xls", "xlsx", "csv"].includes(ext)) fill = "#27ae60";
    else if (["doc", "docx"].includes(ext)) fill = "#2980b9";
    return `<svg class="nc-file-icon" width="32" height="32" viewBox="0 0 24 24" aria-hidden="true"><path fill="${fill}" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg>`;
  }

  function sortListingItems(items) {
    return [...(items || [])].sort((a, b) => {
      const fa = !!a.is_folder;
      const fb = !!b.is_folder;
      if (fa !== fb) return fa ? -1 : 1;
      const c = (a.name || "").localeCompare(b.name || "", undefined, {
        sensitivity: "base",
        numeric: true,
      });
      return listSortDir === "asc" ? c : -c;
    });
  }

  function parseIsoMs(iso) {
    if (!iso) return 0;
    const t = new Date(normalizeIso(iso)).getTime() + APP_TIME_OFFSET_MS;
    return Number.isFinite(t) ? t : 0;
  }

  function applyLeftNavUi() {
    document.querySelectorAll(".nc-leftnav-item[data-nav]").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.nav === leftNavMode);
    });
  }

  function filterPayloadForLeftNav(payload) {
    const base = payload || { items: [], shared_with_me: [], breadcrumb: [{ id: null, name: "All files" }] };
    const q = (leftSearchQuery || "").toLowerCase();
    const fav = favoriteIds || new Set();

    const filterBySearch = (arr) => {
      if (!q) return arr;
      return (arr || []).filter((it) => String(it.name || "").toLowerCase().includes(q));
    };

    // Only root view supports shares section.
    const isRoot = currentParentId === null;

    if (leftNavMode === "shares") {
      if (!isRoot)
        return {
          ...base,
          items: filterBySearch(base.items || []),
          shared_with_me: [],
          shared_by_me: [],
          _sharesDualView: false,
        };
      return {
        ...base,
        breadcrumb: [{ id: null, name: "Shares" }],
        // Incoming + outgoing so recipients see what others shared with them, not only what they sent.
        items: filterBySearch(base.shared_by_me || []),
        shared_with_me: filterBySearch(base.shared_with_me || []),
        shared_by_me: [],
        _sharesDualView: true,
      };
    }

    if (leftNavMode === "favorites") {
      const items = filterBySearch((base.items || []).filter((it) => fav.has(String(it.id))));
      return { ...base, items, shared_with_me: [] };
    }

    if (leftNavMode === "recycle") {
      // UI uses a dedicated fetch; keep payload filtering minimal.
      return { ...base, items: filterBySearch(base.items || []), shared_with_me: [] };
    }

    if (leftNavMode === "admin") {
      return {
        ...base,
        items: filterBySearch(base.items || []),
        shared_with_me: [],
        shared_by_me: [],
        breadcrumb: base.breadcrumb || [{ id: null, name: "All users" }],
      };
    }

    if (leftNavMode === "personal" || leftNavMode === "all") {
      return { ...base, items: filterBySearch(base.items || []), shared_with_me: isRoot ? filterBySearch(base.shared_with_me || []) : [] };
    }

    return { ...base, items: filterBySearch(base.items || []), shared_with_me: isRoot ? filterBySearch(base.shared_with_me || []) : [] };
  }

  function fileThumbKind(name) {
    const ext = extOf(name);
    if (["png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "bmp", "tif", "tiff"].includes(ext)) return "image";
    if (ext === "pdf") return "pdf";
    if (["xls", "xlsx", "csv", "ods"].includes(ext)) return "sheet";
    if (["doc", "docx", "odt", "rtf", "txt", "md"].includes(ext)) return "doc";
    if (["ppt", "pptx", "pps", "ppsx", "ppsm", "pptm", "pot", "potx", "potm", "key"].includes(ext)) return "deck";
    if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "archive";
    if (["mp3", "wav", "flac", "m4a"].includes(ext)) return "audio";
    if (["mp4", "mov", "webm", "mkv"].includes(ext)) return "video";
    return "file";
  }

  function fileThumbHtml(isFolder, name) {
    if (isFolder) {
      return `<span class="nc-list-icon-wrap">${fileIconSvg(true, name)}</span>`;
    }
    const k = fileThumbKind(name);
    return `<div class="nc-file-thumb nc-file-thumb--${k}" role="presentation" aria-hidden="true"></div>`;
  }

  function typeLabel(it) {
    if (it.is_folder) return "Folder";
    const ext = extOf(it.name);
    if (!ext) return "File";
    const map = {
      pdf: "PDF",
      doc: "Word",
      docx: "Word",
      xls: "Excel",
      xlsx: "Excel",
      csv: "Spreadsheet",
      ppt: "Presentation",
      pptx: "Presentation",
      png: "Image",
      jpg: "Image",
      jpeg: "Image",
      gif: "Image",
      webp: "Image",
      svg: "Image",
      zip: "Archive",
      txt: "Text",
      md: "Markdown",
    };
    return map[ext] || ext.toUpperCase();
  }

  function renderBreadcrumb(crumbs) {
    lastBreadcrumb = crumbs && crumbs.length ? crumbs : [{ id: null, name: "All files" }];
    breadcrumbEl.innerHTML = "";
    lastBreadcrumb.forEach((c, i) => {
      const isLast = i === lastBreadcrumb.length - 1;
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "sep";
        sep.textContent = "›";
        breadcrumbEl.appendChild(sep);
      }
      if (isLast) {
        const span = document.createElement("span");
        span.className = "current";
        span.textContent = c.name;
        breadcrumbEl.appendChild(span);
      } else {
        const a = document.createElement("a");
        a.href = "#";
        a.textContent = c.name;
        a.addEventListener("click", (e) => {
          e.preventDefault();
          cancelPendingSearch();
          clearLeftSearchInput();
          load(c.id);
        });
        breadcrumbEl.appendChild(a);
      }
    });
  }

  async function uploadFiles(parentId, files) {
    if (leftNavMode === "personal") {
      setStatus("Uploads are disabled in Personal files view. Switch to All files and open a folder first.");
      return;
    }
    const pid = parentId != null ? parentId : effectiveParentId();
    if (pid == null) {
      setStatus("Open your Home folder first, then upload.");
      return;
    }
    const list = Array.from(files || []).filter((f) => f && f.name);
    if (!list.length) return;

    const totalFiles = list.length;
    const totalBytes = list.reduce((s, f) => s + (f.size || 0), 0);
    const useByteProgress = totalBytes > 0;

    if (tryStartIntranetBackgroundUpload("files", pid, list, totalFiles, totalBytes, "Uploading…")) {
      return;
    }

    beginBlockingNavDuringTransfer();
    try {
      beginUploadSession("Uploading…", totalFiles, totalBytes);
      let completedBytes = 0;
      let uploaded = 0;
      let skipped = 0;
      let failed = 0;
      let lastFailHint = "";

      for (let i = 0; i < list.length; i++) {
        const file = list[i];
        const baseName = file.name.replace(/^.*[\\/]/, "");
        const cu = await fetch(
          `${API_BASE}/api/upload-conflict?parent_id=${pid}&filename=${encodeURIComponent(baseName)}`,
          { credentials: "same-origin" }
        );
        const cd = await cu.json().catch(() => ({}));
        if (cu.ok && cd.conflict) {
          const choice = await showUploadConflictDialog(cd.existing, file, cd.can_replace !== false);
          if (choice === "cancel") {
            scheduleHideUploadProgress(200);
            if (uploaded || skipped) {
              setStatus(`Upload stopped. ${uploaded} uploaded, ${skipped} skipped.`);
              await reloadListing();
            } else {
              setStatus("Upload cancelled.");
            }
            return;
          }
          if (choice === "keep") {
            skipped += 1;
            if (useByteProgress) completedBytes += file.size || 0;
            const pctSkip = useByteProgress
              ? clampPct((completedBytes / totalBytes) * 100)
              : clampPct(((i + 1) / totalFiles) * 100);
            updateUploadProgressUi(
              pctSkip,
              "Uploading…",
              `Kept existing · ${i + 1} of ${totalFiles} · ${baseName}`
            );
            continue;
          }
        }

        const fileSize = file.size || 0;
        const onProg = (loaded, tot) => {
          let pct;
          if (useByteProgress) {
            pct = ((completedBytes + loaded) / totalBytes) * 100;
          } else {
            const denom = tot || fileSize || 1;
            pct = ((i + loaded / denom) / totalFiles) * 100;
          }
          const detail = useByteProgress
            ? `File ${i + 1} of ${totalFiles} · ${baseName} · ${formatUploadBytes(
                completedBytes + loaded
              )} / ${formatUploadBytes(totalBytes)}`
            : `File ${i + 1} of ${totalFiles} · ${baseName}`;
          updateUploadProgressUi(pct, "Uploading…", detail);
        };

        const r = await uploadSingleFile(pid, file, onProg);
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          const hint =
            r.status === 413
              ? "File too large for upload (server limit)."
              : err.error || err.reason || "Upload failed";
          failed += 1;
          lastFailHint = `${baseName}: ${hint}`;
          if (useByteProgress) completedBytes += fileSize;
          updateUploadProgressUi(
            useByteProgress ? clampPct((completedBytes / totalBytes) * 100) : clampPct(((i + 1) / totalFiles) * 100),
            "Uploading…",
            `Failed ${i + 1} of ${totalFiles} · ${baseName}`
          );
          continue;
        }
        completedBytes += fileSize;
        uploaded += 1;
        if (useByteProgress) {
          updateUploadProgressUi(
            clampPct((completedBytes / totalBytes) * 100),
            "Uploading…",
            `Finished ${i + 1} of ${totalFiles} · ${baseName}`
          );
        }
      }

      const summaryParts = [];
      if (uploaded) summaryParts.push(`${uploaded} uploaded`);
      if (skipped) summaryParts.push(`${skipped} kept existing`);
      if (failed) summaryParts.push(`${failed} failed`);
      const summary = summaryParts.length ? summaryParts.join(", ") + "." : "";
      const title = failed ? "Upload finished with errors" : uploaded ? "Upload complete" : skipped ? "Done" : "Done";
      if (failed) {
        updateUploadProgressUi(100, title, `${summary} ${lastFailHint}`.trim());
        setStatus(`Upload finished: ${summary} Check the progress detail for the last error.`);
      } else if (uploaded && skipped) {
        updateUploadProgressUi(100, title, summary);
        setStatus(`Upload complete (${uploaded} replaced or added, ${skipped} kept existing).`);
      } else if (uploaded) {
        updateUploadProgressUi(100, title, summary || `${uploaded} file${uploaded === 1 ? "" : "s"} uploaded.`);
        setStatus("Upload complete.");
      } else if (skipped) {
        updateUploadProgressUi(100, title, summary);
        setStatus(`No files uploaded (${skipped} existing file(s) kept).`);
      } else {
        updateUploadProgressUi(100, title, "");
        setStatus("");
      }
      scheduleHideUploadProgress(900);
      showUploadSummaryDialog({
        uploaded,
        skipped,
        failed,
        total: totalFiles,
        mode: "files",
        partial: failed > 0,
        cancelled: false,
        lastError: lastFailHint || "",
      });
      await reloadListing();
    } catch (e) {
      scheduleHideUploadProgress(200);
      setStatus(String(e && e.message ? e.message : e) || "Upload failed");
    } finally {
      endBlockingNavDuringTransfer();
    }
  }

  async function ensureFolderPath(baseParentId, relDir) {
    const norm = String(relDir || "").replace(/^[\\/]+|[\\/]+$/g, "");
    if (!norm) return baseParentId;
    const parts = norm.split(/[\\/]+/).filter(Boolean);
    let cur = baseParentId;
    let acc = "";
    // cache key is baseParentId + path
    ensureFolderPath._cache = ensureFolderPath._cache || new Map();
    const cache = ensureFolderPath._cache;
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      const k = `${baseParentId}::${acc}`;
      if (cache.has(k)) {
        cur = cache.get(k);
        continue;
      }
      const r = await fetch(mkdirUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ parent_id: cur, name: p, reuse_existing: true }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.node || !j.node.id) {
        throw new Error(j.error || "Could not create folder path");
      }
      cur = j.node.id;
      cache.set(k, cur);
    }
    return cur;
  }

  async function uploadFolder(parentId, files) {
    if (leftNavMode === "personal") {
      setStatus("Uploads are disabled in Personal files view. Switch to All files and open a folder first.");
      return;
    }
    const list = Array.from(files || []).filter((f) => f && f.name);
    const pid = parentId != null ? parentId : effectiveParentId();
    if (pid == null) {
      setStatus("Open your Home folder first, then upload a folder.");
      return;
    }
    if (!list.length) return;

    const totalFiles = list.length;
    const totalBytes = list.reduce((s, f) => s + (f.size || 0), 0);
    const useByteProgress = totalBytes > 0;

    if (tryStartIntranetBackgroundUpload("folder", pid, list, totalFiles, totalBytes, "Uploading folder…")) {
      return;
    }

    beginBlockingNavDuringTransfer();
    try {
      beginUploadSession("Uploading folder…", totalFiles, totalBytes);
      let completedBytes = 0;
      let uploaded = 0;
      let skipped = 0;
      let failed = 0;
      let lastFailHint = "";

      try {
        for (let i = 0; i < list.length; i++) {
        const f = list[i];
        const rel = fileRelativePath(f);
        const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
        const baseName = rel.includes("/") ? rel.slice(rel.lastIndexOf("/") + 1) : f.name;

        if (dir) {
          const pctPrep = useByteProgress
            ? clampPct((completedBytes / totalBytes) * 100)
            : clampPct((i / Math.max(1, totalFiles)) * 100);
          updateUploadProgressUi(pctPrep, "Uploading folder…", `Preparing path · ${dir}`);
        }

        const destId = await ensureFolderPath(pid, dir);

        const cu = await fetch(
          `${API_BASE}/api/upload-conflict?parent_id=${destId}&filename=${encodeURIComponent(baseName)}`,
          { credentials: "same-origin" }
        );
        const cd = await cu.json().catch(() => ({}));
        if (cu.ok && cd.conflict) {
          const choice = await showUploadConflictDialog(cd.existing, f, cd.can_replace !== false);
          if (choice === "cancel") {
            scheduleHideUploadProgress(200);
            setStatus(`Upload stopped. ${uploaded} uploaded, ${skipped} skipped.`);
            await reloadListing();
            return;
          }
          if (choice === "keep") {
            skipped += 1;
            if (useByteProgress) completedBytes += f.size || 0;
            const pctSkip = useByteProgress
              ? clampPct((completedBytes / totalBytes) * 100)
              : clampPct(((i + 1) / totalFiles) * 100);
            updateUploadProgressUi(
              pctSkip,
              "Uploading folder…",
              `Kept existing · ${i + 1} of ${totalFiles} · ${dir ? `${dir}/` : ""}${baseName}`
            );
            continue;
          }
        }

        const fileSize = f.size || 0;
        const onProg = (loaded, tot) => {
          let pct;
          if (useByteProgress) {
            pct = ((completedBytes + loaded) / totalBytes) * 100;
          } else {
            const denom = tot || fileSize || 1;
            pct = ((i + loaded / denom) / totalFiles) * 100;
          }
          const pathHint = dir ? `${dir}/` : "";
          const detail = useByteProgress
            ? `File ${i + 1} of ${totalFiles} · ${pathHint}${baseName} · ${formatUploadBytes(
                completedBytes + loaded
              )} / ${formatUploadBytes(totalBytes)}`
            : `File ${i + 1} of ${totalFiles} · ${pathHint}${baseName}`;
          updateUploadProgressUi(pct, "Uploading folder…", detail);
        };

        const r = await uploadSingleFile(destId, f, onProg);
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          const hint =
            r.status === 413
              ? "File too large for upload (server limit)."
              : err.error || err.reason || "Upload failed";
          failed += 1;
          lastFailHint = `${rel}: ${hint}`;
          if (useByteProgress) completedBytes += fileSize;
          const pathHint = dir ? `${dir}/` : "";
          updateUploadProgressUi(
            useByteProgress ? clampPct((completedBytes / totalBytes) * 100) : clampPct(((i + 1) / totalFiles) * 100),
            "Uploading folder…",
            `Failed ${i + 1} of ${totalFiles} · ${pathHint}${baseName}`
          );
          continue;
        }
        completedBytes += fileSize;
        uploaded += 1;
        if (useByteProgress) {
          updateUploadProgressUi(
            clampPct((completedBytes / totalBytes) * 100),
            "Uploading folder…",
            `Finished ${i + 1} of ${totalFiles} · ${baseName}`
          );
        }
      }

      const summaryParts = [];
      if (uploaded) summaryParts.push(`${uploaded} uploaded`);
      if (skipped) summaryParts.push(`${skipped} kept existing`);
      if (failed) summaryParts.push(`${failed} failed`);
      const summary = summaryParts.length ? summaryParts.join(", ") + "." : "";
      const title = failed ? "Folder upload finished with errors" : "Folder upload complete";
      if (failed) {
        updateUploadProgressUi(100, title, `${summary} ${lastFailHint}`.trim());
        setStatus(`Folder upload finished: ${summary} Check the progress detail for the last error.`);
      } else if (uploaded && skipped) {
        updateUploadProgressUi(100, title, summary);
        setStatus(`Folder upload complete (${uploaded} uploaded, ${skipped} kept existing).`);
      } else if (uploaded) {
        updateUploadProgressUi(100, title, summary || `${uploaded} file${uploaded === 1 ? "" : "s"} uploaded.`);
        setStatus("Folder upload complete.");
      } else if (skipped) {
        updateUploadProgressUi(100, "Done", summary);
        setStatus(`No files uploaded (${skipped} kept existing).`);
      } else {
        updateUploadProgressUi(100, "Done", "");
        setStatus("");
      }
      const folderRoots = new Set();
      list.forEach((f) => {
        const rel = fileRelativePath(f);
        const top = rel.includes("/") ? rel.split("/")[0] : "";
        if (top) folderRoots.add(top);
      });
      scheduleHideUploadProgress(900);
      showUploadSummaryDialog({
        uploaded,
        skipped,
        failed,
        total: totalFiles,
        folderCount: folderRoots.size,
        mode: "folder",
        partial: failed > 0,
        cancelled: false,
        lastError: lastFailHint || "",
      });
      await reloadListing();
      } catch (e) {
        scheduleHideUploadProgress(200);
        setStatus(String(e && e.message ? e.message : e) || "Folder upload failed");
      }
    } finally {
      endBlockingNavDuringTransfer();
    }
  }

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  /** Pretty path for search results (path_key is usually /Home/…/file). */
  function displayPathForSearch(pathKey) {
    if (!pathKey) return "";
    const s = String(pathKey).replace(/^\/+/, "").trim();
    if (!s) return "";
    return s.split("/").filter(Boolean).join(" › ");
  }

  function closeRowMenu() {
    rowMenu.hidden = true;
    rowMenuBackdrop.hidden = true;
    rowMenu.innerHTML = "";
  }

  function openRowMenu(anchorBtn, it) {
    closeRowMenu();
    const rect = anchorBtn.getBoundingClientRect();
    rowMenu.style.top = `${rect.bottom + 4}px`;
    rowMenu.style.left = `${Math.min(rect.left, window.innerWidth - 220)}px`;

    const add = (label, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.addEventListener("click", () => {
        closeRowMenu();
        fn();
      });
      rowMenu.appendChild(b);
    };

    if (leftNavMode === "recycle") {
      add("Restore", () => restoreFromRecycle(it.id));
      add("Delete permanently…", () => purgeFromRecycle(it.id, it.name));
    } else {
      add("Details", () => openDetail(it.id));
      add("Rename…", () => renameNode(it));
      if (!it.is_folder) {
        add("Download", () => {
          window.location.href = `${API_BASE}/api/download/${it.id}`;
        });
        add("Versions", () => openVersions(it.id));
      }
      add("Share…", () => openShareDialog(it.id));
      add("Delete…", () => deleteNode(it.id, it.name));
    }

    rowMenu.hidden = false;
    rowMenuBackdrop.hidden = false;
  }

  function openContextMenuAt(x, y, it) {
    closeRowMenu();
    rowMenu.style.top = `${Math.min(y, window.innerHeight - 240)}px`;
    rowMenu.style.left = `${Math.min(x, window.innerWidth - 220)}px`;

    const add = (label, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.addEventListener("click", () => {
        closeRowMenu();
        fn();
      });
      rowMenu.appendChild(b);
    };

    if (leftNavMode === "recycle") {
      add("Restore", () => restoreFromRecycle(it.id));
      add("Delete permanently…", () => purgeFromRecycle(it.id, it.name));
    } else {
      add("Rename…", () => renameNode(it));
      if (!it.is_folder) add("Download", () => (window.location.href = `${API_BASE}/api/download/${it.id}`));
      if (!it.is_folder && isPdf(it.name)) add("View PDF", () => openPdfViewer(it));
      if (!it.is_folder && isDrawio(it.name)) add("Edit in draw.io", () => openDrawioViewer(it));
      if (!it.is_folder && isImage(it.name)) add("View image", () => openImageViewer(it));
      if (!it.is_folder && isVideo(it.name)) add("Play video", () => openVideoViewer(it));
      if (!it.is_folder && isEml(it.name)) add("View email (.eml)", () => openEmlViewer(it));
      if (!it.is_folder && isTextLike(it.name)) add("View text", () => openTextViewer(it));
      if (!it.is_folder && is3dModel(it.name)) add("View 3D model", () => open3dViewer(it));
      if (!it.is_folder) add("Version control", () => openVersions(it.id));
      add(favoriteIds.has(String(it.id)) ? "Remove from favorites" : "Add to favorites", async () => {
        await setFavorite(it.id, !favoriteIds.has(String(it.id)));
      });
      add(personalIds.has(String(it.id)) ? "Remove from personal files" : "Add to personal files", async () => {
        await setPersonal(it.id, !personalIds.has(String(it.id)));
      });
      add("Delete…", () => deleteNode(it.id, it.name));
    }

    rowMenu.hidden = false;
    rowMenuBackdrop.hidden = false;
  }

  function itemFromRowEl(tr) {
    if (!tr) return null;
    const id = Number(tr.dataset.id);
    if (!Number.isFinite(id)) return null;
    const is_folder = tr.dataset.folder === "1";
    const name = tr.dataset.itemName || tr.querySelector(".nc-name-text")?.textContent || "item";
    return { id, name, is_folder };
  }

  rowMenuBackdrop.addEventListener("click", closeRowMenu);

  async function setFavorite(nodeId, on) {
    const r = await fetch(`${API_BASE}/api/favorites/${nodeId}`, {
      method: on ? "PUT" : "DELETE",
      credentials: "same-origin",
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setStatus(j.error || j.reason || "Could not update favorite");
      return false;
    }
    await refreshFavorites();
    setStatus(on ? "Added to favorites." : "Removed from favorites.");
    if (leftNavMode === "favorites") await refreshMainView();
    return true;
  }

  async function setPersonal(nodeId, on) {
    const r = await fetch(`${API_BASE}/api/personal/${nodeId}`, {
      method: on ? "PUT" : "DELETE",
      credentials: "same-origin",
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setStatus(j.error || j.reason || "Could not update personal files");
      return false;
    }
    await refreshPersonal();
    setStatus(on ? "Added to personal files." : "Removed from personal files.");
    if (leftNavMode === "personal") await refreshMainView();
    return true;
  }

  async function createShareForNode(nodeId) {
    const box = document.getElementById("share-result");
    const r = await fetch(shareUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_node_id: nodeId, permission: "read" }),
    });
    box.hidden = false;
    if (!r.ok) {
      box.textContent = "Share failed (check permissions).";
      return;
    }
    const data = await r.json();
    box.textContent = data.url;
  }

  function updateFooter(items) {
    let folders = 0;
    let files = 0;
    let bytes = 0;
    for (const it of items) {
      if (it.is_folder) folders += 1;
      else {
        files += 1;
        bytes += it.size_bytes || 0;
      }
    }
    const parts = [];
    if (files) parts.push(`${files} file${files === 1 ? "" : "s"}`);
    if (folders) parts.push(`${folders} folder${folders === 1 ? "" : "s"}`);
    footerSummary.textContent = parts.length ? parts.join(" and ") : "Nothing here yet";
    footerSize.textContent = bytes ? `Total: ${fmtSize(bytes)}` : "";
  }

  function clearSelectedRowUi() {
    tbody.querySelectorAll("tr.is-selected").forEach((tr) => tr.classList.remove("is-selected"));
  }

  function setSelectedRow(tr) {
    if (!tr) return;
    clearSelectedRowUi();
    tr.classList.add("is-selected");
  }

  function closeDetail() {
    detailNodeId = null;
    lastDetailPayload = null;
    detailPanel.hidden = true;
    detailPublicLinkResult.hidden = true;
    detailPublicLinkResult.textContent = "";
    if (detailActivityList) detailActivityList.innerHTML = "";
    if (detailActivityEmpty) detailActivityEmpty.hidden = true;
    if (detailCommentsList) detailCommentsList.innerHTML = "";
    if (detailCommentsEmpty) detailCommentsEmpty.hidden = true;
    if (detailCommentInput) detailCommentInput.value = "";
    clearSelectedRowUi();
  }

  function switchDetailTab(which) {
    document.querySelectorAll(".nc-detail-tab").forEach((btn) => {
      const on = btn.dataset.tab === which;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", String(on));
    });
    detailTabActivity.hidden = which !== "activity";
    if (detailTabComments) detailTabComments.hidden = which !== "comments";
    detailTabSharing.hidden = which !== "sharing";
    if (detailTabVersions) detailTabVersions.hidden = which !== "versions";
    if (which === "versions" && detailNodeId != null) {
      loadDetailVersions(detailNodeId);
    }
  }

  document.querySelectorAll(".nc-detail-tab").forEach((btn) => {
    btn.addEventListener("click", () => switchDetailTab(btn.dataset.tab));
  });

  detailClose.addEventListener("click", closeDetail);

  async function openDetail(nodeId) {
    detailNodeId = nodeId;
    detailVersionsLoadedFor = null;
    detailPanel.hidden = false;
    detailSharingManage.hidden = true;
    detailSharingReadonly.hidden = true;
    switchDetailTab("comments");
    detailTitle.textContent = "Loading…";
    detailSub.textContent = "";
    detailInternalList.innerHTML = "";
    if (detailActivityList) detailActivityList.innerHTML = "";
    if (detailActivityEmpty) detailActivityEmpty.hidden = true;
    if (detailCommentsList) detailCommentsList.innerHTML = "";
    if (detailCommentsEmpty) detailCommentsEmpty.hidden = true;
    if (detailVersionsList) detailVersionsList.innerHTML = "";
    if (detailVersionsEmpty) detailVersionsEmpty.hidden = true;

    const r = await fetch(nodeDetailUrl(nodeId));
    if (!r.ok) {
      detailTitle.textContent = "Unavailable";
      detailSub.textContent = "Could not load details.";
      return;
    }
    const d = await r.json();
    lastDetailPayload = d;
    const n = d.node;
    detailTitle.textContent = n.name;
    const when = n.updated_at ? fmtRelative(n.updated_at) : "—";
    const primary = n.is_folder ? `Folder · ${when}` : `${fmtSize(n.size_bytes)} · ${when}`;
    const owner = d.owner_username || "—";
    detailSub.textContent = `${primary}\nOwner ${owner} · You: ${d.role}`;

    if (d.can_manage_sharing) {
      detailSharingManage.hidden = false;
      renderInternalSharesList(d.internal_shares || [], nodeId);
    } else if (d.your_share) {
      detailSharingReadonly.hidden = false;
      detailYourShareText.textContent = `You have ${d.your_share.permission} access. Shared by ${d.your_share.granted_by_username || "owner"}.`;
    } else {
      detailSharingReadonly.hidden = false;
      detailYourShareText.textContent = "You can view this item. Only the owner can change sharing.";
    }

    await loadDetailActivity(nodeId);
    await loadDetailComments(nodeId);
  }

  async function loadDetailVersions(nodeId) {
    if (!detailVersionsList || !detailVersionsEmpty) return;
    if (detailVersionsLoadedFor === String(nodeId)) return;
    detailVersionsLoadedFor = String(nodeId);
    detailVersionsList.innerHTML = "";
    detailVersionsEmpty.hidden = true;

    if (!lastDetailPayload || !lastDetailPayload.node) {
      detailVersionsEmpty.hidden = false;
      detailVersionsEmpty.textContent = "Select an item to view versions.";
      return;
    }
    const n = lastDetailPayload.node;
    if (n.is_folder) {
      detailVersionsEmpty.hidden = false;
      detailVersionsEmpty.textContent = "Folders don’t have version history.";
      return;
    }

    const r = await fetch(`${API_BASE}/api/versions/${encodeURIComponent(String(nodeId))}`, {
      credentials: "same-origin",
      redirect: "manual",
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      detailVersionsEmpty.hidden = false;
      detailVersionsEmpty.textContent = err.error === "forbidden" ? "You don’t have access to version history." : "Could not load versions.";
      return;
    }
    const data = await r.json().catch(() => ({}));
    const vers = Array.isArray(data.versions) ? data.versions : [];
    if (!vers.length) {
      detailVersionsEmpty.hidden = false;
      detailVersionsEmpty.textContent = "No versions yet.";
      return;
    }

    for (const v of vers) {
      const li = document.createElement("li");
      const when = v.created_at ? fmtRelative(v.created_at) : "";
      const sha = v.sha256 ? String(v.sha256).slice(0, 12) : "";
      const isCur = !!v.is_current;

      li.style.display = "flex";
      li.style.alignItems = "center";
      li.style.gap = "0.45rem";
      li.style.padding = "0.45rem 0";
      if (isCur) {
        li.style.background = "rgba(14,165,233,0.06)";
        li.style.borderRadius = "10px";
        li.style.padding = "0.55rem 0.55rem";
      }

      const meta = document.createElement("span");
      meta.innerHTML = `<strong>v${escapeHtml(String(v.version_number))}</strong> — ${escapeHtml(
        sha ? `${sha}…` : ""
      )} ${escapeHtml(when ? `— ${when}` : "")}`;
      li.appendChild(meta);

      if (isCur) {
        const badge = document.createElement("span");
        badge.textContent = "Active";
        badge.style.fontSize = "11px";
        badge.style.fontWeight = "850";
        badge.style.padding = "4px 8px";
        badge.style.borderRadius = "999px";
        badge.style.border = "1px solid rgba(14,165,233,0.35)";
        badge.style.background = "rgba(14,165,233,0.10)";
        badge.style.color = "rgba(2,132,199,1)";
        li.appendChild(badge);
      }

      const actions = document.createElement("span");
      actions.style.display = "inline-flex";
      actions.style.gap = "0.35rem";
      actions.style.alignItems = "center";
      actions.style.marginLeft = "auto";

      const dl = document.createElement("a");
      dl.className = "nc-btn nc-btn-secondary";
      dl.textContent = "Download";
      dl.href = `${API_BASE}/api/download/${encodeURIComponent(String(nodeId))}?version_id=${encodeURIComponent(String(v.id))}`;
      actions.appendChild(dl);

      const restore = document.createElement("button");
      restore.type = "button";
      restore.textContent = "Restore";
      restore.className = "nc-btn nc-btn-secondary";
      restore.disabled = !!v.is_current;
      restore.addEventListener("click", async () => {
        const rr = await fetch(`${API_BASE}/api/restore`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ file_node_id: nodeId, version_id: v.id }),
        });
        if (rr.ok) {
          detailVersionsLoadedFor = null;
          await reloadListing();
          await openDetail(nodeId);
          switchDetailTab("versions");
        } else {
          const ej = await rr.json().catch(() => ({}));
          setStatus(ej.error || ej.reason || "Could not restore version");
        }
      });
      actions.appendChild(restore);

      li.appendChild(actions);
      detailVersionsList.appendChild(li);
    }
  }

  function formatAuditAction(action) {
    const a = String(action || "");
    const map = {
      "files.upload": "Uploaded",
      "files.upload.version": "Uploaded new version",
      "files.download": "Downloaded",
      "files.move": "Moved",
      "files.rename": "Renamed",
      "files.delete": "Deleted",
      "files.mkdir": "Created folder",
      "files.version.restore": "Restored version",
      "files.share.user.grant": "Shared with user",
      "files.share.user.revoke": "Removed user share",
      "files.detail": "Viewed details",
    };
    return map[a] || a.replace(/^files\./, "").replaceAll(".", " ");
  }

  async function loadDetailActivity(nodeId) {
    if (!detailActivityList || !detailActivityEmpty) return;
    const r = await fetch(nodeActivityUrl(nodeId), { credentials: "same-origin" });
    if (!r.ok) {
      detailActivityList.innerHTML = "";
      detailActivityEmpty.hidden = false;
      detailActivityEmpty.textContent = "Could not load activity.";
      return;
    }
    const data = await r.json().catch(() => ({}));
    const items = data.items || [];
    detailActivityList.innerHTML = "";
    if (!items.length) {
      detailActivityEmpty.hidden = false;
      detailActivityEmpty.textContent = "No activity recorded for this item yet.";
      return;
    }
    detailActivityEmpty.hidden = true;
    for (const it of items) {
      const li = document.createElement("li");
      li.className = "nc-activity-item";
      const who = it.username ? String(it.username) : "Someone";
      const what = formatAuditAction(it.action);
      const when = it.timestamp ? fmtRelative(it.timestamp) : "";
      li.innerHTML = `<div class="nc-activity-line"><strong>${escapeHtml(who)}</strong> ${escapeHtml(
        what
      )}</div><div class="nc-activity-meta">${escapeHtml(when)}</div>`;
      detailActivityList.appendChild(li);
    }
  }

  function renderComments(items) {
    if (!detailCommentsList || !detailCommentsEmpty) return;
    detailCommentsList.innerHTML = "";
    if (!items || !items.length) {
      detailCommentsEmpty.hidden = false;
      detailCommentsEmpty.textContent = "No comments yet.";
      return;
    }
    detailCommentsEmpty.hidden = true;
    for (const c of items) {
      const li = document.createElement("li");
      li.className = "nc-comment-item";
      const who = c.username ? String(c.username) : "Someone";
      const whenAbs = c.created_at ? fmtLocalFromIso(c.created_at) : "";
      const whenRel = c.created_at ? fmtRelative(c.created_at) : "";
      const when = whenAbs && whenRel ? `${whenAbs} (${whenRel})` : whenAbs || whenRel || "";
      li.innerHTML = `<div class="nc-comment-head"><strong>${escapeHtml(who)}</strong><span class="nc-comment-when">${escapeHtml(
        when
      )}</span></div><div class="nc-comment-body">${escapeHtml(c.body || "")}</div>`;
      detailCommentsList.appendChild(li);
    }
  }

  async function loadDetailComments(nodeId) {
    if (!detailCommentsList || !detailCommentsEmpty) return;
    const r = await fetch(nodeCommentsUrl(nodeId), { credentials: "same-origin" });
    if (!r.ok) {
      renderComments([]);
      detailCommentsEmpty.hidden = false;
      detailCommentsEmpty.textContent = "Could not load comments.";
      return;
    }
    const data = await r.json().catch(() => ({}));
    renderComments(data.items || []);
  }

  async function postDetailComment() {
    if (!detailNodeId || !detailCommentInput) return;
    const body = (detailCommentInput.value || "").trim();
    if (!body) return;
    if (detailCommentSend) detailCommentSend.disabled = true;
    const r = await fetch(nodeCommentsUrl(detailNodeId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ body }),
    });
    if (detailCommentSend) detailCommentSend.disabled = false;
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      setStatus(err.error || "Could not post comment");
      return;
    }
    detailCommentInput.value = "";
    await loadDetailComments(detailNodeId);
  }

  detailPublicLink.addEventListener("click", async () => {
    if (!detailNodeId || !lastDetailPayload || !lastDetailPayload.can_manage_sharing) return;
    detailPublicLinkResult.hidden = false;
    const pr = await fetch(shareUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ file_node_id: detailNodeId, permission: "read" }),
    });
    if (!pr.ok) {
      const err = await pr.json().catch(() => ({}));
      detailPublicLinkResult.textContent = err.error || err.reason || `Could not create link (${pr.status}).`;
      return;
    }
    const pj = await pr.json();
    detailPublicLinkResult.textContent = pj.url || "";
  });

  function renderInternalSharesList(shares, nodeId) {
    detailInternalList.innerHTML = "";
    for (const sh of shares) {
      const li = document.createElement("li");
      li.innerHTML = `<span><strong>${escapeHtml(shareListLabel(sh))}</strong> — ${escapeHtml(sh.permission)}</span>`;
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "nc-btn nc-btn-secondary";
      rm.textContent = "Remove";
      rm.addEventListener("click", async () => {
        const rr = await fetch(nodeShareDeleteUrl(nodeId, sh), { method: "DELETE" });
        if (rr.ok) {
          openDetail(nodeId);
          await reloadListing();
        }
      });
      li.appendChild(rm);
      detailInternalList.appendChild(li);
    }
  }

  detailShareAdd.addEventListener("click", async () => {
    if (!detailNodeId) return;
    const raw = (detailShareUsername.value || "").trim();
    if (!raw) return;
    const permission = detailSharePerm.value;
    const ok = await addShareTarget(detailNodeId, raw, permission, setStatus);
    if (!ok) return;
    detailShareUsername.value = "";
    openDetail(detailNodeId);
    await reloadListing();
  });

  detailShareUsername.addEventListener("input", () => {
    const q = detailShareUsername.value.trim();
    window.clearTimeout(suggestTimer);
    if (q.length < 1) {
      detailUserSuggestions.innerHTML = "";
      shareSuggestMap.clear();
      return;
    }
    suggestTimer = window.setTimeout(() => populateShareSuggestions(detailUserSuggestions, q), 250);
  });

  // --- Share dialog wiring ---
  if (shareClose && dlgShare) shareClose.addEventListener("click", () => dlgShare.close());
  if (dlgShare) dlgShare.addEventListener("close", () => clearShareDialog());
  if (dlgShare) {
    dlgShare.addEventListener("click", (e) => {
      // Clicking the <dialog> backdrop should close.
      if (e.target === dlgShare) dlgShare.close();
    });
  }

  function stripViewerFromHistoryState() {
    try {
      const st = history.state;
      if (!st || !st.viewer || !st.viewer.kind) return;
      const rest = { ...st };
      delete rest.viewer;
      history.replaceState(Object.keys(rest).length ? rest : null, "", window.location.href);
    } catch (_) {}
  }

  document.addEventListener(
    "click",
    (e) => {
      const a = e.target && e.target.closest && e.target.closest(".nc-intranet-tabs a.nc-intranet-tab");
      if (!a) return;
      const anyOpen =
        (pdfViewer && !pdfViewer.hidden) ||
        (emlViewer && !emlViewer.hidden) ||
        (imgViewer && !imgViewer.hidden) ||
        (vidViewer && !vidViewer.hidden) ||
        (drawioViewer && !drawioViewer.hidden) ||
        (model3dViewer && !model3dViewer.hidden) ||
        (textViewer && !textViewer.hidden);
      if (!anyOpen) return;
      if (pdfViewer && !pdfViewer.hidden) closePdfViewer({ popHistory: false });
      if (emlViewer && !emlViewer.hidden) closeEmlViewer({ popHistory: false });
      if (imgViewer && !imgViewer.hidden) closeImageViewer({ popHistory: false });
      if (vidViewer && !vidViewer.hidden) closeVideoViewer({ popHistory: false });
      if (drawioViewer && !drawioViewer.hidden) closeDrawioViewer({ popHistory: false });
      if (model3dViewer && !model3dViewer.hidden) close3dViewer({ popHistory: false });
      if (textViewer && !textViewer.hidden) closeTextViewer({ popHistory: false });
      stripViewerFromHistoryState();
    },
    { capture: true, signal: ncFbSig }
  );

  // --- PDF viewer wiring ---
  if (pdfClose) pdfClose.addEventListener("click", closePdfViewer);
  document.addEventListener(
    "keydown",
    (e) => {
    if (e.key === "Escape" && pdfViewer && !pdfViewer.hidden) closePdfViewer();
    if (e.key === "Escape" && imgViewer && !imgViewer.hidden) closeImageViewer();
    if (e.key === "Escape" && vidViewer && !vidViewer.hidden) closeVideoViewer();
    if (e.key === "Escape" && model3dViewer && !model3dViewer.hidden) close3dViewer();
    if (e.key === "Escape" && textViewer && !textViewer.hidden) closeTextViewer();
    },
    { signal: ncFbSig }
  );

  // --- Image viewer wiring ---
  if (imgClose) imgClose.addEventListener("click", closeImageViewer);

  // --- Video viewer wiring ---
  if (vidClose) vidClose.addEventListener("click", closeVideoViewer);

  // --- 3D viewer wiring ---
  if (model3dClose) model3dClose.addEventListener("click", close3dViewer);

  // --- Move/Copy dialog wiring ---
  if (moveCopyCancel && dlgMoveCopy) moveCopyCancel.addEventListener("click", () => dlgMoveCopy.close());
  if (moveCopyClose && dlgMoveCopy) moveCopyClose.addEventListener("click", () => dlgMoveCopy.close());
  if (dlgMoveCopy) {
    dlgMoveCopy.addEventListener("click", (e) => {
      // Clicking the <dialog> backdrop should close.
      if (e.target === dlgMoveCopy) dlgMoveCopy.close();
    });
    dlgMoveCopy.addEventListener("close", () => {
      moveCopyState = null;
    });
  }
  if (moveCopyUp) {
    moveCopyUp.addEventListener("click", async () => {
      if (!moveCopyState) return;
      if (moveCopyState.stack.length > 0) moveCopyState.stack.pop();
      moveCopyState.selectedId = null;
      if (moveCopyMove) moveCopyMove.disabled = true;
      if (moveCopyCopy) moveCopyCopy.disabled = true;
      await moveCopyLoadCurrent();
    });
  }
  if (moveCopyMove) moveCopyMove.addEventListener("click", async () => runMoveOrCopy("move"));
  if (moveCopyCopy) moveCopyCopy.addEventListener("click", async () => runMoveOrCopy("copy"));

  if (sharePublicLink) {
    sharePublicLink.addEventListener("click", async () => {
      if (!shareNodeId || !lastSharePayload || !lastSharePayload.can_manage_sharing) return;
      if (sharePublicLinkBox) sharePublicLinkBox.hidden = false;
      const pr = await fetch(shareUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ file_node_id: shareNodeId, permission: "read" }),
      });
      if (!pr.ok) {
        const err = await pr.json().catch(() => ({}));
        if (sharePublicLinkResult)
          sharePublicLinkResult.value = err.error || err.reason || `Could not create link (${pr.status}).`;
        return;
      }
      const pj = await pr.json().catch(() => ({}));
      if (sharePublicLinkResult) sharePublicLinkResult.value = pj.url || "";
      if (shareNodeId) openShareDialog(shareNodeId);
      await reloadListing();
    });
  }

  if (sharePublicLinkCopy) {
    sharePublicLinkCopy.addEventListener("click", async () => {
      const url = sharePublicLinkResult && sharePublicLinkResult.value ? String(sharePublicLinkResult.value) : "";
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        setShareStatus("Copied link.");
      } catch (_) {
        setShareStatus("Copy failed.");
      }
    });
  }

  if (sharePublicLinkRemove) {
    sharePublicLinkRemove.addEventListener("click", async () => {
      if (!shareNodeId) return;
      const r = await fetch(`${API_BASE}/api/node/${shareNodeId}/shares/link`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        setShareStatus(err.error || err.reason || "Could not remove link(s)");
        return;
      }
      openShareDialog(shareNodeId);
      await reloadListing();
    });
  }

  if (shareAdd) {
    shareAdd.addEventListener("click", async () => {
      if (!shareNodeId) return;
      const raw = (shareUsername && shareUsername.value ? shareUsername.value : "").trim();
      if (!raw) return;
      const permission = sharePerm ? sharePerm.value : "read";
      const ok = await addShareTarget(shareNodeId, raw, permission, setShareStatus);
      if (!ok) return;
      if (shareUsername) shareUsername.value = "";
      openShareDialog(shareNodeId);
      await reloadListing();
    });
  }

  if (shareUsername) {
    shareUsername.addEventListener("input", () => {
      const q = shareUsername.value.trim();
      window.clearTimeout(shareSuggestTimer);
      if (q.length < 1) {
        if (shareUserSuggestions) shareUserSuggestions.innerHTML = "";
        shareSuggestMap.clear();
        return;
      }
      shareSuggestTimer = window.setTimeout(() => populateShareSuggestions(shareUserSuggestions, q), 180);
    });
  }

  if (detailCommentSend) {
    detailCommentSend.addEventListener("click", () => postDetailComment());
  }
  if (detailCommentInput) {
    detailCommentInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        postDetailComment();
      }
    });
  }

  function renderGrid(items, data, sharedWithMe) {
    viewGrid.innerHTML = "";
    const combined = [];
    if (currentParentId === null && (sharedWithMe || []).length) {
      const sharedObjs = (sharedWithMe || []).map((s) => ({
        id: s.id,
        name: s.owner_username ? `${s.name} (${s.owner_username})` : s.name,
        thumbName: s.name,
        is_folder: s.is_folder,
        size_bytes: null,
        updated_at: s.updated_at,
      }));
      for (const row of sortListingItems(sharedObjs)) {
        combined.push(row);
      }
    }
    for (const it of items) combined.push(it);
    for (const it of combined) {
      const card = document.createElement("div");
      card.className = "nc-grid-item";
      card.dataset.id = String(it.id);
      card.dataset.folder = it.is_folder ? "1" : "0";
      const thumbSrc = it.thumbName != null ? it.thumbName : it.name;
      const pathSub =
        data && data.search && data.search.q && it.path_key
          ? `<div class="nc-grid-path">${escapeHtml(displayPathForSearch(it.path_key))}</div>`
          : "";
      card.innerHTML = `<div class="nc-file-icon-wrap">${fileThumbHtml(it.is_folder, thumbSrc)}</div><div class="nc-grid-name">${escapeHtml(
        it.name
      )}</div>${pathSub}`;
      card.addEventListener("click", () => {
        if (it.is_folder) {
          cancelPendingSearch();
          clearLeftSearchInput();
          load(it.id, { pushHistory: true });
          return;
        }
        if (isPdf(it.name)) openPdfViewer(it);
        else if (isDrawio(it.name)) openDrawioViewer(it);
        else if (isImage(it.name)) openImageViewer(it);
        else if (isVideo(it.name)) openVideoViewer(it);
        else if (isEml(it.name)) openEmlViewer(it);
        else if (is3dModel(it.name)) open3dViewer(it);
        else if (isTextLike(it.name)) openTextViewer(it);
        else if (isOfficeDoc(it.name)) window.location.href = documentEditorHref(it.id, { item: it });
        else window.location.href = `${API_BASE}/api/download/${it.id}`;
      });
      card.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openContextMenuAt(e.clientX, e.clientY, { id: it.id, name: it.name, is_folder: !!it.is_folder });
      });
      wireDrag(card, it, data);
      viewGrid.appendChild(card);
    }
  }

  function appendSectionRow(label) {
    const tr = document.createElement("tr");
    tr.className = "nc-section-row";
    const td = document.createElement("td");
    td.colSpan = 8;
    td.textContent = label;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  function renderTableRows(data) {
    tbody.innerHTML = "";
    clearSelectedRowUi();

    // Shares sidebar: two sections at root (incoming vs outgoing).
    if (currentParentId === null && data._sharesDualView) {
      const swm = data.shared_with_me || [];
      const sbm = data.items || [];
      if (swm.length) {
        appendSectionRow("Shared with you");
        const sharedObjs = swm.map((s) => ({
          id: s.id,
          name: s.name,
          is_folder: s.is_folder,
          size_bytes: s.size_bytes ?? null,
          updated_at: s.updated_at,
          owner_username: s.owner_username,
          shared_out: false,
        }));
        for (const it of sortListingItems(sharedObjs)) {
          tbody.appendChild(buildItemRow(it, data, { shared: true }));
        }
      }
      if (sbm.length) {
        appendSectionRow("Shared by you");
        for (const it of sortListingItems(sbm)) {
          tbody.appendChild(buildItemRow(it, data, { shared_out: true }));
        }
      }
      return;
    }

    // Root view: show items shared with you as a separate section (list view parity with grid view).
    if (currentParentId === null && (data.shared_with_me || []).length) {
      appendSectionRow("Shared with you");
      const sharedObjs = (data.shared_with_me || []).map((s) => ({
        id: s.id,
        name: s.name,
        is_folder: s.is_folder,
        size_bytes: s.size_bytes ?? null,
        updated_at: s.updated_at,
        owner_username: s.owner_username,
        shared_out: false,
      }));
      for (const it of sortListingItems(sharedObjs)) {
        tbody.appendChild(buildItemRow(it, data, { shared: true }));
      }
      appendSectionRow("Your files");
    }

    for (const it of sortListingItems(data.items || [])) {
      tbody.appendChild(buildItemRow(it, data, {}));
    }
  }

  function buildItemRow(it, data, flags) {
    const isShared = flags && flags.shared;
    const isSharedOut = (flags && flags.shared_out) || !!it.shared_out;
    const tr = document.createElement("tr");
    tr.dataset.id = String(it.id);
    tr.dataset.folder = it.is_folder ? "1" : "0";
    tr.dataset.itemName = it.name;
    tr.className = (it.is_folder ? "row-folder" : "row-file") + (isShared ? " row-shared" : "");
    tr.draggable = true;

    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.className = "row-check";
    chk.addEventListener("click", (e) => e.stopPropagation());

    const td0 = document.createElement("td");
    td0.className = "col-check";
    td0.appendChild(chk);

    const td1 = document.createElement("td");
    td1.className = "col-icon";
    td1.innerHTML = fileThumbHtml(it.is_folder, it.name);

    const tdName = document.createElement("td");
    tdName.className = "col-name";
    const nt = document.createElement("span");
    nt.className = "nc-name-text";
    nt.textContent = it.name;
    if ((isShared || leftNavMode === "admin") && it.owner_username) {
      nt.textContent = `${it.name} (${it.owner_username})`;
    }
    tdName.appendChild(nt);
    if (data && data.search && data.search.q && it.path_key) {
      const pl = document.createElement("div");
      pl.className = "nc-name-path";
      pl.textContent = displayPathForSearch(it.path_key);
      tdName.appendChild(pl);
    }

    const tdShare = document.createElement("td");
    tdShare.className = "col-share";
    tdShare.classList.toggle("has-shared", isSharedOut);
    const shareWrap = document.createElement("div");
    shareWrap.className = "nc-sharecell";
    const shareRowBtn = document.createElement("button");
    shareRowBtn.type = "button";
    shareRowBtn.className = "nc-row-icon-btn";
    shareRowBtn.title = "Share";
    shareRowBtn.setAttribute("aria-label", "Share");
    shareRowBtn.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 4.02"/></svg>';
    shareRowBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openShareDialog(it.id);
    });
    if (isSharedOut) {
      const lab = document.createElement("button");
      lab.type = "button";
      lab.className = "nc-shared-pill";
      lab.textContent = "Shared";
      lab.addEventListener("click", (e) => {
        e.stopPropagation();
        openShareDialog(it.id);
      });
      shareWrap.appendChild(lab);
    }
    shareWrap.appendChild(shareRowBtn);
    tdShare.appendChild(shareWrap);

    const tdMore = document.createElement("td");
    tdMore.className = "col-more";
    const moreRowBtn = document.createElement("button");
    moreRowBtn.type = "button";
    moreRowBtn.className = "nc-row-icon-btn";
    moreRowBtn.title = "More actions";
    moreRowBtn.setAttribute("aria-label", "More actions");
    moreRowBtn.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
    moreRowBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openRowMenu(moreRowBtn, it);
    });
    tdMore.appendChild(moreRowBtn);

    const tdSize = document.createElement("td");
    tdSize.className = "col-size";
    tdSize.textContent = it.is_folder ? "—" : fmtSize(it.size_bytes);

    const tdType = document.createElement("td");
    tdType.className = "col-type";
    tdType.textContent = typeLabel(it);

    const tdMod = document.createElement("td");
    tdMod.className = "col-modified";
    tdMod.textContent = it.updated_at ? fmtRelative(it.updated_at) : "—";

    tr.appendChild(td0);
    tr.appendChild(td1);
    tr.appendChild(tdName);
    tr.appendChild(tdShare);
    tr.appendChild(tdMore);
    tr.appendChild(tdSize);
    tr.appendChild(tdType);
    tr.appendChild(tdMod);

    tr.addEventListener("click", (e) => {
      if (e.target.closest("button") || e.target.closest("input")) return;
      setSelectedRow(tr);
      if (it.is_folder) {
        cancelPendingSearch();
        clearLeftSearchInput();
        load(it.id, { pushHistory: true });
        return;
      }
      if (isPdf(it.name)) openPdfViewer(it);
      else if (isDrawio(it.name)) openDrawioViewer(it);
      else if (isImage(it.name)) openImageViewer(it);
      else if (isVideo(it.name)) openVideoViewer(it);
      else if (isEml(it.name)) openEmlViewer(it);
      else if (is3dModel(it.name)) open3dViewer(it);
      else if (isTextLike(it.name)) openTextViewer(it);
      else if (isOfficeDoc(it.name)) window.location.href = documentEditorHref(it.id, { item: it });
      else window.location.href = `${API_BASE}/api/download/${it.id}`;
    });
    tr.addEventListener("contextmenu", (e) => {
      if (e.target.closest("button") || e.target.closest("input")) return;
      e.preventDefault();
      setSelectedRow(tr);
      const item = itemFromRowEl(tr) || it;
      openContextMenuAt(e.clientX, e.clientY, item);
    });
    wireDrag(tr, it, data);
    return tr;
  }

  function folderUrlFor(parentId) {
    const u = new URL(window.location.href);
    if (parentId == null) u.searchParams.delete("parent_id");
    else u.searchParams.set("parent_id", String(parentId));
    const nav =
      parentId == null ? leftNavMode : leftNavMode === "admin" ? "admin" : "all";
    if (nav && nav !== "all") u.searchParams.set("nav", nav);
    else u.searchParams.delete("nav");
    return u.toString();
  }

  function maybeSelectFromUrl() {
    try {
      const u = new URL(window.location.href);
      const raw = (u.searchParams.get("select_id") || "").trim();
      if (!raw) return;
      const want = Number(raw);
      if (!Number.isFinite(want)) return;
      const tr = tbody.querySelector(`tr[data-id="${String(want)}"]`);
      if (!tr) return;
      setSelectedRow(tr);
      try {
        tr.scrollIntoView({ block: "center" });
      } catch (_) {}
      u.searchParams.delete("select_id");
      history.replaceState(history.state || {}, "", u.toString());
    } catch (_) {}
  }

  async function load(parentId, opts = {}) {
    const { pushHistory = false } = opts || {};
    setStatus("Loading…");
    try {
      closeRowMenu();
      const q = listApiQuery(parentId);
      /* Flask-Login redirects to HTML login; default fetch follows → 200 HTML → JSON parse throws. */
      const r = await fetch(listUrl + q, { credentials: "same-origin", redirect: "manual" });
      if ([301, 302, 303, 307, 308].includes(r.status)) {
        const loc = r.headers.get("Location");
        window.location.href = loc || "/login";
        return;
      }
      if (!r.ok) {
        setStatus("Failed to load folder.");
        return;
      }
      let data;
      try {
        data = await r.json();
      } catch {
        setStatus("Invalid response from server. Try refreshing the page.");
        return;
      }
      currentParentId = data.parent && data.parent.id != null ? data.parent.id : null;
      if (data.list_scope === "admin") leftNavMode = "admin";
      // Left-nav "views" are root-level; when navigating into a folder,
      // force the UI back to All files.
      if (parentId != null && leftNavMode !== "all" && leftNavMode !== "admin") {
        leftNavMode = "all";
        applyLeftNavUi();
      }
      if (pushHistory) {
        const nav = currentParentId == null ? leftNavMode : "all";
        history.pushState({ parentId: currentParentId, nav }, "", folderUrlFor(currentParentId));
      }
      baseListPayload = data;
      lastListPayload = data;

      await refreshMainView();

      cancelPendingBulkMove();
      tbody.querySelectorAll(".row-check").forEach((c) => {
        c.checked = false;
      });
      selectAll.checked = false;
      selectAll.indeterminate = false;
      updateSelectionBar();

      if (detailNodeId) openDetail(detailNodeId);
    } catch (e) {
      setStatus("Could not load folder (network or server error).");
      console.error(e);
    }
  }

  function closeAnyViewerForBackNav() {
    const anyOpen =
      (pdfViewer && !pdfViewer.hidden) ||
      (emlViewer && !emlViewer.hidden) ||
      (imgViewer && !imgViewer.hidden) ||
      (vidViewer && !vidViewer.hidden) ||
      (drawioViewer && !drawioViewer.hidden) ||
      (model3dViewer && !model3dViewer.hidden) ||
      (textViewer && !textViewer.hidden);
    if (!anyOpen) return false;
    // Close without triggering another history.back(); popstate already represents the navigation.
    if (pdfViewer && !pdfViewer.hidden) closePdfViewer({ popHistory: false });
    if (emlViewer && !emlViewer.hidden) closeEmlViewer({ popHistory: false });
    if (imgViewer && !imgViewer.hidden) closeImageViewer({ popHistory: false });
    if (vidViewer && !vidViewer.hidden) closeVideoViewer({ popHistory: false });
    if (drawioViewer && !drawioViewer.hidden) closeDrawioViewer({ popHistory: false });
    if (model3dViewer && !model3dViewer.hidden) close3dViewer({ popHistory: false });
    if (textViewer && !textViewer.hidden) closeTextViewer({ popHistory: false });
    return true;
  }

  window.addEventListener(
    "popstate",
    (e) => {
    const st = (e && e.state) || null;
    // If we navigated away from a viewer state, close the overlay and do not reload.
    if (closeAnyViewerForBackNav() && (!st || !st.viewer)) return;

    // Restore left-nav mode (root only).
    if (st && st.nav) {
      leftNavMode = st.nav || "all";
      applyLeftNavUi();
    } else if (currentParentId === null) {
      leftNavMode = "all";
      applyLeftNavUi();
    }

    // If we navigated forward/back into a viewer state, restore it.
    if (st && st.viewer && st.viewer.kind && st.viewer.id) {
      const it = { id: st.viewer.id, name: st.viewer.name || "Viewer" };
      if (st.viewer.kind === "pdf") openPdfViewer(it, { pushHistory: false });
      else if (st.viewer.kind === "eml") openEmlViewer(it, { pushHistory: false });
      else if (st.viewer.kind === "image") openImageViewer(it, { pushHistory: false });
      else if (st.viewer.kind === "video") openVideoViewer(it, { pushHistory: false });
      else if (st.viewer.kind === "drawio") openDrawioViewer(it, { pushHistory: false });
      else if (st.viewer.kind === "3d") open3dViewer(it, { pushHistory: false });
      else if (st.viewer.kind === "text") openTextViewer(it, { pushHistory: false });
      return;
    }

    const pid = st ? st.parentId : null;
    // Avoid refetch when staying in the same folder.
    if (pid === currentParentId) return;
    load(pid, { pushHistory: false });
    },
    { signal: ncFbSig }
  );

  function syncSortHeaderUi() {
    if (!thSortName) return;
    thSortName.setAttribute("aria-sort", listSortDir === "asc" ? "ascending" : "descending");
    const caret = thSortName.querySelector(".nc-sort-caret");
    if (caret) caret.textContent = listSortDir === "asc" ? "▲" : "▼";
  }

  function wireDrag(el, it, data) {
    el.addEventListener("dragstart", (e) => {
      const id = String(it.id);
      e.dataTransfer.setData("application/x-node-id", id);
      e.dataTransfer.setData("text/plain", id);
      e.dataTransfer.effectAllowed = "move";
    });
    el.addEventListener("dragend", () => el.classList.remove("drag-over"));

    el.addEventListener("dragover", (e) => {
      if (hasFilePayload(e.dataTransfer)) {
        if (it.is_folder || currentParentId != null) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
        if (it.is_folder) el.classList.add("drag-over");
        return;
      }
      if (it.is_folder) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        el.classList.add("drag-over");
      }
    });

    if (it.is_folder) {
      el.addEventListener("dragleave", (e) => {
        if (!el.contains(e.relatedTarget)) el.classList.remove("drag-over");
      });
    }

    el.addEventListener("drop", async (e) => {
      const files = e.dataTransfer.files;
      const fileDrop = !!(files && files.length && hasFilePayload(e.dataTransfer));

      if (fileDrop) {
        e.preventDefault();
        e.stopPropagation();
        el.classList.remove("drag-over");
        const targetFolderId = it.is_folder ? it.id : currentParentId;
        if (!targetFolderId) {
          setStatus("Drop onto a folder row to upload here.");
          return;
        }
        await uploadFiles(targetFolderId, files);
        return;
      }

      if (!it.is_folder) {
        e.preventDefault();
        return;
      }

      e.preventDefault();
      e.stopPropagation();
      el.classList.remove("drag-over");
      const nid =
        e.dataTransfer.getData("application/x-node-id") || e.dataTransfer.getData("text/plain");
      if (!nid) return;
      if (String(it.id) === nid) return;
      await moveNode(Number(nid), it.id);
    });
  }

  async function moveNode(nodeId, newParentId) {
    const r = await fetch(moveUrl, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ node_id: nodeId, new_parent_id: newParentId }),
      credentials: "same-origin",
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      setStatus(err.error || "Move failed");
      return;
    }
    setStatus("Moved.");
    await reloadListing();
  }

  async function renameNode(it) {
    const nn = prompt(`Rename “${it.name}” to:`, it.name);
    if (nn == null) return;
    const name = nn.trim();
    if (!name || name === it.name) return;
    if (name.includes("/") || name.includes("\\")) {
      setStatus("Name cannot contain slashes.");
      return;
    }
    const r = await fetch(`${API_BASE}/api/node/${it.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
      credentials: "same-origin",
    });
    const err = await r.json().catch(() => ({}));
    if (!r.ok) {
      setStatus(err.error || err.reason || "Rename failed");
      return;
    }
    setStatus("Renamed.");
    if (detailNodeId === it.id) await openDetail(it.id);
    await reloadListing();
  }

  async function deleteNode(id, name) {
    if (!confirm(`Delete “${name}”?`)) return;
    const justification = promptDeletionJustification(`Moving “${name}” to recycle bin`);
    if (justification === null) return;
    const r = await fetch(`${API_BASE}/api/node/${id}`, {
      method: "DELETE",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ justification }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      setStatus(err.error || err.reason || "Delete failed");
      return;
    }
    setStatus("Deleted.");
    if (detailNodeId === id) closeDetail();
    await reloadListing();
  }

  async function restoreFromRecycle(id) {
    const r = await fetch(`${API_BASE}/api/recycle/${id}/restore`, { method: "POST", credentials: "same-origin" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setStatus(j.error || j.reason || "Restore failed");
      return;
    }
    setStatus("Restored.");
    await reloadListing();
  }

  async function purgeFromRecycle(id, name) {
    if (!confirm(`Delete permanently “${name}”? This cannot be undone.`)) return;
    const justification = promptDeletionJustification(`Permanent delete: “${name}”`);
    if (justification === null) return;
    const r = await fetch(`${API_BASE}/api/recycle/${id}/purge`, {
      method: "DELETE",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ justification }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setStatus(j.error || j.reason || "Purge failed");
      return;
    }
    setStatus("Permanently deleted.");
    await reloadListing();
  }

  async function bulkDeleteSelected() {
    const rows = getSelectedRows();
    if (!rows.length) return;
    const lines = rows.map((r) => r.dataset.itemName || r.querySelector(".nc-name-text")?.textContent || "item");
    const preview = lines.join("\n");
    const isRecycle = leftNavMode === "recycle";
    if (
      !confirm(
        `${isRecycle ? "Permanently delete" : "Delete"} ${rows.length} selected item(s)?\n\n${
          preview.length > 600 ? `${preview.slice(0, 600)}…` : preview
        }${isRecycle ? "\n\nThis cannot be undone." : ""}`
      )
    ) {
      return;
    }
    const justification = promptDeletionJustification(
      `${isRecycle ? "Permanent delete" : "Move to recycle bin"} — ${rows.length} item(s)`
    );
    if (justification === null) return;
    let ok = 0;
    let lastErr = "";
    for (const tr of rows) {
      const id = Number(tr.dataset.id);
      const r = await fetch(isRecycle ? `${API_BASE}/api/recycle/${id}/purge` : `${API_BASE}/api/node/${id}`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ justification }),
      });
      if (r.ok) {
        ok += 1;
        if (detailNodeId === id) closeDetail();
      } else {
        const err = await r.json().catch(() => ({}));
        lastErr = err.error || err.reason || "";
      }
    }
    if (ok === rows.length) {
      setStatus(isRecycle ? `Permanently deleted ${ok} item(s).` : `Deleted ${ok} item(s).`);
    } else {
      setStatus(
        `${isRecycle ? "Permanently deleted" : "Deleted"} ${ok} of ${rows.length}.${lastErr ? ` ${lastErr}` : ""}`
      );
    }
    clearAllRowSelection();
    await reloadListing();
  }

  async function openVersions(fileId) {
    const r = await fetch(`${API_BASE}/api/versions/${fileId}`);
    if (!r.ok) return;
    const data = await r.json();
    versionsBody.innerHTML = "";
    const ul = document.createElement("ul");
    ul.className = "share-list";
    for (const v of data.versions) {
      const li = document.createElement("li");
      const cur = v.is_current ? " (ACTIVE)" : "";
      li.textContent = `v${v.version_number}${cur} — ${v.sha256.slice(0, 12)}… — ${fmtRelative(v.created_at)}`;
      const restore = document.createElement("button");
      restore.type = "button";
      restore.textContent = "Restore";
      restore.className = "nc-btn nc-btn-secondary";
      restore.disabled = v.is_current;
      restore.addEventListener("click", async () => {
        const rr = await fetch(`${API_BASE}/api/restore`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file_node_id: fileId, version_id: v.id }),
        });
        if (rr.ok) {
          dlgVersions.close();
          await reloadListing();
        }
      });
      li.appendChild(restore);
      ul.appendChild(li);
    }
    versionsBody.appendChild(ul);
    dlgVersions.showModal();
  }

  document.getElementById("btn-new-menu").addEventListener("click", () => {
    const open = !newMenuPanel.hidden;
    newMenuPanel.hidden = open;
    newMenuBtn.setAttribute("aria-expanded", String(!open));
  });

  document.addEventListener(
    "click",
    (e) => {
    if (!newMenuBtn || !newMenuPanel) return;
    if (!newMenuBtn.contains(e.target) && !newMenuPanel.contains(e.target)) {
      newMenuPanel.hidden = true;
      newMenuBtn.setAttribute("aria-expanded", "false");
    }
    },
    { signal: ncFbSig }
  );

  document.getElementById("menu-upload").addEventListener("click", () => {
    newMenuPanel.hidden = true;
    fileInput.click();
  });

  const menuUploadFolder = document.getElementById("menu-upload-folder");
  if (menuUploadFolder) {
    menuUploadFolder.addEventListener("click", () => {
      newMenuPanel.hidden = true;
      folderInput.click();
    });
  }

  document.getElementById("menu-new-folder").addEventListener("click", async () => {
    newMenuPanel.hidden = true;
    const raw = prompt("Folder name?", "New Folder");
    if (raw == null) return;
    const name = String(raw || "").trim();
    if (!name) return;
    const r = await fetch(mkdirUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parent_id: resolveCreateParentId(), name }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      setStatus(err.error || "Could not create folder");
      return;
    }
    await reloadListing();
  });

  const menuNewDocx = document.getElementById("menu-new-docx");
  if (menuNewDocx) {
    menuNewDocx.addEventListener("click", async () => {
      newMenuPanel.hidden = true;
      const raw = prompt("Document name?", "New document.docx");
      if (raw == null) return;
      const name = String(raw || "").trim() || "New document.docx";
      const r = await fetch(`${API_BASE}/api/new-docx`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ parent_id: resolveCreateParentId(), name }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setStatus(j.error || "Could not create document");
        return;
      }
      const node = j.node;
      await reloadListing();
      if (node && node.id) window.location.href = documentEditorHref(node.id, { parentId: resolveCreateParentId() });
    });
  }

  async function createOfficeFile(kind, promptLabel, defaultName, apiPath) {
    newMenuPanel.hidden = true;
    const raw = prompt(promptLabel, defaultName);
    if (raw == null) return;
    const name = String(raw || "").trim() || defaultName;
    const r = await fetch(`${API_BASE}${apiPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ parent_id: resolveCreateParentId(), name }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setStatus(j.error || `Could not create ${kind}`);
      return;
    }
    const node = j.node;
    await reloadListing();
    if (node && node.id) window.location.href = documentEditorHref(node.id, { parentId: resolveCreateParentId() });
  }

  const menuNewXlsx = document.getElementById("menu-new-xlsx");
  if (menuNewXlsx) {
    menuNewXlsx.addEventListener("click", () =>
      createOfficeFile("spreadsheet", "Spreadsheet name?", "New spreadsheet.xlsx", "/api/new-xlsx")
    );
  }
  const menuNewPptx = document.getElementById("menu-new-pptx");
  if (menuNewPptx) {
    menuNewPptx.addEventListener("click", () =>
      createOfficeFile("presentation", "Presentation name?", "New presentation.pptx", "/api/new-pptx")
    );
  }

  const menuNewVsdx = document.getElementById("menu-new-vsdx");
  if (menuNewVsdx) {
    menuNewVsdx.addEventListener("click", async () => {
      newMenuPanel.hidden = true;
      const raw = prompt("Visio diagram name?", "New diagram.drawio");
      if (raw == null) return;
      const name = String(raw || "").trim() || "New diagram.drawio";
      const r = await fetch(`${API_BASE}/api/new-vsdx`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ parent_id: resolveCreateParentId(), name }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setStatus(j.error || "Could not create Visio document");
        return;
      }
      const node = j.node;
      await reloadListing();
      if (node && node.id) openDrawioViewer(node);
    });
  }

  fileInput.addEventListener("change", async () => {
    const files = fileInput.files;
    if (!files || !files.length) return;
    await uploadFiles(currentParentId, files);
    fileInput.value = "";
  });

  if (folderInput) {
    folderInput.addEventListener("change", async () => {
      const files = folderInput.files;
      if (!files || !files.length) return;
      try {
        await uploadFolder(currentParentId, files);
      } catch (e) {
        setStatus(String(e && e.message ? e.message : e) || "Folder upload failed");
      }
      folderInput.value = "";
    });
  }

  document.getElementById("btn-share-folder").addEventListener("click", () => {
    if (currentParentId == null) {
      setStatus("Open a folder to share it.");
      return;
    }
    openShareDialog(currentParentId);
  });

  document.getElementById("btn-view-list").addEventListener("click", () => {
    viewMode = "list";
    applyViewMode();
  });

  document.getElementById("btn-view-grid").addEventListener("click", () => {
    viewMode = "grid";
    applyViewMode();
  });

  tbody.addEventListener("change", (e) => {
    if (e.target.classList.contains("row-check")) {
      syncSelectAllFromRows();
      updateSelectionBar();
    }
  });

  selectAll.addEventListener("change", () => {
    tbody.querySelectorAll(".row-check").forEach((c) => {
      c.checked = selectAll.checked;
    });
    syncSelectAllFromRows();
    updateSelectionBar();
  });

  if (selectionBar && selClear) {
    selClear.addEventListener("click", () => clearAllRowSelection());
  }

  if (selFavorites) {
    selFavorites.addEventListener("click", async () => {
      const rows = getSelectedRows();
      if (!rows.length) return;
      let ok = 0;
      for (const tr of rows) {
        const id = Number(tr.dataset.id);
        if (!Number.isFinite(id)) continue;
        const r = await setFavorite(id, true);
        if (r) ok += 1;
      }
      setStatus(ok ? `Added ${ok} item(s) to favorites.` : "Could not add favorites.");
    });
  }

  if (selPersonal) {
    selPersonal.addEventListener("click", async () => {
      const rows = getSelectedRows();
      if (!rows.length) return;
      let ok = 0;
      for (const tr of rows) {
        const id = Number(tr.dataset.id);
        if (!Number.isFinite(id)) continue;
        const r = await setPersonal(id, true);
        if (r) ok += 1;
      }
      setStatus(ok ? `Added ${ok} item(s) to personal files.` : "Could not add personal files.");
    });
  }

  if (selMove) {
    selMove.addEventListener("click", async () => {
      const rows = getSelectedRows();
      if (!rows.length) return;
      const ids = rows.map((tr) => Number(tr.dataset.id));
      await openMoveCopyDialog(ids);
    });
  }

  if (selRename) {
    selRename.addEventListener("click", () => {
      const rows = getSelectedRows();
      if (rows.length !== 1) return;
      const it = itemFromRowEl(rows[0]);
      if (!it) return;
      renameNode(it);
    });
  }

  if (selDownload) {
    selDownload.addEventListener("click", async () => {
      const rows = getSelectedRows();
      if (!rows.length) return;
      const ids = rows.map((tr) => Number(tr.dataset.id)).filter((n) => Number.isFinite(n));
      const hasFolder = rows.some((tr) => tr.dataset.folder === "1");
      if (!ids.length) return;

      // Single file: download directly; otherwise zip.
      if (ids.length === 1 && !hasFolder) {
        window.open(`${API_BASE}/api/download/${ids[0]}`, "_blank", "noopener,noreferrer");
        return;
      }

      setStatus("Preparing ZIP…");
      const r = await fetch(`${API_BASE}/api/download-zip`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ node_ids: ids }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        setStatus(err.error || err.reason || "Could not create ZIP");
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "download.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      setStatus("");
    });
  }

  if (selDelete) {
    selDelete.addEventListener("click", () => bulkDeleteSelected());
  }

  dropzone.addEventListener("dragenter", (e) => {
    if (!hasFilePayload(e.dataTransfer)) return;
    e.preventDefault();
    dropzone.classList.add("drag");
  });
  dropzone.addEventListener("dragleave", (e) => {
    if (!hasFilePayload(e.dataTransfer)) return;
    e.preventDefault();
    if (!dropzone.contains(e.relatedTarget)) dropzone.classList.remove("drag");
  });
  dropzone.addEventListener("dragover", (e) => {
    if (!hasFilePayload(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = effectiveParentId() != null ? "copy" : "none";
  });

  dropzone.addEventListener("drop", async (e) => {
    dropzone.classList.remove("drag");
    if (!hasFilePayload(e.dataTransfer)) return;
    e.preventDefault();
    const pid = effectiveParentId();
    if (pid == null) {
      setStatus("Open your Home folder first, then upload.");
      return;
    }

    async function readAllEntries(reader) {
      const out = [];
      while (true) {
        const batch = await new Promise((resolve) => reader.readEntries(resolve));
        if (!batch || !batch.length) break;
        out.push(...batch);
      }
      return out;
    }

    async function collectDroppedFiles(dt) {
      const items = dt.items ? Array.from(dt.items) : [];
      const hasEntry = items.some((it) => typeof it.webkitGetAsEntry === "function");
      if (!hasEntry) {
        // Fallback: plain files only.
        return { files: Array.from(dt.files || []), hasFolders: false };
      }

      const files = [];
      let hasFolders = false;

      async function walk(entry, basePath) {
        if (!entry) return;
        if (entry.isFile) {
          const f = await new Promise((resolve) => entry.file(resolve, () => resolve(null)));
          if (f) {
            // Preserve relative path for uploadFolder().
            f.relativePath = basePath ? `${basePath}/${f.name}` : f.name;
            files.push(f);
          }
          return;
        }
        if (entry.isDirectory) {
          hasFolders = true;
          const dirReader = entry.createReader();
          const children = await readAllEntries(dirReader);
          const nextBase = basePath ? `${basePath}/${entry.name}` : entry.name;
          for (const ch of children) {
            await walk(ch, nextBase);
          }
        }
      }

      for (const it of items) {
        const entry = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
        if (!entry) continue;
        await walk(entry, "");
      }

      // If for some reason traversal yields nothing, fall back to dt.files.
      if (!files.length) return { files: Array.from(dt.files || []), hasFolders };
      return { files, hasFolders };
    }

    const gathered = await collectDroppedFiles(e.dataTransfer);
    const files = gathered.files || [];
    if (!files.length) return;
    const looksLikeFolderUpload =
      gathered.hasFolders || files.some((f) => (f.webkitRelativePath || f.relativePath || "").includes("/"));

    if (looksLikeFolderUpload) await uploadFolder(pid, files);
    else await uploadFiles(pid, files);
  });

  if (thSortName) {
    thSortName.addEventListener("click", () => {
      listSortDir = listSortDir === "asc" ? "desc" : "asc";
      syncSortHeaderUi();
      if (!lastListPayload) return;
      const display = filterPayloadForLeftNav(lastListPayload);
      lastItems =
        leftNavMode === "favorites" || leftNavMode === "personal"
          ? display.items || []
          : sortListingItems(display.items || []);
      renderTableRows(display);
      renderGrid(lastItems, display, display.shared_with_me || []);
      applyViewMode();
      updateFooter(lastItems);
      selectAll.checked = false;
      selectAll.indeterminate = false;
      updateSelectionBar();
    });
  }

  // Initialize folder state from URL, then keep Back/Forward within folders.
  const initialParentId = (() => {
    try {
      const u = new URL(window.location.href);
      const nav = (u.searchParams.get("nav") || "").trim().toLowerCase();
      if (nav && ["personal", "favorites", "shares", "recycle", "admin"].includes(nav)) {
        leftNavMode = nav;
      } else {
        leftNavMode = "all";
      }
      const raw = u.searchParams.get("parent_id");
      const n = raw == null ? null : Number(raw);
      // Root-only nav modes ignore parent_id on refresh.
      if (leftNavMode !== "all" && leftNavMode !== "admin") return null;
      return Number.isFinite(n) ? n : null;
    } catch {
      leftNavMode = "all";
      return null;
    }
  })();
  history.replaceState(
    {
      parentId: initialParentId,
      nav: initialParentId == null ? leftNavMode : leftNavMode === "admin" ? "admin" : "all",
    },
    "",
    folderUrlFor(initialParentId)
  );
  load(initialParentId);

  // Left navigation + search wiring
  applyLeftNavUi();
  document.querySelectorAll(".nc-leftnav-item[data-nav]").forEach((b) => {
    b.addEventListener("click", () => {
      cancelPendingSearch();
      leftNavMode = b.dataset.nav || "all";
      applyLeftNavUi();
      // left-nav filters are root-level views; go to root.
      // Update URL immediately so refresh preserves the view even if the fetch is still in-flight.
      history.pushState({ parentId: null, nav: leftNavMode }, "", folderUrlFor(null));
      load(null, { pushHistory: false });
    });
  });

  const leftSearchInput = document.querySelector(".nc-search-input");
  const leftSearchClear = document.querySelector(".nc-search-clear");
  if (leftSearchInput) {
    const runSearch = async () => {
      leftSearchQuery = String(leftSearchInput.value || "");
      if (leftSearchClear) leftSearchClear.hidden = !leftSearchQuery.length;
      await refreshMainView();
    };

    const scheduleSearch = () => {
      leftSearchQuery = String(leftSearchInput.value || "");
      if (leftSearchClear) leftSearchClear.hidden = !leftSearchQuery.length;
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      const q = leftSearchQuery.trim();
      if ((leftNavMode === "all" || leftNavMode === "admin") && q) {
        searchDebounceTimer = setTimeout(() => {
          searchDebounceTimer = null;
          runSearch();
        }, 300);
        return;
      }
      searchDebounceTimer = setTimeout(() => {
        searchDebounceTimer = null;
        runSearch();
      }, 120);
    };

    leftSearchInput.addEventListener("input", scheduleSearch);
    if (leftSearchClear) {
      leftSearchClear.addEventListener("click", () => {
        leftSearchInput.value = "";
        cancelPendingSearch();
        scheduleSearch();
      });
    }
  }
  window.__ncFbReloadListing = function () {
    try {
      void reloadListing();
    } catch {
      /* ignore */
    }
  };
  document.addEventListener(
    "nc-filebrowser-reload",
    () => {
    try {
      void reloadListing();
    } catch {
      /* ignore */
    }
    },
    { signal: ncFbSig }
  );
})();
