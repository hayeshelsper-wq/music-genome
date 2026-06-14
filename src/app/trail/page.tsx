import Link from "next/link";
import InfluenceTrail from "@/components/InfluenceTrail";

export const metadata = {
  title: "Audible Influence Trails — The Music Genome Project",
};

export default function TrailPage() {
  return (
    <div className="container">
      <div style={{ paddingBottom: 12 }}>
        <Link className="lib-link" href="/">
          ← Home
        </Link>
      </div>
      <InfluenceTrail />
    </div>
  );
}
