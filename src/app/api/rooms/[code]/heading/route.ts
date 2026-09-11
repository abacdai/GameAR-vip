import { NextRequest } from "next/server";
import { updateHeading } from "@/lib/game-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/rooms/:code/heading { playerId, heading }
// Lightweight periodic sync of compass heading so the lobby / spectator HUD
// (and reconnects) always have a recent value even before the next shot.
export async function POST(req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const { playerId, heading } = body ?? {};
  if (typeof playerId === "string" && typeof heading === "number") {
    updateHeading(code.trim(), playerId, heading);
  }
  return Response.json({ ok: true });
}
