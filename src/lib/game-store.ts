// ---------------------------------------------------------------------------
// Core in-memory realtime game engine for the AR Laser Tag Battle Royale.
//
// WHY NOT SOCKET.IO?
// This project is hosted as a single long-lived Next.js Node process behind
// a platform that only exposes the Next.js HTTP port. Rather than spinning up
// a second HTTP/WebSocket server on a separate port (which would not be
// reachable from other players' phones), we implement the exact same
// publish/subscribe realtime pattern using Server-Sent Events (SSE) over
// plain HTTP, which works perfectly through the same Next.js port and proxy.
// The client API (`audio-sync.js` / `game.js`) is written so the transport
// could be swapped for Socket.io with virtually no change to the game logic.
//
// This module is intentionally framework-agnostic: it holds all rooms,
// players and match logic and exposes a tiny event emitter that the SSE
// route (`/api/rooms/[code]/stream`) forwards to connected clients.
// ---------------------------------------------------------------------------
import { EventEmitter } from "events";
import { randomUUID } from "crypto";

export type DamageType = "headshot" | "bodyshot" | "miss";

export interface Player {
  id: string;
  name: string;
  hp: number;
  maxHp: number;
  armor: number;
  maxArmor: number;
  ammo: number;
  maxAmmo: number;
  reserveAmmo: number;
  kills: number;
  deaths: number;
  headshots: number;
  damageDealt: number;
  alive: boolean;
  isHost: boolean;
  hasUsedKit: boolean;
  usingKit: boolean;
  heading: number; // last known compass heading in degrees [0, 360)
  connected: boolean;
  joinedAt: number;
  lastSeen: number;
}

export type RoomStatus = "lobby" | "active" | "ended";

export interface PendingShot {
  id: string;
  roomCode: string;
  shooterId: string;
  shooterName: string;
  heading: number;
  damageType: DamageType;
  damage: number;
  createdAt: number;
  expiresAt: number;
  resolved: boolean;
}

export interface Room {
  code: string;
  hostId: string;
  status: RoomStatus;
  players: Map<string, Player>;
  pendingShots: Map<string, PendingShot>;
  createdAt: number;
  emitter: EventEmitter;
}

// Tolerance window: target must report the ultrasonic detection within this
// many milliseconds of the shot being fired (mic detection + network jitter).
const HIT_WINDOW_MS = 1500;
// Compass tolerance: target heading must be within this many degrees of being
// exactly opposite (180 degrees) the shooter's heading.
const HEADING_TOLERANCE_DEG = 15;

const globalForGame = globalThis as typeof globalThis & {
  __arLaserTagRooms?: Map<string, Room>;
  __arLaserTagBus?: EventEmitter;
};

// Global bus used for cross-cutting concerns (e.g. writing match results to
// Postgres) without coupling this module to the database layer.
export const gameBus: EventEmitter =
  globalForGame.__arLaserTagBus ?? new EventEmitter();
globalForGame.__arLaserTagBus = gameBus;
gameBus.setMaxListeners(50);

const rooms: Map<string, Room> =
  globalForGame.__arLaserTagRooms ?? new Map();
globalForGame.__arLaserTagRooms = rooms;

function makeRoomCode(): string {
  let code = "";
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms.has(code));
  return code;
}

function angularDiff(a: number, b: number): number {
  // Smallest absolute difference between two compass headings (0-360).
  let diff = Math.abs(a - b) % 360;
  if (diff > 180) diff = 360 - diff;
  return diff;
}

function newPlayer(name: string, isHost: boolean): Player {
  const now = Date.now();
  return {
    id: randomUUID(),
    name: name.slice(0, 16) || "Player",
    hp: 100,
    maxHp: 100,
    armor: 50,
    maxArmor: 50,
    ammo: 30,
    maxAmmo: 30,
    reserveAmmo: 99,
    kills: 0,
    deaths: 0,
    headshots: 0,
    damageDealt: 0,
    alive: true,
    isHost,
    hasUsedKit: false,
    usingKit: false,
    heading: 0,
    connected: true,
    joinedAt: now,
    lastSeen: now,
  };
}

