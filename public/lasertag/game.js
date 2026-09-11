/**
 * game.js
 * ---------------------------------------------------------------------------
 * Main client application: lobby flow, realtime sync with the server
 * (Server-Sent Events channel, functionally equivalent to a Socket.io
 * connection but works over the single HTTP port this app is deployed on),
 * the AR camera HUD, and the single-frame MediaPipe damage classification.
 *
 * PERFORMANCE NOTE: MediaPipe Pose only ever runs ONCE per trigger pull, on
 * one still frame drawn to an offscreen canvas. It never runs in a
 * requestAnimationFrame loop, so it costs nothing while aiming/walking and
 * the camera feed itself renders natively via the <video> element (GPU
 * composited), keeping the game smooth on low-end phones.
 * ---------------------------------------------------------------------------
 */

// ---- MediaPipe Tasks Vision (loaded lazily from CDN as an ES module) ------
const MEDIAPIPE_VERSION = "0.10.14";
const POSE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

let poseLandmarker = null;
let poseLandmarkerPromise = null;

async function initPoseLandmarker() {
  if (poseLandmarker || poseLandmarkerPromise) return poseLandmarkerPromise;
  poseLandmarkerPromise = (async () => {
    try {
      const mp = await import(
        `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/+esm`
      );
      const vision = await mp.FilesetResolver.forVisionTasks(
        `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`,
      );
      try {
        poseLandmarker = await mp.PoseLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate: "GPU" },
          runningMode: "IMAGE",
          numPoses: 1,
          minPoseDetectionConfidence: 0.4,
          minPosePresenceConfidence: 0.4,
        });
      } catch (gpuErr) {
        console.warn("[game] GPU delegate unavailable, retrying on CPU", gpuErr);
        poseLandmarker = await mp.PoseLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate: "CPU" },
          runningMode: "IMAGE",
          numPoses: 1,
          minPoseDetectionConfidence: 0.4,
          minPosePresenceConfidence: 0.4,
        });
      }
      console.log("[game] PoseLandmarker ready");
    } catch (err) {
      console.error("[game] MediaPipe failed to load — falling back to heuristic hit detection", err);
      poseLandmarker = null;
    }
  })();
  return poseLandmarkerPromise;
}
// Kick off model download immediately (pure network+WASM init, needs no
// user gesture / camera permission) so it is (hopefully) ready by the time
// the player fires their first shot.
initPoseLandmarker();

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
const state = {
  playerId: null,
  playerName: null,
  roomCode: null,
  isHost: false,
  players: [],
  me: null,
  matchStarted: false,
  eventSource: null,
  shotCooldownUntil: 0,
  incomingShots: [], // { shotId, heading, expiresAt, attempted }
  videoReady: false,
};

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const screens = document.querySelectorAll(".screen");
function showScreen(id) {
  screens.forEach((s) => s.classList.toggle("active", s.id === id));
}
function currentScreenId() {
  const active = document.querySelector(".screen.active");
  return active ? active.id : null;
}

const el = {
  inputName: $("input-name"),
  tabCreate: $("tab-create"),
  tabJoin: $("tab-join"),
  paneCreate: $("pane-create"),
  paneJoin: $("pane-join"),
  inputCode: $("input-code"),
  btnCreate: $("btn-create"),
  btnJoin: $("btn-join"),
  lobbyError: $("lobby-error"),
  btnOpenLeaderboard: $("btn-open-leaderboard"),
  btnCloseLeaderboard: $("btn-close-leaderboard"),
  leaderboardList: $("leaderboard-list"),

  waitingCode: $("waiting-code"),
  waitingPlayers: $("waiting-players"),
  btnStartMatch: $("btn-start-match"),
  waitingStatus: $("waiting-status"),
  btnLeaveLobby: $("btn-leave-lobby"),

  btnEnableAr: $("btn-enable-ar"),
  permissionStatus: $("permission-status"),

  video: $("camera-feed"),
  canvas: $("capture-canvas"),
  damageFlash: $("damage-flash"),
  hpFill: $("hp-fill"),
  hpValue: $("hp-value"),
  armorFill: $("armor-fill"),
  armorValue: $("armor-value"),
  btnExit: $("btn-exit"),
  aliveCounter: $("alive-counter"),
  killFeed: $("kill-feed"),
  statusBanner: $("status-banner"),
  hitMarker: $("hit-marker"),
  btnKit: $("btn-kit"),
  kitRingFill: $("kit-ring-fill"),
  ammoCurrent: $("ammo-current"),
  ammoReserve: $("ammo-reserve"),
  btnShoot: $("btn-shoot"),
  eliminatedOverlay: $("eliminated-overlay"),

  gameoverTitle: $("gameover-title"),
  gameoverList: $("gameover-list"),
  btnPlayAgain: $("btn-play-again"),
};

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function apiPost(path, body) {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    return await res.json();
  } catch (err) {
    console.error("[game] request failed", path, err);
    return { error: "Network error" };
  }
}

