import { Resend } from "resend";
import { prisma } from "../db";
import { CANDIDATE_STATUS } from "../constants";
import type { InsightFlags } from "../dashboard";
import { ensureDraft, HOLD_DAYS } from "./drafts";
import { EMAIL_TYPE_LABEL, type EmailType } from "./templates";

// Workflow B (§6.3): Arjun's click → confirmation → 10-minute undo → Resend.
// Nothing is ever sent without a click.
//
// Serverless-friendly: when Arjun confirms, the email is handed to Resend
// straight away as a *scheduled* send for the end of the undo window. Undo
// cancels it at Resend. There's no background process to keep alive; local
// statuses catch up (settleEmails) whenever the app is used, and daily.

const S = CANDIDATE_STATUS;

// The undo window (§6.3). UNDO_MINUTES can shorten it for testing; Resend
// needs scheduled sends at least a minute ahead, so it never goes below 1.
export function undoMinutes(): number {
  const raw = process.env.UNDO_MINUTES;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 1 ? n : 10;
}

export function testMode(): boolean {
  return process.env.TEST_MODE !== "false";
}

// Why sending can't happen right now, if anything.
export function mailConfigProblem(): string | null {
  if (!process.env.RESEND_API_KEY) return "Email isn't set up: add RESEND_API_KEY.";
  if (testMode()) {
    if (!process.env.TEST_RECIPIENT) return "Test mode is on but TEST_RECIPIENT is empty. Add your own email so test emails come to you.";
    return null;
  }
  const from = process.env.FROM_EMAIL ?? "";
  if (!from) return "Add FROM_EMAIL (Arjun's address on a verified domain).";
  if (/resend\.dev$/i.test(from)) return "onboarding@resend.dev can't email candidates. Verify Kargo's domain in Resend and set FROM_EMAIL to Arjun's address, or turn TEST_MODE back on.";
  if (/no-?reply/i.test(from)) return "The spec never allows a noreply sender. Use Arjun's own address as FROM_EMAIL.";
  return null;
}

// The pre-send status each email type expects, and where it moves the candidate.
const TRANSITION: Record<EmailType, { from: string[]; to: string }> = {
  invite: { from: [S.SELECTED], to: S.INVITED },
  hold: { from: [S.HOLD], to: S.HOLD_NOTIFIED },
  regret_close: { from: [S.REJECTED, S.HOLD_NOTIFIED], to: S.REGRET_SENT },
  regret_clear: { from: [S.REJECTED], to: S.REGRET_SENT },
};

const resend = () => new Resend(process.env.RESEND_API_KEY);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Hands one email to Resend, scheduled for `at`.
async function schedule(e: { id: string; subject: string; body: string }, c: { name: string; email: string | null }, at: Date) {
  const test = testMode();
  const to = test ? process.env.TEST_RECIPIENT! : c.email!;
  const subject = test ? `[TEST for ${c.name} <${c.email}>] ${e.subject}` : e.subject;
  const from = test ? `Arjun Mehta (test) <${process.env.FROM_EMAIL || "onboarding@resend.dev"}>` : `Arjun Mehta <${process.env.FROM_EMAIL}>`;
  const replyTo = process.env.REPLY_TO_EMAIL || undefined;
  const { data, error } = await resend().emails.send(
    { from, to: [to], subject, text: e.body, scheduledAt: at.toISOString(), ...(replyTo ? { replyTo } : {}) },
    { idempotencyKey: `kargo-email-${e.id}-${at.getTime()}` },
  );
  return { to, id: data?.id ?? null, error: error ? `${error.name}: ${error.message}` : data ? null : "No response from Resend" };
}

export type QueueResult = { queued: number; skipped: { name: string; reason: string }[]; sendAt: Date | null };

