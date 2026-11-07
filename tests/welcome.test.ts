import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";

import { WelcomeToast } from "../components/WelcomeToast";
import { middleware } from "../middleware";
import {
  LOGIN_WELCOME_COOKIE,
  LOGIN_WELCOME_HEADER,
  LOGIN_WELCOME_VISIBLE_MS,
  scheduleLoginWelcomeDismiss,
} from "../lib/login-welcome";
import { createLoginWelcomeToken, isLoginWelcomeTokenForSession } from "../lib/login-welcome-token";

const login = {
  sessionId: "sess_welcome_test",
  personId: "p_amara",
  expires: "2026-11-08T00:05:00.000Z",
};
const now = Date.parse("2026-11-08T00:00:00.000Z");
const currentSession = { sessionId: login.sessionId, person: { id: login.personId } };

test("login welcome is tied to the successful session and rejects failure or replay", () => {
  const token = createLoginWelcomeToken(login, now);
  assert.equal(isLoginWelcomeTokenForSession(token, currentSession, now), true);
  assert.equal(isLoginWelcomeTokenForSession(null, currentSession, now), false);
  assert.equal(isLoginWelcomeTokenForSession(token, null, now), false);
  assert.equal(
    isLoginWelcomeTokenForSession(token, { sessionId: "sess_other", person: { id: login.personId } }, now),
    false
  );
  assert.equal(isLoginWelcomeTokenForSession(token, currentSession, now + 60_001), false);
  assert.equal(isLoginWelcomeTokenForSession(token, currentSession, Date.parse(login.expires)), false);

  const [body, signature] = token.split(".");
  const tampered = `${body}.${signature[0] === "a" ? "b" : "a"}${signature.slice(1)}`;
  assert.equal(isLoginWelcomeTokenForSession(tampered, currentSession, now), false);

  // A failed/tampered attempt does not poison recovery: a fresh successful
  // login receives a new token tied to its own new session.
  const recovery = { ...login, sessionId: "sess_recovered" };
  const recoveryToken = createLoginWelcomeToken(recovery, now);
  assert.equal(isLoginWelcomeTokenForSession(token, { sessionId: recovery.sessionId, person: { id: login.personId } }, now), false);
  assert.equal(
    isLoginWelcomeTokenForSession(recoveryToken, { sessionId: recovery.sessionId, person: { id: login.personId } }, now),
    true
  );
});

test("middleware consumes the welcome flash once and never trusts a spoofed header", () => {
  const token = createLoginWelcomeToken(login);
  const first = middleware(
    new NextRequest("http://localhost/", {
      headers: { cookie: `${LOGIN_WELCOME_COOKIE}=${token}`, [LOGIN_WELCOME_HEADER]: "spoofed" },
    })
  );
  assert.equal(first.headers.get(`x-middleware-request-${LOGIN_WELCOME_HEADER}`), token);
  const cleared = first.headers.get("set-cookie") ?? "";
  assert.match(cleared, new RegExp(`${LOGIN_WELCOME_COOKIE}=;`));
  assert.match(cleared, /Max-Age=0/i);
  assert.match(cleared, /HttpOnly/i);

  const second = middleware(new NextRequest("http://localhost/", { headers: { [LOGIN_WELCOME_HEADER]: "spoofed" } }));
  assert.equal(second.headers.get(`x-middleware-request-${LOGIN_WELCOME_HEADER}`), null);
  assert.equal(second.headers.get("set-cookie"), null);
});

test("the login route neither displays nor consumes a pending welcome", () => {
  const token = createLoginWelcomeToken(login);
  const response = middleware(
    new NextRequest("http://localhost/login", {
      headers: { cookie: `${LOGIN_WELCOME_COOKIE}=${token}`, [LOGIN_WELCOME_HEADER]: "spoofed" },
    })
  );
  assert.equal(response.headers.get(`x-middleware-request-${LOGIN_WELCOME_HEADER}`), null);
  assert.equal(response.headers.get("set-cookie"), null);
});

test("welcome toast renders an accessible personalised message with manual dismissal", () => {
  const html = renderToStaticMarkup(createElement(WelcomeToast, { name: "Amara Okafor" }));
  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-atomic="true"/);
  assert.match(html, /Welcome back, Amara!/);
  assert.match(html, /Your QA workspace is ready\./);
  assert.match(html, /aria-label="Dismiss welcome message"/);
});

test("welcome toast schedules automatic dismissal at exactly two seconds", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let dismissed = 0;
  const timer = scheduleLoginWelcomeDismiss(() => {
    dismissed += 1;
  });
  assert.equal(LOGIN_WELCOME_VISIBLE_MS, 2000);
  t.mock.timers.tick(1999);
  assert.equal(dismissed, 0);
  t.mock.timers.tick(1);
  assert.equal(dismissed, 1);
  clearTimeout(timer);
});
