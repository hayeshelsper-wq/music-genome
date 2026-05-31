import { complete } from "./llm";
import { ArtistDnaReport } from "./types";

const SYSTEM = `You are a music historian, A&R scout, and producer mentor rolled into one.
You are given structured facts about an artist pulled from MusicBrainz, Wikidata, and Last.fm.
Write a sharp, vivid "DNA profile" — the kind of read that makes a music nerd say "holy shit, that's exactly right."
Rules:
- Ground every claim in the supplied data. Never invent collaborators, influences, or genres that aren't listed.
- 3 short sections with markdown headers: "## Lineage", "## Sound", "## Where they sit".
- Be specific and opinionated, not encyclopedic. No hedging, no filler intro.
- ~180 words total.`;

export async function writeNarrative(report: ArtistDnaReport): Promise<string> {
  const a = report.artist;
  const influences = report.family.nodes
    .filter((n) => n.group === "influence")
    .map((n) => n.name);
  const descendants = report.family.nodes
    .filter((n) => n.group === "descendant")
    .map((n) => n.name);
  const collaborators = report.collaborators.nodes
    .filter((n) => n.group === "collaborator")
    .map((n) => `${n.name}${n.detail ? ` (${n.detail})` : ""}`);
  const genreArc = report.timeline
    .map((t) => `${t.year}: ${t.genres.join(", ")}`)
    .join(" → ");

  const facts = [
    `Artist: ${a.name}${a.country ? ` (${a.country})` : ""}${
      a.beginYear ? `, active from ${a.beginYear}` : ""
    }`,
    `Top tags (Last.fm): ${report.tags.join(", ") || "n/a"}`,
    `Influenced by: ${influences.join(", ") || "unknown"}`,
    `Went on to influence: ${descendants.join(", ") || "unknown"}`,
    `Key collaborators: ${collaborators.slice(0, 12).join(", ") || "n/a"}`,
    `Sonic neighbors (Last.fm): ${report.similar.map((s) => s.name).slice(0, 10).join(", ") || "n/a"}`,
    `Genre arc across discography: ${genreArc || "n/a"}`,
  ].join("\n");

  return complete(SYSTEM, facts);
}