// Queues drafts that pass every check. Each gets its own undo window.
export async function queueEmails(emailIds: string[], actor: "arjun" = "arjun"): Promise<QueueResult> {
  const problem = mailConfigProblem();
  const emails = await prisma.email.findMany({ where: { id: { in: emailIds } }, include: { candidate: true } });
  if (problem) return { queued: 0, skipped: emails.map((e) => ({ name: e.candidate.name, reason: problem })), sendAt: null };

  const now = new Date();
  const sendAt = new Date(now.getTime() + undoMinutes() * 60_000);
  const skipped: QueueResult["skipped"] = [];
  let queued = 0;

  for (const e of emails) {
    const checks: string[] = e.checksJson ? JSON.parse(e.checksJson) : [];
    if (e.status !== "draft") { skipped.push({ name: e.candidate.name, reason: "Not a draft any more." }); continue; }
    if (checks.length) { skipped.push({ name: e.candidate.name, reason: checks[0] }); continue; }
    if (!e.candidate.email) { skipped.push({ name: e.candidate.name, reason: "No email address." }); continue; }
    if (!TRANSITION[e.type as EmailType].from.includes(e.candidate.status)) {
      skipped.push({ name: e.candidate.name, reason: "Their status changed; the draft is out of date." });
      continue;
    }
    // Idempotency (§11.4): one email per candidate per status.
    const dup = await prisma.email.findFirst({
      where: { candidateId: e.candidateId, type: e.type, id: { not: e.id }, status: { in: ["queued", "sending", "sent", "delivered", "bounced"] } },
    });
    if (dup) { skipped.push({ name: e.candidate.name, reason: "Already emailed for this status." }); continue; }

    // Claim the draft first so a double click can't schedule it twice.
    const claimed = await prisma.email.updateMany({ where: { id: e.id, status: "draft" }, data: { status: "sending" } });
    if (!claimed.count) { skipped.push({ name: e.candidate.name, reason: "Already queued." }); continue; }

    const r = await schedule(e, e.candidate, sendAt);
    if (!r.id) {
      await prisma.email.update({ where: { id: e.id }, data: { status: "draft" } });
      skipped.push({ name: e.candidate.name, reason: `Resend refused it: ${r.error}` });
      continue;
    }
    await prisma.email.update({
      where: { id: e.id },
      data: { status: "queued", queuedAt: now, sendAfter: sendAt, resendId: r.id, toAddress: r.to, lastEvent: "scheduled", error: null },
    });
    queued++;
    await prisma.auditLog.create({
      data: {
        actor,
        action: "email.queued",
        entity: `candidate:${e.candidateId}`,
        payloadJson: JSON.stringify({ type: e.type, emailId: e.id, sendAfter: sendAt.toISOString(), testMode: testMode(), resendId: r.id }),
      },
    });
    if (emails.length > 1) await sleep(300); // stay under Resend's request rate in bulk sends
  }
  return { queued, skipped, sendAt: queued ? sendAt : null };
}

// Cancels a scheduled email at Resend. True if it was stopped in time.
export async function cancelAtResend(resendId: string | null): Promise<boolean> {
  if (!resendId || !process.env.RESEND_API_KEY) return false;
  const { error } = await resend().emails.cancel(resendId);
  return !error;
}

export async function undoEmail(emailId: string): Promise<{ ok: boolean; error?: string }> {
  const e = await prisma.email.findUnique({ where: { id: emailId } });
  if (!e) return { ok: false, error: "Email not found." };
  if (e.status !== "queued" || !e.sendAfter || e.sendAfter <= new Date()) return { ok: false, error: "Too late: it has already gone out." };
  if (!(await cancelAtResend(e.resendId))) return { ok: false, error: "Resend couldn't cancel it; it may already have gone out." };
  await prisma.email.update({ where: { id: emailId }, data: { status: "draft", queuedAt: null, sendAfter: null, resendId: null, lastEvent: null } });
  await prisma.auditLog.create({
    data: { actor: "arjun", action: "email.undone", entity: `candidate:${e.candidateId}`, payloadJson: JSON.stringify({ type: e.type, emailId }) },
  });
  return { ok: true };
}