export function serializePlayer(p: Player) {
  return {
    id: p.id,
    name: p.name,
    hp: p.hp,
    maxHp: p.maxHp,
    armor: p.armor,
    maxArmor: p.maxArmor,
    ammo: p.ammo,
    maxAmmo: p.maxAmmo,
    reserveAmmo: p.reserveAmmo,
    kills: p.kills,
    deaths: p.deaths,
    headshots: p.headshots,
    damageDealt: p.damageDealt,
    alive: p.alive,
    isHost: p.isHost,
    hasUsedKit: p.hasUsedKit,
    usingKit: p.usingKit,
    connected: p.connected,
  };
}

export function roomSnapshot(room: Room) {
  return {
    code: room.code,
    status: room.status,
    hostId: room.hostId,
    players: Array.from(room.players.values()).map(serializePlayer),
  };
}

function broadcast(room: Room, event: string, data: unknown) {
  room.emitter.emit("event", { event, data });
}

export function createRoom(hostName: string) {
  const code = makeRoomCode();
  const host = newPlayer(hostName, true);
  const room: Room = {
    code,
    hostId: host.id,
    status: "lobby",
    players: new Map([[host.id, host]]),
    pendingShots: new Map(),
    createdAt: Date.now(),
    emitter: new EventEmitter(),
  };
  room.emitter.setMaxListeners(50);
  rooms.set(code, room);
  return { room, player: host };
}

export function getRoom(code: string): Room | undefined {
  return rooms.get(code);
}

export function joinRoom(code: string, name: string) {
  const room = rooms.get(code);
  if (!room) return { error: "Room not found" as const };
  if (room.status !== "lobby") return { error: "Game already in progress" as const };
  if (room.players.size >= 12) return { error: "Room is full" as const };
  const player = newPlayer(name, false);
  room.players.set(player.id, player);
  broadcast(room, "player-joined", { player: serializePlayer(player) });
  broadcast(room, "state", roomSnapshot(room));
  return { room, player };
}

export function leaveRoom(code: string, playerId: string) {
  const room = rooms.get(code);
  if (!room) return;
  const player = room.players.get(playerId);
  if (!player) return;
  room.players.delete(playerId);
  broadcast(room, "player-left", { playerId, name: player.name });
  if (room.players.size === 0) {
    rooms.delete(code);
    return;
  }
  if (room.hostId === playerId) {
    const next = room.players.values().next().value as Player | undefined;
    if (next) {
      next.isHost = true;
      room.hostId = next.id;
    }
  }
  broadcast(room, "state", roomSnapshot(room));
}

export function startGame(code: string, requesterId: string) {
  const room = rooms.get(code);
  if (!room) return { error: "Room not found" as const };
  if (room.hostId !== requesterId) return { error: "Only the host can start the match" as const };
  if (room.players.size < 2) return { error: "Need at least 2 players to start" as const };
  room.status = "active";
  for (const p of room.players.values()) {
    p.hp = p.maxHp;
    p.armor = p.maxArmor;
    p.ammo = p.maxAmmo;
    p.reserveAmmo = 99;
    p.kills = 0;
    p.deaths = 0;
    p.headshots = 0;
    p.damageDealt = 0;
    p.alive = true;
    p.hasUsedKit = false;
    p.usingKit = false;
  }
  broadcast(room, "game-start", { startedAt: Date.now() });
  broadcast(room, "state", roomSnapshot(room));
  return { room };
}

export function updateHeading(code: string, playerId: string, heading: number) {
  const room = rooms.get(code);
  const player = room?.players.get(playerId);
  if (!room || !player) return;
  player.heading = ((heading % 360) + 360) % 360;
  player.lastSeen = Date.now();
}

