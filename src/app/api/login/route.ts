import { NextResponse } from "next/server";
import { makeToken, passwordMatches, SESSION_COOKIE, SESSION_DAYS } from "@/lib/session";

export const runtime = "nodejs";

// Only same-site relative paths, so ?next= can't send someone elsewhere.
function safeNext(raw: FormDataEntryValue | null): string {
  const s = typeof raw === "string" ? raw : "/";
  return s.startsWith("/") && !s.startsWith("//") ? s : "/";
}

export async function POST(req: Request) {
  const form = await req.formData();
  const next = safeNext(form.get("next"));
  const base = new URL(req.url);

  if (!process.env.DASHBOARD_PASSWORD) {
    return NextResponse.redirect(new URL(`/login?error=unset&next=${encodeURIComponent(next)}`, base), 303);
  }
  if (!(await passwordMatches(String(form.get("password") ?? "")))) {
    await new Promise((r) => setTimeout(r, 800)); // slow down guessing
    return NextResponse.redirect(new URL(`/login?error=wrong&next=${encodeURIComponent(next)}`, base), 303);
  }

  const res = NextResponse.redirect(new URL(next, base), 303);
  res.cookies.set(SESSION_COOKIE, (await makeToken())!, {
    httpOnly: true,
    sameSite: "lax",
    secure: base.protocol === "https:",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  });
  return res;
}

// Sign out.
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