// Explicit "Send again" (§11.4): a copy of a sent email, scheduled again.
export async function sendAgain(emailId: string): Promise<QueueResult> {
  const e = await prisma.email.findUnique({ where: { id: emailId }, include: { candidate: true } });
  if (!e || !["sent", "delivered", "bounced", "failed"].includes(e.status)) {
    return { queued: 0, skipped: [{ name: e?.candidate.name ?? "", reason: "Only sent or failed emails can be sent again." }], sendAt: null };
  }
  const problem = mailConfigProblem();
  if (problem) return { queued: 0, skipped: [{ name: e.candidate.name, reason: problem }], sendAt: null };
  const sendAt = new Date(Date.now() + undoMinutes() * 60_000);
  const copy = await prisma.email.create({
    data: {
      candidateId: e.candidateId, type: e.type, role: e.role, subject: e.subject, body: e.body, status: "sending",
      editedByArjun: e.editedByArjun, checksJson: "[]", factsKey: e.factsKey, customNote: e.customNote,
    },
  });
  const r = await schedule(copy, e.candidate, sendAt);
  if (!r.id) {
    await prisma.email.delete({ where: { id: copy.id } });
    return { queued: 0, skipped: [{ name: e.candidate.name, reason: `Resend refused it: ${r.error}` }], sendAt: null };
  }
  await prisma.email.update({
    where: { id: copy.id },
    data: { status: "queued", queuedAt: new Date(), sendAfter: sendAt, resendId: r.id, toAddress: r.to, lastEvent: "scheduled" },
  });
  await prisma.auditLog.create({
    data: { actor: "arjun", action: "email.send_again", entity: `candidate:${e.candidateId}`, payloadJson: JSON.stringify({ type: e.type, emailId: copy.id, of: e.id }) },
  });
  return { queued: 1, skipped: [], sendAt };
}

// ---- Catching up -------------------------------------------------------------

// Emails whose undo window has passed have gone out (Resend sends them on
// schedule). Mark them sent and move the candidate on. One quick query when
// nothing is due, so it's safe on every page load. Delivery-status polling
// (slow: one Resend call per email) only runs when asked, off the click path.
export async function settleEmails(opts: { poll?: boolean } = {}, now = new Date()): Promise<number> {
  const due = await prisma.email.findMany({ where: { status: "queued", sendAfter: { lte: now } }, include: { candidate: true }, take: 200 });
  for (const e of due) {
    const claimed = await prisma.email.updateMany({ where: { id: e.id, status: "queued" }, data: { status: "sent", sentAt: e.sendAfter, lastEvent: "sent" } });
    if (!claimed.count) continue;
    const t = TRANSITION[e.type as EmailType];
    const c = e.candidate;
    const sentAt = e.sendAfter ?? now;
    await prisma.$transaction([
      ...(t.from.includes(c.status)
        ? [
            prisma.candidate.update({
              where: { id: c.id },
              data: { status: t.to, holdDeadline: e.type === "hold" ? new Date(sentAt.getTime() + HOLD_DAYS * 86_400_000) : c.holdDeadline },
            }),
            prisma.statusEvent.create({
              data: { candidateId: c.id, fromStatus: c.status, toStatus: t.to, actor: "system", reason: `${EMAIL_TYPE_LABEL[e.type as EmailType]} sent${testMode() ? " (test mode)" : ""}` },
            }),
          ]
        : []),
      prisma.auditLog.create({
        data: { actor: "system", action: "email.sent", entity: `candidate:${c.id}`, payloadJson: JSON.stringify({ type: e.type, emailId: e.id, to: e.toAddress, resendId: e.resendId }) },
      }),
    ]);
  }
  if (opts.poll) await pollDelivery().catch((err) => console.error("[email] delivery", err));
  return due.length;
}

const FINAL_BAD = new Set(["bounced", "failed", "complained", "suppressed", "canceled"]);
const pollState = globalThis as unknown as { kargoPollBlocked?: string; kargoLastPoll?: number };

// A "Sending access" Resend key can send but not read status.
export function deliveryTrackingProblem(): string | null {
  return pollState.kargoPollBlocked ?? null;
}

