// Generic NDJSON stream reader for the browser: fetch, split on newlines
// (buffering partial lines across chunks), JSON-parse each line, and hand every
// object to the caller. Extracted from AskGenome so every streaming feature
// (Ask, Studio optimize, …) reads the wire the same way.

export async function streamNdjson(
  input: RequestInfo,
  init: RequestInit,
  onEvent: (obj: Record<string, unknown>) => void,
  onDone?: () => void,
  onError?: (e: Error) => void
): Promise<void> {
  try {
    const res = await fetch(input, init);
    if (!res.ok || !res.body) {
      let message = `request failed (${res.status})`;
      try {
        const body = await res.text();
        try {
          const j = JSON.parse(body) as { error?: string };
          if (j.error) message = j.error;
        } catch {
          if (body.trim()) message = body.slice(0, 300);
        }
      } catch {
        // keep the status-based message
      }
      onError?.(new Error(message));
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return; // tolerate malformed/partial lines
      }
      onEvent(obj);
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) handleLine(line);
    }
    // Tolerate a final unterminated line.
    handleLine(buf);
    onDone?.();
  } catch (e) {
    onError?.(e instanceof Error ? e : new Error("stream failed"));
  }
}
