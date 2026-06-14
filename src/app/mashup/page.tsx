import Link from "next/link";
import MashupLab from "@/components/MashupLab";

export const metadata = {
  title: "Mashup Lab — The Music Genome Project",
};

export default function MashupPage() {
  return (
    <div className="container">
      <div style={{ paddingBottom: 12 }}>
        <Link className="lib-link" href="/">
          ← Home
        </Link>
      </div>
      <MashupLab />
    </div>
  );
}
