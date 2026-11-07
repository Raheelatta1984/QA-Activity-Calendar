import { NextResponse, type NextRequest } from "next/server";
import { LOGIN_WELCOME_COOKIE, LOGIN_WELCOME_HEADER } from "./lib/login-welcome";

/**
 * Exposes the current path to server layouts so disabled tabs and role gates
 * can be enforced centrally (not just by hiding the navigation link).
 *
 * A successful login also leaves a signed, short-lived welcome cookie. The
 * first dashboard GET forwards it as a server-only request header and clears
 * it from the browser, making the notification a true one-time flash message.
 */
export function middleware(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set("x-pathname", request.nextUrl.pathname);

  // Never trust a welcome header supplied directly by a client.
  headers.delete(LOGIN_WELCOME_HEADER);
  const welcome =
    request.method === "GET" && request.nextUrl.pathname === "/"
      ? request.cookies.get(LOGIN_WELCOME_COOKIE)?.value
      : undefined;
  if (welcome) headers.set(LOGIN_WELCOME_HEADER, welcome);

  const response = NextResponse.next({ request: { headers } });
  if (welcome) {
    response.cookies.set(LOGIN_WELCOME_COOKIE, "", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: process.env.NODE_ENV === "production",
      expires: new Date(0),
      maxAge: 0,
    });
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|api).*)"],
};
