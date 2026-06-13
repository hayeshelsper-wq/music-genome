// Spotify Web API — used ONLY as the identity/input layer for the playlist feed.
// We log the user in (Authorization Code + PKCE — the implicit/localhost flows
// were killed Nov 2025), then read their playlists/liked songs. We deliberately
// do NOT touch any deprecated endpoint (audio-features, recommendations, related
// artists, preview_url) — all of that is rebuilt from open sources keyed by the
// MusicBrainz MBID we resolve from each track's ISRC (external_ids.isrc).
//
// Dev-Mode reality (Feb 2026): max 5 allow-listed Premium users, batch
// Get-Several-* endpoints removed — fine, because Get Playlist Items already
// returns full track objects (incl. ISRC) in one paginated call.

import crypto from "crypto";
import { cookies } from "next/headers";
import type { NextResponse } from "next/server";

const AUTH = "https://accounts.spotify.com/authorize";
const TOKEN = "https://accounts.spotify.com/api/token";
const API = "https://api.spotify.com/v1";

// Scopes: read their playlists (private + collaborative), liked songs, top items.
const SCOPES = [
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-library-read",
  "user-top-read",
].join(" ");

export function clientId(): string {
  return process.env.SPOTIFY_CLIENT_ID || "";
}
function clientSecret(): string | undefined {
  return process.env.SPOTIFY_CLIENT_SECRET || undefined;
}
export function redirectUri(): string {
  return (
    process.env.SPOTIFY_REDIRECT_URI ||
    "http://127.0.0.1:3000/api/spotify/callback"
  );
}

// The one canonical origin the whole OAuth flow must stay on. Spotify forces the
// callback to 127.0.0.1 (localhost is banned), and httpOnly cookies are
// origin-scoped, so login/callback/cookies must all live on this exact origin or
// the PKCE/state/session cookies vanish across the localhost↔127.0.0.1 boundary.
// Derived from the registered redirect URI so there's a single source of truth.
export function appOrigin(): string {
  try {
    return new URL(redirectUri()).origin;
  } catch {
    return "http://127.0.0.1:3000";
  }
}

// ---- PKCE + authorize URL ---------------------------------------------------

export function makePkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(64).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}
export function randomState(): string {
  return crypto.randomBytes(16).toString("base64url");
}
export function authorizeUrl(challenge: string, state: string): string {
  const qs = new URLSearchParams({
    client_id: clientId(),
    response_type: "code",
    redirect_uri: redirectUri(),
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
    scope: SCOPES,
  });
  return `${AUTH}?${qs.toString()}`;
}

// ---- token exchange / refresh ----------------------------------------------

export interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

