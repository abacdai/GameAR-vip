// Database schema for the AR Laser Tag game.
//
// Realtime match state (HP, ammo, room membership, etc.) lives entirely in
// server memory (see `src/lib/game-store.ts`) because it needs to mutate many
// times per second and does not need to survive a server restart.
//
// Postgres is only used for durable data that should persist across matches:
// a simple post-game leaderboard of who won / how many kills each player got.
import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

export const gameResults = pgTable("game_results", {
  id: serial("id").primaryKey(),
  roomCode: text("room_code").notNull(),
  playerName: text("player_name").notNull(),
  kills: integer("kills").notNull().default(0),
  deaths: integer("deaths").notNull().default(0),
  headshots: integer("headshots").notNull().default(0),
  damageDealt: integer("damage_dealt").notNull().default(0),
  placement: integer("placement").notNull().default(0),
  won: boolean("won").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
