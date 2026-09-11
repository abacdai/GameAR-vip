import { NextRequest } from "next/server";
import { useKit } from "@/lib/game-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/rooms/:code/use-kit  { playerId }
// Starts the 3-second med-kit channel (server-authoritative timer). Can only
// succeed once per player per match and heals 50 HP on completion.
export async function POST(req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const playerId = typeof body.playerId === "string" ? body.playerId : "";
  const result = useKit(code.trim(), playerId);
  if ("error" in result) return Response.json({ error: result.error }, { status: 400 });
  return Response.json({ ok: true });
}
