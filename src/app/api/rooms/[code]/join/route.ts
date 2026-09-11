import { NextRequest } from "next/server";
import { joinRoom, roomSnapshot, serializePlayer } from "@/lib/game-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/rooms/:code/join  { name } -> joins an existing lobby
export async function POST(req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return Response.json({ error: "Name is required" }, { status: 400 });
  }
  const result = joinRoom(code.trim(), name);
  if ("error" in result) {
    return Response.json({ error: result.error }, { status: 400 });
  }
  return Response.json({
    room: roomSnapshot(result.room),
    player: serializePlayer(result.player),
    playerId: result.player.id,
  });
}
