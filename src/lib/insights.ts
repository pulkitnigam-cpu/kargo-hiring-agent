import { prisma } from "./db";
import { CANDIDATE_STATUS } from "./constants";
import { bandOfStatus } from "./decisions";
import { bandFor, type Band } from "./scoring/rubric";

// Phase 6: success metrics (§16), override analytics, and the §15.3
// agreement test.

const S = CANDIDATE_STATUS;
const SCORED: string[] = [S.SELECTED, S.HOLD, S.REJECTED, S.INVITED, S.HOLD_NOTIFIED, S.REGRET_SENT];
const HOUR = 3_600_000;

export type Metric = { label: string; value: string; target: string; ok: boolean | null; note?: string };

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

function hours(ms: number | null): string {
  if (ms === null) return "–";
  if (ms < HOUR) return `${Math.round(ms / 60_000)} min`;
  if (ms < 48 * HOUR) return `${Math.round((ms / HOUR) * 10) / 10} h`;
  return `${Math.round(ms / (24 * HOUR))} days`;
}

export async function successMetrics(): Promise<Metric[]> {
  const total = await prisma.candidate.count();
  const scored = await prisma.candidate.count({ where: { status: { in: SCORED } } });

  // Upload to scored dashboard: latest bulk upload → last score for its CVs.
  const batch = await prisma.uploadBatch.findFirst({ where: { mode: "bulk" }, orderBy: { createdAt: "desc" } });
  let uploadToScored: number | null = null;
  let batchNote = "No bulk upload yet.";
  if (batch) {
    const ids = (await prisma.candidate.findMany({ where: { uploadBatchId: batch.id }, select: { id: true } })).map((c) => `candidate:${c.id}`);
    const last = await prisma.auditLog.findFirst({ where: { action: "candidate.scored", entity: { in: ids } }, orderBy: { createdAt: "desc" } });
    const waiting = await prisma.candidate.count({ where: { uploadBatchId: batch.id, status: S.PARSED } });
    if (last) uploadToScored = last.createdAt.getTime() - batch.createdAt.getTime();
    batchNote = `${ids.length} CVs in the latest bulk upload${waiting ? `, ${waiting} still waiting` : ""}.`;
  }

  // Everyone hears back.
  const heard = await prisma.candidate.count({ where: { emails: { some: { status: { in: ["sent", "delivered"] } } } } });

  // Shortlist to decision: scored → first email queued.
  const firstQueued = await prisma.auditLog.findMany({ where: { action: "email.queued" }, orderBy: { createdAt: "asc" } });
  const scoredAt = new Map(
    (await prisma.auditLog.findMany({ where: { action: "candidate.scored" }, orderBy: { createdAt: "asc" } })).map((a) => [a.entity, a.createdAt]),
  );
  const seen = new Set<string>();
  const decideTimes: number[] = [];
  for (const q of firstQueued) {
    if (seen.has(q.entity)) continue;
    seen.add(q.entity);
    const s = scoredAt.get(q.entity);
    if (s) decideTimes.push(q.createdAt.getTime() - s.getTime());
  }
  const decide = median(decideTimes);

  // Hold resolved within 7 days.
  const holdNotes = await prisma.email.findMany({ where: { type: "hold", status: { in: ["sent", "delivered"] } }, include: { candidate: true } });
  const overdue = holdNotes.filter((e) => e.candidate.status === S.HOLD_NOTIFIED && e.candidate.holdDeadline && e.candidate.holdDeadline < new Date()).length;

  const agreement = await latestAgreement();
  const override = await overrideRate();

  return [
    { label: "Upload to scored dashboard", value: hours(uploadToScored), target: "< 30 min for 60 CVs", ok: uploadToScored === null ? null : uploadToScored < 30 * 60_000, note: batchNote },
    { label: "Candidates who heard back", value: total ? `${heard} of ${total} (${Math.round((heard / total) * 100)}%)` : "–", target: "100%", ok: total ? heard === total : null },
    { label: "Shortlist to Arjun's decision (median)", value: hours(decide), target: "< 48 h", ok: decide === null ? null : decide < 48 * HOUR, note: `From scoring to the first email queued, over ${decideTimes.length} candidates.` },
    { label: "Holds resolved within 7 days", value: holdNotes.length ? `${overdue} overdue of ${holdNotes.length} hold notes` : "–", target: "0 overdue", ok: holdNotes.length ? overdue === 0 : null },
    { label: "Arjun–rubric agreement", value: agreement ? `${agreement.agree} of ${agreement.total} (${Math.round((agreement.agree / agreement.total) * 100)}%)` : "Not run yet", target: "≥ 80%", ok: agreement ? agreement.agree / agreement.total >= 0.8 : null },
    { label: "Arjun override rate", value: scored ? `${override.moved} of ${scored} (${Math.round(override.rate * 100)}%)` : "–", target: "> 30% triggers a rubric review", ok: scored ? override.rate <= 0.3 : null },
  ];
}

