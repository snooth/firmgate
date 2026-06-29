(function () {
  "use strict";

  const G = (window.__ncSipPhone ??= {
    ua: null,
    registered: false,
    iceServers: [],
    activeSession: null,
    pendingSession: null,
    callHasVideo: false,
    ui: null,
  });

  function formatCallFailure(ev) {
    const msg = ev?.message;
    const code = msg?.status_code;
    const phrase = (msg?.reason_phrase || "").trim();
    const cause = (ev?.cause || "unknown").trim();
    if (code) {
      const base = `Call failed: ${code}${phrase ? ` ${phrase}` : cause ? ` (${cause})` : ""}`;
      if (code === 403) return `${base} — check outbound permissions for this extension on the PBX.`;
      if (code === 404) return `${base} — number or route not found on the PBX.`;
      if (code === 484) return `${base} — invalid number format for your dial plan.`;
      if (code === 603) return `${base} — call declined by the PBX or destination.`;
      return base;
    }
    return cause ? `Call failed: ${cause}` : "Call failed.";
  }

  function jssipSrc() {
    return (
      document.getElementById("nc-phone-app")?.getAttribute("data-jssip-src") ||
      document.getElementById("nc-sip-dial-root")?.getAttribute("data-jssip-src") ||
      "/static/jssip.min.js"
    );
  }

  function $id(...ids) {
    for (let i = 0; i < ids.length; i += 1) {
      const node = document.getElementById(ids[i]);
      if (node) return node;
    }
    return null;
  }

  function ensureJsSIP() {
    if (typeof window.JsSIP !== "undefined") return Promise.resolve(true);
    return new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-jssip-bundle="1"]');
      if (existing) {
        existing.addEventListener("load", () => resolve(typeof window.JsSIP !== "undefined"));
        existing.addEventListener("error", () => reject(new Error("JsSIP failed to load")));
        return;
      }
      const script = document.createElement("script");
      script.src = jssipSrc();
      script.dataset.jssipBundle = "1";
      script.onload = () => {
        if (typeof window.JsSIP !== "undefined") resolve(true);
        else reject(new Error("JsSIP loaded but is unavailable"));
      };
      script.onerror = () => reject(new Error("JsSIP failed to load"));
      document.head.appendChild(script);
    });
  }

  function initPhone() {
    const app = document.getElementById("nc-phone-app");
    const dialPopover = document.getElementById("nc-sip-dial-popover");
    if (!app && !dialPopover) return;
    G.sipClientInit = true;

    // Turbo Drive swaps page content on navigation, so the dial input, keypad
    // and Call button are recreated each time we land back on the Phone page.
    // Bind handlers idempotently (per element) so the current DOM is always
    // wired without double-binding when initPhone runs more than once.
    const bind = (el, type, handler) => {
      if (!el) return;
      const key = `__ncw_${type}`;
      if (el[key]) return;
      el[key] = true;
      el.addEventListener(type, handler);
    };
    const bindAll = (selector, type, handler) => {
      document.querySelectorAll(selector).forEach((el) => bind(el, type, handler));
    };

    const popoverDialInput = document.getElementById("nc-sip-popover-dial-input");
    const statusDot = $id("nc-phone-status-dot", "nc-sip-popover-status-dot");
    const statusText = $id("nc-phone-status-text", "nc-sip-popover-status-text");
    const extEl = $id("nc-phone-extension", "nc-sip-popover-extension");
    const passEl = $id("nc-phone-password", "nc-sip-popover-password");
    const nameEl = $id("nc-phone-display-name", "nc-sip-popover-display-name");
    const credsStatus = $id("nc-phone-creds-status", "nc-sip-popover-creds-status");
    const credsForm = $id("nc-phone-creds-form", "nc-sip-popover-creds-form");
    const registerBtn = $id("nc-phone-register-btn", "nc-sip-popover-register-btn");
    const unregisterBtn = $id("nc-phone-unregister-btn", "nc-sip-popover-unregister-btn");
    const dialInput = document.getElementById("nc-phone-dial-input");
    const callBtn = $id("nc-phone-call-btn", "nc-sip-popover-call-btn");
    const hangupBtn = $id("nc-phone-hangup-btn", "nc-sip-popover-hangup-btn");
    const muteBtn = document.getElementById("nc-phone-mute-btn");
    const callStatus = $id("nc-phone-call-status", "nc-sip-popover-call-status");
    const incomingWrap = $id("nc-phone-incoming", "nc-sip-global-incoming");
    const incomingFrom = $id("nc-phone-incoming-from", "nc-sip-global-incoming-from");
    const answerBtn = $id("nc-phone-answer-btn", "nc-sip-global-answer-btn");
    const rejectBtn = $id("nc-phone-reject-btn", "nc-sip-global-reject-btn");
    const remoteAudio = $id("nc-phone-remote-audio", "nc-sip-global-remote-audio");
    const backspaceBtn = $id("nc-phone-backspace", "nc-sip-popover-backspace");
    const extBtn = $id("nc-phone-ext-btn", "nc-sip-popover-ext-btn");
    const extPopover = $id("nc-phone-ext-popover", "nc-sip-popover-ext-popover");
    const extClose = document.getElementById("nc-phone-ext-close");
    const dialPopoverClose = document.getElementById("nc-sip-dial-popover-close");
    const videoBtn = document.getElementById("nc-phone-video-btn");
    const camBtn = document.getElementById("nc-phone-cam-btn");
    const fullscreenBtn = document.getElementById("nc-phone-fullscreen-btn");
    const videoCard = app ? app.querySelector(".nc-phone-video") : null;
    const videoScreen = document.getElementById("nc-phone-video-screen");
    const videoBar = document.getElementById("nc-phone-video-bar");
    const remoteVideo = document.getElementById("nc-phone-remote-video");
    const localVideo = document.getElementById("nc-phone-local-video");

    let callHasVideo = false;

    function activeDialInput() {
      if (dialPopover && !dialPopover.hidden && popoverDialInput) return popoverDialInput;
      return dialInput || popoverDialInput;
    }

    function openDialPopover() {
      if (!dialPopover) return;
      dialPopover.hidden = false;
      (popoverDialInput || dialInput)?.focus();
    }

    function closeDialPopover() {
      if (!dialPopover) return;
      dialPopover.hidden = true;
      if (extPopover) extPopover.hidden = true;
      extBtn?.setAttribute("aria-expanded", "false");
    }

    function syncAllStatus(state, text) {
      document.querySelectorAll("#nc-phone-status-dot, #nc-sip-popover-status-dot").forEach((dot) => {
        dot.dataset.state = state;
      });
      document.querySelectorAll("#nc-phone-status-text, #nc-sip-popover-status-text").forEach((el) => {
        el.textContent = text;
      });
    }

    function syncAllCredsStatus(msg) {
      document.querySelectorAll("#nc-phone-creds-status, #nc-sip-popover-creds-status").forEach((el) => {
        el.textContent = msg || "";
      });
    }

    function syncAllCallStatus(msg) {
      document.querySelectorAll("#nc-phone-call-status, #nc-sip-popover-call-status").forEach((el) => {
        el.textContent = msg || "";
      });
    }

    G.ui = {
      setStatus,
      setCredsStatus,
      setCallStatus,
      updateCallButtons,
      showIncoming,
      hideIncoming,
      get callHasVideo() {
        return callHasVideo;
      },
      set callHasVideo(v) {
        callHasVideo = !!v;
      },
      els: {
        statusDot,
        statusText,
        credsStatus,
        callStatus,
        incomingWrap,
        incomingFrom,
        remoteAudio,
        remoteVideo,
        localVideo,
        videoScreen,
        videoBar,
        hangupBtn,
        muteBtn,
        camBtn,
        callBtn,
        videoBtn,
        unregisterBtn,
        registerBtn,
      },
    };

    function isFullscreen() {
      return !!(document.fullscreenElement || document.webkitFullscreenElement);
    }

    function exitFullscreen() {
      try {
        if (document.exitFullscreen) document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      } catch (_) {
        /* ignore */
      }
    }

    function syncFullscreenButton() {
      const fs = isFullscreen();
      const open = fullscreenBtn?.querySelector(".nc-phone-fs-icon-open");
      const close = fullscreenBtn?.querySelector(".nc-phone-fs-icon-close");
      if (open) open.hidden = fs;
      if (close) close.hidden = !fs;
      if (fullscreenBtn) {
        fullscreenBtn.title = fs ? "Exit full screen" : "Full screen";
        fullscreenBtn.setAttribute("aria-label", fullscreenBtn.title);
      }
    }

    function toggleFullscreen() {
      if (!videoCard) return;
      if (isFullscreen()) {
        exitFullscreen();
        return;
      }
      try {
        if (videoCard.requestFullscreen) videoCard.requestFullscreen();
        else if (videoCard.webkitRequestFullscreen) videoCard.webkitRequestFullscreen();
      } catch (_) {
        /* ignore */
      }
    }

    function showVideoStage(on) {
      callHasVideo = !!on;
      G.callHasVideo = callHasVideo;
      if (videoScreen) videoScreen.dataset.active = on ? "true" : "false";
      if (app) app.classList.toggle("is-video-call", !!on);
    }

    function clearVideo() {
      if (isFullscreen()) exitFullscreen();
      showVideoStage(false);
      if (remoteVideo) remoteVideo.srcObject = null;
      if (localVideo) localVideo.srcObject = null;
    }

    function streamFromSenders(pc) {
      const stream = new MediaStream();
      if (pc && typeof pc.getSenders === "function") {
        pc.getSenders().forEach((s) => {
          if (s.track) stream.addTrack(s.track);
        });
      }
      return stream;
    }

    function streamFromReceivers(pc) {
      const stream = new MediaStream();
      if (pc && typeof pc.getReceivers === "function") {
        pc.getReceivers().forEach((r) => {
          if (r.track) stream.addTrack(r.track);
        });
      }
      return stream;
    }

    function attachLocalStream(session) {
      try {
        const stream = streamFromSenders(session.connection);
        if (stream.getTracks().length && localVideo) localVideo.srcObject = stream;
      } catch (_) {
        /* ignore */
      }
    }

    function renderRemoteFromReceivers(session) {
      try {
        const stream = streamFromReceivers(session.connection);
        if (!stream.getTracks().length) return;
        const hasVideo = stream.getVideoTracks().length > 0;
        if (hasVideo) {
          showVideoStage(true);
          if (remoteVideo) {
            remoteVideo.srcObject = stream;
            playRemote(remoteVideo);
          }
          if (remoteAudio) remoteAudio.srcObject = null;
        } else if (remoteAudio) {
          remoteAudio.srcObject = stream;
          playRemote(remoteAudio);
        }
      } catch (_) {
        /* ignore */
      }
    }

    function toggleExtPopover(trigger) {
      const pop =
        trigger?.id === "nc-sip-popover-ext-btn"
          ? document.getElementById("nc-sip-popover-ext-popover")
          : extPopover;
      if (!pop) return;
      if (pop.hidden) {
        pop.hidden = false;
        trigger?.setAttribute("aria-expanded", "true");
        pop.querySelector('[id$="-extension"]')?.focus();
      } else {
        pop.hidden = true;
        trigger?.setAttribute("aria-expanded", "false");
      }
    }

    function setStatus(state, text) {
      syncAllStatus(state, text);
    }

    function setCredsStatus(msg) {
      syncAllCredsStatus(msg);
    }

    function setCallStatus(msg) {
      syncAllCallStatus(msg);
    }

    function updateCallButtons() {
      const onCall = !!(G.activeSession && !G.activeSession.isEnded());
      const input = activeDialInput();
      const hasNumber = !!(input?.value || "").trim();
      const canDial = G.registered && !onCall && !G.pendingSession;
      document.querySelectorAll("#nc-phone-call-btn, #nc-sip-popover-call-btn").forEach((btn) => {
        btn.disabled = !canDial || !hasNumber;
      });
      if (videoBtn) videoBtn.disabled = !canDial || !hasNumber;
      document.querySelectorAll("#nc-phone-hangup-btn, #nc-sip-popover-hangup-btn").forEach((btn) => {
        btn.hidden = !onCall;
      });
      if (muteBtn) muteBtn.hidden = !onCall;
      if (camBtn) camBtn.hidden = !onCall || !callHasVideo;
      if (fullscreenBtn) fullscreenBtn.hidden = !onCall || !callHasVideo;
      if (videoBar) videoBar.hidden = !onCall;
      document.querySelectorAll("#nc-phone-unregister-btn, #nc-sip-popover-unregister-btn").forEach((btn) => {
        btn.hidden = !G.registered;
      });
      document.querySelectorAll("#nc-phone-register-btn, #nc-sip-popover-register-btn").forEach((btn) => {
        btn.disabled = G.registered;
      });
    }

    function syncRegisteredUi() {
      if (G.registered || (G.ua && typeof G.ua.isRegistered === "function" && G.ua.isRegistered())) {
        G.registered = true;
        setStatus("online", "Registered");
        setCredsStatus("Registered with SIP server.");
      } else {
        setStatus("offline", "Offline");
      }
      updateCallButtons();
    }

    async function api(path, opts) {
      const r = await fetch(`/intranet/api${path}`, { credentials: "same-origin", ...opts });
      const j = await r.json().catch(() => ({}));
      return { r, j };
    }

    async function loadStatus() {
      const { r, j } = await api("/sip/status", { method: "GET" });
      if (!r.ok) return;
      document.querySelectorAll("#nc-phone-extension, #nc-sip-popover-extension").forEach((el) => {
        el.value = j.extension || "";
      });
      document.querySelectorAll("#nc-phone-display-name, #nc-sip-popover-display-name").forEach((el) => {
        el.value = j.display_name || "";
      });
      document.querySelectorAll("#nc-phone-password, #nc-sip-popover-password").forEach((el) => {
        el.value = "";
        el.placeholder = j.password_set ? "Leave blank to keep saved password" : "PBX extension password";
      });
      syncRegisteredUi();
      if (!G.registered && j.stay_registered && j.credentials_set) {
        await register({ auto: true });
      }
    }

    async function setStayRegistered(enabled) {
      await api("/sip/stay-registered", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !!enabled }),
      });
    }

    async function saveCredentials(ev) {
      if (ev) ev.preventDefault();
      const form = ev?.target;
      const extInput = form?.querySelector('[id$="-extension"]') || extEl;
      const nameInput = form?.querySelector('[id$="-display-name"]') || nameEl;
      const passInput = form?.querySelector('[id$="-password"]') || passEl;
      const body = {
        extension: (extInput?.value || "").trim(),
        display_name: (nameInput?.value || "").trim(),
      };
      const pw = (passInput?.value || "").trim();
      if (pw) body.password = pw;
      setCredsStatus("Saving…");
      const { r, j } = await api("/sip/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        setCredsStatus(j.error || "Could not save credentials.");
        return;
      }
      document.querySelectorAll("#nc-phone-password, #nc-sip-popover-password").forEach((el) => {
        el.value = "";
      });
      setCredsStatus("Credentials saved.");
      await loadStatus();
    }

    function playRemote(el) {
      if (!el || typeof el.play !== "function") return;
      const p = el.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    }

    function attachSession(session) {
      if (session.__ncAttached) return;
      session.__ncAttached = true;
      session.on("progress", () => setCallStatus("Ringing…"));
      session.on("accepted", () => {
        setCallStatus(callHasVideo ? "In video call" : "In call");
        attachLocalStream(session);
        renderRemoteFromReceivers(session);
        updateCallButtons();
      });
      session.on("confirmed", () => {
        attachLocalStream(session);
        renderRemoteFromReceivers(session);
        updateCallButtons();
      });
      session.on("ended", () => {
        G.activeSession = null;
        G.pendingSession = null;
        setCallStatus("");
        clearVideo();
        updateCallButtons();
      });
      session.on("failed", (e) => {
        G.activeSession = null;
        G.pendingSession = null;
        setCallStatus(formatCallFailure(e));
        clearVideo();
        updateCallButtons();
      });
      session.on("peerconnection", (ev) => {
        const pc = ev.peerconnection;
        // Some PBX WebRTC stacks (e.g. Grandstream) fire `track` events with an
        // empty `streams` array, so accumulate tracks into our own MediaStream.
        const remoteStream = new MediaStream();

        const renderRemote = () => {
          const hasVideo = remoteStream.getVideoTracks().length > 0;
          if (hasVideo) {
            showVideoStage(true);
            if (remoteVideo) {
              remoteVideo.srcObject = remoteStream;
              playRemote(remoteVideo);
            }
            if (remoteAudio) remoteAudio.srcObject = null;
          } else if (remoteAudio) {
            remoteAudio.srcObject = remoteStream;
            playRemote(remoteAudio);
          }
          updateCallButtons();
        };

        pc.addEventListener("track", (trackEv) => {
          const provided = trackEv.streams && trackEv.streams[0];
          if (provided) {
            provided.getTracks().forEach((t) => {
              if (!remoteStream.getTracks().includes(t)) remoteStream.addTrack(t);
            });
          } else if (trackEv.track) {
            remoteStream.addTrack(trackEv.track);
          }
          renderRemote();
        });
      });
    }

    function showIncoming(session) {
      G.pendingSession = session;
      const from = session.remote_identity?.uri?.user || session.remote_identity?.display_name || "Unknown";
      if (incomingFrom) incomingFrom.textContent = from;
      if (incomingWrap) incomingWrap.hidden = false;
      openDialPopover();
      attachSession(session);
      session.on("ended", () => {
        if (incomingWrap) incomingWrap.hidden = true;
        G.pendingSession = null;
        updateCallButtons();
      });
      session.on("failed", () => {
        if (incomingWrap) incomingWrap.hidden = true;
        G.pendingSession = null;
        updateCallButtons();
      });
    }

    function hideIncoming() {
      if (incomingWrap) incomingWrap.hidden = true;
    }

    async function register(opts) {
      const auto = !!(opts && opts.auto);
      if (G.ua && typeof G.ua.isRegistered === "function" && G.ua.isRegistered()) {
        G.registered = true;
        syncRegisteredUi();
        return;
      }
      if (!auto) setCredsStatus("Loading SIP library…");
      try {
        await ensureJsSIP();
      } catch (_err) {
        setCredsStatus("JsSIP library could not be loaded. Refresh the page and try again.");
        setStatus("offline", "Offline");
        return;
      }
      if (!auto) setCredsStatus("Connecting…");
      setStatus("connecting", auto ? "Reconnecting…" : "Connecting…");
      const { r, j } = await api("/sip/register-config", { method: "GET" });
      if (!r.ok) {
        setCredsStatus(j.error || "Could not load SIP configuration.");
        setStatus("offline", "Offline");
        return;
      }
      const cfg = j.config || {};
      G.iceServers = Array.isArray(cfg.ice_servers) ? cfg.ice_servers : [];
      try {
        if (G.ua) {
          try {
            G.ua.stop();
          } catch (_) {
            /* ignore */
          }
          G.ua = null;
        }
        const socket = new window.JsSIP.WebSocketInterface(cfg.websocket_uri);
        G.ua = new window.JsSIP.UA({
          sockets: [socket],
          uri: cfg.uri,
          password: cfg.password,
          display_name: cfg.display_name || cfg.extension,
          register: true,
          register_expires: cfg.registration_expires || 300,
          session_timers: cfg.use_session_timers !== false,
          outbound_proxy_set: !!cfg.outbound_proxy,
          outbound_proxy: cfg.outbound_proxy || undefined,
          connection_recovery_min_interval: 2,
          connection_recovery_max_interval: 30,
        });

        G.ua.on("connected", () => setStatus("connecting", "Connected — registering…"));
        G.ua.on("disconnected", () => {
          G.registered = false;
          setStatus("offline", "Disconnected");
          updateCallButtons();
        });
        G.ua.on("registered", async () => {
          G.registered = true;
          setStatus("online", "Registered");
          setCredsStatus("Registered with SIP server.");
          updateCallButtons();
          await setStayRegistered(true);
        });
        G.ua.on("unregistered", () => {
          G.registered = false;
          setStatus("offline", "Unregistered");
          updateCallButtons();
        });
        G.ua.on("registrationFailed", (ev) => {
          G.registered = false;
          const cause = ev?.cause || "registration failed";
          setStatus("error", "Registration failed");
          setCredsStatus(`Registration failed: ${cause}`);
          updateCallButtons();
        });
        G.ua.on("newRTCSession", (data) => {
          const session = data.session;
          const ui = G.ui;
          if (session.direction === "incoming") {
            if (G.activeSession || G.pendingSession) {
              session.terminate({ status_code: 486, reason_phrase: "Busy Here" });
              return;
            }
            if (ui && typeof ui.showIncoming === "function") {
              ui.showIncoming(session);
            } else {
              G.pendingSession = session;
            }
          } else {
            G.activeSession = session;
            attachSession(session);
          }
          updateCallButtons();
        });

        G.ua.start();
      } catch (err) {
        setStatus("error", "Error");
        setCredsStatus(err?.message || "Could not start SIP client.");
      }
    }

    async function unregister() {
      await setStayRegistered(false);
      if (G.ua) {
        try {
          G.ua.unregister({ all: true });
          G.ua.stop();
        } catch (_) {
          /* ignore */
        }
        G.ua = null;
      }
      G.registered = false;
      G.activeSession = null;
      G.pendingSession = null;
      hideIncoming();
      setStatus("offline", "Offline");
      setCredsStatus("");
      updateCallButtons();
    }

    function setDialNumber(number) {
      const num = String(number || "").trim();
      if (dialInput) dialInput.value = num;
      if (popoverDialInput) popoverDialInput.value = num;
      updateCallButtons();
    }

    async function ensureRegistered() {
      if (G.registered) return true;
      await register({ auto: true });
      for (let i = 0; i < 40; i += 1) {
        if (G.registered) return true;
        await new Promise((resolve) => window.setTimeout(resolve, 150));
      }
      return G.registered;
    }

    function placeCall(withVideo) {
      if (!G.ua || !G.registered) return;
      if (G.activeSession && !G.activeSession.isEnded()) return;
      const input = activeDialInput();
      const target = (input?.value || "").trim();
      if (!target) return;
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
        setCallStatus(
          "Microphone unavailable. The page must be served over HTTPS (or localhost) for calls to capture audio.",
        );
        return;
      }
      const domain = G.ua.configuration?.uri?.host || "";
      const uri = target.includes("@") ? `sip:${target}` : `sip:${target}@${domain}`;
      showVideoStage(!!withVideo);
      const options = {
        mediaConstraints: { audio: true, video: !!withVideo },
        pcConfig: { iceServers: G.iceServers },
      };
      setCallStatus(withVideo ? "Starting video call…" : "Calling…");
      G.activeSession = G.ua.call(uri, options);
      attachSession(G.activeSession);
      updateCallButtons();
    }

    function hangup() {
      if (G.activeSession && !G.activeSession.isEnded()) G.activeSession.terminate();
      if (G.pendingSession && !G.pendingSession.isEnded()) G.pendingSession.terminate();
      hideIncoming();
      clearVideo();
      updateCallButtons();
    }

    function senderTrack(kind) {
      const pc = G.activeSession?.connection;
      if (!pc || typeof pc.getSenders !== "function") return null;
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === kind);
      return sender ? sender.track : null;
    }

    function toggleMute() {
      if (!G.activeSession || G.activeSession.isEnded()) return;
      let muted = false;
      try {
        muted = !!(G.activeSession.isMuted && G.activeSession.isMuted().audio);
      } catch (_) {
        muted = false;
      }
      if (muted) {
        try {
          G.activeSession.unmute({ audio: true });
        } catch (_) {
          /* ignore */
        }
        const t = senderTrack("audio");
        if (t) t.enabled = true;
        muteBtn?.classList.remove("is-active");
        if (muteBtn) muteBtn.title = "Mute";
      } else {
        try {
          G.activeSession.mute({ audio: true });
        } catch (_) {
          /* ignore */
        }
        const t = senderTrack("audio");
        if (t) t.enabled = false;
        muteBtn?.classList.add("is-active");
        if (muteBtn) muteBtn.title = "Unmute";
      }
    }

    function toggleCamera() {
      if (!G.activeSession || G.activeSession.isEnded() || !callHasVideo) return;
      const track = senderTrack("video");
      if (!track) return;
      track.enabled = !track.enabled;
      camBtn?.classList.toggle("is-active", !track.enabled);
      if (camBtn) camBtn.title = track.enabled ? "Turn camera off" : "Turn camera on";
    }

    function appendKey(key) {
      const input = activeDialInput();
      if (!input) return;
      input.value = `${input.value || ""}${key}`;
      updateCallButtons();
    }

    bindAll("#nc-phone-ext-btn, #nc-sip-popover-ext-btn", "click", (ev) => {
      ev.stopPropagation();
      toggleExtPopover(ev.currentTarget);
    });
    bind(extClose, "click", () => {
      if (extPopover) extPopover.hidden = true;
      document.querySelectorAll("#nc-phone-ext-btn, #nc-sip-popover-ext-btn").forEach((b) => {
        b.setAttribute("aria-expanded", "false");
      });
    });
    bind(dialPopoverClose, "click", closeDialPopover);
    bind(extPopover, "click", (ev) => ev.stopPropagation());
    if (!G.docListeners) {
      G.docListeners = true;
      document.addEventListener("click", (ev) => {
        document.querySelectorAll("#nc-phone-ext-popover, #nc-sip-popover-ext-popover").forEach((pop) => {
          if (pop.hidden) return;
          const btn = ev.target.closest("#nc-phone-ext-btn, #nc-sip-popover-ext-btn");
          if (btn || pop.contains(ev.target)) return;
          pop.hidden = true;
          document.querySelectorAll("#nc-phone-ext-btn, #nc-sip-popover-ext-btn").forEach((b) => {
            b.setAttribute("aria-expanded", "false");
          });
        });
        const dialPop = document.getElementById("nc-sip-dial-popover");
        if (dialPop && !dialPop.hidden && !dialPop.contains(ev.target)) {
          const onCall = !!(G.activeSession && !G.activeSession.isEnded());
          if (!onCall) closeDialPopover();
        }
      });
      document.addEventListener("keydown", (ev) => {
        if (ev.key !== "Escape") return;
        document.querySelectorAll("#nc-phone-ext-popover, #nc-sip-popover-ext-popover").forEach((pop) => {
          pop.hidden = true;
        });
        document.querySelectorAll("#nc-phone-ext-btn, #nc-sip-popover-ext-btn").forEach((b) => {
          b.setAttribute("aria-expanded", "false");
        });
        const onCall = !!(G.activeSession && !G.activeSession.isEnded());
        if (!onCall) closeDialPopover();
      });
    }

    bindAll("#nc-phone-creds-form, #nc-sip-popover-creds-form", "submit", saveCredentials);
    bindAll("#nc-phone-register-btn, #nc-sip-popover-register-btn", "click", register);
    bindAll("#nc-phone-unregister-btn, #nc-sip-popover-unregister-btn", "click", unregister);
    bindAll("#nc-phone-call-btn, #nc-sip-popover-call-btn", "click", () => placeCall(false));
    bind(videoBtn, "click", () => placeCall(true));
    bindAll("#nc-phone-hangup-btn, #nc-sip-popover-hangup-btn", "click", hangup);
    bind(muteBtn, "click", toggleMute);
    bind(camBtn, "click", toggleCamera);
    bind(fullscreenBtn, "click", toggleFullscreen);
    bind(document, "fullscreenchange", syncFullscreenButton);
    bind(document, "webkitfullscreenchange", syncFullscreenButton);
    bindAll("#nc-phone-dial-input, #nc-sip-popover-dial-input", "input", updateCallButtons);
    bindAll("#nc-phone-dial-input, #nc-sip-popover-dial-input", "keydown", (ev) => {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      const input = ev.currentTarget;
      const onCall = !!(G.activeSession && !G.activeSession.isEnded());
      if (G.registered && !onCall && !G.pendingSession && (input.value || "").trim()) {
        placeCall(false);
      }
    });
    bindAll("#nc-phone-backspace, #nc-sip-popover-backspace", "click", () => {
      const input = activeDialInput();
      if (!input) return;
      input.value = (input.value || "").slice(0, -1);
      updateCallButtons();
    });

    bindAll(".nc-phone-key, .nc-sip-popover-key", "click", (ev) => {
      appendKey(ev.currentTarget.getAttribute("data-key") || "");
    });

    bind(answerBtn, "click", () => {
      if (!G.pendingSession) return;
      hideIncoming();
      G.activeSession = G.pendingSession;
      G.pendingSession = null;
      let wantsVideo = false;
      try {
        wantsVideo = !!(
          G.activeSession.request &&
          typeof G.activeSession.request.body === "string" &&
          /m=video/i.test(G.activeSession.request.body)
        );
      } catch (_) {
        wantsVideo = false;
      }
      showVideoStage(wantsVideo);
      G.activeSession.answer({
        mediaConstraints: { audio: true, video: wantsVideo },
        pcConfig: { iceServers: G.iceServers },
      });
      updateCallButtons();
    });

    bind(rejectBtn, "click", () => {
      if (G.pendingSession) G.pendingSession.terminate();
      hideIncoming();
      G.pendingSession = null;
      updateCallButtons();
    });

    G.ui.loadStatus = loadStatus;
    G.ui.openDialPopover = openDialPopover;
    G.ui.setDialNumber = setDialNumber;
    G.ui.placeCall = placeCall;
    G.ui.ensureRegistered = ensureRegistered;

    window.ncSipDial = async function (number, opts) {
      const o = opts || {};
      openDialPopover();
      setDialNumber(number);
      if (!o.autoCall) return;
      setCallStatus("Connecting…");
      const ok = await ensureRegistered();
      if (!ok) {
        setCallStatus("Register your SIP extension first (SIP button).");
        return;
      }
      placeCall(false);
    };

    void loadStatus();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initPhone);
  } else {
    initPhone();
  }
  // The script is re-evaluated on every Turbo navigation (data-turbo-eval="always"),
  // so register the turbo:load listener only once to avoid stacking handlers.
  if (!G.turboHook) {
    G.turboHook = true;
    document.addEventListener("turbo:load", initPhone);
  }
})();