// Delivery status without a public webhook: ask Resend about recent sends,
// at most once a minute per server instance.
export async function pollDelivery(): Promise<void> {
  if (!process.env.RESEND_API_KEY || pollState.kargoPollBlocked) return;
  if (Date.now() - (pollState.kargoLastPoll ?? 0) < 60_000) return;
  pollState.kargoLastPoll = Date.now();
  const since = new Date(Date.now() - 3 * 86_400_000);
  const open = await prisma.email.findMany({ where: { status: "sent", sentAt: { gte: since }, resendId: { not: null } }, take: 20 });
  for (const e of open) {
    const { data, error } = await resend().emails.get(e.resendId!);
    await sleep(300);
    if (error?.name === "restricted_api_key") {
      pollState.kargoPollBlocked =
        "Delivery status isn't tracked: the Resend key has \"Sending access\" only. Emails still send. For delivered/bounced status, use a Full access key.";
      return;
    }
    if (!data?.last_event || data.last_event === e.lastEvent) continue;
    const ev = data.last_event;
    const status = ev === "delivered" || ev === "opened" || ev === "clicked" ? "delivered" : FINAL_BAD.has(ev) ? "bounced" : "sent";
    await prisma.email.update({ where: { id: e.id }, data: { lastEvent: ev, status } });
    if (status === "bounced") {
      await prisma.auditLog.create({
        data: { actor: "system", action: "email.bounced", entity: `candidate:${e.candidateId}`, payloadJson: JSON.stringify({ type: e.type, event: ev }) },
      });
    }
  }
}

// ---- Bulk send (§11.2 #9) ---------------------------------------------------

export type BulkGroup = "invite" | "hold" | "regret" | "hold_due";

export const BULK_LABEL: Record<BulkGroup, string> = {
  invite: "Send to all selected",
  hold: "Send hold notes",
  regret: "Send regrets",
  hold_due: "Send close-call regrets to holds due",
};

export const GROUP_STATUS: Record<BulkGroup, string> = { invite: S.SELECTED, hold: S.HOLD, regret: S.REJECTED, hold_due: S.HOLD_NOTIFIED };

export type Prepared = {
  ready: { candidateId: string; name: string; emailId: string; type: EmailType }[];
  skipped: { candidateId: string; name: string; reason: string }[];
};

export async function candidatesForGroup(group: BulkGroup, now = new Date()) {
  return prisma.candidate.findMany({
    where: {
      status: GROUP_STATUS[group],
      ...(group === "hold_due" ? { holdDeadline: { lte: now } } : {}),
    },
    include: { insight: { select: { flagsJson: true } } },
    orderBy: { createdAt: "asc" },
  });
}

// Drafts everything the group needs (a few at a time) and sorts candidates
// into ready and skipped, with the reason for each skip.
export async function prepareBulk(group: BulkGroup): Promise<Prepared> {
  const cands = await candidatesForGroup(group);
  const out: Prepared = { ready: [], skipped: [] };
  const queue = [...cands];
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const meta: InsightFlags | null = c.insight ? JSON.parse(c.insight.flagsJson) : null;
      // ⚠ rows stay out of bulk send until Arjun has opened them (§10.4).
      if (meta?.needsReview && !c.reviewedAt) {
        out.skipped.push({ candidateId: c.id, name: c.name, reason: "Flagged: open them first" });
        continue;
      }
      if (!c.email) { out.skipped.push({ candidateId: c.id, name: c.name, reason: "No email address" }); continue; }
      try {
        const d = await ensureDraft(c.id);
        if (!d.ok) { out.skipped.push({ candidateId: c.id, name: c.name, reason: d.reason }); continue; }
        const email = await prisma.email.findUniqueOrThrow({ where: { id: d.emailId } });
        const checks: string[] = email.checksJson ? JSON.parse(email.checksJson) : [];
        if (checks.length) { out.skipped.push({ candidateId: c.id, name: c.name, reason: `Draft needs a fix: ${checks[0]}` }); continue; }
        out.ready.push({ candidateId: c.id, name: c.name, emailId: d.emailId, type: d.type });
      } catch (err) {
        out.skipped.push({ candidateId: c.id, name: c.name, reason: `Couldn't draft: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}` });
      }
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  out.ready.sort(byName);
  out.skipped.sort(byName);
  return out;
}
