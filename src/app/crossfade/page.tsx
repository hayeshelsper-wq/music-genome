"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Crossfader from "@/components/Crossfader";

function CrossfadeInner() {
  const params = useSearchParams();
  const [a, setA] = useState<{ mbid: string; name: string } | null>(null);
  const [b, setB] = useState<{ mbid: string; name: string } | null>(null);
  const [ready, setReady] = useState(false);

  // Deep link: /crossfade?a=<mbid>&b=<mbid> (names resolved via search API by
  // mbid lookups on the artist route are heavier; the trail passes names too).
  useEffect(() => {
    const am = params.get("a");
    const bm = params.get("b");
    const an = params.get("aName");
    const bn = params.get("bName");
    if (am && an) setA({ mbid: am, name: an });
    if (bm && bn) setB({ mbid: bm, name: bn });
    setReady(true);
  }, [params]);

  if (!ready) return null;
  return <Crossfader initialA={a} initialB={b} />;
}

export default function CrossfadePage() {
  return (
    <div className="container">
      <div className="studio-head">
        <h2>🎚 Artist DNA Crossfader</h2>
        <p className="muted">
          Two artists, one slider, live generated music. The genome embeds each
          artist&apos;s measured style, and a realtime model morphs between them
          as you move the fader — no pre-rendered audio, every second is
          generated while you listen.
        </p>
      </div>
      <Suspense>
        <CrossfadeInner />
      </Suspense>
      <footer className="cf-footer muted">
        Live generation: Magenta RealTime, CC-BY 4.0, Google DeepMind
      </footer>
    </div>
  );
}