// ---------------------------------------------------------------------------
// SHOOT: called the instant a shooter fires. The client has already run the
// single-frame MediaPipe pose detection locally to know whether the shot
// would land as a headshot/bodyshot/miss *if* it connects with a real player.
// The server just needs to (a) validate + consume ammo and (b) open a short
// "listening window" that other clients can confirm against via the
// ultrasonic + compass handshake.
// ---------------------------------------------------------------------------
export function fireShot(
  code: string,
  shooterId: string,
  heading: number,
  damageType: DamageType,
  damage: number,
) {
  const room = rooms.get(code);
  if (!room) return { error: "Room not found" as const };
  const shooter = room.players.get(shooterId);
  if (!shooter) return { error: "Player not found" as const };
  if (room.status !== "active") return { error: "Match not active" as const };
  if (!shooter.alive) return { error: "You are eliminated" as const };
  if (shooter.ammo <= 0) return { error: "Out of ammo" as const };

  shooter.ammo -= 1;
  shooter.heading = ((heading % 360) + 360) % 360;

  const shotId = randomUUID();
  const now = Date.now();
  const shot: PendingShot = {
    id: shotId,
    roomCode: code,
    shooterId,
    shooterName: shooter.name,
    heading: shooter.heading,
    damageType,
    damage,
    createdAt: now,
    expiresAt: now + HIT_WINDOW_MS,
    resolved: damageType === "miss", // an AI miss can never be confirmed
  };
  room.pendingShots.set(shotId, shot);

  // Garbage collect old shots to keep the map small.
  for (const [id, s] of room.pendingShots) {
    if (now - s.createdAt > 10_000) room.pendingShots.delete(id);
  }

  broadcast(room, "shot-fired", {
    shotId,
    shooterId,
    shooterName: shooter.name,
    heading: shooter.heading,
    damageType,
    timestamp: now,
    expiresAt: shot.expiresAt,
  });
  broadcast(room, "ammo-update", { playerId: shooterId, ammo: shooter.ammo, reserveAmmo: shooter.reserveAmmo });

  return { room, shot, ammo: shooter.ammo };
}

export function reload(code: string, playerId: string) {
  const room = rooms.get(code);
  const player = room?.players.get(playerId);
  if (!room || !player) return { error: "Player not found" as const };
  if (!player.alive) return { error: "You are eliminated" as const };
  if (player.ammo >= player.maxAmmo) return { error: "Magazine already full" as const };
  if (player.reserveAmmo <= 0) return { error: "No reserve ammo" as const };
  const needed = player.maxAmmo - player.ammo;
  const take = Math.min(needed, player.reserveAmmo);
  player.ammo += take;
  player.reserveAmmo -= take;
  broadcast(room!, "ammo-update", { playerId, ammo: player.ammo, reserveAmmo: player.reserveAmmo });
  return { room, ammo: player.ammo, reserveAmmo: player.reserveAmmo };
}

function applyDamage(room: Room, target: Player, shooter: Player, damage: number, damageType: DamageType) {
  let remaining = damage;
  if (target.armor > 0) {
    const absorbed = Math.min(target.armor, remaining);
    target.armor -= absorbed;
    remaining -= absorbed;
  }
  target.hp = Math.max(0, target.hp - remaining);
  shooter.damageDealt += damage;
  if (damageType === "headshot") shooter.headshots += 1;

  broadcast(room, "hit-confirmed", {
    targetId: target.id,
    targetName: target.name,
    shooterId: shooter.id,
    shooterName: shooter.name,
    damage,
    damageType,
    targetHp: target.hp,
    targetArmor: target.armor,
  });

  if (target.hp <= 0 && target.alive) {
    target.alive = false;
    target.deaths += 1;
    shooter.kills += 1;
    broadcast(room, "player-eliminated", {
      targetId: target.id,
      targetName: target.name,
      shooterId: shooter.id,
      shooterName: shooter.name,
    });
    checkGameOver(room);
  }
  broadcast(room, "state", roomSnapshot(room));
}

