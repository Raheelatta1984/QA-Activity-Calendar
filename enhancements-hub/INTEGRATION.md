# Attaching the hub to another project

One module, four attachment patterns — pick the one that fits the host. In every
pattern the hub keeps its own SQLite database and Markdown vault; the host never
needs to share its schema.

---

## Pattern A — standalone service (works with ANY stack)

Run the hub as its own process and talk HTTP. The host can be Rails, Django,
Spring, Laravel, a static site — anything that can call an API.

```bash
cd enhancements-hub && npm install && HUB_API_KEY=changeit npm run dev
```

Behind a reverse proxy (nginx, Caddy, Traefik), mount it at a path or subdomain:

```
https://hub.internal.example.com/  →  enhancements-hub (port 4310)
```

For serverless deployment (Vercel/Netlify/Lambda), deploy `server/` behind any
Web-Request-compatible function and set the serverless env vars from
`.env.example` — the db and vault layers already detect read-only bundles and
fall back to writable storage.

---

## Pattern B — Next.js App Router (one file)

Copy `enhancements-hub/` into the repo (e.g. `packages/enhancements-hub/`), then
create **one** catch-all route:

```ts
// app/hub/[[...path]]/route.ts
import { mountHub } from "@/enhancements-hub/server/adapters/next.ts";

const hub = mountHub({ basePath: "/hub" });
export const GET = hub;
export const POST = hub;
export const PATCH = hub;
export const DELETE = hub;
export const OPTIONS = hub;
export const dynamic = "force-dynamic";
```

Live at `/hub/api/v1/*` and `/hub/mcp`. Wire it to the host's real auth so
requests are attributed to the signed-in user:

```ts
const hub = mountHub({
  basePath: "/hub",
  auth: {
    identify: async () => {
      const session = await getSession();                    // your auth
      if (!session) return { actor: "anonymous", role: "viewer" };
      return {
        actor: session.name,
        role: session.isAdmin ? "admin" : "editor",
        tenant: session.tenantSlug ?? "default",
      };
    },
  },
});
```

Set `DATABASE_FILE` / `HUB_VAULT_DIR` in the host's env when the defaults don't
suit the deployment.

---

## Pattern C — Express / Fastify / bare Node

```js
import express from "express";
import { attachHub } from "./enhancements-hub/server/adapters/express.ts";

const app = express();
app.use(express.json());
attachHub(app, { basePath: "/hub", auth: myAuthAdapter });
app.listen(8080);
```

Bare Node http, Bun, Deno — any runtime with Web Request/Response:

```js
import { createHubHandler } from "./enhancements-hub/server/app.ts";
const handle = createHubHandler();
// Bun.serve({ fetch: handle })  ·  Deno.serve(handle)  ·  Elysia/Worker mounts…
```

Python hosts (FastAPI/Django/Flask) usually take **Pattern A** plus a thin proxy:

```python
# FastAPI proxy example
import os, httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

HUB = os.environ.get("HUB_URL", "http://localhost:4310")
app = FastAPI()

@app.api_route("/hub/{path:path}", methods=["GET", "POST", "PATCH", "DELETE"])
async def proxy(path: str, request: Request):
    async with httpx.AsyncClient() as client:
        upstream = await client.request(
            request.method, f"{HUB}/{path}",
            content=await request.body(),
            headers={k: v for k, v in request.headers.items() if k.lower() != "host"},
        )
    return JSONResponse(status_code=upstream.status_code, content=upstream.json())
```

---

## Pattern D — embed the core library (no HTTP at all)

The domain layer is importable and side-effect-light:

```ts
import {
  ensureTenant, createApplication, createEnhancement,
  setEnhancementStatus, listEnhancements, syncVaultDocs,
} from "./enhancements-hub/server/core/service.ts";

ensureTenant("acme", "Acme Ltd");
const app = createApplication({ tenantSlug: "acme", slug: "portal", name: "Acme Portal" });
const { record, filename, content } = createEnhancement(
  { name: "Reema", role: "editor" },
  { tenantSlug: "acme", applicationSlug: app.slug, title: "…", brief: "…" }
);
await setEnhancementStatus({ name: "reema", role: "editor" }, record.id, "Building");
```

Hosts that embed directly supply identity per call — `Actor = { name, role }` —
so the hub never touches cookies, sessions or headers.

---

## Identity — the one thing the host must supply

```ts
interface AuthAdapter {
  identify(request: Request): HubIdentity | Promise<HubIdentity>;
}
type HubIdentity = { actor: string; role: "viewer" | "editor" | "admin"; tenant?: string };
```

The built-in `HeaderAuthAdapter` (bearer key / `X-Api-Key`, `X-Actor`, `X-Tenant`)
is fine for standalone and dev use. For a host with real users, write a 5-line
adapter that maps the host session to `HubIdentity` (see Pattern B) — the same
extension point the source app used for its viewer/role model.

## Environment variables

See `.env.example` for the full list. The essentials:

| Variable | Purpose |
| --- | --- |
| `HUB_PORT` | standalone shell port (default 4310) |
| `HUB_API_KEY` / `HUB_READ_KEY` | write / read bearer keys |
| `HUB_DEFAULT_TENANT` | tenant when the caller sends none (default `default`) |
| `DATABASE_FILE` | SQLite location (default `./data/enhancements-hub.db`) |
| `HUB_VAULT_DIR` | Markdown vault root (default `./vault`) |
| `GITHUB_TOKEN` | fallback connector token; per-app tokens use the env var named by each application's `tokenEnv` |

## Committing the vault to the target repo's Git

The handover Markdown the hub writes into `vault/<tenant>/<app>/` is meant to be
committed, exactly like the source project's `enhancements/` vault:

```bash
git add vault && git commit -m "docs(enhancements): capture latest proposals"
```

`scripts/sync-docs.ts` reconciles statuses after pulling a branch that contains
completed (archived) handovers, and `POST /api/v1/sync` does the same remotely.
