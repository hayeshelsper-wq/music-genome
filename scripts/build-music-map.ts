// Build the Living Map of Music corpus: a curated set of landmark tracks across
// 1950→2025, each resolved to an iTunes preview, embedded with CLAP (via the
// local audio-service), and projected to 2D with PCA. Writes:
//   public/music-map.json          — points for the client (no vectors)
//   src/data/musicMapEmbeddings.json — id→{x,y,vec} for server-side "place your track"
//
// Run with the local audio-service up:  npx tsx scripts/build-music-map.ts
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { getTrackPreview } from "../src/lib/itunes";

const AUDIO = process.env.AUDIO_SERVICE_URL || "http://127.0.0.1:8000";

interface Seed { artist: string; title: string; year: number; genre: string }

// Curated landmarks — broad across eras + genres, chosen to have iTunes previews.
const CORPUS: Seed[] = [
  { artist: "Muddy Waters", title: "Hoochie Coochie Man", year: 1954, genre: "Roots" },
  { artist: "Chuck Berry", title: "Johnny B. Goode", year: 1958, genre: "Rock" },
  { artist: "Elvis Presley", title: "Jailhouse Rock", year: 1957, genre: "Rock" },
  { artist: "Miles Davis", title: "So What", year: 1959, genre: "Roots" },
  { artist: "Johnny Cash", title: "Ring of Fire", year: 1963, genre: "Roots" },
  { artist: "The Beach Boys", title: "Good Vibrations", year: 1966, genre: "Pop" },
  { artist: "The Beatles", title: "Hey Jude", year: 1968, genre: "Rock" },
  { artist: "Bob Dylan", title: "Like a Rolling Stone", year: 1965, genre: "Rock" },
  { artist: "The Rolling Stones", title: "(I Can't Get No) Satisfaction", year: 1965, genre: "Rock" },
  { artist: "Jimi Hendrix", title: "Purple Haze", year: 1967, genre: "Rock" },
  { artist: "James Brown", title: "I Got You (I Feel Good)", year: 1965, genre: "Soul/Funk" },
  { artist: "Aretha Franklin", title: "Respect", year: 1967, genre: "Soul/Funk" },
  { artist: "The Velvet Underground", title: "Sunday Morning", year: 1967, genre: "Indie/Alt" },
  { artist: "Led Zeppelin", title: "Whole Lotta Love", year: 1969, genre: "Rock" },
  { artist: "Black Sabbath", title: "Paranoid", year: 1970, genre: "Punk/Metal" },
  { artist: "Pink Floyd", title: "Money", year: 1973, genre: "Rock" },
  { artist: "David Bowie", title: "Heroes", year: 1977, genre: "Rock" },
  { artist: "Stevie Wonder", title: "Superstition", year: 1972, genre: "Soul/Funk" },
  { artist: "Parliament", title: "Flash Light", year: 1977, genre: "Soul/Funk" },
  { artist: "Donna Summer", title: "I Feel Love", year: 1977, genre: "Disco/Electronic" },
  { artist: "Kraftwerk", title: "The Robots", year: 1978, genre: "Disco/Electronic" },
  { artist: "Ramones", title: "Blitzkrieg Bop", year: 1976, genre: "Punk/Metal" },
  { artist: "Bob Marley & The Wailers", title: "Could You Be Loved", year: 1980, genre: "Soul/Funk" },
  { artist: "Michael Jackson", title: "Billie Jean", year: 1982, genre: "Pop" },
  { artist: "Prince", title: "When Doves Cry", year: 1984, genre: "Pop" },
  { artist: "Madonna", title: "Like a Prayer", year: 1989, genre: "Pop" },
  { artist: "New Order", title: "Blue Monday", year: 1983, genre: "Disco/Electronic" },
  { artist: "Depeche Mode", title: "Personal Jesus", year: 1989, genre: "Disco/Electronic" },
  { artist: "The Cure", title: "Just Like Heaven", year: 1987, genre: "Indie/Alt" },
  { artist: "Metallica", title: "Master of Puppets", year: 1986, genre: "Punk/Metal" },
  { artist: "Run-D.M.C.", title: "Walk This Way", year: 1986, genre: "Hip-Hop" },
  { artist: "Public Enemy", title: "Fight the Power", year: 1989, genre: "Hip-Hop" },
  { artist: "Nirvana", title: "Smells Like Teen Spirit", year: 1991, genre: "Grunge" },
  { artist: "Dr. Dre", title: "Nuthin' but a 'G' Thang", year: 1992, genre: "Hip-Hop" },
  { artist: "Wu-Tang Clan", title: "C.R.E.A.M.", year: 1993, genre: "Hip-Hop" },
  { artist: "The Notorious B.I.G.", title: "Juicy", year: 1994, genre: "Hip-Hop" },
  { artist: "Radiohead", title: "Paranoid Android", year: 1997, genre: "Indie/Alt" },
  { artist: "Oasis", title: "Wonderwall", year: 1995, genre: "Indie/Alt" },
  { artist: "Beck", title: "Loser", year: 1993, genre: "Indie/Alt" },
  { artist: "Daft Punk", title: "Around the World", year: 1997, genre: "Disco/Electronic" },
  { artist: "Aphex Twin", title: "Windowlicker", year: 1999, genre: "Disco/Electronic" },
  { artist: "Britney Spears", title: "...Baby One More Time", year: 1998, genre: "Pop" },
  { artist: "OutKast", title: "Hey Ya!", year: 2003, genre: "Hip-Hop" },
  { artist: "The Strokes", title: "Last Nite", year: 2001, genre: "Indie/Alt" },
  { artist: "Eminem", title: "Lose Yourself", year: 2002, genre: "Hip-Hop" },
  { artist: "Beyoncé", title: "Crazy in Love", year: 2003, genre: "R&B" },
  { artist: "Arcade Fire", title: "Wake Up", year: 2004, genre: "Indie/Alt" },
  { artist: "Kanye West", title: "Stronger", year: 2007, genre: "Hip-Hop" },
  { artist: "Amy Winehouse", title: "Rehab", year: 2006, genre: "R&B" },
  { artist: "LCD Soundsystem", title: "All My Friends", year: 2007, genre: "Indie/Alt" },
  { artist: "M.I.A.", title: "Paper Planes", year: 2007, genre: "Hip-Hop" },
  { artist: "Gnarls Barkley", title: "Crazy", year: 2006, genre: "R&B" },
  { artist: "Kendrick Lamar", title: "Alright", year: 2015, genre: "Hip-Hop" },
  { artist: "Daft Punk", title: "Get Lucky", year: 2013, genre: "Disco/Electronic" },
  { artist: "Adele", title: "Rolling in the Deep", year: 2010, genre: "Pop" },
  { artist: "Tame Impala", title: "The Less I Know the Better", year: 2015, genre: "Indie/Alt" },
  { artist: "Frank Ocean", title: "Thinkin Bout You", year: 2012, genre: "R&B" },
  { artist: "Drake", title: "Hotline Bling", year: 2015, genre: "Hip-Hop" },
  { artist: "Lorde", title: "Royals", year: 2013, genre: "Pop" },
  { artist: "The Weeknd", title: "Blinding Lights", year: 2019, genre: "Pop" },
  { artist: "Bon Iver", title: "Holocene", year: 2011, genre: "Indie/Alt" },
  { artist: "Billie Eilish", title: "bad guy", year: 2019, genre: "Pop" },
  { artist: "Olivia Rodrigo", title: "good 4 u", year: 2021, genre: "Pop" },
  { artist: "Bad Bunny", title: "Tití Me Preguntó", year: 2022, genre: "Hip-Hop" },
  { artist: "Doja Cat", title: "Say So", year: 2020, genre: "Pop" },
  { artist: "Phoebe Bridgers", title: "Kyoto", year: 2020, genre: "Indie/Alt" },
  { artist: "SZA", title: "Kill Bill", year: 2022, genre: "R&B" },
  { artist: "Steve Lacy", title: "Bad Habit", year: 2022, genre: "R&B" },
  { artist: "Fred again..", title: "Delilah (pull me out of this)", year: 2022, genre: "Disco/Electronic" },
];