function showLobbyError(msg) {
  el.lobbyError.textContent = msg;
  el.lobbyError.classList.remove("hidden");
}
function clearLobbyError() {
  el.lobbyError.classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Lobby: tabs
// ---------------------------------------------------------------------------
el.tabCreate.addEventListener("click", () => {
  el.tabCreate.classList.add("active");
  el.tabJoin.classList.remove("active");
  el.paneCreate.classList.remove("hidden");
  el.paneJoin.classList.add("hidden");
});
el.tabJoin.addEventListener("click", () => {
  el.tabJoin.classList.add("active");
  el.tabCreate.classList.remove("active");
  el.paneJoin.classList.remove("hidden");
  el.paneCreate.classList.add("hidden");
});

el.btnCreate.addEventListener("click", async () => {
  clearLobbyError();
  const name = el.inputName.value.trim();
  if (!name) return showLobbyError("Enter your name first");
  el.btnCreate.disabled = true;
  const res = await apiPost("/api/rooms", { name });
  el.btnCreate.disabled = false;
  if (res.error) return showLobbyError(res.error);
  enterRoom(res);
});

el.btnJoin.addEventListener("click", async () => {
  clearLobbyError();
  const name = el.inputName.value.trim();
  const code = el.inputCode.value.trim();
  if (!name) return showLobbyError("Enter your name first");
  if (!/^\d{4}$/.test(code)) return showLobbyError("Room code must be 4 digits");
  el.btnJoin.disabled = true;
  const res = await apiPost(`/api/rooms/${code}/join`, { name });
  el.btnJoin.disabled = false;
  if (res.error) return showLobbyError(res.error);
  enterRoom(res);
});

el.btnOpenLeaderboard.addEventListener("click", async () => {
  el.leaderboardList.innerHTML = "<li>Loading…</li>";
  showScreen("screen-leaderboard");
  try {
    const res = await fetch("/api/leaderboard").then((r) => r.json());
    renderLeaderboard(res.players || []);
  } catch {
    el.leaderboardList.innerHTML = "<li>Failed to load leaderboard</li>";
  }
});
el.btnCloseLeaderboard.addEventListener("click", () => showScreen("screen-lobby"));

function renderLeaderboard(players) {
  if (!players.length) {
    el.leaderboardList.innerHTML = "<li>No matches played yet — be the first!</li>";
    return;
  }
  el.leaderboardList.innerHTML = players
    .map(
      (p, i) => `<li><span><span class="rank">#${i + 1}</span>${escapeHtml(p.playerName)}</span>
        <span>🏆 ${p.wins} · 🔫 ${p.kills} kills · 🎯 ${p.headshots} HS</span></li>`,
    )
    .join("");
}

// ---------------------------------------------------------------------------
// Room lifecycle
// ---------------------------------------------------------------------------
function enterRoom(res) {
  state.playerId = res.playerId;
  state.playerName = res.player.name;
  state.roomCode = res.room.code;
  state.isHost = res.player.isHost;
  state.players = res.room.players;
  state.me = res.player;
  state.matchStarted = false;

  el.waitingCode.textContent = state.roomCode;
  renderWaitingList();
  connectStream();
  showScreen("screen-waiting");
}

function connectStream() {
  if (state.eventSource) state.eventSource.close();
  const es = new EventSource(`/api/rooms/${state.roomCode}/stream?playerId=${state.playerId}`);
  state.eventSource = es;

  es.addEventListener("state", (e) => applyRoomState(JSON.parse(e.data)));
  es.addEventListener("player-joined", () => {});
  es.addEventListener("player-left", () => {});
  es.addEventListener("game-start", onGameStart);
  es.addEventListener("shot-fired", onShotFired);
  es.addEventListener("ammo-update", onAmmoUpdate);
  es.addEventListener("hit-confirmed", onHitConfirmed);
  es.addEventListener("player-eliminated", onPlayerEliminated);
  es.addEventListener("kit-start", onKitStart);
  es.addEventListener("kit-complete", onKitComplete);
  es.addEventListener("game-over", onGameOver);
  es.onerror = () => {
    // EventSource auto-reconnects; nothing else required for this game.
  };
}

function applyRoomState(room) {
  state.players = room.players;
  state.isHost = room.status !== "ended" && room.hostId === state.playerId;
  const me = room.players.find((p) => p.id === state.playerId);
  if (me) state.me = me;

  if (currentScreenId() === "screen-waiting") renderWaitingList();
  if (currentScreenId() === "screen-game") {
    updateHudFromMe();
    updateAliveCounter();
  }
}

function renderWaitingList() {
  el.waitingPlayers.innerHTML = state.players
    .map(
      (p) =>
        `<li><span>${escapeHtml(p.name)}${p.isHost ? '<span class="host-tag">HOST</span>' : ""}</span><span>${p.connected ? "🟢" : "⚪"}</span></li>`,
    )
    .join("");
  el.btnStartMatch.classList.toggle("hidden", !state.isHost);
  el.btnStartMatch.disabled = state.players.length < 2;
  el.waitingStatus.textContent = state.isHost
    ? state.players.length < 2
      ? "Need at least 2 players to start…"
      : "Ready when you are, host!"
    : "Waiting for host to start the match…";
}

el.btnStartMatch.addEventListener("click", async () => {
  const res = await apiPost(`/api/rooms/${state.roomCode}/start`, { playerId: state.playerId });
  if (res.error) el.waitingStatus.textContent = res.error;
});

el.btnLeaveLobby.addEventListener("click", async () => {
  await cleanupAndLeave();
  showScreen("screen-lobby");
});

// ---------------------------------------------------------------------------
// Match start -> permissions gate -> AR game
// ---------------------------------------------------------------------------
function onGameStart() {
  if (state.matchStarted) return;
  if (currentScreenId() !== "screen-waiting") return;
  state.matchStarted = true;
  showScreen("screen-permissions");
}

el.btnEnableAr.addEventListener("click", async () => {
  el.btnEnableAr.disabled = true;
  el.permissionStatus.textContent = "Requesting camera…";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    el.video.srcObject = stream;
    await el.video.play().catch(() => {});
    el.video.addEventListener("loadedmetadata", () => (state.videoReady = true), { once: true });
    if (el.video.videoWidth) state.videoReady = true;

    el.permissionStatus.textContent = "Requesting compass…";
    await AudioSync.startCompass(() => {});

    el.permissionStatus.textContent = "Requesting microphone…";
    const micOk = await AudioSync.startListening(onUltrasonicPing);
    if (!micOk) {
      el.permissionStatus.textContent = "Microphone denied — hit detection will not work. You can still play.";
    }

    el.permissionStatus.textContent = "Loading AI targeting model…";
    await initPoseLandmarker();

    resetGameHud();
    showScreen("screen-game");
  } catch (err) {
    console.error(err);
    el.permissionStatus.textContent = "Camera permission denied. Tap to try again.";
  } finally {
    el.btnEnableAr.disabled = false;
  }
});

