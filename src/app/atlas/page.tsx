import AtlasMap from "@/components/AtlasMap";

export const metadata = {
  title: "The Living Map of Music — The Music Genome Project",
};

export default function AtlasPage() {
  return (
    <div className="container">
      <AtlasMap />
    </div>
  );
}