export async function overrideRate(): Promise<{ moved: number; rate: number }> {
  const scored = await prisma.candidate.count({ where: { status: { in: SCORED } } });
  const moved = await prisma.candidate.count({ where: { status: { in: SCORED }, movedByArjun: true } });
  return { moved, rate: scored ? moved / scored : 0 };
}

export type Override = { candidateId: string; name: string; role: string | null; score: number; rubric: Band; arjun: Band; reason: string | null; direction: "up" | "down" };

// Where Arjun disagreed with the rubric (§10.3 keeps the gap for recalibration).
export async function overrides(): Promise<Override[]> {
  const cands = await prisma.candidate.findMany({
    where: { movedByArjun: true },
    include: {
      scores: { orderBy: { createdAt: "desc" }, take: 2 },
      statusEvents: { where: { actor: "arjun" }, orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  const order: Band[] = ["REJECTED", "HOLD", "SELECTED"];
  return cands
    .map((c) => {
      const s = c.scores.find((x) => x.roleScored === c.roleAssigned);
      const arjun = bandOfStatus(c.status);
      if (!s || !arjun) return null;
      const rubric = bandFor(s.total);
      return {
        candidateId: c.id,
        name: c.name,
        role: c.roleAssigned,
        score: s.total,
        rubric,
        arjun,
        reason: c.statusEvents[0]?.reason ?? null,
        direction: order.indexOf(arjun) > order.indexOf(rubric) ? "up" : "down",
      } as Override;
    })
    .filter((x): x is Override => x !== null)
    .sort((a, b) => b.score - a.score);
}

// ---- Agreement test (§15.3) ----------------------------------------------

export type AgreementItem = { candidateId: string; arjun: Band | null; rubric: Band; score: number };

// Picks 10 scored CVs, spread across the rubric's bands where possible.
export async function startAgreement(n = 10): Promise<{ id: string } | { error: string }> {
  const cands = await prisma.candidate.findMany({
    where: { status: { in: SCORED } },
    include: { scores: { orderBy: { createdAt: "desc" }, take: 2 } },
  });
  const pool = cands
    .map((c) => {
      const s = c.scores.find((x) => x.roleScored === c.roleAssigned);
      return s ? { candidateId: c.id, rubric: bandFor(s.total), score: s.total } : null;
    })
    .filter((x): x is Omit<AgreementItem, "arjun"> => x !== null);
  if (pool.length < n) return { error: `Needs at least ${n} scored candidates; there are ${pool.length}.` };

  const shuffle = <T,>(xs: T[]) => xs.map((x) => [Math.random(), x] as const).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const byBand = (["SELECTED", "HOLD", "REJECTED"] as Band[]).map((b) => shuffle(pool.filter((p) => p.rubric === b)));
  const picked: Omit<AgreementItem, "arjun">[] = [];
  for (let i = 0; picked.length < n; i = (i + 1) % 3) {
    const next = byBand[i].shift();
    if (next) picked.push(next);
    if (byBand.every((b) => !b.length)) break;
  }
  const items: AgreementItem[] = shuffle(picked).map((p) => ({ ...p, arjun: null }));
  const run = await prisma.agreementRun.create({ data: { itemsJson: JSON.stringify(items) } });
  await prisma.auditLog.create({ data: { actor: "arjun", action: "agreement.started", entity: `agreement:${run.id}`, payloadJson: JSON.stringify({ n: items.length }) } });
  return { id: run.id };
}

export async function recordCall(runId: string, candidateId: string, band: Band): Promise<void> {
  const run = await prisma.agreementRun.findUniqueOrThrow({ where: { id: runId } });
  const items: AgreementItem[] = JSON.parse(run.itemsJson);
  const item = items.find((i) => i.candidateId === candidateId);
  if (!item) return;
  item.arjun = band;
  const done = items.every((i) => i.arjun);
  await prisma.agreementRun.update({ where: { id: runId }, data: { itemsJson: JSON.stringify(items), completedAt: done ? new Date() : null } });
  if (done) {
    const agree = items.filter((i) => i.arjun === i.rubric).length;
    await prisma.auditLog.create({
      data: { actor: "arjun", action: "agreement.completed", entity: `agreement:${runId}`, payloadJson: JSON.stringify({ agree, total: items.length }) },
    });
  }
}

export async function latestAgreement(): Promise<{ agree: number; total: number; runId: string } | null> {
  const run = await prisma.agreementRun.findFirst({ where: { completedAt: { not: null } }, orderBy: { completedAt: "desc" } });
  if (!run) return null;
  const items: AgreementItem[] = JSON.parse(run.itemsJson);
  return { agree: items.filter((i) => i.arjun === i.rubric).length, total: items.length, runId: run.id };
}
