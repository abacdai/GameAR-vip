import { getRoom, roomSnapshot } from "@/lib/game-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/rooms/:code/state -> one-shot snapshot fetch (initial load / reconnect)
export async function GET(_req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const room = getRoom(code.trim());
  if (!room) return Response.json({ error: "Room not found" }, { status: 404 });
  return Response.json({ room: roomSnapshot(room) });
}
