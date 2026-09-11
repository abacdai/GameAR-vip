import { getTopPlayers } from "@/lib/leaderboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/leaderboard -> all-time top players across every finished match
export async function GET() {
  try {
    const players = await getTopPlayers(10);
    return Response.json({ players });
  } catch (err) {
    console.error(err);
    return Response.json({ players: [] });
  }
}
