import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "The Music Genome Project",
  description: "Artist DNA Report — influence, collaboration, and genre lineage.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
