"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { GraphLink, GraphNode } from "@/lib/types";

// react-force-graph touches window/canvas — load client-side only.
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
  ssr: false,
  loading: () => (
    <div className="center muted" style={{ paddingTop: 200 }}>
      rendering graph…
    </div>
  ),
});

const COLOR: Record<GraphNode["group"], string> = {
  root: "#ffd166",
  influence: "#06d6a0",
  descendant: "#ef476f",
  collaborator: "#5b8def",
  similar: "#9a9ab0",
};

export default function Graph({
  nodes,
  links,
}: {
  nodes: GraphNode[];
  links: GraphLink[];
}) {
  const router = useRouter();
  const wrapRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);
  // ForceGraph2D defaults to the full WINDOW size if width/height aren't given,
  // which overflows the container. Measure the box and feed it real dimensions.
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  // ForceGraph mutates the data objects, so hand it fresh copies.
  const data = useMemo(
    () => ({
      nodes: nodes.map((n) => ({ ...n })),
      links: links.map((l) => ({ ...l })),
    }),
    [nodes, links]
  );

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="graph-box" ref={wrapRef}>
      {size.w > 0 && (
        <ForceGraph2D
          ref={fgRef}
          width={size.w}
          height={size.h}
          graphData={data}
          backgroundColor="#07070c"
          nodeRelSize={5}
          linkColor={() => "rgba(255,255,255,0.18)"}
          linkDirectionalArrowLength={3}
          linkDirectionalArrowRelPos={1}
          cooldownTicks={120}
          // Once the simulation settles, frame every node inside the viewport.
          onEngineStop={() => fgRef.current?.zoomToFit(400, 50)}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onNodeClick={(n: any) => {
            // MusicBrainz-keyed nodes can be explored; synthetic ones can't.
            const id = String(n.id ?? "");
            if (id && !id.startsWith("wd:") && !id.startsWith("lfm:")) {
              router.push(`/artist/${id}`);
            }
          }}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          nodeCanvasObject={(node: any, ctx: any, scale: number) => {
            const r = node.group === "root" ? 7 : 5;
            ctx.beginPath();
            ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
            ctx.fillStyle = COLOR[node.group as GraphNode["group"]] || "#888";
            ctx.fill();
            const fontSize = Math.max(11 / scale, 3);
            ctx.font = `${node.group === "root" ? "bold " : ""}${fontSize}px sans-serif`;
            ctx.fillStyle = "#e8e8f0";
            ctx.textAlign = "center";
            ctx.fillText(node.name, node.x, node.y + r + fontSize + 1);
          }}
        />
      )}
    </div>
  );
}