async function tokenRequest(body: URLSearchParams): Promise<Tokens> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  // PKCE doesn't require the secret, but if this app is a confidential client
  // (secret set) Spotify accepts Basic auth too — include it when present.
  const secret = clientSecret();
  if (secret) {
    headers["Authorization"] =
      "Basic " + Buffer.from(`${clientId()}:${secret}`).toString("base64");
  }
  const res = await fetch(TOKEN, { method: "POST", headers, body });
  if (!res.ok) {
    throw new Error(`spotify token ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as Tokens;
}

export function exchangeCode(code: string, verifier: string): Promise<Tokens> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
      client_id: clientId(),
      code_verifier: verifier,
    })
  );
}
export function refreshTokens(refresh: string): Promise<Tokens> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: clientId(),
    })
  );
}

// ---- session cookies --------------------------------------------------------

const COOKIE = { httpOnly: true, sameSite: "lax" as const, path: "/" };

export function setTokenCookies(res: NextResponse, t: Tokens): void {
  const secure = process.env.NODE_ENV === "production";
  res.cookies.set("sp_at", t.access_token, { ...COOKIE, secure });
  if (t.refresh_token)
    res.cookies.set("sp_rt", t.refresh_token, { ...COOKIE, secure });
  res.cookies.set("sp_exp", String(Date.now() + t.expires_in * 1000), {
    ...COOKIE,
    secure,
  });
}
export function clearTokenCookies(res: NextResponse): void {
  res.cookies.delete("sp_at");
  res.cookies.delete("sp_rt");
  res.cookies.delete("sp_exp");
}

/**
 * Read a usable access token from cookies, transparently refreshing if it's
 * within 30s of expiry. When `refreshed` is returned, the caller MUST persist it
 * with setTokenCookies() on its response so the new token sticks.
 */
export async function getAccessToken(): Promise<{
  token: string | null;
  refreshed?: Tokens;
}> {
  const c = await cookies();
  const at = c.get("sp_at")?.value;
  const rt = c.get("sp_rt")?.value;
  const exp = Number(c.get("sp_exp")?.value || 0);
  if (at && Date.now() < exp - 30_000) return { token: at };
  if (rt) {
    try {
      const t = await refreshTokens(rt);
      return { token: t.access_token, refreshed: t };
    } catch {
      return { token: null };
    }
  }
  return { token: at || null };
}

// ---- API client -------------------------------------------------------------

async function spotifyGet<T>(
  token: string,
  path: string,
  params?: Record<string, string>
): Promise<T> {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  const res = await fetch(`${API}${path}${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`spotify ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

// Spotify paginates with an absolute `next` URL that carries offset (and our
// `fields`). Walk it, capped so a giant library can't spin forever.
interface SpotifyPage {
  items?: unknown[];
  next?: string | null;
}

async function paginate(
  token: string,
  firstPath: string,
  firstParams: Record<string, string>,
  onPage: (items: unknown[]) => void,
  maxPages = 12
): Promise<void> {
  let path = firstPath;
  let params: Record<string, string> | undefined = firstParams;
  for (let i = 0; i < maxPages; i++) {
    const page: SpotifyPage = await spotifyGet<SpotifyPage>(token, path, params);
    onPage(page.items || []);
    const next = page.next;
    if (!next) break;
    const u = new URL(next);
    path = u.pathname.replace(/^\/v1/, "");
    params = Object.fromEntries(u.searchParams.entries());
  }
}

export interface PlaylistSummary {
  id: string;
  name: string;
  trackCount: number;
  image?: string;
  owner?: string;
  description?: string;
  collaborative?: boolean;
}

export async function getMyPlaylists(token: string): Promise<PlaylistSummary[]> {
  const out: PlaylistSummary[] = [];
  // Spotify can return the same playlist more than once (owned + followed, or
  // across page boundaries), which would collide React keys — dedupe by id.
  const seen = new Set<string>();
  await paginate(
    token,
    "/me/playlists",
    { limit: "50" },
    (items) => {
      for (const raw of items) {
        const p = raw as {
          id: string;
          name: string;
          description?: string;
          collaborative?: boolean;
          images?: { url: string }[];
          owner?: { display_name?: string };
          tracks?: { total?: number };
        } | null;
        if (!p?.id || seen.has(p.id)) continue;
        seen.add(p.id);
        out.push({
          id: p.id,
          name: p.name,
          trackCount: p.tracks?.total ?? 0,
          image: p.images?.[0]?.url,
          owner: p.owner?.display_name,
          description: p.description,
          collaborative: p.collaborative,
        });
      }
    }
  );
  return out;
}

export interface PlaylistTrack {
  id: string | null;
  title: string;
  artists: string[];
  album?: string;
  /** The bridge key: ISRC -> MusicBrainz recording MBID -> our whole engine. */
  isrc?: string;
  durationMs?: number;
  image?: string;
  addedAt?: string;
}

export async function getPlaylist(
  token: string,
  id: string
): Promise<{ name: string; description?: string; image?: string; tracks: PlaylistTrack[] }> {
  const meta = await spotifyGet<{
    name: string;
    description?: string;
    images?: { url: string }[];
  }>(token, `/playlists/${id}`, { fields: "name,description,images" });

  const tracks: PlaylistTrack[] = [];
  await paginate(
    token,
    `/playlists/${id}/tracks`,
    {
      limit: "100",
      fields:
        "next,items(added_at,track(id,name,duration_ms,external_ids(isrc),album(name,images),artists(name)))",
    },
    (items) => {
      for (const raw of items) {
        const it = raw as {
          added_at?: string;
          track?: {
            id?: string;
            name?: string;
            duration_ms?: number;
            external_ids?: { isrc?: string };
            album?: { name?: string; images?: { url: string }[] };
            artists?: { name?: string }[];
          } | null;
        };
        const t = it?.track;
        if (!t?.name) continue; // skip nulls (removed/unavailable tracks)
        tracks.push({
          id: t.id ?? null,
          title: t.name,
          artists: (t.artists || []).map((a) => a.name || "").filter(Boolean),
          album: t.album?.name,
          isrc: t.external_ids?.isrc,
          durationMs: t.duration_ms,
          image: t.album?.images?.[0]?.url,
          addedAt: it.added_at,
        });
      }
    }
  );
  return {
    name: meta.name,
    description: meta.description,
    image: meta.images?.[0]?.url,
    tracks,
  };
}
