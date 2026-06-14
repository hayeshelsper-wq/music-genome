import Link from "next/link";
import AtlasMap from "@/components/AtlasMap";

export const metadata = {
  title: "The Living Map of Music — The Music Genome Project",
};

export default function AtlasPage() {
  return (
    <div className="container">
      <div style={{ paddingBottom: 12 }}>
        <Link className="lib-link" href="/">
          ← Home
        </Link>
      </div>
      <AtlasMap />
    </div>
  );
}
