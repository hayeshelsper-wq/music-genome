import Link from "next/link";
import GenomeStudio from "@/components/GenomeStudio";

export const metadata = {
  title: "The Genome Studio — The Music Genome Project",
};

export default function StudioPage() {
  return (
    <div className="container">
      <div style={{ paddingBottom: 12 }}>
        <Link className="lib-link" href="/">
          ← Home
        </Link>
      </div>
      <GenomeStudio />
    </div>
  );
}
