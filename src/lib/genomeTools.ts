// Tool surface for "Ask the Genome" — the agentic music-research chat.
//
// Each tool is a thin, typed wrapper over a capability the app already has:
// the MusicBrainz/Wikidata/Last.fm knowledge graph (ingest + store), the iTunes
// catalog, the CLAP audio-embedding search over the upload library, per-track
// DSP/Flamingo analyses, and Genius credits + lyrics. The point is that the
// agent can *compose* these — e.g. "find a library track that sounds like rain
// on glass but shares a producer with Radiohead" becomes search_by_sound +
// get_artist_dna + get_song_credits_and_lyrics, planned by the model.
//
// Tools return compact JSON strings (token-budget friendly) and never throw:
// failures come back as { error } so the model can recover or relay them.

import { ingestArtist, buildReport } from "./ingest";
import { isIngested } from "./store";
import { searchArtists } from "./musicbrainz";
import { getTopTracks } from "./itunes";
import { cloudRunAuthHeader } from "./cloudRun";
import {
  findNearestUploads,
  getUpload,
  getUploadVector,
  listUploads,
} from "./store";
import { getSongMeta, getLyricsText } from "./genius";

const AUDIO_SERVICE = process.env.AUDIO_SERVICE_URL || "http://127.0.0.1:8000";

// ---- JSON-schema tool definitions (shape matches Anthropic.Tool) -----------

export interface GenomeTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const TOOLS: GenomeTool[] = [
  {
    name: "search_artist",
    description:
      "Resolve an artist name to MusicBrainz candidates. ALWAYS call this first to get an artist's `mbid` before calling get_artist_dna. Returns up to 8 matches; pick the one whose type/country/years fit what the user means.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Artist name to search for." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_artist_dna",
    description:
      "The core knowledge-graph lookup. Given a MusicBrainz `mbid` (from search_artist), returns the artist's DNA: who influenced them and whom they influenced (Wikidata), collaborators with their roles incl. producers/engineers (MusicBrainz), sonic neighbors and top tags (Last.fm), and the genre arc across their discography. Use this to answer lineage, collaboration, producer, and genre-evolution questions, and to find shared collaborators between two artists.",
    input_schema: {
      type: "object",
      properties: {
        mbid: { type: "string", description: "MusicBrainz artist id." },
      },
      required: ["mbid"],
    },
  },
  {
    name: "get_artist_top_tracks",
    description:
      "Playable catalog for an artist from iTunes: top tracks with 30-second preview URLs, album, release year and genre. Use when the user wants something to listen to, or to ground a claim in specific songs.",
    input_schema: {
      type: "object",
      properties: {
        artist_name: { type: "string", description: "Artist name." },
      },
      required: ["artist_name"],
    },
  },
  {
    name: "search_by_sound",
    description:
      "Semantic audio search over the user's uploaded track library using CLAP embeddings (text→audio). Describe a SOUND, not a name — e.g. 'warm lo-fi tape hiss with a slow boom-bap beat', 'rain on glass', 'aggressive distorted bass'. Returns the closest library tracks with a similarity distance (lower = closer). Only searches uploaded tracks; returns empty if the library is empty.",
    input_schema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "Natural-language description of the desired sound.",
        },
      },
      required: ["description"],
    },
  },
  {
    name: "find_sonic_twins",
    description:
      "Audio→audio similarity: given a library track id (from search_by_sound or list_my_library), return the other library tracks that sound most like it, by CLAP embedding distance.",
    input_schema: {
      type: "object",
      properties: {
        track_id: { type: "string", description: "Upload/library track id." },
      },
      required: ["track_id"],
    },
  },
  {
    name: "get_track_details",
    description:
      "Full analysis of one library track id: measured DSP features (key, tempo, chord progression, energy arc, brightness, dynamics), discriminative instrument/mood/genre tags, the Music Flamingo audio-model read, and the producer-style breakdown. Use to explain or compare specific tracks.",
    input_schema: {
      type: "object",
      properties: {
        track_id: { type: "string", description: "Upload/library track id." },
      },
      required: ["track_id"],
    },
  },
  {
    name: "list_my_library",
    description:
      "List the user's uploaded tracks (id, title, key, tempo, duration). Use to see what audio is available before searching or comparing, or when the user refers to 'my tracks'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_song_credits_and_lyrics",
    description:
      "Genius credits (producers, writers, release date) plus the lyrics for a specific song. Use for songwriting/production-credit questions and lyric-themed queries ('songs about X'). Lyrics may be unavailable for obscure tracks.",
    input_schema: {
      type: "object",
      properties: {
        artist: { type: "string", description: "Artist name." },
        title: { type: "string", description: "Song title." },
      },
      required: ["artist", "title"],
    },
  },
];

// ---- executors -------------------------------------------------------------

type ToolResult = { ok: boolean; content: string };

function ok(data: unknown): ToolResult {
  return { ok: true, content: JSON.stringify(data) };
}
function fail(message: string): ToolResult {
  return { ok: false, content: JSON.stringify({ error: message }) };
}

// MusicBrainz ids are UUIDs; influence nodes that only exist in Wikidata carry a
// synthetic "wd:Q…" id, which is NOT linkable to /artist/[mbid]. Emit `mbid`
// only when it's a real MusicBrainz id so the agent links the right entity.
function isMbid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id);
}

