import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // node:sqlite is a Node.js builtin; keep it on the server runtime and out of the bundler.
  serverExternalPackages: ["node:sqlite"],
  experimental: {
    serverActions: { bodySizeLimit: "2mb" },
  },
  poweredByHeader: false,
};

export default nextConfig;
