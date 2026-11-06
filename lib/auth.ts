import { cookies } from "next/headers";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { get, run } from "./db";
import { token } from "./ids";
import { ensureBootstrapped } from "./bootstrap";
import { encodeSessionToken, decodeSessionToken, signValue } from "./session-token";

export { encodeSessionToken, decodeSessionToken, signValue };
export type { SessionToken } from "./session-token";

export const SESSION_COOKIE = "qa_session";
const SESSION_DAYS = 7;

export type Person = {
  id: string;
  department_id: string | null;
  manager_id: string | null;
  name: string;
  email: string;
  title: string | null;
  role: "admin" | "exec" | "manager" | "editor" | "viewer";
  capacity_hours_day: number;
  colour: string;
  active: number;
  is_demo: number;
};

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored?: string | null): boolean {
  if (!stored) return false;
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

export function createSession(personId: string): { id: string; expires: string } {
  const id = token(24);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  run(`INSERT INTO sessions (id, person_id, expires_at) VALUES (?, ?, ?)`, id, personId, expires);
  return { id, expires };
}

export async function setSessionCookie(input: {
  sessionId: string;
  personId: string;
  expires: string;
  impersonateId?: string | null;
}) {
  const store = await cookies();
  const value = encodeSessionToken({
    s: input.sessionId,
    p: input.personId,
    e: input.expires,
    i: input.impersonateId ?? null,
  });
  store.set(SESSION_COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    expires: new Date(input.expires),
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export async function getSession() {
  ensureBootstrapped();
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  const parsed = decodeSessionToken(raw);
  if (!parsed) return null;
  if (new Date(parsed.e).getTime() < Date.now()) return null;

  // When the row exists (single-instance or warm instance) it is authoritative.
  const row = get<{ person_id: string; impersonate_id: string | null; expires_at: string }>(
    `SELECT person_id, impersonate_id, expires_at FROM sessions WHERE id = ?`,
    parsed.s
  );
  if (row && new Date(row.expires_at).getTime() < Date.now()) {
    run(`DELETE FROM sessions WHERE id = ?`, parsed.s);
    return null;
  }
  const personId = row?.person_id ?? parsed.p;
  const impersonateId = row ? row.impersonate_id : (parsed.i ?? null);

  const person = get<Person>(`SELECT * FROM people WHERE id = ?`, personId);
  if (!person || !person.active) return null;
  const impersonated = impersonateId
    ? get<Person>(`SELECT * FROM people WHERE id = ?`, impersonateId)
    : undefined;
  return { sessionId: parsed.s, person, impersonated: impersonated ?? null };
}

export async function destroySession() {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  if (raw) {
    const parsed = decodeSessionToken(raw);
    if (parsed) run(`DELETE FROM sessions WHERE id = ?`, parsed.s);
  }
  await clearSessionCookie();
}

export async function setImpersonation(personId: string | null) {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  if (!raw) return;
  const parsed = decodeSessionToken(raw);
  if (!parsed) return;
  const row = get<{ person_id: string; expires_at: string }>(
    `SELECT person_id, expires_at FROM sessions WHERE id = ?`,
    parsed.s
  );
  if (row) run(`UPDATE sessions SET impersonate_id = ? WHERE id = ?`, personId, parsed.s);
  // Re-sign so the preview survives a cold start on serverless storage.
  await setSessionCookie({
    sessionId: parsed.s,
    personId: row?.person_id ?? parsed.p,
    expires: row?.expires_at ?? parsed.e,
    impersonateId: personId,
  });
}
