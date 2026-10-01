import { NextResponse } from "next/server";
import { settleEmails } from "@/lib/email/send";
import { purgeExpired } from "@/lib/retention";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Vercel Cron, once a day (vercel.json): bring email statuses up to date and
// delete closed-out rejected candidates past the retention period (§13.5).
// Vercel sends "Authorization: Bearer $CRON_SECRET".
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const settled = await settleEmails();
  const purged = await purgeExpired();
  return NextResponse.json({ ok: true, settled, purged });
}
