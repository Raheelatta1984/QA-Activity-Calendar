import { cookies } from "next/headers";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { get, run } from "./db";
import { uid, token } from "./ids";

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

export function signValue(value: string): string {
  const secret = process.env.SESSION_SECRET || "dev-only-insecure-secret";
  return createHash("sha256").update(`${value}:${secret}`).digest("hex").slice(0, 32);
}

export function createSession(personId: string): { id: string; expires: string } {
  const id = token(24);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  run(
    `INSERT INTO sessions (id, person_id, expires_at) VALUES (?, ?, ?)`,
    id,
    personId,
    expires
  );
  return { id, expires };
}

export async function setSessionCookie(id: string, expires: string) {
  const store = await cookies();
  store.set(SESSION_COOKIE, `${id}.${signValue(id)}`, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    expires: new Date(expires),
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export async function destroySession() {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  if (raw) {
    const [id] = raw.split(".");
    run("DELETE FROM sessions WHERE id = ?", id);
  }
  await clearSessionCookie();
}

export async function getSession() {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  const [id, sig] = raw.split(".");
  if (!id || sig !== signValue(id)) return null;
  const row = get<{
    session_id: string;
    person_id: string;
    impersonate_id: string | null;
    expires_at: string;
  }>(
    `SELECT id AS session_id, person_id, impersonate_id, expires_at FROM sessions WHERE id = ?`,
    id
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    run("DELETE FROM sessions WHERE id = ?", id);
    return null;
  }
  const person = get<Person>(`SELECT * FROM people WHERE id = ?`, row.person_id);
  if (!person) return null;
  const impersonated = row.impersonate_id
    ? get<Person>(`SELECT * FROM people WHERE id = ?`, row.impersonate_id)
    : undefined;
  return { sessionId: row.session_id, person, impersonated: impersonated ?? null };
}

export async function setImpersonation(personId: string | null) {
  const session = await getSession();
  if (!session) return;
  run(`UPDATE sessions SET impersonate_id = ? WHERE id = ?`, personId, session.sessionId);
}
