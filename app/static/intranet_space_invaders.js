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

  let player = { x: W / 2, y: H - 48, w: 36, h: 22, cd: 0 };
  let bullets = [];
  let enemyBullets = [];
  let invaders = [];
  let invaderDir = 1;
  let invaderStepCd = 0;
  let invaderShootCd = 1.4;
  let ufo = null;
  let ufoCd = 8;

  try {
    best = Number(localStorage.getItem("firmgate.spaceInvaders.best") || 0) || 0;
  } catch (_) {
    best = 0;
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

  function spawnWave() {
    invaders = [];
    const cols = 11;
    const rows = 5;
    const gapX = 44;
    const gapY = 34;
    const startX = (W - (cols - 1) * gapX) / 2;
    const startY = 72;
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
    invaderShootCd = Math.max(0.55, 1.6 - wave * 0.08);
    ufoCd = 6 + Math.random() * 6;
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
    spawnWave();
    setStatus("← → or A D to move · Space to fire · P pause");
    syncHud();
  }

  function aliveInvaders() {
    return invaders.filter((i) => i.alive);
  }

  function moveInvaders(dt) {
    const alive = aliveInvaders();
    if (!alive.length) {
      wave += 1;
      spawnWave();
      setStatus(`Wave ${wave}!`);
      syncHud();
      return;
    }

    invaderStepCd -= dt;
    if (invaderStepCd > 0) return;

    const speed = 0.34 + wave * 0.04;
    invaderStepCd = speed;

    let minX = Infinity;
    let maxX = -Infinity;
    alive.forEach((inv) => {
      minX = Math.min(minX, inv.x);
      maxX = Math.max(maxX, inv.x + inv.w);
    });

    const step = 10 + Math.min(wave, 8);
    let hitEdge = false;
    if (maxX + step >= W - 24 && invaderDir > 0) hitEdge = true;
    if (minX - step <= 24 && invaderDir < 0) hitEdge = true;

    if (hitEdge) {
      invaderDir *= -1;
      alive.forEach((inv) => {
        inv.y += 16;
        if (inv.y + inv.h >= player.y - 8) {
          gameOver = true;
          saveBest();
          setStatus("The invaders landed — game over. Press R to restart.");
        }
      });
    } else {
      alive.forEach((inv) => {
        inv.x += step * invaderDir;
      });
    }

    invaderShootCd -= dt;
    if (invaderShootCd <= 0) {
      const shooters = alive.filter(() => Math.random() < 0.35);
      const pick = shooters.length ? shooters[(Math.random() * shooters.length) | 0] : alive[(Math.random() * alive.length) | 0];
      if (pick) {
        enemyBullets.push({ x: pick.x + pick.w / 2, y: pick.y + pick.h, vy: 180 + wave * 8 });
      }
      invaderShootCd = Math.max(0.45, 1.5 - wave * 0.07) + Math.random() * 0.6;
    }
  }

  function maybeSpawnUfo(dt) {
    if (ufo) {
      ufo.x += ufo.vx * dt;
      if (ufo.x < -60 || ufo.x > W + 60) ufo = null;
      return;
    }
    ufoCd -= dt;
    if (ufoCd <= 0) {
      const fromLeft = Math.random() < 0.5;
      ufo = {
        x: fromLeft ? -40 : W + 40,
        y: 42,
        w: 44,
        h: 18,
        vx: fromLeft ? 120 : -120,
        pts: [50, 100, 150, 300][(Math.random() * 4) | 0],
      };
      ufoCd = 14 + Math.random() * 10;
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
          syncHud();
        }
      });
      if (ufo) {
        const ur = { x: ufo.x - ufo.w / 2, y: ufo.y, w: ufo.w, h: ufo.h };
        if (rectsOverlap(rect, ur)) {
          score += ufo.pts;
          ufo = null;
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
        syncHud();
        if (lives <= 0) {
          gameOver = true;
          saveBest();
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
  function loop(ts) {
    if (!running) return;
    const dt = Math.min(0.033, (ts - lastTs) / 1000 || 0.016);
    lastTs = ts;
    if (visible && !paused) {
      frame += 1;
      update(dt);
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
    el.restart.addEventListener("click", () => resetGame());
  }

  resetGame();
  startLoop();

  window.ncSpaceInvadersOnTabVisible = function () {
    visible = true;
    canvas.focus();
  };
  window.ncSpaceInvadersOnTabHidden = function () {
    visible = false;
    Object.keys(KEYS).forEach((k) => {
      KEYS[k] = false;
    });
  };
})();
