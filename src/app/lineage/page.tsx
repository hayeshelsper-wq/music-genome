import Link from "next/link";
import LineageWalk from "@/components/LineageWalk";

export const metadata = {
  title: "Lineage Walk — The Music Genome Project",
};

export default function LineagePage() {
  return (
    <div className="container">
      <div style={{ paddingBottom: 12 }}>
        <Link className="lib-link" href="/">
          ← Home
        </Link>
      </div>
      <LineageWalk />
    </div>
  );
}
