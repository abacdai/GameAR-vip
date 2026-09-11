// Subscribes to the in-memory game engine's "game-over" events and persists
// a durable record of each match to Postgres via Drizzle, plus exposes a
// helper to read the all-time leaderboard back out.
import { db } from "@/db";
import { gameResults } from "@/db/schema";
import { gameBus } from "@/lib/game-store";
import { desc, sql } from "drizzle-orm";

interface GameOverPayload {
  roomCode: string;
  winnerId: string | null;
  players: Array<{
    name: string;
    kills: number;
    deaths: number;
    headshots: number;
    damageDealt: number;
    placement: number;
    won: boolean;
  }>;
}

const globalForLeaderboard = globalThis as typeof globalThis & {
  __arLaserTagLeaderboardInit?: boolean;
};

export function initLeaderboard() {
  if (globalForLeaderboard.__arLaserTagLeaderboardInit) return;
  globalForLeaderboard.__arLaserTagLeaderboardInit = true;

  gameBus.on("game-over", (payload: GameOverPayload) => {
    void persistGameResult(payload);
  });
}

async function persistGameResult(payload: GameOverPayload) {
  try {
    if (!payload.players.length) return;
    await db.insert(gameResults).values(
      payload.players.map((p) => ({
        roomCode: payload.roomCode,
        playerName: p.name,
        kills: p.kills,
        deaths: p.deaths,
        headshots: p.headshots,
        damageDealt: p.damageDealt,
        placement: p.placement,
        won: p.won,
      })),
    );
  } catch (err) {
    console.error("[leaderboard] failed to persist game result", err);
  }
}

export async function getTopPlayers(limit = 10) {
  const rows = await db
    .select({
      playerName: gameResults.playerName,
      wins: sql<number>`sum(case when ${gameResults.won} then 1 else 0 end)`.mapWith(Number),
      matches: sql<number>`count(*)`.mapWith(Number),
      kills: sql<number>`sum(${gameResults.kills})`.mapWith(Number),
      headshots: sql<number>`sum(${gameResults.headshots})`.mapWith(Number),
      damageDealt: sql<number>`sum(${gameResults.damageDealt})`.mapWith(Number),
    })
    .from(gameResults)
    .groupBy(gameResults.playerName)
    .orderBy(desc(sql`sum(case when ${gameResults.won} then 1 else 0 end)`), desc(sql`sum(${gameResults.kills})`))
    .limit(limit);
  return rows;
}