async function embed(previewUrl: string): Promise<number[] | null> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.AUDIO_TOKEN) headers.Authorization = `Bearer ${process.env.AUDIO_TOKEN}`;
  const res = await fetch(`${AUDIO}/analyze`, {
    method: "POST",
    headers,
    body: JSON.stringify({ previewUrl }),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { embedding?: number[] };
  return Array.isArray(j.embedding) ? j.embedding : null;
}

// ---- PCA → 2D (top-2 principal components via power iteration) -------------
function pca2d(rows: number[][]): { x: number; y: number }[] {
  const n = rows.length, d = rows[0].length;
  const mean = new Array(d).fill(0);
  for (const r of rows) for (let i = 0; i < d; i++) mean[i] += r[i] / n;
  const X = rows.map((r) => r.map((v, i) => v - mean[i]));

  const topPC = (M: number[][]): number[] => {
    let v = new Array(d).fill(0).map(() => Math.random() - 0.5);
    v = normalize(v);
    for (let it = 0; it < 150; it++) {
      // w = Mᵀ (M v)
      const u = M.map((row) => dot(row, v));            // n
      const w = new Array(d).fill(0);
      for (let r = 0; r < M.length; r++) for (let i = 0; i < d; i++) w[i] += M[r][i] * u[r];
      v = normalize(w);
    }
    return v;
  };
  const pc1 = topPC(X);
  const Xd = X.map((row) => { const p = dot(row, pc1); return row.map((val, i) => val - p * pc1[i]); });
  const pc2 = topPC(Xd);

  const pts = X.map((row) => ({ x: dot(row, pc1), y: dot(row, pc2) }));
  // normalize into [0.04, 0.96] on each axis
  const norm01 = (vals: number[]) => {
    const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
    return vals.map((v) => 0.04 + 0.92 * ((v - lo) / span));
  };
  const xs = norm01(pts.map((p) => p.x)), ys = norm01(pts.map((p) => p.y));
  return pts.map((_p, i) => ({ x: round4(xs[i]), y: round4(ys[i]) }));
}

const dot = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const normalize = (v: number[]) => { const m = Math.sqrt(dot(v, v)) || 1; return v.map((x) => x / m); };
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

async function main() {
  const built: (Seed & { previewUrl: string; image?: string; vec: number[]; id: string })[] = [];
  for (let i = 0; i < CORPUS.length; i++) {
    const s = CORPUS[i];
    const tag = `[${i + 1}/${CORPUS.length}] ${s.artist} — ${s.title}`;
    try {
      const tk = await getTrackPreview(s.artist, s.title);
      if (!tk?.previewUrl) { console.log(`SKIP (no preview) ${tag}`); continue; }
      const vec = await embed(tk.previewUrl);
      if (!vec) { console.log(`SKIP (no embedding) ${tag}`); continue; }
      built.push({
        ...s,
        id: `${slug(s.artist)}--${slug(s.title)}`,
        previewUrl: tk.previewUrl,
        image: tk.artworkUrl,
        vec,
      });
      console.log(`OK   ${tag}`);
    } catch (e) {
      console.log(`ERR  ${tag}: ${e instanceof Error ? e.message : e}`);
    }
  }

  if (built.length < 5) throw new Error(`only ${built.length} tracks embedded — aborting`);

  const coords = pca2d(built.map((b) => b.vec));
  const tracks = built.map((b, i) => ({
    id: b.id, title: b.title, artist: b.artist, year: b.year, genre: b.genre,
    x: coords[i].x, y: coords[i].y, previewUrl: b.previewUrl, image: b.image || null,
  }));

  writeFileSync(
    join(process.cwd(), "public", "music-map.json"),
    JSON.stringify({ generatedAt: Date.now(), count: tracks.length, tracks }, null, 0)
  );

  // server-side placement data (vectors + positions)
  mkdirSync(join(process.cwd(), "src", "data"), { recursive: true });
  const embeddings = built.map((b, i) => ({
    id: b.id, title: b.title, artist: b.artist,
    x: coords[i].x, y: coords[i].y,
    vec: b.vec.map(round6),
  }));
  writeFileSync(
    join(process.cwd(), "src", "data", "musicMapEmbeddings.json"),
    JSON.stringify(embeddings, null, 0)
  );

  console.log(`\nDONE — ${tracks.length}/${CORPUS.length} tracks → public/music-map.json + src/data/musicMapEmbeddings.json`);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

main().catch((e) => { console.error(e); process.exit(1); });
