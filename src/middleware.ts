import { NextResponse, type NextRequest } from "next/server";
import { authRequired, SESSION_COOKIE, verifyToken } from "./lib/session";

// Every page and API route needs the dashboard login: the app holds
// candidates' personal data (DPDP Act, §13.5).
export async function middleware(req: NextRequest) {
  if (!authRequired()) return NextResponse.next();
  if (await verifyToken(req.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();

  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // /api/cron checks its own secret (Vercel Cron can't log in).
  matcher: ["/((?!login|api/login|api/cron|_next/static|_next/image|favicon.ico).*)"],
};
