import { NextRequest } from "next/server";
import { createRoom, roomSnapshot, serializePlayer } from "@/lib/game-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/rooms  { name } -> creates a new room and returns the 4-digit code
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return Response.json({ error: "Name is required" }, { status: 400 });
    }
    const { room, player } = createRoom(name);
    return Response.json({
      room: roomSnapshot(room),
      player: serializePlayer(player),
      playerId: player.id,
    });
  } catch (err) {
    console.error(err);
    return Response.json({ error: "Failed to create room" }, { status: 500 });
  }
}
