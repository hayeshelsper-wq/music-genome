import { Suspense } from "react";
import GenomeStudio from "@/components/GenomeStudio";

export const metadata = {
  title: "The Genome Studio — The Music Genome Project",
};

export default function StudioPage() {
  return (
    <div className="container">
      {/* GenomeStudio reads ?run= via useSearchParams — needs a boundary. */}
      <Suspense>
        <GenomeStudio />
      </Suspense>
    </div>
  );
}
