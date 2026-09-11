// Next.js instrumentation hook — runs once when the Node.js server process
// starts. We use it purely to attach the leaderboard listener to the
// in-memory game event bus so match results get written to Postgres even if
// no HTTP request has hit an API route yet.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initLeaderboard } = await import("@/lib/leaderboard");
    initLeaderboard();
  }
}
