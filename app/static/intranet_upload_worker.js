/**
 * Upload worker (popup or Turbo-persistent iframe): XMLHttpRequest runs here so the main
 * intranet tab can navigate. Progress is posted to the parent shell.
 */
(function () {
  const origin = location.origin;
  const body = document.body;
  const APP_TIME_ZONE = (body.getAttribute("data-time-zone") || "Australia/Melbourne").trim();
  const APP_TIME_OFFSET_MS = Number(body.getAttribute("data-time-offset-ms") || "0") || 0;
  const APP_LOCALE = "en-AU";
  const DT_DISPLAY = {
    timeZone: APP_TIME_ZONE,
    dateStyle: "medium",
    timeStyle: "short",
    timeZoneName: "short",
  };

  const dlgUploadConflict = document.getElementById("dlg-upload-conflict");
  const btnUconflictReplace = document.getElementById("btn-uconflict-replace");
  const btnUconflictKeep = document.getElementById("btn-uconflict-keep");
  const btnUconflictCancel = document.getElementById("btn-uconflict-cancel");
  const uconflictReadonlyHint = document.getElementById("uconflict-readonly-hint");

  const queue = [];
  let pumpRunning = false;

  function setLine(msg) {
    const el = document.getElementById("nc-upload-worker-line");
    if (el) el.textContent = msg || "";
  }

  function postToShell(msg) {
    const payload = Object.assign({ nc: "fb-up-prog" }, msg);
    const targets = [];
    try {
      if (window.opener && !window.opener.closed) targets.push(window.opener);
    } catch {
      /* ignore */
    }
    try {
      if (window.parent && window.parent !== window) targets.push(window.parent);
    } catch {
      /* ignore */
    }
    try {
      if (window.top && window.top !== window) targets.push(window.top);
    } catch {
      /* ignore */
    }
    targets.forEach((t) => {
      try {
        t.postMessage(payload, origin);
      } catch {
        /* ignore */
      }
    });
  }

  let ncWorkerNavBlock = 0;
  function ncBeforeUnloadWhileUpload(e) {
    e.preventDefault();
    e.returnValue = "";
  }
  function beginWorkerNavBlock() {
    ncWorkerNavBlock += 1;
    if (ncWorkerNavBlock === 1) window.addEventListener("beforeunload", ncBeforeUnloadWhileUpload);
  }
  function endWorkerNavBlock() {
    ncWorkerNavBlock = Math.max(0, ncWorkerNavBlock - 1);
    if (ncWorkerNavBlock === 0) window.removeEventListener("beforeunload", ncBeforeUnloadWhileUpload);
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

  function normalizeIso(iso) {
    const s = String(iso || "");
    if (!s) return s;
    if (/[zZ]$/.test(s)) return s;
    if (/[+-]\d\d:\d\d$/.test(s)) return s;
    return s + "Z";
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
      return new Date(new Date(normalizeIso(iso)).getTime() + APP_TIME_OFFSET_MS).toLocaleString(
        APP_LOCALE,
        DT_DISPLAY
      );
    } catch {
      return "—";
    }
  }

  function requestConflictViaShell(existing, file, canReplace) {
    return new Promise((resolve) => {
      const requestId = `cr_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      let shell = null;
      try {
        if (window.opener && !window.opener.closed) shell = window.opener;
        else if (window.parent && window.parent !== window) shell = window.parent;
      } catch {
        shell = null;
      }
      if (!shell) {
        resolve("cancel");
        return;
      }
      function onMsg(ev) {
        if (ev.origin !== origin) return;
        const d = ev.data;
        if (!d || d.nc !== "fb-up" || d.type !== "conflict-response" || d.requestId !== requestId) return;
        window.removeEventListener("message", onMsg);
        const choice = d.choice === "replace" || d.choice === "keep" ? d.choice : "cancel";
        resolve(choice);
      }
      window.addEventListener("message", onMsg);
      try {
        shell.postMessage(
          {
            nc: "fb-up",
            type: "conflict-request",
            requestId,
            existing,
            incoming: {
              name: file.name.replace(/^.*[\\/]/, "") || file.name,
              size: file.size,
              lastModified: file.lastModified,
            },
            canReplace: canReplace !== false,
          },
          origin
        );
      } catch {
        window.removeEventListener("message", onMsg);
        resolve("cancel");
      }
    });
  }

  function showUploadConflictDialog(existing, file, canReplace) {
    try {
      if (
        (window.opener && !window.opener.closed) ||
        (window.parent && window.parent !== window)
      ) {
        return requestConflictViaShell(existing, file, canReplace);
      }
    } catch {
      /* fall through to local dialog */
    }
    if (!dlgUploadConflict) return Promise.resolve("cancel");
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

  function uploadSingleFile(uploadUrl, parentId, file, onProgress) {
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

  async function ensureFolderPath(mkdirUrl, baseParentId, relDir, cache) {
    const norm = String(relDir || "").replace(/^[\\/]+|[\\/]+$/g, "");
    if (!norm) return baseParentId;
    const parts = norm.split(/[\\/]+/).filter(Boolean);
    let cur = baseParentId;
    let acc = "";
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

  function postProgress(jobId, pct, label, detail) {
    postToShell({
      jobId,
      phase: "progress",
      pct: clampPct(pct),
      label,
      detail: detail || "",
    });
  }

  function relativePathFor(job, file, index) {
    const paths = job.relativePaths;
    if (Array.isArray(paths) && paths[index]) return String(paths[index]);
    return String(file.webkitRelativePath || file.relativePath || file.name || "");
  }

  function batchPrefix(job) {
    if (job.batchCount > 1) return `Batch ${job.batchIndex} of ${job.batchCount} · `;
    return "";
  }

  function uploadSummaryMessage(uploaded, skipped, failed, totalFiles) {
    const parts = [];
    if (uploaded) parts.push(`${uploaded} uploaded`);
    if (skipped) parts.push(`${skipped} kept existing`);
    if (failed) parts.push(`${failed} failed`);
    let detail = parts.length ? parts.join(", ") + "." : "";
    let status = "";
    if (failed) {
      status = `Upload finished with ${failed} failed of ${totalFiles}.`;
    } else if (uploaded && skipped) {
      status = `Upload complete (${uploaded} uploaded, ${skipped} kept existing).`;
    } else if (uploaded) {
      status = "Upload complete.";
    } else if (skipped) {
      status = `No files uploaded (${skipped} kept existing).`;
    }
    return { detail, status, partial: failed > 0 };
  }

  function jobResult(uploaded, skipped, failed, totalFiles, mode, extra) {
    return Object.assign(
      {
        uploaded,
        skipped,
        failed,
        totalFiles,
        folderCount: 0,
        mode: mode === "folder" ? "folder" : "files",
        cancelled: false,
        partial: failed > 0,
        lastError: "",
      },
      extra || {}
    );
  }

  function postSessionComplete(acc) {
    const sum = uploadSummaryMessage(acc.uploaded, acc.skipped, acc.failed, acc.totalFiles);
    let detail = sum.detail;
    if (acc.failed && acc.lastError) detail = `${detail} ${acc.lastError}`.trim();
    let status = sum.status;
    if (acc.mode === "folder") {
      if (status === "Upload complete.") status = "Folder upload complete.";
      else if (sum.partial) status = `Folder upload finished with ${acc.failed} failed of ${acc.totalFiles}.`;
    }
    postToShell({
      phase: acc.cancelled ? "cancelled" : "done",
      status,
      detail,
      partial: sum.partial,
      uploaded: acc.uploaded,
      skipped: acc.skipped,
      failed: acc.failed,
      totalFiles: acc.totalFiles,
      folderCount: Math.max(0, Number(acc.folderCount) || 0),
      uploadMode: acc.mode,
      showSummary: true,
      lastError: acc.lastError || "",
      delayHideMs: 900,
      reload: true,
    });
  }

  async function runFilesJob(job) {
    const { jobId, parentId, uploadUrl, apiBase, files } = job;
    const list = Array.from(files || []).filter((f) => f && f.name);
    if (!list.length) return null;

    const totalFiles = list.length;
    const totalBytes = list.reduce((s, f) => s + (f.size || 0), 0);
    const useByteProgress = totalBytes > 0;
    const prefix = batchPrefix(job);

    beginWorkerNavBlock();
    try {
      let completedBytes = 0;
      let uploaded = 0;
      let skipped = 0;
      let failed = 0;
      let lastFailHint = "";

      for (let i = 0; i < list.length; i++) {
        const file = list[i];
        const baseName = file.name.replace(/^.*[\\/]/, "");
        const cu = await fetch(
          `${apiBase}/api/upload-conflict?parent_id=${parentId}&filename=${encodeURIComponent(baseName)}`,
          { credentials: "same-origin" }
        );
        const cd = await cu.json().catch(() => ({}));
        if (cu.ok && cd.conflict) {
          const choice = await showUploadConflictDialog(cd.existing, file, cd.can_replace !== false);
          if (choice === "cancel") {
            return jobResult(uploaded, skipped, failed, totalFiles, "files", {
              cancelled: true,
              partial: true,
              lastError: lastFailHint,
              folderCount: 0,
            });
          }
          if (choice === "keep") {
            skipped += 1;
            if (useByteProgress) completedBytes += file.size || 0;
            const pctSkip = useByteProgress
              ? clampPct((completedBytes / totalBytes) * 100)
              : clampPct(((i + 1) / totalFiles) * 100);
            postProgress(
              jobId,
              pctSkip,
              "Uploading…",
              `${prefix}Kept existing · ${i + 1} of ${totalFiles} · ${baseName}`
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
            ? `${prefix}File ${i + 1} of ${totalFiles} · ${baseName} · ${formatUploadBytes(
                completedBytes + loaded
              )} / ${formatUploadBytes(totalBytes)}`
            : `${prefix}File ${i + 1} of ${totalFiles} · ${baseName}`;
          postProgress(jobId, pct, "Uploading…", detail);
        };

        const r = await uploadSingleFile(uploadUrl, parentId, file, onProg);
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          const hint =
            r.status === 413
              ? "File too large for upload (server limit)."
              : err.error || err.reason || "Upload failed";
          failed += 1;
          lastFailHint = `${baseName}: ${hint}`;
          if (useByteProgress) completedBytes += fileSize;
          postProgress(
            jobId,
            useByteProgress ? clampPct((completedBytes / totalBytes) * 100) : clampPct(((i + 1) / totalFiles) * 100),
            "Uploading…",
            `${prefix}Failed ${i + 1} of ${totalFiles} · ${baseName}`
          );
          continue;
        }
        completedBytes += fileSize;
        uploaded += 1;
        if (useByteProgress) {
          postProgress(
            jobId,
            clampPct((completedBytes / totalBytes) * 100),
            "Uploading…",
            `${prefix}Finished ${i + 1} of ${totalFiles} · ${baseName}`
          );
        }
      }

      return jobResult(uploaded, skipped, failed, totalFiles, "files", { lastError: lastFailHint, folderCount: 0 });
    } catch (e) {
      postToShell({
        jobId,
        phase: "error",
        message: String(e && e.message ? e.message : e) || "Upload failed",
        delayHideMs: 200,
        reload: true,
      });
      return null;
    } finally {
      endWorkerNavBlock();
    }
  }

  function countFolderRoots(job, list) {
    const dirs = new Set();
    for (let i = 0; i < list.length; i++) {
      const rel = relativePathFor(job, list[i], i);
      const top = rel.includes("/") ? rel.split("/")[0] : "";
      if (top) dirs.add(top);
    }
    return dirs.size;
  }

  async function runFolderJob(job) {
    const { jobId, parentId, uploadUrl, apiBase, mkdirUrl, files } = job;
    const list = Array.from(files || []).filter((f) => f && f.name);
    if (!list.length) return null;

    const folderCount = countFolderRoots(job, list);
    const totalFiles = list.length;
    const totalBytes = list.reduce((s, f) => s + (f.size || 0), 0);
    const useByteProgress = totalBytes > 0;
    const pathCache = new Map();
    const prefix = batchPrefix(job);

    beginWorkerNavBlock();
    try {
      let completedBytes = 0;
      let uploaded = 0;
      let skipped = 0;
      let failed = 0;
      let lastFailHint = "";

      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        const rel = relativePathFor(job, f, i);
        const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
        const baseName = rel.includes("/") ? rel.slice(rel.lastIndexOf("/") + 1) : f.name;

        if (dir) {
          const pctPrep = useByteProgress
            ? clampPct((completedBytes / totalBytes) * 100)
            : clampPct((i / Math.max(1, totalFiles)) * 100);
          postProgress(jobId, pctPrep, "Uploading folder…", `${prefix}Preparing path · ${dir}`);
        }

        const destId = await ensureFolderPath(mkdirUrl, parentId, dir, pathCache);

        const cu = await fetch(
          `${apiBase}/api/upload-conflict?parent_id=${destId}&filename=${encodeURIComponent(baseName)}`,
          { credentials: "same-origin" }
        );
        const cd = await cu.json().catch(() => ({}));
        if (cu.ok && cd.conflict) {
          const choice = await showUploadConflictDialog(cd.existing, f, cd.can_replace !== false);
          if (choice === "cancel") {
            return jobResult(uploaded, skipped, failed, totalFiles, "folder", {
              cancelled: true,
              partial: true,
              lastError: lastFailHint,
              folderCount,
            });
          }
          if (choice === "keep") {
            skipped += 1;
            if (useByteProgress) completedBytes += f.size || 0;
            const pctSkip = useByteProgress
              ? clampPct((completedBytes / totalBytes) * 100)
              : clampPct(((i + 1) / totalFiles) * 100);
            const pathHint = dir ? `${dir}/` : "";
            postProgress(
              jobId,
              pctSkip,
              "Uploading folder…",
              `${prefix}Kept existing · ${i + 1} of ${totalFiles} · ${pathHint}${baseName}`
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
            ? `${prefix}File ${i + 1} of ${totalFiles} · ${pathHint}${baseName} · ${formatUploadBytes(
                completedBytes + loaded
              )} / ${formatUploadBytes(totalBytes)}`
            : `${prefix}File ${i + 1} of ${totalFiles} · ${pathHint}${baseName}`;
          postProgress(jobId, pct, "Uploading folder…", detail);
        };

        const r = await uploadSingleFile(uploadUrl, destId, f, onProg);
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
          postProgress(
            jobId,
            useByteProgress ? clampPct((completedBytes / totalBytes) * 100) : clampPct(((i + 1) / totalFiles) * 100),
            "Uploading folder…",
            `${prefix}Failed ${i + 1} of ${totalFiles} · ${pathHint}${baseName}`
          );
          continue;
        }
        completedBytes += fileSize;
        uploaded += 1;
        if (useByteProgress) {
          postProgress(
            jobId,
            clampPct((completedBytes / totalBytes) * 100),
            "Uploading folder…",
            `${prefix}Finished ${i + 1} of ${totalFiles} · ${baseName}`
          );
        }
      }

      return jobResult(uploaded, skipped, failed, totalFiles, "folder", { lastError: lastFailHint, folderCount });
    } catch (e) {
      postToShell({
        jobId,
        phase: "error",
        message: String(e && e.message ? e.message : e) || "Folder upload failed",
        delayHideMs: 200,
        reload: true,
      });
      return null;
    } finally {
      endWorkerNavBlock();
    }
  }

  async function runJob(job) {
    const mode = job.mode === "folder" ? "folder" : "files";
    setLine(mode === "folder" ? "Uploading folder…" : "Uploading…");
    const result = mode === "folder" ? await runFolderJob(job) : await runFilesJob(job);
    setLine("Idle — you can close this window when no uploads are running.");
    return result;
  }

  async function pumpQueue() {
    if (pumpRunning) return;
    pumpRunning = true;
    const acc = {
      uploaded: 0,
      skipped: 0,
      failed: 0,
      totalFiles: 0,
      folderCount: 0,
      mode: "files",
      cancelled: false,
      lastError: "",
    };
    const heartbeat = window.setInterval(() => {
      if (!pumpRunning) return;
      postToShell({
        phase: "heartbeat",
        label: "Uploading…",
        detail: "Background upload in progress — keep the Background uploads window open.",
      });
    }, 20000);
    try {
      while (queue.length) {
        const job = queue.shift();
        const result = await runJob(job);
        if (!result) continue;
        acc.uploaded += result.uploaded;
        acc.skipped += result.skipped;
        acc.failed += result.failed;
        acc.totalFiles += result.totalFiles;
        acc.mode = result.mode;
        if (result.folderCount > acc.folderCount) acc.folderCount = result.folderCount;
        if (result.lastError) acc.lastError = result.lastError;
        if (result.cancelled) {
          acc.cancelled = true;
          break;
        }
      }
      if (acc.totalFiles > 0 || acc.uploaded > 0 || acc.skipped > 0 || acc.failed > 0) {
        postSessionComplete(acc);
      }
    } finally {
      window.clearInterval(heartbeat);
      pumpRunning = false;
    }
  }

  window.addEventListener("message", (ev) => {
    if (ev.origin !== origin) return;
    const d = ev.data;
    if (!d || d.nc !== "fb-up") return;
    if (d.type === "ping") {
      const tgt = ev.source;
      if (tgt && typeof tgt.postMessage === "function") {
        tgt.postMessage({ nc: "fb-up", type: "pong", pingId: d.pingId }, origin);
      }
      return;
    }
    if (d.type === "start") {
      queue.push(d);
      void pumpQueue();
    }
  });

  function announceReady() {
    const msg = { nc: "fb-up", type: "ready" };
    try {
      if (window.opener && !window.opener.closed) window.opener.postMessage(msg, origin);
    } catch {
      /* ignore */
    }
    try {
      if (window.parent && window.parent !== window) window.parent.postMessage(msg, origin);
    } catch {
      /* ignore */
    }
  }

  announceReady();

  if (window.parent && window.parent !== window) {
    setLine("");
  } else if (!window.opener) {
    setLine("Open Documents in the intranet and start an upload — this window is opened automatically for large transfers.");
  } else {
    setLine("Ready for uploads — you can switch menus in the main window.");
  }
})();
