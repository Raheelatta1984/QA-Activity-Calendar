/**
 * Standalone shell — run the hub as its own resumable project:
 *
 *   npm install && npm run dev
 *
 * Serves the REST API (/api/v1/*), the MCP endpoint (/mcp) and the built-in
 * web console (/) on 0.0.0.0:$HUB_PORT (default 4310) with zero dependencies
 * beyond tsx for TypeScript execution.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHubHandler } from "./app.ts";
import { databaseFile } from "./db.ts";
import { vaultInfo } from "./core/vault.ts";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(moduleDir, "..", "web");

const port = Number(process.env.HUB_PORT || 4310);
const handle = createHubHandler();

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    // Static web console (everything that is not the API/MCP).
    if (!url.pathname.startsWith("/api/") && url.pathname !== "/mcp") {
      const requested = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = path.join(webDir, path.normalize(requested).replace(/^([.][.][/\\])+/, ""));
      if (file.startsWith(webDir) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
        fs.createReadStream(file).pipe(res);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    // API + MCP via the portable handler.
    const body = await handle(new Request(`http://localhost${url.pathname}${url.search}`, {
      method: req.method,
      headers: req.headers as unknown as HeadersInit,
      body: ["GET", "HEAD"].includes(req.method || "") ? undefined : await readBody(req),
    }));
    res.writeHead(body.status, Object.fromEntries(body.headers.entries()));
    res.end(Buffer.from(await body.arrayBuffer()));
  } catch (error) {
    console.error("[hub] request failed:", error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal error" }));
  }
});

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

server.listen(port, "0.0.0.0", () => {
  const keyless = !process.env.HUB_API_KEY && !process.env.HUB_READ_KEY;
  console.log(`
  ┌─────────────────────────────────────────────────────────┐
  │  Enhancements Hub                                       │
  ├─────────────────────────────────────────────────────────┤
  │  Web console   http://localhost:${String(port).padEnd(24)}│
  │  REST API      /api/v1/*                                │
  │  MCP endpoint  /mcp   (JSON-RPC 2.0)                    │
  │  Database      ${databaseFile().padEnd(39)}│
  │  Vault         ${vaultInfo().dir.padEnd(39)}│
  │  Auth          ${(keyless ? "key-less dev mode (admin by default)" : "API key required").padEnd(32)}│
  └─────────────────────────────────────────────────────────┘
  Attach it anywhere: see INTEGRATION.md · MCP tools: POST /mcp tools/list
`);
  if (keyless && (process.env.HUB_AUTH_MODE || "warn").toLowerCase() !== "off") {
    console.warn("  [hub] running without HUB_API_KEY — anonymous visitors get editor access. Set HUB_API_KEY before exposing this beyond localhost.\n");
  }
});
