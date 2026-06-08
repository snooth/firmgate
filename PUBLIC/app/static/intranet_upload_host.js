/**
 * Intranet background upload host — dedicated popup window (survives Turbo navigation).
 */
(function () {
  if (!document.body || !document.body.classList.contains("nc-page-intranet")) return;
  if (window.ncIntranetUploadHost) return;

  const UPLOAD_WORKER_NAME = "nc_intranet_file_upload_worker";
  const UPLOAD_WORKER_WIN_FEATURES =
    "popup=yes,width=520,height=320,left=80,top=80,scrollbars=yes,resizable=yes";
  const PING_TIMEOUT_MS = 380;
  const PING_GAP_MS = 55;
  const PING_MAX_ATTEMPTS = 24;

  let readyWorkerWin = null;
  let readyWorkerAt = 0;
  let warmInFlight = false;

  function workerUrl() {
    const slot = document.getElementById("nc-upload-worker-slot");
    const fromSlot = slot && slot.dataset ? slot.dataset.uploadWorkerUrl : "";
    if (fromSlot) return String(fromSlot).trim();
    const fb = document.getElementById("file-browser");
    const fromFb = fb && fb.dataset ? fb.dataset.uploadWorkerUrl : "";
    return String(fromFb || "").trim();
  }

  function isConfigured() {
    return Boolean(workerUrl());
  }

  function cacheReadyWorker(w) {
    if (!w || w.closed) return;
    readyWorkerWin = w;
    readyWorkerAt = Date.now();
    w.__ncUploadHostReady = true;
  }

  function getCachedReadyWorker() {
    if (!readyWorkerWin || readyWorkerWin.closed) {
      readyWorkerWin = null;
      return null;
    }
    if (Date.now() - readyWorkerAt > 60 * 60 * 1000) {
      readyWorkerWin = null;
      return null;
    }
    return readyWorkerWin;
  }

  window.addEventListener("message", (ev) => {
    if (ev.origin !== window.location.origin) return;
    const d = ev.data;
    if (!d || d.nc !== "fb-up" || d.type !== "ready") return;
    const src = ev.source;
    if (!src || src.closed) return;
    cacheReadyWorker(src);
  });

  function pingUploadWorkerWindow(w, pingId, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const ms = timeoutMs != null ? timeoutMs : PING_TIMEOUT_MS;
      const origin = window.location.origin;
      function onMsg(ev) {
        if (done) return;
        if (ev.source !== w || ev.origin !== origin) return;
        const d = ev.data;
        if (d && d.nc === "fb-up" && d.type === "pong" && d.pingId === pingId) {
          done = true;
          window.removeEventListener("message", onMsg);
          window.clearTimeout(tid);
          resolve(true);
        }
      }
      const tid = window.setTimeout(() => {
        if (done) return;
        done = true;
        window.removeEventListener("message", onMsg);
        resolve(false);
      }, ms);
      window.addEventListener("message", onMsg);
      try {
        w.postMessage({ nc: "fb-up", type: "ping", pingId }, origin);
      } catch {
        if (!done) {
          done = true;
          window.removeEventListener("message", onMsg);
          window.clearTimeout(tid);
          resolve(false);
        }
      }
    });
  }

  async function pingWithRetry(w, attempts, gapMs, timeoutMs) {
    if (!w || w.closed) return false;
    const n = attempts != null ? attempts : PING_MAX_ATTEMPTS;
    const gap = gapMs != null ? gapMs : PING_GAP_MS;
    const to = timeoutMs != null ? timeoutMs : PING_TIMEOUT_MS;
    for (let i = 0; i < n; i++) {
      const pingId = `ping_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      if (await pingUploadWorkerWindow(w, pingId, to)) {
        cacheReadyWorker(w);
        return true;
      }
      if (i + 1 < n && gap > 0) await new Promise((r) => setTimeout(r, gap));
    }
    return false;
  }

  function openSyncPopup() {
    const url = workerUrl();
    if (!url) return null;
    try {
      return window.open(url, UPLOAD_WORKER_NAME, UPLOAD_WORKER_WIN_FEATURES);
    } catch {
      return null;
    }
  }

  /**
   * Resolve a ready upload popup. Never window.open("", name) — that blanks an active worker.
   */
  async function resolveUploadHostWindow(syncPopupWin) {
    const cached = getCachedReadyWorker();
    if (cached) {
      const pingId = `ping_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      if (await pingUploadWorkerWindow(cached, pingId, 280)) return cached;
      readyWorkerWin = null;
    }

    const candidates = [];
    if (syncPopupWin && !syncPopupWin.closed) candidates.push(syncPopupWin);

    for (const w of candidates) {
      if (await pingWithRetry(w, PING_MAX_ATTEMPTS, PING_GAP_MS, PING_TIMEOUT_MS)) return w;
    }

    const url = workerUrl();
    if (!url) return null;
    try {
      const fresh = window.open(url, UPLOAD_WORKER_NAME, UPLOAD_WORKER_WIN_FEATURES);
      if (fresh && !fresh.closed && (await pingWithRetry(fresh, PING_MAX_ATTEMPTS, PING_GAP_MS, PING_TIMEOUT_MS))) {
        return fresh;
      }
      try {
        if (fresh) fresh.close();
      } catch {
        /* ignore */
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  function postStartMessage(hostWin, urls, payload) {
    const { uploadUrl, mkdirUrl, apiBase } = urls;
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    hostWin.postMessage(
      {
        nc: "fb-up",
        type: "start",
        jobId,
        uploadUrl,
        mkdirUrl,
        apiBase,
        ...payload,
      },
      window.location.origin
    );
    try {
      hostWin.focus();
    } catch {
      /* ignore */
    }
  }

  async function postUploadJobToWorkerWindow(hostWin, urls, payload) {
    if (!hostWin || hostWin.closed) return false;
    if (hostWin.__ncUploadHostReady) {
      try {
        postStartMessage(hostWin, urls, payload);
        return true;
      } catch {
        hostWin.__ncUploadHostReady = false;
      }
    }
    if (await pingWithRetry(hostWin, 8, PING_GAP_MS, PING_TIMEOUT_MS)) {
      try {
        postStartMessage(hostWin, urls, payload);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  async function postUploadJobsToWorker(hostWin, jobs, urls) {
    for (const job of jobs) {
      if (!(await postUploadJobToWorkerWindow(hostWin, urls, job))) return false;
    }
    return true;
  }

  /** Open the worker popup early on Documents so uploads start quickly. */
  function warmWorker() {
    if (!isConfigured() || warmInFlight) return;
    if (getCachedReadyWorker()) return;
    warmInFlight = true;
    try {
      const w = openSyncPopup();
      if (w && !w.closed) {
        void pingWithRetry(w, PING_MAX_ATTEMPTS, PING_GAP_MS, PING_TIMEOUT_MS).finally(() => {
          warmInFlight = false;
        });
        return;
      }
    } catch {
      /* ignore */
    }
    warmInFlight = false;
  }

  window.ncIntranetUploadHost = {
    UPLOAD_WORKER_NAME,
    UPLOAD_WORKER_WIN_FEATURES,
    workerUrl,
    isConfigured,
    openSyncPopup,
    resolveUploadHostWindow,
    postUploadJobsToWorker,
    pingUploadWorkerWindow,
    warmWorker,
  };

  if (document.getElementById("file-browser")) {
    warmWorker();
  }
  document.addEventListener("turbo:load", () => {
    if (document.getElementById("file-browser")) warmWorker();
  });
})();