function resetGameHud() {
  el.eliminatedOverlay.classList.add("hidden");
  el.hitMarker.classList.add("hidden");
  el.killFeed.innerHTML = "";
  updateHudFromMe();
  updateAliveCounter();
}

// ---------------------------------------------------------------------------
// HUD rendering
// ---------------------------------------------------------------------------
function updateHudFromMe() {
  const me = state.me;
  if (!me) return;
  el.hpFill.style.width = `${Math.max(0, (me.hp / me.maxHp) * 100)}%`;
  el.hpValue.textContent = Math.round(me.hp);
  el.armorFill.style.width = `${Math.max(0, (me.armor / me.maxArmor) * 100)}%`;
  el.armorValue.textContent = Math.round(me.armor);
  el.ammoCurrent.textContent = me.ammo;
  el.ammoReserve.textContent = me.reserveAmmo;
  el.ammoCurrent.classList.toggle("low", me.ammo === 0);

  el.btnKit.disabled = me.hasUsedKit || me.usingKit || !me.alive;

  if (!me.alive) {
    el.eliminatedOverlay.classList.remove("hidden");
    el.btnShoot.disabled = true;
    el.btnKit.disabled = true;
  } else {
    el.eliminatedOverlay.classList.add("hidden");
    el.btnShoot.disabled = false;
  }
}

