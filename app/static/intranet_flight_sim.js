/**
 * Sky Control — air traffic route drawing game (HTML5 canvas).
 */
(function () {
  const canvas = document.getElementById("flight-sim-canvas");
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  const lobby = document.getElementById("nc-game-lobby");
  const apiBase = ((lobby && lobby.getAttribute("data-sky-control-api")) || "/intranet/api/sky-control").replace(
    /\/$/,
    ""
  );

  const el = {
    score: document.getElementById("flight-sim-score"),
    landed: document.getElementById("flight-sim-landed"),
    wave: document.getElementById("flight-sim-wave"),
    lives: document.getElementById("flight-sim-lives"),
    combo: document.getElementById("flight-sim-combo"),
    status: document.getElementById("flight-sim-status"),
    restart: document.getElementById("flight-sim-restart"),
    lbList: document.getElementById("flight-sim-leaderboard-list"),
    lbYou: document.getElementById("flight-sim-leaderboard-you"),
  };

  const W = 1024;
  const H = 640;
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  canvas.style.width = "100%";
  canvas.style.aspectRatio = `${W} / ${H}`;
  ctx.scale(DPR, DPR);

  const TOWER = { x: W / 2, y: H / 2 + 20 };

  /** Runway strips — local coords centered, then world transform */
  const RUNWAYS = [
    { id: "09R", cx: 512, cy: 548, len: 240, width: 32, angle: 0, color: "#38bdf8" },
    { id: "27L", cx: 512, cy: 548, len: 240, width: 32, angle: Math.PI, color: "#38bdf8" },
    { id: "18", cx: 720, cy: 400, len: 160, width: 28, angle: -Math.PI / 2, color: "#a78bfa" },
    { id: "36", cx: 304, cy: 400, len: 160, width: 28, angle: Math.PI / 2, color: "#a78bfa" },
  ];

  const CALLSIGNS = [
    "QFA", "VOZ", "JST", "RXA", "UAE", "SIA", "ANA", "BAW", "DLH", "AFR",
    "FDX", "SWA", "NKS", "HAL", "ACA",
  ];

  let aircraft = [];
  let particles = [];
  let popups = [];
  let score = 0;
  let landed = 0;
  let wave = 1;
  let lives = 3;
  let combo = 0;
  let spawnCd = 1.2;
  let waveCd = 0;
  let gameOver = false;
  let paused = false;
  let lastTs = 0;
  let scoreSubmitted = false;
  let sweep = 0;
  let time = 0;

  let dragPlane = null;
  let dragPts = [];
  let dragging = false;
  let hoverPlane = null;

  function rand(a, b) {
    return a + Math.random() * (b - a);
  }
  function pick(arr) {
    return arr[(Math.random() * arr.length) | 0];
  }
  function dist(ax, ay, bx, by) {
    return Math.hypot(bx - ax, by - ay);
  }

  function setStatus(t) {
    if (el.status) el.status.textContent = t || "";
  }

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = String(s ?? "");
    return d.innerHTML;
  }

  function formatPlayedAt(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    } catch {
      return "";
    }
  }

  function rankClass(rank) {
    if (rank === 1) return "is-gold";
    if (rank === 2) return "is-silver";
    if (rank === 3) return "is-bronze";
    return "";
  }

  async function loadLeaderboard() {
    if (!el.lbList) return;
    try {
      const r = await fetch(`${apiBase}/leaderboard`, { credentials: "same-origin" });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || "Could not load leaderboard");

      const entries = data.entries || [];
      if (!entries.length) {
        el.lbList.innerHTML = '<li class="nc-flight-sim-leaderboard-empty">No scores yet — be the first!</li>';
      } else {
        el.lbList.innerHTML = entries
          .map((e) => {
            const you = e.is_you ? " is-you" : "";
            const dt = formatPlayedAt(e.played_at);
            return `<li class="${you}">
              <span class="nc-flight-sim-lb-rank ${rankClass(e.rank)}">#${e.rank}</span>
              <span class="nc-flight-sim-lb-name">${escapeHtml(e.name)}</span>
              <span class="nc-flight-sim-lb-score">${Number(e.score).toLocaleString()}</span>
              <span class="nc-flight-sim-lb-meta">${e.landed} landed · wave ${e.wave}${dt ? ` · ${dt}` : ""}</span>
            </li>`;
          })
          .join("");
      }

      if (el.lbYou) {
        const you = data.you;
        if (you && !you.on_board) {
          el.lbYou.hidden = false;
          el.lbYou.textContent = `Your best: ${Number(you.score).toLocaleString()} (rank #${you.rank}) — ${you.landed} landed, wave ${you.wave}`;
        } else if (you && you.on_board) {
          el.lbYou.hidden = false;
          el.lbYou.textContent = `Your best this board: ${Number(you.score).toLocaleString()} (overall rank #${you.rank})`;
        } else {
          el.lbYou.hidden = true;
          el.lbYou.textContent = "";
        }
      }
    } catch {
      el.lbList.innerHTML = '<li class="nc-flight-sim-leaderboard-empty">Leaderboard unavailable.</li>';
      if (el.lbYou) el.lbYou.hidden = true;
    }
  }

  async function submitRunScore() {
    if (scoreSubmitted || (score <= 0 && landed <= 0)) return;
    scoreSubmitted = true;
    try {
      const r = await fetch(`${apiBase}/scores`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ score, landed, wave }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.rank) {
        setStatus(`Run saved — you ranked #${data.rank} with ${score.toLocaleString()} points.`);
      }
      await loadLeaderboard();
    } catch {
      /* ignore */
    }
  }

  function endRun() {
    if (!gameOver) return;
    void submitRunScore();
  }
  function hud() {
    if (el.score) el.score.textContent = String(score);
    if (el.landed) el.landed.textContent = String(landed);
    if (el.wave) el.wave.textContent = String(wave);
    if (el.lives) el.lives.textContent = "♥".repeat(Math.max(0, lives)) + "♡".repeat(Math.max(0, 3 - lives));
    if (el.combo) el.combo.textContent = combo > 1 ? `×${combo}` : "—";
  }

  function runwayWorld(rw) {
    return {
      ...rw,
      cos: Math.cos(rw.angle),
      sin: Math.sin(rw.angle),
    };
  }

  function pointOnRunway(px, py, rw) {
    const lx = (px - rw.cx) * rw.cos + (py - rw.cy) * rw.sin;
    const ly = -(px - rw.cx) * rw.sin + (py - rw.cy) * rw.cos;
    return Math.abs(lx) <= rw.len / 2 && Math.abs(ly) <= rw.width / 2;
  }

  function nearestRunwaySnap(px, py, maxD) {
    let best = null;
    let bestD = maxD;
    for (const rw of RUNWAYS) {
      const d = dist(px, py, rw.cx, rw.cy);
      if (d < bestD) {
        bestD = d;
        best = { x: rw.cx, y: rw.cy, rw };
      }
    }
    return best;
  }

  function pathLength(pts) {
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y);
    return len;
  }

  function pointAtPath(pts, distAlong) {
    if (!pts.length) return null;
    if (pts.length === 1) return { ...pts[0], angle: 0 };
    let left = distAlong;
    for (let i = 1; i < pts.length; i++) {
      const seg = dist(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y);
      if (left <= seg || i === pts.length - 1) {
        const t = seg < 0.001 ? 1 : Math.min(1, left / seg);
        const x = pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t;
        const y = pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t;
        const angle = Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x);
        return { x, y, angle };
      }
      left -= seg;
    }
    const last = pts[pts.length - 1];
    const prev = pts[pts.length - 2];
    return { x: last.x, y: last.y, angle: Math.atan2(last.y - prev.y, last.x - prev.x) };
  }

  function simplifyPath(pts, minGap) {
    if (pts.length < 2) return pts;
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const o = out[out.length - 1];
      if (dist(o.x, o.y, pts[i].x, pts[i].y) >= minGap) out.push(pts[i]);
    }
    const end = pts[pts.length - 1];
    const o = out[out.length - 1];
    if (dist(o.x, o.y, end.x, end.y) > 6) out.push(end);
    return out;
  }

  function makeCallSign() {
    return pick(CALLSIGNS) + String(Math.floor(rand(100, 999)));
  }

  function spawnAircraft() {
    if (aircraft.filter((a) => a.active).length >= 6 + Math.min(4, wave)) return;

    const types = [
      { kind: "jet", speed: 2.35, r: 11, color: "#e2e8f0", urgent: 14 },
      { kind: "prop", speed: 1.65, r: 9, color: "#fcd34d", urgent: 18 },
      { kind: "heli", speed: 1.25, r: 10, color: "#86efac", urgent: 22 },
    ];
    const t = wave > 2 && Math.random() < 0.35 ? types[0] : pick(types);

    const edge = (Math.random() * 4) | 0;
    let x;
    let y;
    const pad = 30;
    if (edge === 0) {
      x = rand(pad, W - pad);
      y = -20;
    } else if (edge === 1) {
      x = W + 20;
      y = rand(pad, H - pad);
    } else if (edge === 2) {
      x = rand(pad, W - pad);
      y = H + 20;
    } else {
      x = -20;
      y = rand(pad, H - pad);
    }

    const heading = Math.atan2(TOWER.y - y, TOWER.x - x) + rand(-0.25, 0.25);

    aircraft.push({
      id: Math.random().toString(36).slice(2, 9),
      call: makeCallSign(),
      kind: t.kind,
      x,
      y,
      heading,
      speed: t.speed * (1 + wave * 0.04),
      r: t.r,
      color: t.color,
      urgentMax: t.urgent,
      urgent: 0,
      active: true,
      path: null,
      pathLen: 0,
      pathDist: 0,
      trail: [],
      bank: 0,
      landed: false,
      warn: false,
    });
  }

  function assignPath(ac, rawPts) {
    let pts = simplifyPath(rawPts, 10);
    if (pts.length < 2) return false;
    const snap = nearestRunwaySnap(pts[pts.length - 1].x, pts[pts.length - 1].y, 85);
    if (snap) pts[pts.length - 1] = { x: snap.x, y: snap.y };
    pts[0] = { x: ac.x, y: ac.y };
    ac.path = pts;
    ac.pathLen = pathLength(pts);
    ac.pathDist = 0;
    ac.urgent = 0;
    return true;
  }

  function burst(x, y, color, n) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2);
      const sp = rand(1.5, 5);
      particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: rand(0.4, 0.9),
        color,
        size: rand(2, 5),
      });
    }
  }

  function scorePopup(x, y, text) {
    popups.push({ x, y, text, life: 1.2, vy: -28 });
  }

  function landAircraft(ac) {
    ac.active = false;
    ac.landed = true;
    landed += 1;
    combo += 1;
    const bonus = Math.floor(100 * combo * (ac.kind === "jet" ? 1.2 : 1));
    score += bonus;
    burst(ac.x, ac.y, "#4ade80", 16);
    scorePopup(ac.x, ac.y - 20, `+${bonus}`);
    hud();
    setStatus(`${ac.call} landed on runway · combo ×${combo}`);
  }

  function loseLife(reason) {
    lives -= 1;
    combo = 0;
    hud();
    if (lives <= 0) {
      gameOver = true;
      setStatus(reason || "Airspace closed.");
      endRun();
    } else {
      setStatus(reason || "Incident — be careful.");
    }
  }

  function updateAircraft(ac, dt) {
    if (!ac.active) return;

    ac.urgent += dt;
    if (!ac.path) {
      ac.x += Math.cos(ac.heading) * ac.speed * dt * 58;
      ac.y += Math.sin(ac.heading) * ac.speed * dt * 58;
      if (ac.urgent > ac.urgentMax) {
        ac.speed *= 1 + dt * 0.15;
        ac.warn = true;
      }
    } else {
      ac.pathDist += ac.speed * dt * 58;
      if (ac.pathDist >= ac.pathLen) {
        const end = ac.path[ac.path.length - 1];
        ac.x = end.x;
        ac.y = end.y;
      } else {
        const p = pointAtPath(ac.path, ac.pathDist);
        if (p) {
          const turn = p.angle - ac.heading;
          ac.bank = Math.max(-0.55, Math.min(0.55, turn * 2));
          ac.heading += turn * Math.min(1, dt * 8);
          ac.x = p.x;
          ac.y = p.y;
        }
      }
    }

    ac.trail.push({ x: ac.x, y: ac.y });
    if (ac.trail.length > 28) ac.trail.shift();

    for (const rw of RUNWAYS) {
      if (pointOnRunway(ac.x, ac.y, runwayWorld(rw))) {
        landAircraft(ac);
        return;
      }
    }

    if (ac.x < -60 || ac.x > W + 60 || ac.y < -60 || ac.y > H + 60) {
      ac.active = false;
      burst(ac.x, ac.y, "#f87171", 10);
      loseLife(`${ac.call} left controlled airspace.`);
    }
  }

  function checkCollisions() {
    const live = aircraft.filter((a) => a.active);
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i];
        const b = live[j];
        const d = dist(a.x, a.y, b.x, b.y);
        const min = a.r + b.r + 6;
        a.warn = a.warn || d < min + 28;
        b.warn = b.warn || d < min + 28;
        if (d < min) {
          burst((a.x + b.x) / 2, (a.y + b.y) / 2, "#ef4444", 24);
          a.active = false;
          b.active = false;
          gameOver = true;
          combo = 0;
          setStatus(`Collision: ${a.call} and ${b.call}. Press Restart.`);
          hud();
          endRun();
          return;
        }
      }
    }
  }

  function canvasPt(ev) {
    const r = canvas.getBoundingClientRect();
    return { x: ((ev.clientX - r.left) / r.width) * W, y: ((ev.clientY - r.top) / r.height) * H };
  }

  function pickAircraft(px, py) {
    let best = null;
    let bestD = 42;
    for (const a of aircraft) {
      if (!a.active) continue;
      const d = dist(px, py, a.x, a.y);
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    }
    return best;
  }

  function resetGame() {
    aircraft = [];
    particles = [];
    popups = [];
    score = 0;
    landed = 0;
    wave = 1;
    lives = 3;
    combo = 0;
    spawnCd = 2;
    waveCd = 0;
    gameOver = false;
    paused = false;
    scoreSubmitted = false;
    dragPlane = null;
    dragPts = [];
    dragging = false;
    setStatus("Drag from an aircraft to a runway (glowing strips). Avoid other traffic.");
    hud();
  }

  /* ─── Drawing ─── */
  function drawSky() {
    const g = ctx.createRadialGradient(TOWER.x, TOWER.y, 40, TOWER.x, TOWER.y, Math.max(W, H));
    g.addColorStop(0, "#0f2847");
    g.addColorStop(0.45, "#0a1628");
    g.addColorStop(1, "#050d18");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = "rgba(56, 189, 248, 0.07)";
    ctx.lineWidth = 1;
    for (let r = 80; r < 520; r += 70) {
      ctx.beginPath();
      ctx.arc(TOWER.x, TOWER.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(TOWER.x, TOWER.y);
      ctx.lineTo(TOWER.x + Math.cos(ang) * 500, TOWER.y + Math.sin(ang) * 500);
      ctx.stroke();
    }

    sweep += 0.018;
    ctx.save();
    ctx.translate(TOWER.x, TOWER.y);
    ctx.rotate(sweep);
    const sweepG = ctx.createLinearGradient(0, 0, 420, 0);
    sweepG.addColorStop(0, "rgba(74, 222, 128, 0.22)");
    sweepG.addColorStop(1, "rgba(74, 222, 128, 0)");
    ctx.fillStyle = sweepG;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 420, -0.08, 0.08);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawRunways() {
    for (const rw of RUNWAYS) {
      const rwW = runwayWorld(rw);
      ctx.save();
      ctx.translate(rw.cx, rw.cy);
      ctx.rotate(rw.angle);
      ctx.shadowColor = rw.color;
      ctx.shadowBlur = 18;
      ctx.fillStyle = "rgba(30, 41, 59, 0.92)";
      ctx.fillRect(-rw.len / 2, -rw.width / 2, rw.len, rw.width);
      ctx.shadowBlur = 0;
      ctx.strokeStyle = rw.color;
      ctx.lineWidth = 2;
      ctx.strokeRect(-rw.len / 2, -rw.width / 2, rw.len, rw.width);
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.font = "700 11px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(rw.id, 0, 0);
      ctx.setLineDash([12, 8]);
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.beginPath();
      ctx.moveTo(-rw.len / 2 + 16, 0);
      ctx.lineTo(rw.len / 2 - 16, 0);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    ctx.fillStyle = "rgba(148, 163, 184, 0.5)";
    ctx.beginPath();
    ctx.arc(TOWER.x, TOWER.y, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#38bdf8";
    ctx.font = "600 10px system-ui,sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("TWR", TOWER.x, TOWER.y + 28);
  }

  function drawPath(pts, color, width, glow) {
    if (!pts || pts.length < 2) return;
    ctx.save();
    if (glow) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    ctx.restore();
  }

  function drawAircraft(ac) {
    if (!ac.active && !ac.landed) return;

    if (ac.path) drawPath(ac.path, "rgba(56, 189, 248, 0.55)", 2.5, false);

    if (ac.trail.length > 2) {
      ctx.strokeStyle = "rgba(148, 163, 184, 0.2)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(ac.trail[0].x, ac.trail[0].y);
      for (let i = 1; i < ac.trail.length; i++) ctx.lineTo(ac.trail[i].x, ac.trail[i].y);
      ctx.stroke();
    }

    const pulse = ac.warn ? 0.5 + 0.5 * Math.sin(time * 12) : 0;
    if (ac.warn) {
      ctx.strokeStyle = `rgba(248, 113, 113, ${0.35 + pulse * 0.4})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(ac.x, ac.y, ac.r + 14 + pulse * 4, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (!ac.path && ac.urgent > ac.urgentMax * 0.55) {
      ctx.fillStyle = `rgba(251, 191, 36, ${0.25 + pulse * 0.2})`;
      ctx.beginPath();
      ctx.arc(ac.x, ac.y, ac.r + 8, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.save();
    ctx.translate(ac.x, ac.y);
    ctx.rotate(ac.heading + ac.bank);

    if (ac.kind === "heli") {
      ctx.fillStyle = ac.color;
      ctx.beginPath();
      ctx.ellipse(0, 0, ac.r * 1.2, ac.r * 0.85, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#166534";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-ac.r * 1.5, 0);
      ctx.lineTo(ac.r * 1.5, 0);
      ctx.stroke();
    } else {
      ctx.fillStyle = ac.color;
      ctx.beginPath();
      ctx.moveTo(ac.r * 1.5, 0);
      ctx.lineTo(-ac.r * 0.95, -ac.r * 0.65);
      ctx.lineTo(-ac.r * 0.45, 0);
      ctx.lineTo(-ac.r * 0.95, ac.r * 0.65);
      ctx.closePath();
      ctx.fill();
      if (ac.kind === "jet") {
        ctx.fillStyle = "#94a3b8";
        ctx.fillRect(-ac.r * 0.3, -ac.r * 1.1, ac.r * 0.5, ac.r * 2.2);
      }
    }
    ctx.restore();

    ctx.fillStyle = ac.warn ? "#fca5a5" : "#e2e8f0";
    ctx.font = "600 11px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillText(ac.call, ac.x, ac.y - ac.r - 10);
  }

  function drawDragPreview() {
    if (!dragging || dragPts.length < 2) return;
    drawPath(dragPts, "rgba(74, 222, 128, 0.85)", 3.5, true);
    const end = dragPts[dragPts.length - 1];
    const snap = nearestRunwaySnap(end.x, end.y, 85);
    if (snap) {
      ctx.strokeStyle = "rgba(74, 222, 128, 0.6)";
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.arc(snap.x, snap.y, 22, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (dragPlane) {
      ctx.strokeStyle = "#4ade80";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(dragPlane.x, dragPlane.y, dragPlane.r + 10, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function drawParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      p.x += p.vx;
      p.y += p.vy;
      p.vy += dt * 12;
      if (p.life <= 0) {
        particles.splice(i, 1);
        continue;
      }
      ctx.globalAlpha = Math.min(1, p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  function drawPopups(dt) {
    ctx.textAlign = "center";
    ctx.font = "700 15px system-ui,sans-serif";
    for (let i = popups.length - 1; i >= 0; i--) {
      const p = popups[i];
      p.life -= dt;
      p.y += p.vy * dt;
      if (p.life <= 0) {
        popups.splice(i, 1);
        continue;
      }
      ctx.globalAlpha = Math.min(1, p.life);
      ctx.fillStyle = "#4ade80";
      ctx.fillText(p.text, p.x, p.y);
      ctx.globalAlpha = 1;
    }
  }

  function drawOverlay() {
    if (gameOver) {
      ctx.fillStyle = "rgba(5, 13, 24, 0.82)";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#f8fafc";
      ctx.textAlign = "center";
      ctx.font = "700 32px system-ui,sans-serif";
      ctx.fillText("Game Over", W / 2, H / 2 - 36);
      ctx.font = "400 17px system-ui,sans-serif";
      ctx.fillStyle = "#94a3b8";
      ctx.fillText(`Score ${score}  ·  ${landed} landings  ·  Wave ${wave}`, W / 2, H / 2 + 4);
      ctx.fillText("Restart or press R", W / 2, H / 2 + 36);
    } else if (paused) {
      ctx.fillStyle = "rgba(5, 13, 24, 0.55)";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#f8fafc";
      ctx.font = "600 24px system-ui,sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Paused", W / 2, H / 2);
    }
  }

  function tick(ts) {
    const dt = Math.min(0.05, (ts - lastTs) / 1000 || 0.016);
    lastTs = ts;
    time += dt;

    if (!gameOver && !paused) {
      spawnCd -= dt;
      const rate = Math.max(0.85, 2.4 - wave * 0.14);
      if (spawnCd <= 0) {
        spawnAircraft();
        spawnCd = rate * rand(0.7, 1.2);
      }
      waveCd += dt;
      if (waveCd >= 35) {
        wave += 1;
        waveCd = 0;
        hud();
        setStatus(`Wave ${wave} — heavier traffic.`);
        burst(TOWER.x, TOWER.y, "#38bdf8", 20);
      }
      for (const a of aircraft) {
        a.warn = false;
        updateAircraft(a, dt);
      }
      aircraft = aircraft.filter((a) => a.active);
      checkCollisions();
    }

    drawSky();
    drawRunways();
    for (const a of aircraft) drawAircraft(a);
    drawDragPreview();
    drawParticles(dt);
    drawPopups(dt);
    drawOverlay();

    if (hoverPlane && !dragging && !gameOver) {
      canvas.style.cursor = "pointer";
    } else if (dragging) {
      canvas.style.cursor = "crosshair";
    } else {
      canvas.style.cursor = "default";
    }

    requestAnimationFrame(tick);
  }

  canvas.addEventListener("pointerdown", (ev) => {
    if (gameOver) return;
    canvas.setPointerCapture(ev.pointerId);
    dragging = true;
    const pt = canvasPt(ev);
    dragPlane = pickAircraft(pt.x, pt.y);
    dragPts = dragPlane ? [{ x: dragPlane.x, y: dragPlane.y }, pt] : [pt];
  });

  canvas.addEventListener("pointermove", (ev) => {
    const pt = canvasPt(ev);
    if (!dragging) {
      hoverPlane = pickAircraft(pt.x, pt.y);
      return;
    }
    const last = dragPts[dragPts.length - 1];
    if (!last || dist(last.x, last.y, pt.x, pt.y) > 5) dragPts.push(pt);
  });

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    if (dragPlane && dragPts.length >= 2) {
      if (assignPath(dragPlane, dragPts)) {
        setStatus(`Route set for ${dragPlane.call}.`);
      }
    }
    dragPlane = null;
    dragPts = [];
  }

  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  function onSkyControlKeydown(ev) {
    if (!document.getElementById("flight-sim-canvas")) return;
    if (ev.key === "p" || ev.key === "P") {
      if (!gameOver) paused = !paused;
      ev.preventDefault();
    }
    if (ev.key === "r" || ev.key === "R") {
      resetGame();
      ev.preventDefault();
    }
  }
  window.addEventListener("keydown", onSkyControlKeydown);
  document.addEventListener("turbo:before-render", function teardownSkyKeys() {
    window.removeEventListener("keydown", onSkyControlKeydown);
    document.removeEventListener("turbo:before-render", teardownSkyKeys);
  });

  el.restart?.addEventListener("click", resetGame);

  window.ncSkyControlRefreshLeaderboard = loadLeaderboard;

  resetGame();
  void loadLeaderboard();
  requestAnimationFrame(tick);
})();
