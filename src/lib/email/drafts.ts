import { createHash } from "crypto";
import { prisma } from "../db";
import { CANDIDATE_STATUS, type Role } from "../constants";
import type { InsightFlags } from "../dashboard";
import { makeClient } from "../scoring/ai";
import { HOLD_MIN, type CriterionId, type Point } from "../scoring/rubric";
import { postChecks } from "./checks";
import {
  applyNote,
  assembleBody,
  experienceReason,
  firstNameOf,
  needsDelayApology,
  needsRelocation,
  REASON_LINES,
  subjectFor,
  type EmailFacts,
  type EmailType,
} from "./templates";
import { writePersonal } from "./writer";

const S = CANDIDATE_STATUS;
export const HOLD_DAYS = 7;
export const SENT_STATES = ["queued", "sending", "sent", "delivered", "bounced"];

export function calLink(): string {
  return process.env.CAL_LINK || "";
}

type CandidateForEmail = Awaited<ReturnType<typeof loadCandidate>>;

async function loadCandidate(id: string) {
  return prisma.candidate.findUnique({
    where: { id },
    include: {
      insight: true,
      scores: { orderBy: { createdAt: "desc" }, take: 2, include: { criteria: true } },
      emails: { orderBy: { createdAt: "desc" } },
    },
  });
}

// Which email the candidate's current status calls for (§10, §12).
// A hold note that has run its 7 days gets a close-call regret (§10.2).
export function emailTypeFor(c: NonNullable<CandidateForEmail>, now = new Date()): EmailType | null {
  const score = c.scores.find((s) => s.roleScored === c.roleAssigned)?.total ?? null;
  const hadHoldNote = c.emails.some((e) => e.type === "hold" && SENT_STATES.includes(e.status) && e.status !== "queued");
  switch (c.status) {
    case S.SELECTED:
      return "invite";
    case S.HOLD:
      return hadHoldNote ? null : "hold";
    case S.HOLD_NOTIFIED:
      return c.holdDeadline && c.holdDeadline <= now ? "regret_close" : null;
    case S.REJECTED:
      // Close call for anyone the rubric put in Hold or above, or who had a hold note.
      return hadHoldNote || (score !== null && score >= HOLD_MIN) ? "regret_close" : "regret_clear";
    default:
      return null;
  }
}

// §12.4: the reason line comes from the criterion with the largest weighted
// gap, or the experience line when the range rule fired.
export function reasonLineFor(c: NonNullable<CandidateForEmail>): string | undefined {
  if (!c.insight || !c.roleAssigned) return undefined;
  const meta: InsightFlags = JSON.parse(c.insight.flagsJson);
  if (meta.flags.some((f) => f.code === "below_range" || f.code === "above_range")) return experienceReason(c.roleAssigned as Role);
  const weak: { criterionId: CriterionId }[] = JSON.parse(c.insight.weakPointsJson);
  for (const w of weak) if (REASON_LINES[w.criterionId]) return REASON_LINES[w.criterionId];
  return undefined;
}

function factsFor(c: NonNullable<CandidateForEmail>, type: EmailType, now: Date): EmailFacts {
  return {
    type,
    firstName: firstNameOf(c.name),
    role: c.roleAssigned as Role,
    appliedRole: (c.roleTag as Role | null) ?? null,
    delayApology: needsDelayApology(c.appliedDate),
    augustContact: c.isAugustContact,
    needsRelocation: needsRelocation(c.location),
    reasonLine: type === "regret_close" || type === "regret_clear" ? reasonLineFor(c) : undefined,
    holdDeadline: type === "hold" ? new Date(now.getTime() + HOLD_DAYS * 86_400_000) : undefined,
    calLink: calLink(),
  };
}

function keyOf(f: EmailFacts, email: string | null): string {
  const { holdDeadline: _d, ...rest } = f;
  void _d;
  return createHash("sha1").update(JSON.stringify({ ...rest, email })).digest("hex");
}

export type DraftResult =
  | { ok: true; emailId: string; type: EmailType; created: boolean }
  | { ok: false; reason: string };

