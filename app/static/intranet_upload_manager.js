/**
 * Intranet document uploads in the main window (survives Turbo menu navigation; no popup).
 */
(function () {
  if (!document.body || !document.body.classList.contains("nc-page-intranet")) return;
  if (window.ncIntranetUploadManager) return;

  const queue = [];
  let pumpRunning = false;

  function emit(detail) {
    try {
      document.dispatchEvent(new CustomEvent("nc-upload-prog", { detail }));
    } catch {
      /* ignore */
    }
  }

  function clampPct(p) {
    const x = Number(p);
    if (!Number.isFinite(x)) return 0;
    return Math.min(100, Math.max(0, x));
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

  function requestConflict(existing, file, canReplace, options) {
    return new Promise((resolve) => {
      const requestId = `cr_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      function onResp(ev) {
        const d = ev.detail;
        if (!d || d.requestId !== requestId) return;
        document.removeEventListener("nc-upload-conflict-response", onResp);
        const choice =
          d.choice === "replace" || d.choice === "replace_all" || d.choice === "keep" ? d.choice : "cancel";
        resolve(choice);
      }
      document.addEventListener("nc-upload-conflict-response", onResp);
      document.dispatchEvent(
        new CustomEvent("nc-upload-conflict-request", {
          detail: {
            requestId,
            existing,
            incoming: {
              name: file.name.replace(/^.*[\\/]/, "") || file.name,
              size: file.size,
              lastModified: file.lastModified,
            },
            canReplace: canReplace !== false,
            showReplaceAll: !!(options && options.showReplaceAll),
          },
        })
      );
    });
  }

  async function resolveUploadFileConflict(existing, file, canReplace, conflictCtx) {
    if (conflictCtx.replaceAll) {
      return canReplace === false ? "keep" : "replace";
    }
    const choice = await requestConflict(existing, file, canReplace, {
      showReplaceAll: conflictCtx.totalFiles > 1,
    });
    if (choice === "replace_all") {
      conflictCtx.replaceAll = true;
      return "replace";
    }
    return choice;
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

  function relativePathFor(job, file, index) {
    const paths = job.relativePaths;
    if (Array.isArray(paths) && paths[index]) return String(paths[index]);
    return String(file.webkitRelativePath || file.relativePath || file.name || "");
  }

  function batchPrefix(job) {
    if (job.batchCount > 1) return `Batch ${job.batchIndex} of ${job.batchCount} · `;
    return "";
  }

  function postProgress(pct, label, detail) {
    emit({ phase: "progress", pct: clampPct(pct), label, detail: detail || "" });
  }

  function uploadSummaryMessage(uploaded, skipped, failed, totalFiles) {
    const parts = [];
    if (uploaded) parts.push(`${uploaded} uploaded`);
    if (skipped) parts.push(`${skipped} kept existing`);
    if (failed) parts.push(`${failed} failed`);
    const detail = parts.length ? parts.join(", ") + "." : "";
    let status = "";
    if (failed) status = `Upload finished with ${failed} failed of ${totalFiles}.`;
    else if (uploaded && skipped) status = `Upload complete (${uploaded} uploaded, ${skipped} kept existing).`;
    else if (uploaded) status = "Upload complete.";
    else if (skipped) status = `No files uploaded (${skipped} kept existing).`;
    return { detail, status, partial: failed > 0 };
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
    emit({
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
    const { parentId, uploadUrl, apiBase, files } = job;
    const list = Array.from(files || []).filter((f) => f && f.name);
    if (!list.length) return null;

    const totalFiles = list.length;
    const totalBytes = list.reduce((s, f) => s + (f.size || 0), 0);
    const useByteProgress = totalBytes > 0;
    const prefix = batchPrefix(job);

    let completedBytes = 0;
    let uploaded = 0;
    let skipped = 0;
    let failed = 0;
    let lastFailHint = "";
    const conflictCtx = { replaceAll: false, totalFiles };

    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      const baseName = file.name.replace(/^.*[\\/]/, "");
      const cu = await fetch(
        `${apiBase}/api/upload-conflict?parent_id=${parentId}&filename=${encodeURIComponent(baseName)}`,
        { credentials: "same-origin" }
      );
      const cd = await cu.json().catch(() => ({}));
      if (cu.ok && cd.conflict) {
        const choice = await resolveUploadFileConflict(cd.existing, file, cd.can_replace !== false, conflictCtx);
        if (choice === "cancel") {
          return {
            uploaded,
            skipped,
            failed,
            totalFiles,
            mode: "files",
            cancelled: true,
            lastError: lastFailHint,
            folderCount: 0,
          };
        }
        if (choice === "keep") {
          skipped += 1;
          if (useByteProgress) completedBytes += file.size || 0;
          postProgress(
            useByteProgress ? clampPct((completedBytes / totalBytes) * 100) : clampPct(((i + 1) / totalFiles) * 100),
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
        postProgress(pct, "Uploading…", detail);
      };

      const r = await uploadSingleFile(uploadUrl, parentId, file, onProg);
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        const hint =
          r.status === 413 ? "File too large for upload (server limit)." : err.error || err.reason || "Upload failed";
        failed += 1;
        lastFailHint = `${baseName}: ${hint}`;
        if (useByteProgress) completedBytes += fileSize;
        postProgress(
          useByteProgress ? clampPct((completedBytes / totalBytes) * 100) : clampPct(((i + 1) / totalFiles) * 100),
          "Uploading…",
          `${prefix}Failed ${i + 1} of ${totalFiles} · ${baseName}`
        );
        continue;
      }
      completedBytes += fileSize;
      uploaded += 1;
    }

    return { uploaded, skipped, failed, totalFiles, mode: "files", cancelled: false, lastError: lastFailHint, folderCount: 0 };
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
    const { parentId, uploadUrl, apiBase, mkdirUrl, files } = job;
    const list = Array.from(files || []).filter((f) => f && f.name);
    if (!list.length) return null;

    const folderCount = countFolderRoots(job, list);
    const totalFiles = list.length;
    const totalBytes = list.reduce((s, f) => s + (f.size || 0), 0);
    const useByteProgress = totalBytes > 0;
    const pathCache = new Map();
    const prefix = batchPrefix(job);

    let completedBytes = 0;
    let uploaded = 0;
    let skipped = 0;
    let failed = 0;
    let lastFailHint = "";
    const conflictCtx = { replaceAll: false, totalFiles };

    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      const rel = relativePathFor(job, f, i);
      const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      const baseName = rel.includes("/") ? rel.slice(rel.lastIndexOf("/") + 1) : f.name;

      if (dir) {
        postProgress(
          useByteProgress ? clampPct((completedBytes / totalBytes) * 100) : clampPct((i / Math.max(1, totalFiles)) * 100),
          "Uploading folder…",
          `${prefix}Preparing path · ${dir}`
        );
      }

      const destId = await ensureFolderPath(mkdirUrl, parentId, dir, pathCache);

      const cu = await fetch(
        `${apiBase}/api/upload-conflict?parent_id=${destId}&filename=${encodeURIComponent(baseName)}`,
        { credentials: "same-origin" }
      );
      const cd = await cu.json().catch(() => ({}));
      if (cu.ok && cd.conflict) {
        const choice = await resolveUploadFileConflict(cd.existing, f, cd.can_replace !== false, conflictCtx);
        if (choice === "cancel") {
          return {
            uploaded,
            skipped,
            failed,
            totalFiles,
            mode: "folder",
            cancelled: true,
            lastError: lastFailHint,
            folderCount,
          };
        }
        if (choice === "keep") {
          skipped += 1;
          if (useByteProgress) completedBytes += f.size || 0;
          const pathHint = dir ? `${dir}/` : "";
          postProgress(
            useByteProgress ? clampPct((completedBytes / totalBytes) * 100) : clampPct(((i + 1) / totalFiles) * 100),
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
        postProgress(pct, "Uploading folder…", detail);
      };

      const r = await uploadSingleFile(uploadUrl, destId, f, onProg);
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        const hint =
          r.status === 413 ? "File too large for upload (server limit)." : err.error || err.reason || "Upload failed";
        failed += 1;
        lastFailHint = `${rel}: ${hint}`;
        if (useByteProgress) completedBytes += fileSize;
        const pathHint = dir ? `${dir}/` : "";
        postProgress(
          useByteProgress ? clampPct((completedBytes / totalBytes) * 100) : clampPct(((i + 1) / totalFiles) * 100),
          "Uploading folder…",
          `${prefix}Failed ${i + 1} of ${totalFiles} · ${pathHint}${baseName}`
        );
        continue;
      }
      completedBytes += fileSize;
      uploaded += 1;
    }

    return { uploaded, skipped, failed, totalFiles, mode: "folder", cancelled: false, lastError: lastFailHint, folderCount };
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
    try {
      while (queue.length) {
        const job = queue.shift();
        const result = job.mode === "folder" ? await runFolderJob(job) : await runFilesJob(job);
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
    } catch (e) {
      emit({
        phase: "error",
        message: String(e && e.message ? e.message : e) || "Upload failed",
        delayHideMs: 200,
        reload: true,
      });
    } finally {
      pumpRunning = false;
    }
  }

  function start(opts) {
    queue.push(opts);
    void pumpQueue();
  }

  window.ncIntranetUploadManager = { start, isActive: () => pumpRunning || queue.length > 0 };
})();
