import { NextRequest } from "next/server";
import { fireShot, DamageType } from "@/lib/game-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_TYPES: DamageType[] = ["headshot", "bodyshot", "miss"];

// POST /api/rooms/:code/shoot
// body: { playerId, heading, damageType, damage }
//
// Called the instant the shooter taps "Shoot". The client has already:
//  1. Captured a single camera frame and run MediaPipe pose detection once
//     to classify headshot / bodyshot / miss against the crosshair.
//  2. Emitted the 19kHz ultrasonic ping via Web Audio API.
//  3. Read the current compass heading.
// The server opens a short confirmation window that other clients answer via
// /report-hit once their filtered microphone hears the ping.
export async function POST(req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const { playerId, heading, damageType, damage } = body ?? {};

  if (typeof playerId !== "string" || typeof heading !== "number") {
    return Response.json({ error: "playerId and heading are required" }, { status: 400 });
  }
  const type: DamageType = VALID_TYPES.includes(damageType) ? damageType : "miss";
  const dmg = type === "miss" ? 0 : Math.max(0, Math.min(100, Number(damage) || 0));

  const result = fireShot(code.trim(), playerId, heading, type, dmg);
  if ("error" in result) return Response.json({ error: result.error }, { status: 400 });

  return Response.json({ shotId: result.shot.id, ammo: result.ammo });
}
