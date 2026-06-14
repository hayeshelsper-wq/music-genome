// Pre-render a curated set of full Song X-Rays into the persistent cache, so the
// /showcase has instant examples (no Flamingo GPU cold start at demo time).
//
// Drives the DEPLOYED, gated endpoints exactly like the browser does: log in →
// GET /api/track/analyze → poll /api/track/flamingo until the read lands. The
// routes persist each completed X-Ray to Firestore (xrayCache). The first song
// pays the GPU cold start (~5-7 min image pull); the rest are fast.
//
// Usage:  WEB_URL=https://… AUTH_PASSWORD=… npx tsx scripts/build-xray-examples.ts
import { getTrackPreview } from "../src/lib/itunes";

const WEB = process.env.WEB_URL || "https://web-4dlnl52txa-uc.a.run.app";
const PASSWORD = process.env.AUTH_PASSWORD || "";

const SONGS = [
  { artist: "Michael Jackson", title: "Billie Jean" },
  { artist: "Radiohead", title: "Paranoid Android" },
  { artist: "Kendrick Lamar", title: "Alright" },
  { artist: "Amy Winehouse", title: "Rehab" },
  { artist: "Daft Punk", title: "Get Lucky" },
  { artist: "Nirvana", title: "Smells Like Teen Spirit" },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function login(): Promise<string> {
  const res = await fetch(`${WEB}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const set = (res.headers.getSetCookie?.() || []).join("; ");
  const cookie = set.split(/,(?=\s*\w+=)/).map((c) => c.split(";")[0].trim()).join("; ");
  if (!cookie) throw new Error("login failed — no cookie (check AUTH_PASSWORD)");
  return cookie;
}

async function render(cookie: string, artist: string, title: string): Promise<boolean> {
  const tk = await getTrackPreview(artist, title);
  if (!tk?.previewUrl) { console.log(`SKIP (no preview) ${artist} — ${title}`); return false; }
  const qs = `previewUrl=${encodeURIComponent(tk.previewUrl)}&title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`;
  const headers = { Cookie: cookie };

  // 1. analyze (may come back with Flamingo already, or pending on a cold GPU)
  let a = await (await fetch(`${WEB}/api/track/analyze?${qs}`, { headers })).json();
  if (a.flamingoStatus === "complete" && a.flamingo) { console.log(`OK (cached/warm) ${artist} — ${title}`); return true; }

  // 2. poll the Flamingo backfill until the read lands (warms a cold GPU)
  for (let i = 0; i < 60; i++) {
    process.stdout.write(`  …${artist} — ${title}: flamingo poll ${i + 1}\r`);
    try {
      const bf = await (await fetch(`${WEB}/api/track/flamingo?${qs}`, { headers })).json();
      if (bf.flamingoStatus === "complete" && bf.flamingo) {
        console.log(`\nOK ${artist} — ${title} (flamingo landed)`);
        return true;
      }
    } catch { /* transient — keep polling */ }
    await sleep(15000);
  }
  console.log(`\nINCOMPLETE ${artist} — ${title} (flamingo never landed)`);
  return false;
}

async function main() {
  if (!PASSWORD) throw new Error("set AUTH_PASSWORD");
  console.log(`Pre-rendering ${SONGS.length} X-Rays via ${WEB} …`);
  const cookie = await login();
  let ok = 0;
  for (const s of SONGS) {
    try { if (await render(cookie, s.artist, s.title)) ok++; }
    catch (e) { console.log(`ERR ${s.artist} — ${s.title}: ${e instanceof Error ? e.message : e}`); }
  }
  console.log(`\nDONE — ${ok}/${SONGS.length} X-Rays pre-rendered + persisted to Firestore.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