function updateAliveCounter() {
  const alive = state.players.filter((p) => p.alive).length;
  el.aliveCounter.textContent = `👥 ${alive}/${state.players.length}`;
}

function showBanner(text, duration = 1200) {
  el.statusBanner.textContent = text;
  el.statusBanner.classList.remove("hidden");
  clearTimeout(showBanner._t);
  showBanner._t = setTimeout(() => el.statusBanner.classList.add("hidden"), duration);
}

function addKillFeed(html) {
  const div = document.createElement("div");
  div.className = "entry";
  div.innerHTML = html;
  el.killFeed.appendChild(div);
  setTimeout(() => div.remove(), 4200);
}

function flashDamage() {
  el.damageFlash.classList.add("show");
  requestAnimationFrame(() => {
    setTimeout(() => el.damageFlash.classList.remove("show"), 30);
  });
}

function showHitMarker() {
  el.hitMarker.classList.remove("hidden");
  el.hitMarker.style.animation = "none";
  void el.hitMarker.offsetWidth;
  el.hitMarker.style.animation = "";
  setTimeout(() => el.hitMarker.classList.add("hidden"), 400);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------------
// SHOOTING — single-frame MediaPipe classification + ultrasonic ping
// ---------------------------------------------------------------------------
el.btnShoot.addEventListener("click", handleShoot);

async function handleShoot() {
  if (!state.me || !state.me.alive) return;
  if (Date.now() < state.shotCooldownUntil) return;
  if (state.me.ammo <= 0) {
    showBanner("OUT OF AMMO — RELOADING", 1200);
    await apiPost(`/api/rooms/${state.roomCode}/reload`, { playerId: state.playerId });
    return;
  }

  state.shotCooldownUntil = Date.now() + 300; // basic fire-rate limiter
  el.btnShoot.classList.add("firing");
  setTimeout(() => el.btnShoot.classList.remove("firing"), 150);
  if (navigator.vibrate) navigator.vibrate(30);

  // 1) Capture EXACTLY ONE still frame and run MediaPipe once against it.
  const { damageType, damage } = await classifyShot();

  // 2) Read current compass heading + fire the 100ms 19kHz ultrasonic ping.
  const heading = AudioSync.getHeading();
  AudioSync.playUltrasonicPing();

  // 3) Tell the server. It consumes ammo and opens a short confirmation
  //    window that potential targets answer via /report-hit.
  const res = await apiPost(`/api/rooms/${state.roomCode}/shoot`, {
    playerId: state.playerId,
    heading,
    damageType,
    damage,
  });
  if (res.error) {
    showBanner(res.error, 1000);
    return;
  }
  state.me.ammo = res.ammo;
  updateHudFromMe();
  showBanner(damageType === "miss" ? "MISS" : `${damageType.toUpperCase()} — confirming…`, 700);
}

el.ammoCurrent.parentElement.addEventListener("click", async () => {
  if (!state.me || !state.me.alive) return;
  const res = await apiPost(`/api/rooms/${state.roomCode}/reload`, { playerId: state.playerId });
  if (!res.error) {
    state.me.ammo = res.ammo;
    state.me.reserveAmmo = res.reserveAmmo;
    updateHudFromMe();
  }
});

/**
 * Captures the current video frame onto a small offscreen canvas and runs a
 * single MediaPipe PoseLandmarker inference against it. The crosshair is
 * always exactly the center of the frame (the camera feed uses
 * object-fit: cover with centered cropping, so screen-center == frame-center).
 */
async function classifyShot() {
  const video = el.video;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return { damageType: "miss", damage: 0 };

  const maxDim = 480; // downscale for speed on low-end phones
  const scale = Math.min(1, maxDim / Math.max(vw, vh));
  const cw = Math.max(1, Math.round(vw * scale));
  const ch = Math.max(1, Math.round(vh * scale));
  el.canvas.width = cw;
  el.canvas.height = ch;
  const ctx2d = el.canvas.getContext("2d");
  ctx2d.drawImage(video, 0, 0, cw, ch);

  if (!poseLandmarker) {
    // Graceful degradation: if the AI model failed to load (e.g. offline
    // gym/hallway with no signal), treat every shot as a body hit so the
    // game stays playable rather than failing entirely.
    return { damageType: "bodyshot", damage: 10 };
  }

  try {
    const result = poseLandmarker.detect(el.canvas);
    return classifyFromPose(result, cw, ch);
  } catch (err) {
    console.error("[game] pose detection failed", err);
    return { damageType: "miss", damage: 0 };
  }
}

function classifyFromPose(result, w, h) {
  if (!result || !result.landmarks || result.landmarks.length === 0) {
    return { damageType: "miss", damage: 0 };
  }
  const landmarks = result.landmarks[0];
  let minX = 1,
    minY = 1,
    maxX = 0,
    maxY = 0,
    any = false;
  for (const p of landmarks) {
    if (typeof p.visibility === "number" && p.visibility < 0.4) continue;
    any = true;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (!any) return { damageType: "miss", damage: 0 };

  const left = minX * w;
  const right = maxX * w;
  const top = minY * h;
  const bottom = maxY * h;
  const cx = w / 2;
  const cy = h / 2;

  if (cx < left || cx > right || cy < top || cy > bottom) {
    return { damageType: "miss", damage: 0 };
  }
  const relY = (cy - top) / Math.max(1, bottom - top);
  if (relY <= 0.2) return { damageType: "headshot", damage: 25 };
  return { damageType: "bodyshot", damage: 10 };
}

// ---------------------------------------------------------------------------
// ULTRASONIC DETECTION (target side) — called continuously by audio-sync.js
// whenever the filtered microphone detects a 19kHz spike. We only act on it
// if there is an active "shot fired" window from the server to compare
// against, and the compass heading roughly opposes the shooter's heading.
// ---------------------------------------------------------------------------
function onUltrasonicPing() {
  const now = Date.now();
  const heading = AudioSync.getHeading();
  state.incomingShots = state.incomingShots.filter((s) => now <= s.expiresAt);

  for (const shot of state.incomingShots) {
    if (shot.attempted) continue;
    shot.attempted = true; // never retry the same shot window twice

    // Cheap client-side pre-check purely to avoid a pointless network call;
    // the server re-validates this authoritatively regardless.
    if (!AudioSync.isOpposite(heading, shot.heading, 15)) continue;

    apiPost(`/api/rooms/${state.roomCode}/report-hit`, {
      playerId: state.playerId,
      shotId: shot.shotId,
      heading,
    });
  }
}

function onShotFired(e) {
  const data = JSON.parse(e.data);
  if (data.shooterId === state.playerId) return; // I fired this one myself
  state.incomingShots.push({
    shotId: data.shotId,
    heading: data.heading,
    expiresAt: data.expiresAt,
    attempted: false,
  });
}

function onAmmoUpdate(e) {
  const data = JSON.parse(e.data);
  if (data.playerId !== state.playerId) return;
  if (state.me) {
    state.me.ammo = data.ammo;
    state.me.reserveAmmo = data.reserveAmmo;
    updateHudFromMe();
  }
}

function onHitConfirmed(e) {
  const data = JSON.parse(e.data);
  const isMe = data.targetId === state.playerId;
  const iShotThem = data.shooterId === state.playerId;

  if (isMe && state.me) {
    state.me.hp = data.targetHp;
    state.me.armor = data.targetArmor;
    updateHudFromMe();
    flashDamage();
    showBanner(`-${data.damage} ${data.damageType.toUpperCase()} from ${data.shooterName}`, 1200);
    if (navigator.vibrate) navigator.vibrate(120);
  }
  if (iShotThem) {
    showHitMarker();
    showBanner(`HIT! ${data.damageType.toUpperCase()} on ${data.targetName}`, 900);
    if (navigator.vibrate) navigator.vibrate(50);
  }
  addKillFeed(`💥 ${escapeHtml(data.shooterName)} hit ${escapeHtml(data.targetName)} (-${data.damage})`);
}

function onPlayerEliminated(e) {
  const data = JSON.parse(e.data);
  addKillFeed(`💀 ${escapeHtml(data.shooterName)} eliminated ${escapeHtml(data.targetName)}`);
  if (data.targetId === state.playerId) {
    if (navigator.vibrate) navigator.vibrate([150, 80, 150]);
    updateHudFromMe();
  }
  updateAliveCounter();
}

function onKitStart(e) {
  const data = JSON.parse(e.data);
  if (data.playerId !== state.playerId) return;
  if (state.me) state.me.usingKit = true;
  el.btnKit.disabled = true;
  showBanner("APPLYING MED-KIT…", data.durationMs);
  el.kitRingFill.style.transition = "none";
  el.kitRingFill.style.strokeDashoffset = "176";
  requestAnimationFrame(() => {
    el.kitRingFill.style.transition = `stroke-dashoffset ${data.durationMs}ms linear`;
    el.kitRingFill.style.strokeDashoffset = "0";
  });
}

function onKitComplete(e) {
  const data = JSON.parse(e.data);
  if (data.playerId !== state.playerId) return;
  if (state.me) {
    state.me.hp = data.hp;
    state.me.usingKit = false;
    state.me.hasUsedKit = true;
  }
  updateHudFromMe();
  showBanner(data.cancelled ? "Med-kit interrupted" : "+50 HP", 1000);
}

function onGameOver(e) {
  const data = JSON.parse(e.data);
  el.gameoverTitle.textContent = data.winnerName ? `🏆 ${data.winnerName} WINS` : "MATCH OVER";
  el.gameoverList.innerHTML = data.players
    .map(
      (p, i) => `<li class="${p.id === data.winnerId ? "winner" : ""}">
        <span><span class="rank">#${i + 1}</span>${escapeHtml(p.name)}</span>
        <span>🔫 ${p.kills} · 🎯 ${p.headshots} HS · 💀 ${p.deaths}</span>
      </li>`,
    )
    .join("");
  teardownGameSession();
  showScreen("screen-gameover");
}

// ---------------------------------------------------------------------------
// Kit
// ---------------------------------------------------------------------------
el.btnKit.addEventListener("click", async () => {
  if (!state.me || !state.me.alive || state.me.hasUsedKit || state.me.usingKit) return;
  const res = await apiPost(`/api/rooms/${state.roomCode}/use-kit`, { playerId: state.playerId });
  if (res.error) showBanner(res.error, 1000);
});

// ---------------------------------------------------------------------------
// Exit / cleanup
// ---------------------------------------------------------------------------
el.btnExit.addEventListener("click", async () => {
  await cleanupAndLeave();
  showScreen("screen-lobby");
});

el.btnPlayAgain.addEventListener("click", async () => {
  await cleanupAndLeave();
  showScreen("screen-lobby");
});

function teardownGameSession() {
  const stream = el.video.srcObject;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  el.video.srcObject = null;
  AudioSync.stopListening();
  state.videoReady = false;
}

async function cleanupAndLeave() {
  if (state.roomCode && state.playerId) {
    await apiPost(`/api/rooms/${state.roomCode}/leave`, { playerId: state.playerId });
  }
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  teardownGameSession();
  state.playerId = null;
  state.roomCode = null;
  state.matchStarted = false;
  state.incomingShots = [];
  state.players = [];
  state.me = null;
}

// Best-effort cleanup if the tab is closed mid-match.
window.addEventListener("pagehide", () => {
  if (state.roomCode && state.playerId) {
    navigator.sendBeacon?.(
      `/api/rooms/${state.roomCode}/leave`,
      new Blob([JSON.stringify({ playerId: state.playerId })], { type: "application/json" }),
    );
  }
});
