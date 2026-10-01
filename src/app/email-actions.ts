"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { ensureDraft, saveEdit, setNote } from "@/lib/email/drafts";
import { BULK_LABEL, mailConfigProblem, prepareBulk, queueEmails, sendAgain, testMode, undoEmail, undoMinutes, type BulkGroup } from "@/lib/email/send";

export type DraftView = {
  email: {
    id: string;
    type: string;
    subject: string;
    body: string;
    status: string;
    checks: string[];
    editedByArjun: boolean;
    customNote: string | null;
    sendAfter: string | null;
    sentAt: string | null;
    lastEvent: string | null;
    toAddress: string | null;
    error: string | null;
  } | null;
  history: { id: string; type: string; status: string; sentAt: string | null; lastEvent: string | null; toAddress: string | null; subject: string; body: string; error: string | null }[];
  note: string | null; // why there is no draft
  configProblem: string | null;
  testMode: boolean;
  testRecipient: string | null;
  undoMinutes: number;
};

function view(e: NonNullable<Awaited<ReturnType<typeof prisma.email.findUnique>>>): NonNullable<DraftView["email"]> {
  return {
    id: e.id,
    type: e.type,
    subject: e.subject,
    body: e.body,
    status: e.status,
    checks: e.checksJson ? JSON.parse(e.checksJson) : [],
    editedByArjun: e.editedByArjun,
    customNote: e.customNote,
    sendAfter: e.sendAfter?.toISOString() ?? null,
    sentAt: e.sentAt?.toISOString() ?? null,
    lastEvent: e.lastEvent,
    toAddress: e.toAddress,
    error: e.error,
  };
}

// The side panel's email section: the current draft (written on first open)
// plus what has already been sent.
export async function loadDraft(candidateId: string): Promise<DraftView> {
  const base = {
    configProblem: mailConfigProblem(),
    testMode: testMode(),
    testRecipient: process.env.TEST_RECIPIENT || null,
    undoMinutes: undoMinutes(),
  };
  let note: string | null = null;
  let current: DraftView["email"] = null;

  const queued = await prisma.email.findFirst({ where: { candidateId, status: { in: ["queued", "sending"] } }, orderBy: { createdAt: "desc" } });
  if (queued) current = view(queued);
  else {
    try {
      const d = await ensureDraft(candidateId);
      if (d.ok) current = view((await prisma.email.findUnique({ where: { id: d.emailId } }))!);
      else note = d.reason;
    } catch (err) {
      note = `Couldn't write the draft: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`;
    }
  }

  const sent = await prisma.email.findMany({
    where: { candidateId, status: { in: ["sent", "delivered", "bounced", "failed", "cancelled"] } },
    orderBy: { createdAt: "desc" },
  });
  return {
    ...base,
    email: current,
    note,
    history: sent.map((e) => ({
      id: e.id, type: e.type, status: e.status, sentAt: (e.sentAt ?? e.updatedAt)?.toISOString() ?? null, lastEvent: e.lastEvent,
      toAddress: e.toAddress, subject: e.subject, body: e.body, error: e.error,
    })),
  };
}

export async function saveDraftEdit(emailId: string, subject: string, body: string) {
  const res = await saveEdit(emailId, subject.slice(0, 300), body.slice(0, 5000));
  revalidatePath("/", "layout");
  return res;
}

export async function sendOne(emailId: string, consent = false) {
  if (!consent) return { queued: 0, skipped: [{ name: "", reason: "Tick \"Yes, send\" first." }], sendAt: null };
  const res = await queueEmails([emailId]);
  revalidatePath("/", "layout");
  return { ...res, sendAt: res.sendAt?.toISOString() ?? null };
}

export async function undo(emailId: string) {
  const res = await undoEmail(emailId);
  revalidatePath("/", "layout");
  return res;
}

export async function resend(emailId: string) {
  const res = await sendAgain(emailId);
  revalidatePath("/", "layout");
  return { ...res, sendAt: res.sendAt?.toISOString() ?? null };
}

export async function prepare(group: BulkGroup) {
  if (!(group in BULK_LABEL)) return { ready: [], skipped: [], configProblem: "Unknown group." };
  const configProblem = mailConfigProblem();
  const res = await prepareBulk(group);
  revalidatePath("/", "layout");
  return { ...res, configProblem };
}

export async function saveNote(emailId: string, note: string) {
  const res = await setNote(emailId, note);
  revalidatePath("/", "layout");
  return res;
}

// Bulk send with Arjun's explicit consent. An optional message for the whole
// group is added to each email (after any personal note it already has).
export async function sendBulk(emailIds: string[], groupNote = "", consent = false) {
  if (!consent) return { queued: 0, skipped: [{ name: "", reason: "Tick \"Yes, send\" first." }], sendAt: null };
  const ids = emailIds.slice(0, 500);
  const note = groupNote.trim();
  const skipped: { name: string; reason: string }[] = [];
  if (note) {
    const drafts = await prisma.email.findMany({ where: { id: { in: ids } }, include: { candidate: { select: { name: true } } } });
    for (const d of drafts) {
      const combined = [d.customNote, note].filter((x) => x && x.trim()).join("\n\n");
      const r = await setNote(d.id, combined);
      if (r.problems.length) skipped.push({ name: d.candidate.name, reason: `With your message: ${r.problems[0]}` });
    }
  }
  const res = await queueEmails(ids);
  revalidatePath("/", "layout");
  // Don't report a candidate twice.
  const all = [...skipped, ...res.skipped.filter((s) => !skipped.some((k) => k.name === s.name))];
  return { ...res, skipped: all, sendAt: res.sendAt?.toISOString() ?? null };
}