function entities(
  nodes: { id: string; name: string; group: string; detail?: string }[],
  group: string
) {
  return nodes
    .filter((n) => n.group === group)
    .map((n) => ({ name: n.name, mbid: isMbid(n.id) ? n.id : undefined }));
}

async function runArtistDna(mbid: string): Promise<ToolResult> {
  if (!mbid) return fail("mbid is required");
  if (!(await isIngested(mbid))) await ingestArtist(mbid);
  const r = await buildReport(mbid);
  return ok({
    artist: {
      name: r.artist.name,
      mbid: r.artist.mbid,
      country: r.artist.country,
      type: r.artist.type,
      years: [r.artist.beginYear, r.artist.endYear].filter(Boolean).join("–"),
    },
    influenced_by: entities(r.family.nodes, "influence"),
    influenced: entities(r.family.nodes, "descendant"),
    collaborators: r.collaborators.nodes
      .filter((n) => n.group === "collaborator")
      .slice(0, 25)
      .map((n) => ({
        name: n.name,
        role: n.detail,
        mbid: isMbid(n.id) ? n.id : undefined,
      })),
    similar: r.similar
      .slice(0, 12)
      .map((s) => ({ name: s.name, match: s.match, mbid: s.mbid })),
    tags: r.tags,
    genre_timeline: r.timeline
      .slice(0, 20)
      .map((t) => ({ year: t.year, release: t.release, genres: t.genres })),
  });
}

async function embedText(text: string): Promise<number[] | null> {
  const auth = await cloudRunAuthHeader(AUDIO_SERVICE);
  const res = await fetch(`${AUDIO_SERVICE}/embed-text`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { embedding?: number[] };
  return Array.isArray(j.embedding) ? j.embedding : null;
}

async function runSearchBySound(description: string): Promise<ToolResult> {
  if (!description) return fail("description is required");
  let vec: number[] | null;
  try {
    vec = await embedText(description);
  } catch (e) {
    return fail(
      `audio service unavailable (${e instanceof Error ? e.message : "error"})`
    );
  }
  if (!vec) return fail("could not embed the query (audio service down?)");
  const hits = await findNearestUploads(vec, 10);
  if (hits.length === 0)
    return ok({ hits: [], note: "the upload library has no embedded tracks yet" });
  return ok({ hits });
}

async function runSonicTwins(trackId: string): Promise<ToolResult> {
  if (!trackId) return fail("track_id is required");
  const vec = await getUploadVector(trackId);
  if (!vec) return fail("that track has no CLAP embedding (not analyzed yet)");
  const hits = await findNearestUploads(vec, 8, trackId);
  return ok({ hits });
}

async function runTrackDetails(trackId: string): Promise<ToolResult> {
  if (!trackId) return fail("track_id is required");
  const rec = await getUpload(trackId);
  if (!rec) return fail("no library track with that id");
  // Trim the raw feature blob so we don't blow the token budget; keep the
  // human-meaningful measured fields plus the model reads.
  const features =
    rec.features && typeof rec.features === "object"
      ? JSON.stringify(rec.features).slice(0, 1800)
      : undefined;
  return ok({
    id: rec.id,
    title: rec.title,
    artist: rec.artist,
    key: rec.key,
    tempo: rec.tempo,
    duration_sec: rec.durationSec,
    tags: rec.tags,
    features,
    flamingo: rec.flamingo,
    producer_breakdown: rec.review,
  });
}

async function runLibrary(): Promise<ToolResult> {
  const list = await listUploads(50);
  return ok({
    tracks: list.map((u) => ({
      id: u.id,
      title: u.title,
      key: u.key,
      tempo: u.tempo,
      duration_sec: u.durationSec,
    })),
  });
}

async function runCreditsAndLyrics(
  artist: string,
  title: string
): Promise<ToolResult> {
  if (!artist || !title) return fail("artist and title are required");
  const meta = await getSongMeta(artist, title);
  const lyricsFull = await getLyricsText(artist, title, meta?.url);
  const lyrics = lyricsFull ? lyricsFull.slice(0, 1600) : null;
  return ok({
    credits: meta
      ? {
          title: meta.title,
          artist: meta.artist,
          release_date: meta.releaseDate,
          producers: meta.producers,
          writers: meta.writers,
        }
      : null,
    lyrics,
    lyrics_truncated: !!lyricsFull && lyricsFull.length > 1600,
  });
}

/** Dispatch a tool call by name. Never throws — wraps failures as { error }. */
export async function runTool(
  name: string,
  input: Record<string, unknown>
): Promise<ToolResult> {
  try {
    switch (name) {
      case "search_artist":
        return ok({ artists: await searchArtists(String(input.query || "")) });
      case "get_artist_dna":
        return await runArtistDna(String(input.mbid || ""));
      case "get_artist_top_tracks":
        return ok({
          tracks: await getTopTracks(String(input.artist_name || "")),
        });
      case "search_by_sound":
        return await runSearchBySound(String(input.description || ""));
      case "find_sonic_twins":
        return await runSonicTwins(String(input.track_id || ""));
      case "get_track_details":
        return await runTrackDetails(String(input.track_id || ""));
      case "list_my_library":
        return await runLibrary();
      case "get_song_credits_and_lyrics":
        return await runCreditsAndLyrics(
          String(input.artist || ""),
          String(input.title || "")
        );
      default:
        return fail(`unknown tool: ${name}`);
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : "tool failed");
  }
}
