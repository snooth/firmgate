/**
 * Local WebRTC voice calls for Team Chat (signaling via /intranet/api/chat/rooms/:id/call/*).
 */
(function () {
  const POLL_MS = 800;
  const HEARTBEAT_MS = 25000;
  const START_TIMEOUT_MS = 20000;
  const MIC_TIMEOUT_MS = 12000;

  let active = false;
  let starting = false;
  let roomId = null;
  let meId = null;
  let meName = "";
  let lastSignalId = 0;
  let pollTimer = null;
  let heartbeatTimer = null;
  let localStream = null;
  let micRequest = null;
  let muted = false;
  let onCloseCb = null;

  /** @type {Map<number, { pc: RTCPeerConnection, audio: HTMLAudioElement, name: string, makingOffer: boolean, ignoreOffer: boolean }>} */
  const peers = new Map();

  const statusEl = () => document.getElementById("tc-call-status");
  const participantsEl = () => document.getElementById("tc-call-participants");
  const muteBtn = () => document.getElementById("tc-call-mute");

  function iceServers() {
    const root = document.getElementById("nc-team-chat-root");
    const stun = root && root.getAttribute("data-webrtc-stun");
    if (stun && String(stun).trim()) {
      return [{ urls: String(stun).trim() }];
    }
    return [{ urls: "stun:stun.l.google.com:19302" }];
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

  function renderParticipants() {
    const el = participantsEl();
    if (!el) return;
    const names = [{ id: meId, name: meName + " (you)", self: true }];
    peers.forEach((p, uid) => {
      names.push({ id: uid, name: p.name || `User ${uid}`, self: false });
    });
    el.innerHTML = names
      .map((n) => {
        const state = n.self ? (muted ? "muted" : "connected") : "connected";
        return `<li class="nc-tc-call-participant${n.self ? " nc-tc-call-participant--you" : ""}"><span class="nc-tc-call-participant-name">${escapeHtml(n.name)}</span><span class="nc-tc-call-participant-state">${escapeHtml(state)}</span></li>`;
      })
      .join("");
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function refreshStatusLine() {
    if (!active) return;
    setStatus(peers.size ? "Connected" : "In call — waiting for others to join");
  }

  async function postSignal(kind, toUserId, payload) {
    const body = { kind, payload: payload || {} };
    if (toUserId != null) body.to_user_id = toUserId;
    await api(`/intranet/api/chat/rooms/${encodeURIComponent(String(roomId))}/call/signals`, {
      method: "POST",
      body: JSON.stringify(body),
    });
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
    const host = document.getElementById("tc-call-remote-audio");
    if (host) host.appendChild(audio);

    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    entry = { pc, audio, name: remoteName || `User ${remoteId}`, makingOffer: false, ignoreOffer: false };
    peers.set(remoteId, entry);

    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      postSignal("ice", remoteId, { candidate: ev.candidate.toJSON() }).catch(() => {});
    };

    pc.ontrack = (ev) => {
      if (ev.streams && ev.streams[0]) {
        audio.srcObject = ev.streams[0];
      } else if (ev.track) {
        audio.srcObject = new MediaStream([ev.track]);
      }
      audio.play().catch(() => {});
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
      await postSignal("offer", remoteId, { sdp });
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
      await postSignal("answer", fromId, { sdp });
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
    if (!active || !roomId) return;
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
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = window.setInterval(() => pollSignals().catch(() => {}), POLL_MS);
    if (heartbeatTimer) window.clearInterval(heartbeatTimer);
    heartbeatTimer = window.setInterval(() => {
      postSignal("join", null, { name: meName }).catch(() => {});
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

  function requestMicrophone() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
      return Promise.reject(new Error("Microphone not supported in this browser. Use HTTPS or localhost."));
    }
    const ac = new AbortController();
    micRequest = ac;
    const timer = window.setTimeout(() => ac.abort(), MIC_TIMEOUT_MS);
    return navigator.mediaDevices
      .getUserMedia({ audio: true, video: false })
      .then((stream) => {
        window.clearTimeout(timer);
        micRequest = null;
        return stream;
      })
      .catch((err) => {
        window.clearTimeout(timer);
        micRequest = null;
        if (err && err.name === "AbortError") {
          throw new Error("Microphone permission timed out. Check browser permissions and try again.");
        }
        throw err;
      });
  }

  async function startInner(opts) {
    if (active) await end(true);

    roomId = opts && opts.roomId != null ? Number(opts.roomId) : null;
    meId = opts && opts.meId != null ? Number(opts.meId) : null;
    meName = (opts && opts.meName) || "You";
    onCloseCb = opts && opts.onClose;
    lastSignalId = 0;
    muted = false;

    if (!roomId || !Number.isFinite(meId)) {
      setStatus("No chat selected.");
      return false;
    }

    setStatus("Requesting microphone…");
    try {
      localStream = await requestMicrophone();
    } catch (e) {
      setStatus(String(e.message || e) || "Microphone access denied.");
      return false;
    }

    active = true;
    renderParticipants();

    try {
      await postSignal("join", null, { name: meName });
    } catch (e) {
      setStatus(String(e.message || e) || "Could not join call.");
      await end(true);
      return false;
    }

    startPolling();
    refreshStatusLine();
    pollSignals().catch(() => {});
    syncExistingParticipants().catch(() => {});
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
    if (micRequest) {
      try {
        micRequest.abort();
      } catch (_) {}
      micRequest = null;
    }
    const notify = !skipNotify;
    active = false;
    stopPolling();
    const rid = roomId;
    const mid = meId;
    if (rid && mid) {
      try {
        await postSignal("leave", null, {});
      } catch (_) {}
    }
    peers.forEach((_, uid) => removePeer(uid));
    peers.clear();
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    roomId = null;
    meId = null;
    lastSignalId = 0;
    muted = false;
    const mb = muteBtn();
    if (mb) {
      mb.textContent = "Mute";
      mb.classList.remove("is-active");
    }
    const host = document.getElementById("tc-call-remote-audio");
    if (host) host.innerHTML = "";
    if (participantsEl()) participantsEl().innerHTML = "";
    if (!skipNotify) setStatus("");
    if (notify && typeof onCloseCb === "function") {
      const cb = onCloseCb;
      onCloseCb = null;
      cb();
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

  function wireControls() {
    const mb = muteBtn();
    if (mb && !mb.dataset.wired) {
      mb.dataset.wired = "1";
      mb.addEventListener("click", (e) => {
        e.preventDefault();
        toggleMute();
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
  }

  wireControls();

  window.ncTeamChatCall = {
    start,
    end: (skipNotify) => end(!!skipNotify),
    hangUp: () => end(false),
    isActive: () => active || starting,
    toggleMute,
  };
})();
