import { db } from "@/db";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  await db.execute(sql`select 1`);

  return (
    <main className="grid min-h-screen place-items-center bg-[#03060a] px-6 py-12 text-white">
      <section className="w-full max-w-2xl rounded-3xl border border-[#00ffc84d] bg-gradient-to-b from-[#0f1622] to-[#060a10] p-10 text-center shadow-[0_24px_60px_rgba(0,255,200,0.08)]">
        <p className="m-0 text-sm uppercase tracking-[0.2em] text-[#7c93a8]">
          Browser-based · WebRTC-free · Works on any phone
        </p>
        <h1 className="mt-4 bg-gradient-to-r from-[#00ffc8] to-[#00b3ff] bg-clip-text text-[clamp(2rem,6vw,3.5rem)] font-extrabold leading-[1.05] text-transparent">
          AR Laser Tag
        </h1>
        <p className="mt-4 text-base text-[#c7dbe8]">
          Point your camera, pull the trigger. An inaudible 19&nbsp;kHz ultrasonic
          ping + compass handshake confirms who got hit, and a single-frame
          MediaPipe pose check decides headshot vs. bodyshot — all running at a
          smooth 60&nbsp;FPS on low-end phones, even in a noisy gym or hallway.
        </p>
        <a
          href="/lasertag/index.html"
          className="mt-8 inline-block w-full rounded-2xl bg-gradient-to-r from-[#00ffc8] to-[#00b3ff] px-8 py-4 text-lg font-extrabold tracking-wide text-[#00131a] no-underline"
        >
          ENTER THE ARENA
        </a>
        <ul className="mt-8 grid grid-cols-1 gap-2 text-left text-sm text-[#9fb4c6] sm:grid-cols-2">
          <li>🎯 Ultrasonic + compass hit detection</li>
          <li>🧠 Single-frame MediaPipe headshot AI</li>
          <li>🩹 One-time 3s med-kit (+50 HP)</li>
          <li>📡 Realtime lobbies for 5+ players</li>
        </ul>
      </section>
    </main>
  );
}
