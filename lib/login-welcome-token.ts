import { LOGIN_WELCOME_COOKIE_MAX_AGE_SECONDS } from "./login-welcome";
import { decodeSessionToken, encodeSessionToken } from "./session-token";

export type LoginWelcomeSession = {
  sessionId: string;
  personId: string;
  expires: string;
};

/**
 * A signed, short-lived flash token tied to the newly-created session. Reusing
 * the session-token envelope avoids putting a name or other personal data in
 * the welcome cookie or URL.
 */
export function createLoginWelcomeToken(session: LoginWelcomeSession, now = Date.now()): string {
  const expires = Math.min(
    new Date(session.expires).getTime(),
    now + LOGIN_WELCOME_COOKIE_MAX_AGE_SECONDS * 1000
  );
  return encodeSessionToken({
    s: session.sessionId,
    p: session.personId,
    e: new Date(expires).toISOString(),
    i: null,
  });
}

export function isLoginWelcomeTokenForSession(
  raw: string | null | undefined,
  session: { sessionId: string; person: { id: string } } | null,
  now = Date.now()
): boolean {
  if (!raw || !session) return false;
  const welcome = decodeSessionToken(raw);
  if (!welcome) return false;
  const expires = new Date(welcome.e).getTime();
  return (
    welcome.s === session.sessionId &&
    welcome.p === session.person.id &&
    Number.isFinite(expires) &&
    expires > now
  );
}
