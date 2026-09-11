import { NextRequest } from "next/server";
import { startGame, roomSnapshot } from "@/lib/game-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/rooms/:code/start  { playerId } -> host starts the match
export async function POST(req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const playerId = typeof body.playerId === "string" ? body.playerId : "";
  const result = startGame(code.trim(), playerId);
  if ("error" in result) return Response.json({ error: result.error }, { status: 400 });
  return Response.json({ room: roomSnapshot(result.room) });
}
