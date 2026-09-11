import { getRoom, roomSnapshot, subscribe, touchPlayer } from "@/lib/game-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/rooms/:code/stream?playerId=...
//
// Server-Sent Events channel used in place of a Socket.io connection. It
// pushes every room event (player-joined, shot-fired, hit-confirmed,
// player-eliminated, kit-start/kit-complete, game-over, state, ...) to every
// connected client in the room in realtime over plain HTTP, which works
// through the single port this app is served on.
export async function GET(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const url = new URL(req.url);
  const playerId = url.searchParams.get("playerId") ?? "";
  const room = getRoom(code.trim());
  if (!room) {
    return new Response("Room not found", { status: 404 });
  }

  const encoder = new TextEncoder();
  let keepAlive: ReturnType<typeof setInterval>;
  let unsubscribe: () => void = () => {};

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // controller already closed
        }
      };

      // Initial snapshot so a freshly (re)connected client is in sync.
      send("state", roomSnapshot(room));

      unsubscribe = subscribe(code.trim(), (msg) => send(msg.event, msg.data));

      keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
          if (playerId) touchPlayer(code.trim(), playerId);
        } catch {
          clearInterval(keepAlive);
        }
      }, 15000);

      req.signal.addEventListener("abort", () => {
        clearInterval(keepAlive);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
    cancel() {
      clearInterval(keepAlive);
      unsubscribe();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
