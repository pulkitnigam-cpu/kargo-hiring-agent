import { NextResponse } from "next/server";
import { settleEmails } from "@/lib/email/send";
import { queueState, startScoring } from "@/lib/scoring/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// GET: scoring progress (the dashboard polls this). Also settles emails whose
// undo window has passed, so statuses stay current without a background job.
export async function GET() {
  await settleEmails().catch((e) => console.error("[email] settle", e));
  return NextResponse.json(await queueState());
}

// POST: run one scoring step (up to ~4 minutes), then report progress.
export async function POST() {
  const result = await startScoring();
  return NextResponse.json({ ...result, state: await queueState() });
}
