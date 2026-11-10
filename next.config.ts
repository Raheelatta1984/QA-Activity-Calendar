import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native/runtime packages stay out of the bundler:
  //  • node:sqlite is a Node.js builtin (the default store).
  //  • pg is resolved at runtime by the Postgres bridge worker, so it must stay
  //    a real node_modules package instead of being bundled into a chunk.
  serverExternalPackages: ["node:sqlite", "pg"],
  // The Postgres driver spawns a worker that `require("pg")`s at runtime, which
  // the tracer cannot see statically. Ship the client with the server output.
  outputFileTracingIncludes: {
    "/**": [
      "./node_modules/pg/**",
      "./node_modules/pg-pool/**",
      "./node_modules/pg-protocol/**",
      "./node_modules/pg-types/**",
      "./node_modules/pgpass/**",
      "./node_modules/pg-cloudflare/**",
      "./node_modules/pg-connection-string/**",
      "./node_modules/pg-int8/**",
      "./node_modules/postgres-array/**",
      "./node_modules/postgres-bytea/**",
      "./node_modules/postgres-date/**",
      "./node_modules/postgres-interval/**",
      "./node_modules/split2/**",
    ],
  },
  experimental: {
    serverActions: { bodySizeLimit: "2mb" },
  },
  poweredByHeader: false,
};

export default nextConfig;
