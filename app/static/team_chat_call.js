/**
 * Team Chat WebRTC calls — Socket.IO or HTTP signaling via intranet signaling settings.
 */
(function () {
  const POLL_MS = 800;
  const HEARTBEAT_MS = 25000;
  const START_TIMEOUT_MS = 25000;
  const MEDIA_TIMEOUT_MS = 15000;
  const SOCKET_TIMEOUT_MS = 10000;

  let active = false;
  let starting = false;
  let roomId = null;
  let meId = null;
  let meName = "";
  let wantVideo = false;
  let cameraOff = false;
  let lastSignalId = 0;
  let pollTimer = null;
  let heartbeatTimer = null;
  let localStream = null;
  let mediaRequest = null;
  let muted = false;
  let onCloseCb = null;
  let socket = null;
  let useSocket = false;
  let embedded = false;
  let screenSharing = false;
  let screenTrack = null;
  let savedCameraTrack = null;

  /** @type {Map<number, { pc: RTCPeerConnection, audio: HTMLAudioElement, video: HTMLVideoElement|null, tile: HTMLElement|null, name: string, makingOffer: boolean, ignoreOffer: boolean }>} */
  const peers = new Map();

  const statusEl = () => document.getElementById("tc-call-status");
  const participantsEl = () => document.getElementById("tc-call-participants");
  const muteBtn = () => document.getElementById("tc-call-mute");
  const cameraBtn = () => document.getElementById("tc-call-camera");
  const localVideoEl = () => document.getElementById("tc-call-local-video");
  const remoteVideoHost = () => document.getElementById("tc-call-remote-video");
  const videoStageEl = () => document.getElementById("tc-call-video-stage");
  const videoWrapEl = () => document.getElementById("tc-call-video-wrap");
  const screenShareBtn = () => document.getElementById("tc-call-screenshare");
  const fullscreenBtn = () => document.getElementById("tc-call-fullscreen");
  const embedBtn = () => document.getElementById("tc-call-embed");

  function readSignalingConfig() {
    const root = document.getElementById("nc-team-chat-root");
    if (!root) {
      return {
        enabled: false,
        voice: true,
        video: true,
        maxParticipants: 40,
        useSocketSignaling: true,
        httpFallback: true,
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      };
    }
    let ice = [];
    try {
      ice = JSON.parse(root.getAttribute("data-ice-servers") || "[]");
    } catch (_) {
      ice = [];
    }
    const stun = root.getAttribute("data-webrtc-stun");
    if (!ice.length && stun && String(stun).trim()) {
      ice = [{ urls: String(stun).trim() }];
    }
    if (!ice.length) {
      ice = [{ urls: "stun:stun.l.google.com:19302" }];
    }
    return {
      enabled: root.getAttribute("data-signaling-enabled") === "1",
      voice: root.getAttribute("data-signaling-voice") !== "0",
      video: root.getAttribute("data-signaling-video") !== "0",
      maxParticipants: parseInt(root.getAttribute("data-signaling-max") || "40", 10) || 40,
      useSocketSignaling: root.getAttribute("data-signaling-socket") !== "0",
      httpFallback: root.getAttribute("data-signaling-http-fallback") !== "0",
      iceServers: ice,
    };
  }

  function iceServers() {
    return readSignalingConfig().iceServers;
  }

  function toSdpInit(desc) {
    if (!desc) return null;
    if (typeof desc === "string") return { type: "offer", sdp: desc };
    const type = desc.type;
    const sdp = desc.sdp;
    if (type && sdp) return { type, sdp };
    return null;
  }

  async function api(path, opts) {
    const r = await fetch(path, {
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      ...opts,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText || "Request failed");
    return j;
  }

  function setStatus(msg) {
    const el = statusEl();
    if (el) el.textContent = msg || "";
  }

  function isPolite(localId, remoteId) {
    return Number(localId) < Number(remoteId);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderParticipants() {
    const el = participantsEl();
    if (!el) return;
    const names = [{ id: meId, name: meName + " (you)", self: true }];
    peers.forEach((p, uid) => {
      names.push({ id: uid, name: p.name || `User ${uid}`, self: false });
    });
    el.innerHTML = names
      .map((n) => {
        let state = "connected";
        if (n.self) {
          if (muted) state = "muted";
          else if (wantVideo && cameraOff) state = "camera off";
        }
        return `<li class="nc-tc-call-participant${n.self ? " nc-tc-call-participant--you" : ""}"><span class="nc-tc-call-participant-name">${escapeHtml(n.name)}</span><span class="nc-tc-call-participant-state">${escapeHtml(state)}</span></li>`;
      })
      .join("");
  }

  function refreshStatusLine() {
    if (!active) return;
    setStatus(peers.size ? "Connected" : "In call — waiting for others to join");
  }

  async function postSignalHttp(kind, toUserId, payload) {
    const body = { kind, payload: payload || {} };
    if (toUserId != null) body.to_user_id = toUserId;
    await api(`/intranet/api/chat/rooms/${encodeURIComponent(String(roomId))}/call/signals`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  function emitSignal(kind, toUserId, payload) {
    if (useSocket && socket && socket.connected) {
      socket.emit("call_signal", {
        kind,
        to_user_id: toUserId != null ? toUserId : undefined,
        payload: payload || {},
      });
      return Promise.resolve();
    }
    return postSignalHttp(kind, toUserId, payload);
  }

  function connectSocket() {
    const cfg = readSignalingConfig();
    if (!cfg.useSocketSignaling || typeof window.io !== "function") {
      return Promise.reject(new Error("Socket.IO signaling unavailable"));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const s = window.io("/chat-signaling", {
        transports: ["websocket", "polling"],
        withCredentials: true,
      });
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          s.disconnect();
        } catch (_) {}
        reject(new Error("Signaling server connection timed out."));
      }, SOCKET_TIMEOUT_MS);

      s.on("connect", () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        s.on("call_signal", (sig) => {
          if (sig && typeof sig === "object") handleSignal(sig).catch(() => {});
        });
        s.on("call_error", (err) => {
          const msg = (err && err.error) || "Call signaling error.";
          setStatus(msg);
        });
        resolve(s);
      });

      s.on("connect_error", (err) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        reject(err || new Error("Could not connect to signaling server."));
      });
    });
  }

  function syncVideoChrome() {
    const show = wantVideo;
    const stage = videoStageEl();
    const wrap = videoWrapEl();
    if (stage) stage.hidden = !show;
    if (wrap) wrap.hidden = !show;
    const fs = fullscreenBtn();
    const ss = screenShareBtn();
    const emb = embedBtn();
    if (fs) fs.hidden = !show;
    if (ss) ss.hidden = !show;
    if (emb) emb.hidden = !show || embedded;
  }

  function isVideoFullscreen() {
    const stage = videoStageEl();
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    return !!(stage && fsEl === stage);
  }

  function syncFullscreenButton() {
    const btn = fullscreenBtn();
    if (btn) {
      btn.classList.toggle("is-active", isVideoFullscreen());
      btn.textContent = isVideoFullscreen() ? "Exit full screen" : "Full screen";
    }
  }

  async function replaceLocalVideoTrack(track) {
    if (!localStream) return;
    localStream.getVideoTracks().forEach((t) => {
      if (t !== track && t !== savedCameraTrack) {
        try {
          t.stop();
        } catch (_) {}
      }
      try {
        localStream.removeTrack(t);
      } catch (_) {}
    });
    if (track) {
      try {
        localStream.addTrack(track);
      } catch (_) {}
    }
    for (const [, entry] of peers) {
      const sender = entry.pc.getSenders().find((s) => s.track && s.track.kind === "video");
      if (sender) {
        await sender.replaceTrack(track);
      } else if (track) {
        entry.pc.addTrack(track, localStream);
      }
    }
    attachLocalPreview();
  }

  function restorePanelToDialog() {
    const panel = document.getElementById("tc-call-panel");
    const slot = document.getElementById("tc-call-body-slot");
    const dock = document.getElementById("tc-call-embed-dock");
    const mid = document.querySelector(".nc-tc-mid");
    if (panel && slot && panel.parentElement !== slot) slot.appendChild(panel);
    if (dock) dock.hidden = true;
    mid?.classList.remove("has-embedded-call");
    embedded = false;
    syncVideoChrome();
  }

  function embedInChat() {
    if (!wantVideo || !active) return;
    const panel = document.getElementById("tc-call-panel");
    const dockBody = document.getElementById("tc-call-embed-body");
    const dock = document.getElementById("tc-call-embed-dock");
    const dialog = document.getElementById("tc-call-dialog");
    const mid = document.querySelector(".nc-tc-mid");
    if (!panel || !dockBody || !dock) return;
    dockBody.appendChild(panel);
    dock.hidden = false;
    mid?.classList.add("has-embedded-call");
    embedded = true;
    if (dialog?.open) dialog.close();
    syncVideoChrome();
    const title = document.getElementById("tc-call-title");
    const embedTitle = document.getElementById("tc-call-embed-title");
    if (embedTitle && title) embedTitle.textContent = title.textContent || "Video call";
  }

  function popOutCall() {
    if (!embedded) return;
    restorePanelToDialog();
    const dialog = document.getElementById("tc-call-dialog");
    if (dialog && typeof dialog.showModal === "function") {
      try {
        dialog.showModal();
      } catch (_) {}
    }
  }

  function attachLocalPreview() {
    const lv = localVideoEl();
    if (!lv) return;
    if (wantVideo && localStream) {
      lv.srcObject = localStream;
      lv.hidden = false;
      lv.play().catch(() => {});
    } else {
      lv.srcObject = null;
      lv.hidden = true;
    }
  }

  function getPeer(remoteId, remoteName) {
    let entry = peers.get(remoteId);
    if (entry) {
      if (remoteName) entry.name = remoteName;
      return entry;
    }

    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.playsInline = true;
    const audioHost = document.getElementById("tc-call-remote-audio");
    if (audioHost) audioHost.appendChild(audio);

    let video = null;
    let tile = null;
    if (wantVideo) {
      tile = document.createElement("div");
      tile.className = "nc-tc-call-video-tile";
      video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      const label = document.createElement("span");
      label.className = "nc-tc-call-video-label";
      label.textContent = remoteName || `User ${remoteId}`;
      tile.appendChild(video);
      tile.appendChild(label);
      const host = remoteVideoHost();
      if (host) host.appendChild(tile);
    }

    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    entry = {
      pc,
      audio,
      video,
      tile,
      name: remoteName || `User ${remoteId}`,
      makingOffer: false,
      ignoreOffer: false,
    };
    peers.set(remoteId, entry);

    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      emitSignal("ice", remoteId, { candidate: ev.candidate.toJSON() }).catch(() => {});
    };

    pc.ontrack = (ev) => {
      const stream =
        ev.streams && ev.streams[0] ? ev.streams[0] : ev.track ? new MediaStream([ev.track]) : null;
      if (!stream) return;
      if (ev.track && ev.track.kind === "video" && entry.video) {
        entry.video.srcObject = stream;
        entry.video.play().catch(() => {});
      } else {
        audio.srcObject = stream;
        audio.play().catch(() => {});
      }
      refreshStatusLine();
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        removePeer(remoteId);
      }
      refreshStatusLine();
    };

    if (localStream) {
      localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
    }

    renderParticipants();
    return entry;
  }

  function removePeer(remoteId) {
    const entry = peers.get(remoteId);
    if (!entry) return;
    try {
      entry.pc.close();
    } catch (_) {}
    try {
      entry.audio.remove();
    } catch (_) {}
    try {
      if (entry.tile) entry.tile.remove();
    } catch (_) {}
    peers.delete(remoteId);
    renderParticipants();
    refreshStatusLine();
  }

  async function createOffer(remoteId, remoteName) {
    const entry = getPeer(remoteId, remoteName);
    if (!isPolite(meId, remoteId)) return;
    if (entry.pc.signalingState !== "stable") return;
    try {
      entry.makingOffer = true;
      const offer = await entry.pc.createOffer();
      await entry.pc.setLocalDescription(offer);
      const sdp = toSdpInit(entry.pc.localDescription);
      if (!sdp) throw new Error("invalid local offer");
      await emitSignal("offer", remoteId, { sdp });
    } catch (e) {
      console.warn("offer failed", e);
    } finally {
      entry.makingOffer = false;
    }
  }

  async function handleOffer(fromId, fromName, payload) {
    const init = toSdpInit(payload && payload.sdp);
    if (!init) return;
    const entry = getPeer(fromId, fromName);
    const polite = isPolite(meId, fromId);
    const offerCollision = entry.makingOffer || entry.pc.signalingState !== "stable";
    entry.ignoreOffer = !polite && offerCollision;
    if (entry.ignoreOffer) return;
    try {
      await entry.pc.setRemoteDescription(init);
      const answer = await entry.pc.createAnswer();
      await entry.pc.setLocalDescription(answer);
      const sdp = toSdpInit(entry.pc.localDescription);
      if (!sdp) throw new Error("invalid local answer");
      await emitSignal("answer", fromId, { sdp });
    } catch (e) {
      console.warn("answer failed", e);
    }
  }

  async function handleAnswer(fromId, payload) {
    const init = toSdpInit(payload && payload.sdp);
    if (!init) return;
    const entry = peers.get(fromId);
    if (!entry) return;
    try {
      await entry.pc.setRemoteDescription(init);
    } catch (e) {
      console.warn("set answer failed", e);
    }
  }

  async function handleIce(fromId, payload) {
    const c = payload && payload.candidate;
    if (!c) return;
    const entry = peers.get(fromId);
    if (!entry) return;
    try {
      await entry.pc.addIceCandidate(c);
    } catch (e) {
      console.warn("ice failed", e);
    }
  }

  async function handleSignal(sig) {
    const fromId = Number(sig.from_user_id);
    if (!fromId || fromId === meId) return;
    const name = sig.from_name || `User ${fromId}`;
    const kind = sig.kind;
    const payload = sig.payload || {};

    if (kind === "join") {
      await createOffer(fromId, name);
      return;
    }
    if (kind === "leave") {
      removePeer(fromId);
      return;
    }
    if (kind === "offer") {
      await handleOffer(fromId, name, payload);
      return;
    }
    if (kind === "answer") {
      await handleAnswer(fromId, payload);
      return;
    }
    if (kind === "ice") {
      await handleIce(fromId, payload);
    }
  }

  async function pollSignals() {
    if (!active || !roomId || useSocket) return;
    try {
      const j = await api(
        `/intranet/api/chat/rooms/${encodeURIComponent(String(roomId))}/call/signals?after_id=${encodeURIComponent(String(lastSignalId || 0))}`,
        { method: "GET" }
      );
      const signals = (j && j.signals) || [];
      for (let i = 0; i < signals.length && i < 80; i++) {
        const sig = signals[i];
        const idNum = Number(sig.id) || 0;
        if (idNum > lastSignalId) lastSignalId = idNum;
        await handleSignal(sig);
      }
      refreshStatusLine();
    } catch (e) {
      console.warn("call poll failed", e);
    }
  }

  async function syncExistingParticipants() {
    if (useSocket) return;
    try {
      const j = await api(
        `/intranet/api/chat/rooms/${encodeURIComponent(String(roomId))}/call/participants`,
        { method: "GET" }
      );
      const list = (j && j.participants) || [];
      for (const p of list) {
        const uid = Number(p.user_id);
        if (!uid || uid === meId) continue;
        await createOffer(uid, p.name || `User ${uid}`);
      }
    } catch (e) {
      console.warn("participants sync failed", e);
    }
  }

  function startPolling() {
    if (useSocket) return;
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = window.setInterval(() => pollSignals().catch(() => {}), POLL_MS);
    if (heartbeatTimer) window.clearInterval(heartbeatTimer);
    heartbeatTimer = window.setInterval(() => {
      emitSignal("join", null, { name: meName }).catch(() => {});
    }, HEARTBEAT_MS);
  }

  function stopPolling() {
    if (pollTimer) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
    if (heartbeatTimer) {
      window.clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function requestMedia(video) {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
      return Promise.reject(
        new Error(video ? "Camera not supported in this browser. Use HTTPS or localhost." : "Microphone not supported in this browser. Use HTTPS or localhost.")
      );
    }
    const ac = new AbortController();
    mediaRequest = ac;
    const timer = window.setTimeout(() => ac.abort(), MEDIA_TIMEOUT_MS);
    const constraints = {
      audio: true,
      video: video
        ? { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }
        : false,
    };
    return navigator.mediaDevices
      .getUserMedia(constraints)
      .then((stream) => {
        window.clearTimeout(timer);
        mediaRequest = null;
        return stream;
      })
      .catch((err) => {
        window.clearTimeout(timer);
        mediaRequest = null;
        if (err && err.name === "AbortError") {
          throw new Error(
            video
              ? "Camera permission timed out. Check browser permissions and try again."
              : "Microphone permission timed out. Check browser permissions and try again."
          );
        }
        throw err;
      });
  }

  async function joinSignaling() {
    const cfg = readSignalingConfig();
    useSocket = false;

    if (cfg.useSocketSignaling) {
      try {
        socket = await connectSocket();
        useSocket = true;
        await new Promise((resolve, reject) => {
          const timer = window.setTimeout(() => reject(new Error("Join call timed out.")), 8000);
          socket.emit("call_join", { room_id: roomId, name: meName });
          socket.once("call_joined", () => {
            window.clearTimeout(timer);
            resolve();
          });
          socket.once("call_error", (err) => {
            window.clearTimeout(timer);
            reject(new Error((err && err.error) || "Could not join call."));
          });
        });
        return;
      } catch (e) {
        if (socket) {
          try {
            socket.disconnect();
          } catch (_) {}
          socket = null;
        }
        useSocket = false;
        if (!cfg.httpFallback) throw e;
        console.warn("socket signaling failed, using HTTP fallback", e);
      }
    }

    if (!cfg.httpFallback) {
      throw new Error("Signaling transport unavailable.");
    }
    await postSignalHttp("join", null, { name: meName });
  }

  async function startInner(opts) {
    if (active) await end(true);

    const cfg = readSignalingConfig();
    roomId = opts && opts.roomId != null ? Number(opts.roomId) : null;
    meId = opts && opts.meId != null ? Number(opts.meId) : null;
    meName = (opts && opts.meName) || "You";
    wantVideo = !!(opts && opts.video);
    onCloseCb = opts && opts.onClose;
    lastSignalId = 0;
    muted = false;
    cameraOff = false;

    if (!roomId || !Number.isFinite(meId)) {
      setStatus("No chat selected.");
      return false;
    }

    if (cfg.enabled) {
      if (wantVideo && !cfg.video) {
        setStatus("Video calls are disabled by your administrator.");
        return false;
      }
      if (!wantVideo && !cfg.voice) {
        setStatus("Voice calls are disabled by your administrator.");
        return false;
      }
    }

    setStatus(wantVideo ? "Requesting camera and microphone…" : "Requesting microphone…");
    try {
      localStream = await requestMedia(wantVideo);
      if (wantVideo && localStream) {
        savedCameraTrack = localStream.getVideoTracks()[0] || null;
      }
    } catch (e) {
      if (wantVideo) {
        setStatus("Camera unavailable — trying audio only…");
        try {
          wantVideo = false;
          localStream = await requestMedia(false);
        } catch (err) {
          setStatus(String(err.message || err) || "Microphone access denied.");
          return false;
        }
      } else {
        setStatus(String(e.message || e) || "Microphone access denied.");
        return false;
      }
    }

    attachLocalPreview();
    syncVideoChrome();
    active = true;
    renderParticipants();

    try {
      await joinSignaling();
    } catch (e) {
      setStatus(String(e.message || e) || "Could not join call.");
      await end(true);
      return false;
    }

    startPolling();
    refreshStatusLine();
    if (!useSocket) {
      pollSignals().catch(() => {});
      syncExistingParticipants().catch(() => {});
    }
    return true;
  }

  async function start(opts) {
    if (starting) return false;
    starting = true;
    try {
      const work = startInner(opts);
      const timeout = new Promise((_, reject) => {
        window.setTimeout(() => reject(new Error("Call setup timed out. Close and try again.")), START_TIMEOUT_MS);
      });
      return await Promise.race([work, timeout]);
    } catch (e) {
      setStatus(String(e.message || e) || "Call failed.");
      await end(true);
      return false;
    } finally {
      starting = false;
    }
  }

  async function end(skipNotify) {
    starting = false;
    if (mediaRequest) {
      try {
        mediaRequest.abort();
      } catch (_) {}
      mediaRequest = null;
    }
    const notify = !skipNotify;
    active = false;
    stopPolling();

    const wasSocket = useSocket;
    if (socket) {
      try {
        socket.emit("call_leave");
        socket.disconnect();
      } catch (_) {}
      socket = null;
    }
    useSocket = false;

    if (roomId && meId && !wasSocket) {
      try {
        await postSignalHttp("leave", null, {});
      } catch (_) {}
    }

    peers.forEach((_, uid) => removePeer(uid));
    peers.clear();

    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }

    if (screenTrack) {
      try {
        screenTrack.stop();
      } catch (_) {}
      screenTrack = null;
    }
    screenSharing = false;
    savedCameraTrack = null;
    if (isVideoFullscreen()) {
      try {
        if (document.exitFullscreen) document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      } catch (_) {}
    }
    restorePanelToDialog();

    const lv = localVideoEl();
    if (lv) {
      lv.srcObject = null;
      lv.hidden = true;
    }

    roomId = null;
    meId = null;
    lastSignalId = 0;
    muted = false;
    cameraOff = false;
    wantVideo = false;

    const mb = muteBtn();
    if (mb) {
      mb.textContent = "Mute";
      mb.classList.remove("is-active");
    }
    const cb = cameraBtn();
    if (cb) {
      cb.textContent = "Camera off";
      cb.classList.remove("is-active");
    }
    const ss = screenShareBtn();
    if (ss) {
      ss.textContent = "Share screen";
      ss.classList.remove("is-active");
    }
    syncFullscreenButton();

    const audioHost = document.getElementById("tc-call-remote-audio");
    if (audioHost) audioHost.innerHTML = "";
    const videoHost = remoteVideoHost();
    if (videoHost) videoHost.innerHTML = "";
    if (participantsEl()) participantsEl().innerHTML = "";

    if (!skipNotify) setStatus("");
    if (notify && typeof onCloseCb === "function") {
      const cbFn = onCloseCb;
      onCloseCb = null;
      cbFn();
    }
  }

  function toggleMute() {
    if (!localStream) return muted;
    muted = !muted;
    localStream.getAudioTracks().forEach((t) => {
      t.enabled = !muted;
    });
    const mb = muteBtn();
    if (mb) {
      mb.textContent = muted ? "Unmute" : "Mute";
      mb.classList.toggle("is-active", muted);
    }
    renderParticipants();
    return muted;
  }

  function toggleCamera() {
    if (!localStream || !wantVideo) return cameraOff;
    cameraOff = !cameraOff;
    localStream.getVideoTracks().forEach((t) => {
      t.enabled = !cameraOff;
    });
    const lv = localVideoEl();
    if (lv) lv.style.opacity = cameraOff ? "0.15" : "1";
    const cb = cameraBtn();
    if (cb) {
      cb.textContent = cameraOff ? "Camera on" : "Camera off";
      cb.classList.toggle("is-active", cameraOff);
    }
    renderParticipants();
    return cameraOff;
  }

  async function toggleScreenShare() {
    if (!wantVideo || !active) return screenSharing;
    const btn = screenShareBtn();
    if (screenSharing) {
      if (screenTrack) {
        try {
          screenTrack.stop();
        } catch (_) {}
        screenTrack = null;
      }
      screenSharing = false;
      const restore =
        savedCameraTrack && savedCameraTrack.readyState === "live" && !cameraOff ? savedCameraTrack : null;
      if (restore) {
        await replaceLocalVideoTrack(restore);
      } else {
        await replaceLocalVideoTrack(null);
      }
      if (btn) {
        btn.textContent = "Share screen";
        btn.classList.remove("is-active");
      }
      return false;
    }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== "function") {
      setStatus("Screen sharing is not supported in this browser.");
      return false;
    }
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      screenTrack = display.getVideoTracks()[0] || null;
      if (!screenTrack) return false;
      if (!savedCameraTrack && localStream) {
        savedCameraTrack = localStream.getVideoTracks()[0] || null;
      }
      screenTrack.onended = () => {
        if (screenSharing) void toggleScreenShare();
      };
      await replaceLocalVideoTrack(screenTrack);
      screenSharing = true;
      if (btn) {
        btn.textContent = "Stop sharing";
        btn.classList.add("is-active");
      }
      return true;
    } catch (e) {
      if (!e || e.name !== "NotAllowedError") {
        setStatus("Could not share screen.");
      }
      return false;
    }
  }

  function toggleFullscreen() {
    const stage = videoStageEl();
    if (!stage || !wantVideo) return;
    if (isVideoFullscreen()) {
      try {
        if (document.exitFullscreen) document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      } catch (_) {}
      syncFullscreenButton();
      return;
    }
    try {
      const req = stage.requestFullscreen ? stage.requestFullscreen() : stage.webkitRequestFullscreen?.();
      if (req && typeof req.then === "function") {
        req.then(syncFullscreenButton).catch(() => {});
      } else {
        syncFullscreenButton();
      }
    } catch (_) {
      setStatus("Full screen is not available.");
    }
  }

  function wireControls() {
    const mb = muteBtn();
    if (mb && !mb.dataset.wired) {
      mb.dataset.wired = "1";
      mb.addEventListener("click", (e) => {
        e.preventDefault();
        toggleMute();
      });
    }
    const cb = cameraBtn();
    if (cb && !cb.dataset.wired) {
      cb.dataset.wired = "1";
      cb.addEventListener("click", (e) => {
        e.preventDefault();
        toggleCamera();
      });
    }
    const hang = document.getElementById("tc-call-hangup");
    if (hang && !hang.dataset.wired) {
      hang.dataset.wired = "1";
      hang.addEventListener("click", (e) => {
        e.preventDefault();
        end(false);
      });
    }
    const fs = fullscreenBtn();
    if (fs && !fs.dataset.wired) {
      fs.dataset.wired = "1";
      fs.addEventListener("click", (e) => {
        e.preventDefault();
        toggleFullscreen();
      });
    }
    const ss = screenShareBtn();
    if (ss && !ss.dataset.wired) {
      ss.dataset.wired = "1";
      ss.addEventListener("click", (e) => {
        e.preventDefault();
        void toggleScreenShare();
      });
    }
    const emb = embedBtn();
    if (emb && !emb.dataset.wired) {
      emb.dataset.wired = "1";
      emb.addEventListener("click", (e) => {
        e.preventDefault();
        embedInChat();
      });
    }
    const pop = document.getElementById("tc-call-popout");
    if (pop && !pop.dataset.wired) {
      pop.dataset.wired = "1";
      pop.addEventListener("click", (e) => {
        e.preventDefault();
        popOutCall();
      });
    }
    const embLeave = document.getElementById("tc-call-embed-leave");
    if (embLeave && !embLeave.dataset.wired) {
      embLeave.dataset.wired = "1";
      embLeave.addEventListener("click", (e) => {
        e.preventDefault();
        end(false);
      });
    }
    if (!document.documentElement.dataset.tcCallFsWired) {
      document.documentElement.dataset.tcCallFsWired = "1";
      document.addEventListener("fullscreenchange", syncFullscreenButton);
      document.addEventListener("webkitfullscreenchange", syncFullscreenButton);
    }
  }

  wireControls();

  window.ncTeamChatCall = {
    start,
    end: (skipNotify) => end(!!skipNotify),
    hangUp: () => end(false),
    isActive: () => active || starting,
    isEmbedded: () => embedded,
    toggleMute,
    toggleCamera,
    toggleScreenShare,
    toggleFullscreen,
    embedInChat,
    popOutCall,
  };
})();
