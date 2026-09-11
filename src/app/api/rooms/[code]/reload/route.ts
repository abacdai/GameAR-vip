import { NextRequest } from "next/server";
import { reload } from "@/lib/game-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/rooms/:code/reload { playerId } -> refills magazine from reserve ammo
export async function POST(req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const playerId = typeof body.playerId === "string" ? body.playerId : "";
  const result = reload(code.trim(), playerId);
  if ("error" in result) return Response.json({ error: result.error }, { status: 400 });
  return Response.json({ ammo: result.ammo, reserveAmmo: result.reserveAmmo });
}
