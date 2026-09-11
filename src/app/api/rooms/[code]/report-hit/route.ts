import { NextRequest } from "next/server";
import { reportHit } from "@/lib/game-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/rooms/:code/report-hit
// body: { playerId, shotId, heading }
//
// Called by a TARGET device the moment its highpass-filtered microphone
// detects the 19kHz ultrasonic ping. The server re-validates that this
// player's compass heading is (within tolerance) exactly opposite the
// shooter's heading before confirming the hit and applying damage.
export async function POST(req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const { playerId, shotId, heading } = body ?? {};
  if (typeof playerId !== "string" || typeof shotId !== "string" || typeof heading !== "number") {
    return Response.json({ error: "playerId, shotId and heading are required" }, { status: 400 });
  }
  const result = reportHit(code.trim(), playerId, shotId, heading);
  if ("error" in result) return Response.json({ error: result.error }, { status: 400 });
  return Response.json({ ok: true });
}
