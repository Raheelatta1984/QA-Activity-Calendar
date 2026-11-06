import { NextResponse, type NextRequest } from "next/server";

/**
 * Exposes the current path to server layouts so disabled tabs and role gates
 * can be enforced centrally (not just by hiding the navigation link).
 */
export function middleware(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set("x-pathname", request.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|api).*)"],
};
