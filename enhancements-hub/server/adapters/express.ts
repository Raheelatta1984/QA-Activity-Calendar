/**
 * Express / Connect / Fastify-style adapter.
 *
 *   import express from "express";
 *   import { attachHub } from "enhancements-hub/adapters/express";
 *   const app = express();
 *   app.use(express.json());
 *   attachHub(app, { basePath: "/hub" });
 *
 * Any framework that can hand us (req, res) works: see INTEGRATION.md for a
 * FastAPI proxy example and a bare-Node example.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHubHandler, type HubOptions } from "../app.ts";

export function attachHub(app: { use: (path: string, handler: (req: IncomingMessage, res: ServerResponse, next: (err?: any) => void) => void) => any }, options: HubOptions = {}) {
  const handle = createHubHandler(options);
  const basePath = (options.basePath ?? "").replace(/\/+$/, "");

  app.use(`${basePath}/api`, async (req, res, next) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const origin = `${basePath}/api`;
      const forward = new Request(`http://hub${origin}${url.pathname}${url.search}`, {
        method: req.method,
        headers: Object.entries(req.headers).reduce((acc, [key, value]) => {
          if (typeof value === "string") acc[key] = value;
          return acc;
        }, {} as Record<string, string>),
        body: ["GET", "HEAD"].includes(req.method || "") ? undefined : await readRaw(req),
      });
      const response = await handle(forward);
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      next(error as Error);
    }
  });
  return app;
}

function readRaw(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