function checkGameOver(room: Room) {
  if (room.status !== "active") return;
  const alive = Array.from(room.players.values()).filter((p) => p.alive);
  if (alive.length <= 1 && room.players.size > 1) {
    room.status = "ended";
    const winner = alive[0];
    const ranked = Array.from(room.players.values()).sort((a, b) => {
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      return b.kills - a.kills;
    });
    broadcast(room, "game-over", {
      winnerId: winner?.id ?? null,
      winnerName: winner?.name ?? null,
      players: ranked.map(serializePlayer),
    });
    gameBus.emit("game-over", {
      roomCode: room.code,
      winnerId: winner?.id ?? null,
      players: ranked.map((p, idx) => ({
        name: p.name,
        kills: p.kills,
        deaths: p.deaths,
        headshots: p.headshots,
        damageDealt: p.damageDealt,
        placement: idx + 1,
        won: p.id === winner?.id,
      })),
    });
  }
}

// ---------------------------------------------------------------------------
// REPORT HIT: called by a *target's* device after its filtered microphone
// picked up the 19kHz ultrasonic ping. The server re-validates the compass
// heading opposition server-side so the game cannot be cheated by a modified
// client claiming an out-of-tolerance heading.
// ---------------------------------------------------------------------------
export function reportHit(code: string, targetId: string, shotId: string, targetHeading: number) {
  const room = rooms.get(code);
  if (!room) return { error: "Room not found" as const };
  const target = room.players.get(targetId);
  if (!target) return { error: "Player not found" as const };
  const shot = room.pendingShots.get(shotId);
  if (!shot) return { error: "Shot expired or unknown" as const };
  if (shot.resolved) return { error: "Shot already resolved", alreadyResolved: true as const };
  if (shot.shooterId === targetId) return { error: "Cannot shoot yourself" as const };
  if (!target.alive) return { error: "Target already eliminated" as const };
  const now = Date.now();
  if (now > shot.expiresAt) return { error: "Detection window expired" as const };

  const heading = ((targetHeading % 360) + 360) % 360;
  const diff = angularDiff(heading, shot.heading);
  const oppositeDiff = Math.abs(diff - 180);
  if (oppositeDiff > HEADING_TOLERANCE_DEG) {
    return { error: "Heading does not align with shooter", diff: oppositeDiff } as const;
  }

  // First valid confirmation wins the shot.
  shot.resolved = true;
  const shooter = room.players.get(shot.shooterId);
  if (!shooter) return { error: "Shooter left the game" as const };

  applyDamage(room, target, shooter, shot.damage, shot.damageType);
  return { room, shot, target };
}

// ---------------------------------------------------------------------------
// MEDKIT: usable exactly once per match, takes 3s to "channel". We keep the
// timer authoritative on the server so it can't be sped up client-side.
// ---------------------------------------------------------------------------
const KIT_CHANNEL_MS = 3000;
const KIT_HEAL = 50;

export function useKit(code: string, playerId: string) {
  const room = rooms.get(code);
  const player = room?.players.get(playerId);
  if (!room || !player) return { error: "Player not found" as const };
  if (!player.alive) return { error: "You are eliminated" as const };
  if (player.hasUsedKit || player.usingKit) return { error: "Med-kit already used" as const };
  if (player.hp >= player.maxHp) return { error: "HP already full" as const };

  player.usingKit = true;
  broadcast(room, "kit-start", { playerId, durationMs: KIT_CHANNEL_MS });

  setTimeout(() => {
    const r = rooms.get(code);
    const p = r?.players.get(playerId);
    if (!r || !p) return;
    p.usingKit = false;
    p.hasUsedKit = true;
    if (p.alive) {
      p.hp = Math.min(p.maxHp, p.hp + KIT_HEAL);
      broadcast(r, "kit-complete", { playerId, hp: p.hp, cancelled: false });
    } else {
      broadcast(r, "kit-complete", { playerId, hp: p.hp, cancelled: true });
    }
    broadcast(r, "state", roomSnapshot(r));
  }, KIT_CHANNEL_MS);

  return { room, player };
}

export function subscribe(code: string, listener: (msg: { event: string; data: unknown }) => void) {
  const room = rooms.get(code);
  if (!room) return () => {};
  room.emitter.on("event", listener);
  return () => room.emitter.off("event", listener);
}

export function touchPlayer(code: string, playerId: string) {
  const room = rooms.get(code);
  const player = room?.players.get(playerId);
  if (player) player.lastSeen = Date.now();
}
