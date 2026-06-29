/**
 * Space Invaders — classic arcade shooter (HTML5 canvas).
 */
(function () {
  const canvas = document.getElementById("space-invaders-canvas");
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  const el = {
    score: document.getElementById("space-invaders-score"),
    wave: document.getElementById("space-invaders-wave"),
    lives: document.getElementById("space-invaders-lives"),
    status: document.getElementById("space-invaders-status"),
    restart: document.getElementById("space-invaders-restart"),
    best: document.getElementById("space-invaders-best"),
    mute: document.getElementById("space-invaders-mute"),
    speedBtns: Array.from(document.querySelectorAll(".nc-space-invaders-speed-btn")),
  };

  const W = 800;
  const H = 600;
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  canvas.style.width = "100%";
  canvas.style.aspectRatio = `${W} / ${H}`;
  ctx.scale(DPR, DPR);

  const KEYS = Object.create(null);
  let running = false;
  let visible = false;
  let raf = 0;
  let lastTs = 0;

  let score = 0;
  let best = 0;
  let lives = 3;
  let wave = 1;
  let gameOver = false;
  let paused = false;
  let gameSpeed = 1;
  let muted = false;

  let audioCtx = null;
  let marchStep = 0;
  const MARCH_NOTES = [110, 98, 88, 78];

  let player = { x: W / 2, y: H - 48, w: 36, h: 22, cd: 0 };
  let bullets = [];
  let enemyBullets = [];
  let invaders = [];
  let invaderDir = 1;
  let invaderStepCd = 0;
  let invaderShootCd = 1.4;
  let waveDifficulty = null;
  let ufo = null;
  let ufoCd = 8;

  try {
    best = Number(localStorage.getItem("firmgate.spaceInvaders.best") || 0) || 0;
  } catch (_) {
    best = 0;
  }

  try {
    muted = localStorage.getItem("firmgate.spaceInvaders.muted") === "1";
  } catch (_) {
    muted = false;
  }

  function ensureAudio() {
    if (muted) return null;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  function beep(opts) {
    if (muted) return;
    const ac = ensureAudio();
    if (!ac) return;
    const {
      freq = 440,
      dur = 0.08,
      type = "square",
      vol = 0.07,
      attack = 0.004,
      release = 0.05,
      freqEnd,
    } = opts || {};
    const t = ac.currentTime;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (freqEnd) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, vol), t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur + release);
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.start(t);
    osc.stop(t + dur + release + 0.02);
  }

  function sfxShoot() {
    beep({ freq: 880, freqEnd: 1320, dur: 0.05, type: "square", vol: 0.05 });
  }

  function sfxInvaderHit(row) {
    const base = row === 0 ? 320 : row === 1 ? 260 : 200;
    beep({ freq: base, freqEnd: base * 0.35, dur: 0.1, type: "sawtooth", vol: 0.07 });
    beep({ freq: base * 0.5, freqEnd: 40, dur: 0.14, type: "square", vol: 0.045, attack: 0.01 });
  }

  function sfxUfoHit() {
    beep({ freq: 520, dur: 0.06, type: "square", vol: 0.06 });
    beep({ freq: 780, dur: 0.06, type: "square", vol: 0.06, attack: 0.05 });
    beep({ freq: 1040, dur: 0.1, type: "square", vol: 0.07, attack: 0.11 });
  }

  function sfxPlayerHit() {
    beep({ freq: 180, freqEnd: 60, dur: 0.22, type: "sawtooth", vol: 0.09 });
  }

  function sfxGameOver() {
    beep({ freq: 220, freqEnd: 55, dur: 0.35, type: "triangle", vol: 0.08, release: 0.2 });
    beep({ freq: 165, freqEnd: 40, dur: 0.45, type: "triangle", vol: 0.07, attack: 0.2, release: 0.25 });
  }

  function sfxWaveClear() {
    [523, 659, 784, 1047].forEach((freq, i) => {
      beep({ freq, dur: 0.09, type: "square", vol: 0.055, attack: 0.004 + i * 0.09 });
    });
  }

  function sfxMarch(aliveCount) {
    const tension = Math.max(0, 55 - aliveCount);
    const idx = marchStep % MARCH_NOTES.length;
    marchStep += 1;
    const freq = MARCH_NOTES[idx] * (1 + tension * 0.012);
    const dur = Math.max(0.028, 0.055 - tension * 0.00045);
    beep({ freq, dur, type: "square", vol: 0.038, release: 0.03 });
  }

  function syncMuteButton() {
    if (!el.mute) return;
    el.mute.classList.toggle("is-muted", muted);
    el.mute.setAttribute("aria-pressed", muted ? "true" : "false");
    el.mute.setAttribute("aria-label", muted ? "Unmute sound" : "Mute sound");
    el.mute.title = muted ? "Unmute sound" : "Mute sound";
  }

  function setMuted(next) {
    muted = !!next;
    try {
      localStorage.setItem("firmgate.spaceInvaders.muted", muted ? "1" : "0");
    } catch (_) {}
    syncMuteButton();
    if (!muted) ensureAudio();
  }

  function setStatus(t) {
    if (el.status) el.status.textContent = t || "";
  }

  function syncHud() {
    if (el.score) el.score.textContent = String(score);
    if (el.wave) el.wave.textContent = String(wave);
    if (el.lives) el.lives.textContent = "♥".repeat(Math.max(0, lives)) || "—";
    if (el.best) el.best.textContent = String(best);
  }

  function saveBest() {
    if (score <= best) return;
    best = score;
    try {
      localStorage.setItem("firmgate.spaceInvaders.best", String(best));
    } catch (_) {}
    syncHud();
  }

  function invaderPoints(row) {
    if (row === 0) return 30;
    if (row === 1) return 20;
    return 10;
  }

  /** Per-wave difficulty — each wave ramps movement, fire rate, grid size, and descent. */
  function getWaveDifficulty(w) {
    const tier = Math.max(0, w - 1);
    return {
      cols: Math.min(11 + Math.floor(tier / 3), 15),
      rows: Math.min(5 + Math.floor(tier / 2), 8),
      stepInterval: Math.max(0.1, 0.36 - tier * 0.024),
      horizontalStep: 10 + Math.min(tier * 1.35, 16),
      descendStep: 14 + Math.min(tier * 1.6, 12),
      shootMin: Math.max(0.18, 0.9 - tier * 0.038),
      shootRand: Math.max(0.25, 0.75 - tier * 0.028),
      bulletSpeed: 170 + tier * 14,
      shooterChance: Math.min(0.68, 0.3 + tier * 0.028),
      ufoInterval: Math.max(5, 14 - tier * 0.45),
    };
  }

  function spawnWave() {
    waveDifficulty = getWaveDifficulty(wave);
    invaders = [];
    const { cols, rows } = waveDifficulty;
    const gapX = Math.max(34, 44 - Math.floor(wave / 4));
    const gapY = Math.max(28, 34 - Math.floor(wave / 5));
    const gridW = (cols - 1) * gapX;
    const startX = (W - gridW) / 2;
    const startY = Math.max(48, 72 - Math.floor(wave / 3) * 4);
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        invaders.push({
          x: startX + c * gapX,
          y: startY + r * gapY,
          w: 30,
          h: 22,
          row: r,
          alive: true,
        });
      }
    }
    invaderDir = 1;
    invaderStepCd = 0;
    invaderShootCd = waveDifficulty.shootMin + Math.random() * waveDifficulty.shootRand;
    ufoCd = waveDifficulty.ufoInterval * (0.6 + Math.random() * 0.5);
  }

  function resetGame() {
    score = 0;
    lives = 3;
    wave = 1;
    gameOver = false;
    paused = false;
    player.x = W / 2;
    player.cd = 0;
    bullets = [];
    enemyBullets = [];
    ufo = null;
    marchStep = 0;
    spawnWave();
    setStatus("← → or A D to move · Space to fire · P pause");
    syncHud();
  }

  function aliveInvaders() {
    return invaders.filter((i) => i.alive);
  }

  function moveInvaders(dt) {
    const diff = waveDifficulty || getWaveDifficulty(wave);
    const alive = aliveInvaders();
    if (!alive.length) {
      wave += 1;
      spawnWave();
      const { cols, rows } = waveDifficulty;
      setStatus(`Wave ${wave}! ${cols}×${rows} formation — brace yourself.`);
      sfxWaveClear();
      syncHud();
      return;
    }

    invaderStepCd -= dt;
    if (invaderStepCd > 0) return;

    invaderStepCd = diff.stepInterval;

    let minX = Infinity;
    let maxX = -Infinity;
    alive.forEach((inv) => {
      minX = Math.min(minX, inv.x);
      maxX = Math.max(maxX, inv.x + inv.w);
    });

    const step = diff.horizontalStep;
    let hitEdge = false;
    if (maxX + step >= W - 24 && invaderDir > 0) hitEdge = true;
    if (minX - step <= 24 && invaderDir < 0) hitEdge = true;

    if (hitEdge) {
      invaderDir *= -1;
      sfxMarch(alive.length);
      alive.forEach((inv) => {
        inv.y += diff.descendStep;
        if (inv.y + inv.h >= player.y - 8) {
          gameOver = true;
          saveBest();
          sfxGameOver();
          setStatus("The invaders landed — game over. Press R to restart.");
        }
      });
    } else {
      sfxMarch(alive.length);
      alive.forEach((inv) => {
        inv.x += step * invaderDir;
      });
    }

    invaderShootCd -= dt;
    if (invaderShootCd <= 0) {
      const shooters = alive.filter(() => Math.random() < diff.shooterChance);
      const pick = shooters.length ? shooters[(Math.random() * shooters.length) | 0] : alive[(Math.random() * alive.length) | 0];
      if (pick) {
        enemyBullets.push({ x: pick.x + pick.w / 2, y: pick.y + pick.h, vy: diff.bulletSpeed });
      }
      invaderShootCd = diff.shootMin + Math.random() * diff.shootRand;
    }
  }

  function maybeSpawnUfo(dt) {
    const diff = waveDifficulty || getWaveDifficulty(wave);
    if (ufo) {
      ufo.x += ufo.vx * dt;
      if (ufo.x < -60 || ufo.x > W + 60) ufo = null;
      return;
    }
    ufoCd -= dt;
    if (ufoCd <= 0) {
      const fromLeft = Math.random() < 0.5;
      const speedBoost = 1 + Math.min(wave, 12) * 0.06;
      ufo = {
        x: fromLeft ? -40 : W + 40,
        y: 42,
        w: 44,
        h: 18,
        vx: (fromLeft ? 120 : -120) * speedBoost,
        pts: [50, 100, 150, 300][(Math.random() * 4) | 0],
      };
      ufoCd = diff.ufoInterval * (0.7 + Math.random() * 0.6);
    }
  }

  function rectsOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function update(dt) {
    if (gameOver || paused) return;

    const move = (KEYS.ArrowLeft || KEYS.a || KEYS.A ? -1 : 0) + (KEYS.ArrowRight || KEYS.d || KEYS.D ? 1 : 0);
    player.x += move * 260 * dt;
    player.x = Math.max(24, Math.min(W - 24, player.x));

    if ((KEYS[" "] || KEYS.Spacebar) && player.cd <= 0) {
      bullets.push({ x: player.x, y: player.y - 14, vy: -420 });
      player.cd = 0.28;
      sfxShoot();
    }
    if (player.cd > 0) player.cd -= dt;

    bullets.forEach((b) => {
      b.y += b.vy * dt;
    });
    bullets = bullets.filter((b) => b.y > -20);

    enemyBullets.forEach((b) => {
      b.y += b.vy * dt;
    });
    enemyBullets = enemyBullets.filter((b) => b.y < H + 20);

    moveInvaders(dt);
    maybeSpawnUfo(dt);

    bullets.forEach((b) => {
      const bx = b.x - 2;
      const by = b.y - 6;
      const rect = { x: bx, y: by, w: 4, h: 10 };
      invaders.forEach((inv) => {
        if (!inv.alive) return;
        const ir = { x: inv.x - inv.w / 2, y: inv.y, w: inv.w, h: inv.h };
        if (rectsOverlap(rect, ir)) {
          inv.alive = false;
          b.y = -999;
          score += invaderPoints(inv.row);
          sfxInvaderHit(inv.row);
          syncHud();
        }
      });
      if (ufo) {
        const ur = { x: ufo.x - ufo.w / 2, y: ufo.y, w: ufo.w, h: ufo.h };
        if (rectsOverlap(rect, ur)) {
          score += ufo.pts;
          ufo = null;
          sfxUfoHit();
          syncHud();
        }
      }
    });

    const pr = { x: player.x - player.w / 2, y: player.y - player.h / 2, w: player.w, h: player.h };
    enemyBullets.forEach((b) => {
      const br = { x: b.x - 3, y: b.y - 8, w: 6, h: 12 };
      if (rectsOverlap(pr, br)) {
        b.y = 9999;
        lives -= 1;
        sfxPlayerHit();
        syncHud();
        if (lives <= 0) {
          gameOver = true;
          saveBest();
          sfxGameOver();
          setStatus("Game over — press R to restart.");
        } else {
          setStatus("Ship hit! Careful…");
        }
      }
    });
  }

  function drawInvader(inv, frame) {
    const x = inv.x;
    const y = inv.y;
    const wobble = frame % 2 === 0 ? 0 : 2;
    ctx.fillStyle = inv.row === 0 ? "#f472b6" : inv.row === 1 ? "#38bdf8" : "#4ade80";
    ctx.fillRect(x - inv.w / 2, y + wobble, inv.w, 4);
    ctx.fillRect(x - inv.w / 2 + 4, y + 4 + wobble, inv.w - 8, 8);
    ctx.fillRect(x - 10, y + 12 + wobble, 6, 6);
    ctx.fillRect(x + 4, y + 12 + wobble, 6, 6);
    ctx.fillRect(x - 14, y + 18 + wobble, 28, 4);
  }

  function drawPlayer() {
    const x = player.x;
    const y = player.y;
    ctx.fillStyle = "#38bdf8";
    ctx.beginPath();
    ctx.moveTo(x, y - 12);
    ctx.lineTo(x - 16, y + 10);
    ctx.lineTo(x + 16, y + 10);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#0ea5e9";
    ctx.fillRect(x - 10, y + 8, 20, 6);
  }

  function drawUfo() {
    if (!ufo) return;
    const x = ufo.x;
    const y = ufo.y;
    ctx.fillStyle = "#f87171";
    ctx.beginPath();
    ctx.ellipse(x, y + 6, ufo.w / 2, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fecaca";
    ctx.fillRect(x - 8, y, 16, 6);
  }

  function draw(frame) {
    ctx.fillStyle = "#020617";
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = "rgba(56, 189, 248, 0.08)";
    for (let i = 0; i < 40; i += 1) {
      const sx = (i * 97 + frame * 3) % W;
      const sy = (i * 53) % (H - 80);
      ctx.fillRect(sx, sy + 40, 2, 2);
    }

    drawUfo();
    invaders.forEach((inv) => {
      if (inv.alive) drawInvader(inv, frame);
    });

    ctx.fillStyle = "#fbbf24";
    bullets.forEach((b) => {
      ctx.fillRect(b.x - 2, b.y - 8, 4, 10);
    });

    ctx.fillStyle = "#fb7185";
    enemyBullets.forEach((b) => {
      ctx.fillRect(b.x - 3, b.y - 6, 6, 12);
    });

    if (!gameOver) drawPlayer();

    if (paused && !gameOver) {
      ctx.fillStyle = "rgba(2, 6, 23, 0.55)";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#e2e8f0";
      ctx.font = "700 28px Inter, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Paused", W / 2, H / 2);
      ctx.textAlign = "left";
    }

    if (gameOver) {
      ctx.fillStyle = "rgba(2, 6, 23, 0.72)";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#f8fafc";
      ctx.font = "700 32px Inter, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Game over", W / 2, H / 2 - 12);
      ctx.font = "500 16px Inter, system-ui, sans-serif";
      ctx.fillStyle = "#94a3b8";
      ctx.fillText(`Score ${score} · Best ${best}`, W / 2, H / 2 + 22);
      ctx.fillText("Press R to restart", W / 2, H / 2 + 48);
      ctx.textAlign = "left";
    }
  }

  let frame = 0;
  function setGameSpeed(mult) {
    gameSpeed = mult === 2 || mult === 3 ? mult : 1;
    el.speedBtns.forEach((btn) => {
      const on = Number(btn.dataset.speed) === gameSpeed;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function loop(ts) {
    if (!running) return;
    const dt = Math.min(0.033, (ts - lastTs) / 1000 || 0.016);
    lastTs = ts;
    if (visible && !paused) {
      frame += 1;
      update(dt * gameSpeed);
    }
    draw(frame);
    raf = requestAnimationFrame(loop);
  }

  function startLoop() {
    if (running) return;
    running = true;
    lastTs = 0;
    raf = requestAnimationFrame(loop);
  }

  function onKeyDown(e) {
    if (!visible) return;
    ensureAudio();
    KEYS[e.key] = true;
    if (e.key === "p" || e.key === "P") {
      if (!gameOver) paused = !paused;
      e.preventDefault();
    }
    if (e.key === "r" || e.key === "R") {
      resetGame();
      e.preventDefault();
    }
    if (["ArrowLeft", "ArrowRight", " ", "Spacebar"].includes(e.key)) e.preventDefault();
  }

  function onKeyUp(e) {
    if (!visible) return;
    KEYS[e.key] = false;
  }

  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("keyup", onKeyUp);

  if (el.restart) {
    el.restart.addEventListener("click", () => {
      ensureAudio();
      resetGame();
    });
  }

  canvas.addEventListener("pointerdown", () => ensureAudio());

  el.speedBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      ensureAudio();
      setGameSpeed(Number(btn.dataset.speed) || 1);
    });
  });

  if (el.mute) {
    el.mute.addEventListener("click", () => setMuted(!muted));
  }

  setGameSpeed(1);
  syncMuteButton();

  resetGame();
  startLoop();

  window.ncSpaceInvadersOnTabVisible = function () {
    visible = true;
    canvas.focus();
    ensureAudio();
  };
  window.ncSpaceInvadersOnTabHidden = function () {
    visible = false;
    Object.keys(KEYS).forEach((k) => {
      KEYS[k] = false;
    });
  };
})();
