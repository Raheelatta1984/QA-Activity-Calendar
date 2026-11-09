import { test } from "node:test";
import assert from "node:assert/strict";

import { runSync } from "../scripts/enhancement-github-sync.mjs";

/**
 * The scheduled sync is a client of the app, not of GitHub. These tests pin the
 * contract the workflow depends on: no secret means no call at all, and a failed
 * run is reported as a failure rather than a green no-op.
 */

function recorder(response) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(response.body), { status: response.status ?? 200 });
  };
  return { calls, fetchImpl };
}

test("the scheduled sync refuses to run without a base URL or secret", async () => {
  const { calls, fetchImpl } = recorder({ body: { ok: true } });
  await assert.rejects(() => runSync({}, { fetchImpl }), /APP_URL is not configured/);
  await assert.rejects(
    () => runSync({ APP_URL: "https://example.test" }, { fetchImpl }),
    /ENHANCEMENT_SYNC_SECRET is not configured/
  );
  await assert.rejects(
    () => runSync({ APP_URL: "example.test", ENHANCEMENT_SYNC_SECRET: "s" }, { fetchImpl }),
    /must start with http/
  );
  assert.equal(calls.length, 0, "nothing should be called when configuration is incomplete");
});

test("the scheduled sync posts the direction and a bearer token", async () => {
  const { calls, fetchImpl } = recorder({
    body: { ok: true, report: { direction: "push", repo: "owner/repo", created: 1, updated: 0, skipped: 0, errors: [], items: [] } },
  });
  const result = await runSync(
    { APP_URL: "https://example.test/", ENHANCEMENT_SYNC_SECRET: "s3cret", SYNC_DIRECTION: "push" },
    { fetchImpl }
  );
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.test/api/enhancements/sync");
  assert.equal(calls[0].init.headers.Authorization, "Bearer s3cret");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { direction: "push" });
});

test("an unknown direction falls back to a full two-way run", async () => {
  const { calls, fetchImpl } = recorder({ body: { ok: true } });
  await runSync(
    { APP_URL: "https://example.test", ENHANCEMENT_SYNC_SECRET: "s", SYNC_DIRECTION: "sideways" },
    { fetchImpl }
  );
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { direction: "full" });
});

test("a rejected run is not reported as success", async () => {
  const { fetchImpl } = recorder({ status: 401, body: { ok: false, error: "ENHANCEMENT_SYNC_SECRET is not configured" } });
  const result = await runSync({ APP_URL: "https://example.test", ENHANCEMENT_SYNC_SECRET: "s" }, {
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});
