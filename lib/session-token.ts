import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed, self-contained session token: `<base64url(json)>.<hmac-sha256>`.
 *
 * Carrying the identity inside the signed cookie keeps a session valid across
 * serverless instances and cold starts, where per-instance storage may be
 * empty. The `sessions` table is still written and remains authoritative when
 * a row is present (audit + revocation).
 */
export type SessionToken = { s: string; p: string; e: string; i?: string | null };

export function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET?.trim();
  if (secret) return secret;
  const g = globalThis as unknown as { __qaSecretWarned?: boolean };
  if (!g.__qaSecretWarned) {
    g.__qaSecretWarned = true;
    console.warn(
      "[auth] SESSION_SECRET is not set — using an insecure development secret. Set it in the environment before real use."
    );
  }
  return "dev-only-insecure-secret";
}

function sign(body: string): string {
  return createHmac("sha256", sessionSecret()).update(body).digest("base64url");
}

/** Deterministic short signature (tooling/tests). */
export function signValue(value: string): string {
  return createHmac("sha256", sessionSecret()).update(value).digest("hex").slice(0, 32);
}

export function encodeSessionToken(payload: SessionToken): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(body)}`;
}

export function decodeSessionToken(raw: string): SessionToken | null {
  const index = raw.lastIndexOf(".");
  if (index <= 0) return null;
  const body = raw.slice(0, index);
  const signature = raw.slice(index + 1);
  const expected = sign(body);
  if (signature.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionToken;
    if (!parsed?.p || !parsed?.s || !parsed?.e) return null;
    return parsed;
  } catch {
    return null;
  }
}
