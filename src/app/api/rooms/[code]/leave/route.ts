import { NextRequest } from "next/server";
import { leaveRoom } from "@/lib/game-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/rooms/:code/leave { playerId }
export async function POST(req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const playerId = typeof body.playerId === "string" ? body.playerId : "";
  if (playerId) leaveRoom(code.trim(), playerId);
  return Response.json({ ok: true });
}
