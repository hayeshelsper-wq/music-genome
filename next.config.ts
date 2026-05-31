import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // neo4j-driver ships with optional native deps we don't bundle on the server.
  serverExternalPackages: ["neo4j-driver"],
};

export default nextConfig;