// Returns the current draft for the candidate's status, writing a new one if
// there is none or its inputs changed. Arjun's edits are kept unless the email
// type or role changed.
export async function ensureDraft(candidateId: string, now = new Date()): Promise<DraftResult> {
  const c = await loadCandidate(candidateId);
  if (!c) return { ok: false, reason: "Candidate not found." };
  if (!c.roleAssigned || !c.insight) return { ok: false, reason: "Not scored yet." };
  const type = emailTypeFor(c, now);
  if (!type) return { ok: false, reason: "No email is due for this candidate's status." };

  const already = c.emails.find((e) => e.type === type && SENT_STATES.includes(e.status));
  if (already) return { ok: false, reason: already.status === "queued" ? "Already queued." : "Already emailed for this status." };

  const facts = factsFor(c, type, now);
  const key = keyOf(facts, c.email);
  const drafts = c.emails.filter((e) => e.status === "draft");
  const current = drafts.find((e) => e.type === type && e.role === c.roleAssigned && (e.factsKey === key || e.editedByArjun));
  const stale = drafts.filter((e) => e.id !== current?.id);
  // A note Arjun wrote for this kind of email survives a redraft.
  const carriedNote = stale.find((e) => e.type === type && e.customNote)?.customNote ?? null;
  if (stale.length) await prisma.email.deleteMany({ where: { id: { in: stale.map((e) => e.id) } } });
  if (current) return { ok: true, emailId: current.id, type, created: false };

  // Inputs for the personal sentences: strong points, one probe, verified quotes.
  const strong: Point[] = JSON.parse(c.insight.strongPointsJson);
  const probes: string[] = JSON.parse(c.insight.probesJson);
  const score = c.scores.find((s) => s.roleScored === c.roleAssigned);
  const quotes = (score?.criteria ?? [])
    .filter((x) => x.verified && x.evidenceQuote && x.score0to4 >= 2)
    .sort((a, b) => b.score0to4 - a.score0to4)
    .map((x) => x.evidenceQuote!)
    .slice(0, 6);

  const written = await writePersonal(makeClient(), {
    type,
    role: c.roleAssigned as Role,
    strongPoints: strong.filter((p) => p.quote).map((p) => ({ text: p.text, quote: p.quote })),
    probe: probes[0] ?? null,
    quotes,
  });

  const subject = subjectFor(type, (type === "invite" ? c.roleAssigned : c.roleTag ?? c.roleAssigned) as Role);
  const body = applyNote(assembleBody(facts, written.personal), null, carriedNote);
  const problems = postChecks({ subject, body, firstName: facts.firstName, reasonLine: facts.reasonLine, editedByArjun: false });
  if (!written.traced) problems.push("A personal line may not match the CV. Check it against the quotes, or edit it.");
  if (!c.email) problems.push("No email address for this candidate.");

  const email = await prisma.email.create({
    data: {
      candidateId: c.id,
      type,
      role: c.roleAssigned,
      subject,
      body,
      status: "draft",
      checksJson: JSON.stringify(problems),
      factsKey: key,
      customNote: carriedNote,
    },
  });
  return { ok: true, emailId: email.id, type, created: true };
}

export async function saveEdit(emailId: string, subject: string, body: string): Promise<{ ok: boolean; problems: string[]; error?: string }> {
  const e = await prisma.email.findUnique({ where: { id: emailId }, include: { candidate: true } });
  if (!e) return { ok: false, problems: [], error: "Draft not found." };
  if (e.status !== "draft") return { ok: false, problems: [], error: "Only drafts can be edited." };
  const problems = postChecks({ subject, body, firstName: firstNameOf(e.candidate.name), editedByArjun: true });
  if (!e.candidate.email) problems.push("No email address for this candidate.");
  await prisma.$transaction([
    prisma.email.update({ where: { id: e.id }, data: { subject, body, editedByArjun: true, checksJson: JSON.stringify(problems) } }),
    prisma.auditLog.create({
      data: { actor: "arjun", action: "email.edited", entity: `candidate:${e.candidateId}`, payloadJson: JSON.stringify({ type: e.type, emailId: e.id }) },
    }),
  ]);
  return { ok: true, problems };
}

// Called after a move, role change or re-score: unsent drafts and queued
// emails for the old decision must not go out. Queued ones are scheduled at
// Resend, so they're cancelled there too.
export async function cancelPendingFor(candidateId: string, reason: string): Promise<number> {
  const pending = await prisma.email.findMany({ where: { candidateId, status: { in: ["draft", "queued"] } } });
  if (!pending.length) return 0;
  const queued = pending.filter((e) => e.status === "queued" && (!e.sendAfter || e.sendAfter > new Date()));
  const { cancelAtResend } = await import("./send");
  for (const e of queued) await cancelAtResend(e.resendId);
  await prisma.$transaction([
    prisma.email.deleteMany({ where: { id: { in: pending.filter((e) => e.status === "draft").map((e) => e.id) } } }),
    prisma.email.updateMany({ where: { id: { in: queued.map((e) => e.id) } }, data: { status: "cancelled", error: reason } }),
    ...queued.map((e) =>
      prisma.auditLog.create({
        data: { actor: "system", action: "email.cancelled", entity: `candidate:${candidateId}`, payloadJson: JSON.stringify({ type: e.type, reason }) },
      }),
    ),
  ]);
  return queued.length;
}

// Adds, changes or removes Arjun's personal note on a draft, then re-runs
// the checks (the note counts toward the 150 words and must not leak scores).
export async function setNote(emailId: string, note: string): Promise<{ ok: boolean; problems: string[]; error?: string }> {
  const e = await prisma.email.findUnique({ where: { id: emailId } });
  if (!e) return { ok: false, problems: [], error: "Draft not found." };
  if (e.status !== "draft") return { ok: false, problems: [], error: "Only drafts can be changed." };
  const c = await loadCandidate(e.candidateId);
  if (!c) return { ok: false, problems: [], error: "Candidate not found." };

  const clean = note.trim().slice(0, 1200) || null;
  const body = applyNote(e.body, e.customNote, clean);
  const before: string[] = e.checksJson ? JSON.parse(e.checksJson) : [];
  const problems = postChecks({
    subject: e.subject,
    body,
    firstName: firstNameOf(c.name),
    reasonLine: e.type.startsWith("regret") ? reasonLineFor(c) : undefined,
    editedByArjun: e.editedByArjun,
  });
  // Keep the creation-time warnings that a note can't fix.
  for (const p of before) if (/may not match the CV|No email address/.test(p) && !problems.includes(p)) problems.push(p);

  await prisma.$transaction([
    prisma.email.update({ where: { id: e.id }, data: { body, customNote: clean, checksJson: JSON.stringify(problems) } }),
    prisma.auditLog.create({
      data: { actor: "arjun", action: "email.note", entity: `candidate:${e.candidateId}`, payloadJson: JSON.stringify({ type: e.type, emailId: e.id, note: clean }) },
    }),
  ]);
  return { ok: true, problems };
}
