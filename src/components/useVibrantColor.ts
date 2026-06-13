"use client";

import { useEffect, useState } from "react";

export const FALLBACK_RGB: [number, number, number] = [62, 78, 120]; // muted indigo

/**
 * Pull a vibrant representative color from an image for a Spotify-style hero
 * gradient. Downscales to a tiny canvas and picks the most saturated, mid-bright
 * pixel. Falls back gracefully if the image is cross-origin tainted or missing.
 * Returned as an "r g b" triple ready for `rgb(var(--hero-rgb))`.
 */
export function useVibrantColor(src?: string): [number, number, number] {
  const [rgb, setRgb] = useState<[number, number, number]>(FALLBACK_RGB);
  useEffect(() => {
    if (!src) {
      setRgb(FALLBACK_RGB);
      return;
    }
    let alive = true;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const S = 24;
        const c = document.createElement("canvas");
        c.width = S;
        c.height = S;
        const ctx = c.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, S, S);
        const d = ctx.getImageData(0, 0, S, S).data;
        let best = { score: -1, rgb: FALLBACK_RGB as [number, number, number] };
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] < 128) continue;
          const r = d[i], g = d[i + 1], b = d[i + 2];
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          const sat = max === 0 ? 0 : (max - min) / max;
          const val = max / 255;
          // favor saturated colors that aren't too dark or blown out
          const score = sat * (1 - Math.abs(val - 0.62));
          if (score > best.score) best = { score, rgb: [r, g, b] };
        }
        if (alive) setRgb(best.rgb);
      } catch {
        if (alive) setRgb(FALLBACK_RGB);
      }
    };
    img.onerror = () => {
      if (alive) setRgb(FALLBACK_RGB);
    };
    img.src = src;
    return () => {
      alive = false;
    };
  }, [src]);
  return rgb;
}
