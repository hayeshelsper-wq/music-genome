import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produce a self-contained server bundle (server.js + trimmed node_modules) so
  // the Cloud Run Docker image stays small.
  output: "standalone",
  // gRPC-based SDK with optional native bits — keep it external, not bundled.
  serverExternalPackages: ["@google-cloud/firestore"],
  // The auth middleware buffers the request body, and Next caps that buffer at
  // 10MB by default — which silently TRUNCATES audio uploads >10MB, so
  // req.formData() then fails ("Failed to parse body as FormData"). Raise it to
  // match the 30MB client-side upload cap (+ multipart overhead). (Renamed to
  // proxyClientMaxBodySize in Next 16.)
  experimental: {
    middlewareClientMaxBodySize: "32mb",
  } as NextConfig["experimental"],
};

export default nextConfig;
