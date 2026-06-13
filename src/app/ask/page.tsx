import Link from "next/link";
import AskGenome from "@/components/AskGenome";

export const metadata = {
  title: "Ask the Genome — The Music Genome Project",
};

export default function AskPage() {
  return (
    <div className="ask-page">
      <div className="ask-topbar">
        <Link className="lib-link" href="/">
          ← Home
        </Link>
      </div>
      <AskGenome />
    </div>
  );
}
