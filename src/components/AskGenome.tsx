"use client";

import { useEffect, useRef, useState } from "react";

// Friendly labels + icons for the tool-activity chips the agent emits mid-turn.
const TOOL_META: Record<string, { icon: string; label: (i: any) => string }> = {
  search_artist: { icon: "🔎", label: (i) => `Searching for "${i.query}"` },
  get_artist_dna: { icon: "🧬", label: () => `Reading the DNA graph` },
  get_artist_top_tracks: {
    icon: "🎧",
    label: (i) => `Pulling ${i.artist_name}'s top tracks`,
  },
  search_by_sound: {
    icon: "🌊",
    label: (i) => `Searching by sound: "${i.description}"`,
  },
  find_sonic_twins: { icon: "👯", label: () => `Finding sonic twins` },
  get_track_details: { icon: "🔬", label: () => `Analyzing the track` },
  list_my_library: { icon: "🎵", label: () => `Scanning your library` },
  get_song_credits_and_lyrics: {
    icon: "📝",
    label: (i) => `Looking up "${i.title}" credits & lyrics`,
  },
};

interface ToolChip {
  name: string;
  input: any;
  ok?: boolean;
}
interface Msg {
  role: "user" | "assistant";
  text: string;
  tools?: ToolChip[];
  streaming?: boolean;
}

const EXAMPLES = [
  "Trace the lineage from Black Sabbath to Nirvana — who's the bridge?",
  "Who are Radiohead's most frequent producers and collaborators?",
  "Find something in my library that sounds like warm lo-fi tape hiss",
  "Which artists influenced both Kendrick Lamar and Tyler, the Creator?",
];

// Minimal, safe markdown → HTML for the agent's replies: escapes first, then
// renders links (internal /artist/... or http), bold/italic, and bullet lists.
function renderMarkdown(src: string): string {
  const esc = src
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const inline = (s: string) =>
    s
      .replace(/\[([^\]]+)\]\((\/[^\s)]+|https?:\/\/[^\s)]+)\)/g, (_m, t, u) => {
        const ext = u.startsWith("http");
        return `<a href="${u}"${ext ? ' target="_blank" rel="noreferrer"' : ""}>${t}</a>`;
      })
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");

  const lines = esc.split("\n");
  let html = "";
  let inList = false;
  for (const line of lines) {
    const bullet = line.match(/^\s*[-*]\s+(.*)/);
    if (bullet) {
      if (!inList) {
        html += "<ul>";
        inList = true;
      }
      html += `<li>${inline(bullet[1])}</li>`;
    } else {
      if (inList) {
        html += "</ul>";
        inList = false;
      }
      if (line.trim() === "") html += "<br/>";
      else html += `<p>${inline(line)}</p>`;
    }
  }
  if (inList) html += "</ul>";
  return html;
}

export default function AskGenome() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  async function ask(question: string) {
    if (!question.trim() || busy) return;
    setInput("");
    setBusy(true);

    // History = the conversation so far (text only), before this question.
    const history = messages.map((m) => ({ role: m.role, text: m.text }));
    setMessages((prev) => [
      ...prev,
      { role: "user", text: question },
      { role: "assistant", text: "", tools: [], streaming: true },
    ]);

    const patchLast = (fn: (m: Msg) => Msg) =>
      setMessages((prev) => {
        const copy = [...prev];
        copy[copy.length - 1] = fn(copy[copy.length - 1]);
        return copy;
      });

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, history }),
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        patchLast((m) => ({
          ...m,
          text: `⚠️ ${err.error || `request failed (${res.status})`}`,
          streaming: false,
        }));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev: any;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (ev.t === "token") {
            patchLast((m) => ({ ...m, text: m.text + ev.v }));
          } else if (ev.t === "tool") {
            patchLast((m) => ({
              ...m,
              // If the model wrote a preamble before this tool call, break the
              // paragraph so its post-tool continuation doesn't run on (".Radiohead").
              text:
                m.text && !/\n\n$/.test(m.text) ? m.text + "\n\n" : m.text,
              tools: [...(m.tools || []), { name: ev.name, input: ev.input }],
            }));
          } else if (ev.t === "tool_done") {
            patchLast((m) => {
              const tools = [...(m.tools || [])];
              for (let i = tools.length - 1; i >= 0; i--)
                if (tools[i].name === ev.name && tools[i].ok === undefined) {
                  tools[i] = { ...tools[i], ok: ev.ok };
                  break;
                }
              return { ...m, tools };
            });
          } else if (ev.t === "error") {
            patchLast((m) => ({
              ...m,
              text: m.text + `\n\n⚠️ ${ev.v}`,
              streaming: false,
            }));
          } else if (ev.t === "done") {
            patchLast((m) => ({ ...m, streaming: false }));
          }
        }
      }
    } catch (e) {
      patchLast((m) => ({
        ...m,
        text: m.text + `\n\n⚠️ ${e instanceof Error ? e.message : "failed"}`,
        streaming: false,
      }));
    } finally {
      patchLast((m) => ({ ...m, streaming: false }));
      setBusy(false);
    }
  }

  return (
    <div className="ask">
      <div className="ask-scroll" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="ask-empty">
            <h2>Ask the Genome</h2>
            <p className="muted">
              A research agent with tool access to the whole stack — the
              influence graph, the iTunes catalog, CLAP audio search over your
              library, per-track DSP, and Genius credits. Ask it things a search
              box can&apos;t answer.
            </p>
            <div className="ask-examples">
              {EXAMPLES.map((ex) => (
                <button key={ex} className="ask-chip" onClick={() => ask(ex)}>
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`ask-msg ask-${m.role}`}>
            {m.role === "user" ? (
              <div className="ask-bubble">{m.text}</div>
            ) : (
              <div className="ask-assistant-body">
                {m.tools && m.tools.length > 0 && (
                  <div className="ask-tools">
                    {m.tools.map((t, j) => {
                      const meta = TOOL_META[t.name];
                      return (
                        <div
                          key={j}
                          className={`ask-tool ${
                            t.ok === undefined
                              ? "running"
                              : t.ok
                              ? "ok"
                              : "err"
                          }`}
                        >
                          <span className="ask-tool-icon">
                            {meta ? meta.icon : "🛠️"}
                          </span>
                          {meta ? meta.label(t.input || {}) : t.name}
                          {t.ok === undefined && (
                            <span className="spinner ask-tool-spin" />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {m.text ? (
                  <div
                    className="ask-prose narrative"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }}
                  />
                ) : (
                  m.streaming && (
                    <div className="muted ask-thinking">
                      <span className="spinner" /> &nbsp;thinking…
                    </div>
                  )
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <form
        className="ask-input-row"
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
      >
        <input
          className="search-input ask-input"
          placeholder="Ask anything about music — lineage, producers, sound, lyrics…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
          autoFocus
        />
        <button className="btn" type="submit" disabled={busy || !input.trim()}>
          {busy ? "…" : "Ask"}
        </button>
      </form>
    </div>
  );
}
