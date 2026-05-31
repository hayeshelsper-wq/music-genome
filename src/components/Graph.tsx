"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { GraphLink, GraphNode } from "@/lib/types";

// react-force-graph touches window/canvas — load client-side only.
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
  ssr: false,
  loading: () => <div className="center muted" style={{ paddingTop: 200 }}>rendering graph…</div>,
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
  // ForceGraph mutates the data objects, so hand it fresh copies.
  const data = useMemo(
    () => ({
      nodes: nodes.map((n) => ({ ...n })),
      links: links.map((l) => ({ ...l })),
    }),
    [nodes, links]
  );

  return (
    <div className="graph-box">
      <ForceGraph2D
        graphData={data}
        backgroundColor="#07070c"
        nodeRelSize={5}
        linkColor={() => "rgba(255,255,255,0.18)"}
        linkDirectionalArrowLength={3}
        linkDirectionalArrowRelPos={1}
        linkDirectionalParticles={0}
        cooldownTicks={120}
        onNodeClick={(n: any) => {
          // MusicBrainz-keyed nodes can be explored further; synthetic ones can't.
          if (n.id && !String(n.id).startsWith("wd:") && !String(n.id).startsWith("lfm:")) {
            router.push(`/artist/${n.id}`);
          }
        }}
        nodeCanvasObject={(node: any, ctx, scale) => {
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
    </div>
  );
}
