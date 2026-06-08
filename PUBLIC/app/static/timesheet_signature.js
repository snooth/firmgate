(function (global) {
  function initSignatureCapture(root, options) {
    if (!root) return null;

    const onChange = typeof options?.onChange === "function" ? options.onChange : null;

    const previewWrap = root.querySelector("#nc-ts-sig-preview");
    const previewImg = root.querySelector("#nc-ts-sig-preview-img");
    const emptyEl = root.querySelector("#nc-ts-sig-empty");
    const btnOpen = root.querySelector("#nc-ts-sig-open");
    const btnClear = root.querySelector("#nc-ts-sig-clear");
    const dropZone = root.querySelector("#nc-ts-sig-dropzone");
    const modal = document.getElementById("nc-ts-sig-modal");
    const canvas = document.getElementById("nc-ts-sig-canvas");
    const btnDrawClear = document.getElementById("nc-ts-sig-draw-clear");
    const btnDrawSave = document.getElementById("nc-ts-sig-draw-save");
    const fileInput = root.querySelector("#nc-ts-sig-file");

    let dataUrl = "";
    let drawing = false;
    let lastX = 0;
    let lastY = 0;
    const ctx = canvas && canvas.getContext ? canvas.getContext("2d") : null;

    function setStatusMessage(msg) {
      const st = document.getElementById("nc-ts-status");
      if (st && msg) {
        st.textContent = msg;
        st.style.color = "";
      }
    }

    function refreshUi() {
      const has = !!dataUrl;
      if (previewWrap) previewWrap.hidden = !has;
      if (previewImg && has) previewImg.src = dataUrl;
      if (emptyEl) emptyEl.hidden = has;
      if (btnClear) btnClear.hidden = !has;
      if (btnOpen) btnOpen.textContent = has ? "Change signature" : "Add signature";
      root.classList.toggle("has-signature", has);
    }

    function setSignature(nextUrl, quiet) {
      dataUrl = nextUrl || "";
      refreshUi();
      if (onChange) onChange(dataUrl);
      if (!quiet) setStatusMessage(dataUrl ? "Signature saved." : "Signature cleared.");
    }

    function canvasPoint(evt) {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const clientX = evt.clientX != null ? evt.clientX : evt.touches[0].clientX;
      const clientY = evt.clientY != null ? evt.clientY : evt.touches[0].clientY;
      return {
        x: (clientX - rect.left) * scaleX,
        y: (clientY - rect.top) * scaleY,
      };
    }

    function resetCanvas() {
      if (!ctx || !canvas) return;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = "#111827";
      ctx.lineWidth = 2.4;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
    }

    function canvasHasInk() {
      if (!ctx || !canvas) return false;
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 3; i < pixels.length; i += 4) {
        if (pixels[i] > 0) return true;
      }
      return false;
    }

    function startDraw(evt) {
      if (!ctx) return;
      evt.preventDefault();
      drawing = true;
      const p = canvasPoint(evt);
      lastX = p.x;
      lastY = p.y;
    }

    function moveDraw(evt) {
      if (!drawing || !ctx) return;
      evt.preventDefault();
      const p = canvasPoint(evt);
      ctx.beginPath();
      ctx.moveTo(lastX, lastY);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      lastX = p.x;
      lastY = p.y;
    }

    function endDraw(evt) {
      if (!drawing) return;
      if (evt) evt.preventDefault();
      drawing = false;
    }

    function openModal() {
      if (!modal || !canvas) return;
      resetCanvas();
      if (typeof modal.showModal === "function") modal.showModal();
    }

    function closeModal() {
      if (!modal) return;
      if (typeof modal.close === "function") modal.close();
    }

    function fileToPngDataUrl(file) {
      return new Promise((resolve, reject) => {
        if (!file || !/^image\//i.test(file.type || "")) {
          reject(new Error("Choose a PNG or JPG signature image."));
          return;
        }
        if (file.size > 512000) {
          reject(new Error("Signature image must be 500 KB or smaller."));
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const img = new Image();
          img.onload = () => {
            const maxW = 560;
            const maxH = 180;
            let w = img.width;
            let h = img.height;
            const scale = Math.min(1, maxW / w, maxH / h);
            w = Math.max(1, Math.round(w * scale));
            h = Math.max(1, Math.round(h * scale));
            const c = document.createElement("canvas");
            c.width = w;
            c.height = h;
            const g = c.getContext("2d");
            g.fillStyle = "#fff";
            g.fillRect(0, 0, w, h);
            g.drawImage(img, 0, 0, w, h);
            resolve(c.toDataURL("image/png"));
          };
          img.onerror = () => reject(new Error("Could not read that image."));
          img.src = reader.result;
        };
        reader.onerror = () => reject(new Error("Could not read that file."));
        reader.readAsDataURL(file);
      });
    }

    async function ingestFile(file, quiet) {
      try {
        const url = await fileToPngDataUrl(file);
        setSignature(url, quiet);
      } catch (e) {
        setStatusMessage(String(e && e.message ? e.message : e));
        const st = document.getElementById("nc-ts-status");
        if (st) st.style.color = "var(--nc-danger, #dc2626)";
      }
    }

    if (canvas && ctx) {
      resetCanvas();
      canvas.addEventListener("mousedown", startDraw);
      canvas.addEventListener("mousemove", moveDraw);
      window.addEventListener("mouseup", endDraw);
      canvas.addEventListener("touchstart", startDraw, { passive: false });
      canvas.addEventListener("touchmove", moveDraw, { passive: false });
      window.addEventListener("touchend", endDraw, { passive: false });
    }

    btnOpen?.addEventListener("click", openModal);
    btnClear?.addEventListener("click", () => setSignature(""));

    btnDrawClear?.addEventListener("click", () => resetCanvas());
    btnDrawSave?.addEventListener("click", (e) => {
      e.preventDefault();
      if (!canvasHasInk()) {
        setStatusMessage("Draw your signature first.");
        const st = document.getElementById("nc-ts-status");
        if (st) st.style.color = "var(--nc-danger, #dc2626)";
        return;
      }
      setSignature(canvas.toDataURL("image/png"));
      closeModal();
    });

    modal?.addEventListener("cancel", () => resetCanvas());
    modal?.querySelector('[data-action="cancel"]')?.addEventListener("click", () => {
      resetCanvas();
      closeModal();
    });

    fileInput?.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
      fileInput.value = "";
      if (file) void ingestFile(file);
    });

    root.querySelector("#nc-ts-sig-upload")?.addEventListener("click", () => fileInput?.click());

    if (dropZone) {
      const highlight = (on) => dropZone.classList.toggle("is-dragover", !!on);
      ["dragenter", "dragover"].forEach((ev) => {
        dropZone.addEventListener(ev, (e) => {
          e.preventDefault();
          highlight(true);
        });
      });
      ["dragleave", "drop"].forEach((ev) => {
        dropZone.addEventListener(ev, (e) => {
          e.preventDefault();
          highlight(false);
        });
      });
      dropZone.addEventListener("drop", (e) => {
        const file = e.dataTransfer?.files?.[0];
        if (file) void ingestFile(file);
      });
    }

    refreshUi();

    return {
      getDataUrl: () => dataUrl,
      setDataUrl: (url) => {
        dataUrl = url || "";
        refreshUi();
      },
      hasSignature: () => !!dataUrl,
      clear: () => setSignature(""),
    };
  }

  global.NcTimesheetSignature = { init: initSignatureCapture };
})(window);
