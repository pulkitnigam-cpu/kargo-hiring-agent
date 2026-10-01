import { prisma } from "./db";
import { CANDIDATE_STATUS, type Role } from "./constants";
import { cancelPendingFor } from "./email/drafts";
import { evaluate } from "./scoring/evaluate";
import { rangeFlags } from "./scoring/roleAssign";
import { bandFor, rubricFromRow, type Band, type CriterionId, type CriterionResult } from "./scoring/rubric";

// Arjun's decisions (§6.2, §10.3). The rubric score is never changed by a
// move; the gap between score and decision is kept for recalibration.

const S = CANDIDATE_STATUS;
export const BANDS: Band[] = ["REJECTED", "HOLD", "SELECTED"]; // low → high

// Statuses after an email has gone out still belong to a band.
export function bandOfStatus(status: string): Band | null {
  if (status === S.SELECTED || status === S.INVITED) return "SELECTED";
  if (status === S.HOLD || status === S.HOLD_NOTIFIED) return "HOLD";
  if (status === S.REJECTED || status === S.REGRET_SENT) return "REJECTED";
  return null;
}

export function neighbourBand(band: Band, dir: "up" | "down"): Band | null {
  const i = BANDS.indexOf(band) + (dir === "up" ? 1 : -1);
  return BANDS[i] ?? null;
}

export async function emailAlreadySent(candidateId: string): Promise<boolean> {
  const n = await prisma.email.count({
    where: { candidateId, status: { in: ["sent", "delivered", "bounced"] } },
  });
  return n > 0;
}

async function currentScore(candidateId: string, role: string) {
  return prisma.score.findFirst({
    where: { candidateId, roleScored: role },
    orderBy: { createdAt: "desc" },
    include: { criteria: true, rubricVersion: true },
  });
}

export type MoveResult = { ok: true; from: Band; to: Band; emailWarning: boolean } | { ok: false; error: string };

export async function moveCandidate(candidateId: string, to: Band, reason: string | null): Promise<MoveResult> {
  const c = await prisma.candidate.findUnique({ where: { id: candidateId } });
  if (!c) return { ok: false, error: "Candidate not found." };
  const from = bandOfStatus(c.status);
  if (!from) return { ok: false, error: "Only scored candidates can be moved." };
  if (from === to) return { ok: false, error: "Already in that band." };

  const score = c.roleAssigned ? await currentScore(c.id, c.roleAssigned) : null;
  const scoreBand = score ? bandFor(score.total) : null;
  const emailWarning = await emailAlreadySent(c.id);
  const note = reason?.trim() || null;

  await prisma.$transaction([
    prisma.candidate.update({
      where: { id: c.id },
      data: { status: to, movedByArjun: scoreBand !== null && to !== scoreBand },
    }),
    prisma.statusEvent.create({
      data: { candidateId: c.id, fromStatus: c.status, toStatus: to, actor: "arjun", reason: note },
    }),
    prisma.auditLog.create({
      data: {
        actor: "arjun",
        action: "candidate.moved",
        entity: `candidate:${c.id}`,
        payloadJson: JSON.stringify({
          from,
          to,
          reason: note,
          score: score?.total ?? null,
          scoreBand,
          role: c.roleAssigned,
          rubricVersion: score?.rubricVersion.version ?? null,
          afterEmail: emailWarning,
        }),
      },
    }),
  ]);
  // Drafts and queued emails were for the old band; they must not go out.
  await cancelPendingFor(c.id, `Moved to ${to}`);
  return { ok: true, from, to, emailWarning };
}

// Rebuilds the criterion results stored with a score row.
function resultsFrom(criteria: { criterionId: string; score0to4: number; evidenceQuote: string | null; rationale: string | null; verified: boolean }[]): CriterionResult[] {
  return criteria.map((c) => {
    const d = c.rationale ? JSON.parse(c.rationale) : {};
    return {
      id: c.criterionId as CriterionId,
      score: c.score0to4,
      rawScore: d.rawScore ?? c.score0to4,
      evidenceQuote: c.evidenceQuote ?? "",
      rationale: d.rationale ?? "",
      strength: d.strength ?? "",
      probe: d.probe ?? "",
      confidence: d.confidence ?? "high",
      verified: c.verified,
    };
  });
}

export type RolePreview = { role: Role; total: number; band: Band } | null;

export async function previewRole(candidateId: string, role: Role): Promise<RolePreview> {
  const s = await currentScore(candidateId, role);
  return s ? { role, total: s.total, band: bandFor(s.total) } : null;
}

export type RoleResult = { ok: true; from: Role; to: Role; total: number; band: Band; emailWarning: boolean } | { ok: false; error: string };

// §9.3: one-click role change. Both roles were scored from the same criterion
// scores, so this switches to the other role's weights without a new AI call:
// new total, new proposed band, new strong/weak points and probes.
export async function changeRole(candidateId: string, to: Role, reason: string | null): Promise<RoleResult> {
  const c = await prisma.candidate.findUnique({ where: { id: candidateId }, include: { profile: true, insight: true } });
  if (!c) return { ok: false, error: "Candidate not found." };
  const from = c.roleAssigned as Role | null;
  if (!from) return { ok: false, error: "Only scored candidates can change role." };
  if (from === to) return { ok: false, error: `Already ${to}.` };

  const score = await currentScore(c.id, to);
  if (!score) return { ok: false, error: `No ${to} score on record. Re-score this candidate.` };

  const rubric = rubricFromRow(score.rubricVersion);
  const results = resultsFrom(score.criteria);
  const meta = c.profile?.structuredJson ? JSON.parse(c.profile.structuredJson) : {};
  const ev = evaluate(results, rubric, {
    roleTag: null,
    yearsPm: c.profile?.yearsPmExperience ?? 0,
    roleOverride: to,
    unstable: meta.unstable ?? [],
  });
  const flags = [
    { code: "role_changed", message: `Role changed by Arjun from ${from} to ${to}${c.roleTag && c.roleTag !== to ? ` (applied for ${c.roleTag})` : ""}.` },
    ...rangeFlags(to, c.profile?.yearsPmExperience ?? 0),
    ...ev.flags,
  ];
  const emailWarning = await emailAlreadySent(c.id);
  const note = reason?.trim() || null;
  const prevBand = bandOfStatus(c.status);

  await prisma.$transaction([
    prisma.candidate.update({
      where: { id: c.id },
      // The band is re-proposed from the new score; any earlier move no longer applies.
      data: { roleAssigned: to, roleSource: "arjun", status: ev.band, movedByArjun: false },
    }),
    prisma.insight.update({
      where: { candidateId: c.id },
      data: {
        strongPointsJson: JSON.stringify(ev.insights.strongPoints),
        weakPointsJson: JSON.stringify(ev.insights.weakPoints),
        probesJson: JSON.stringify(ev.insights.probes),
        flagsJson: JSON.stringify({ flags, needsReview: ev.needsReview, confirmRole: false, topReason: ev.insights.topReason }),
      },
    }),
    prisma.statusEvent.create({
      data: {
        candidateId: c.id,
        fromStatus: c.status,
        toStatus: ev.band,
        actor: "arjun",
        reason: `Role ${from} → ${to} (score ${score.total})${note ? `: ${note}` : ""}`,
      },
    }),
    prisma.auditLog.create({
      data: {
        actor: "arjun",
        action: "candidate.role_changed",
        entity: `candidate:${c.id}`,
        payloadJson: JSON.stringify({
          from,
          to,
          reason: note,
          total: score.total,
          band: ev.band,
          previousBand: prevBand,
          rubricVersion: rubric.version,
          afterEmail: emailWarning,
        }),
      },
    }),
  ]);
  await cancelPendingFor(c.id, `Role changed to ${to}`);
  return { ok: true, from, to, total: score.total, band: ev.band, emailWarning };
}

// Opening a candidate counts as reviewing them; ⚠ rows stay out of bulk send
// until this has happened (§10.4).
export async function markReviewed(candidateId: string): Promise<void> {
  const c = await prisma.candidate.findUnique({ where: { id: candidateId }, select: { reviewedAt: true, insight: { select: { flagsJson: true } } } });
  if (!c || c.reviewedAt) return;
  await prisma.candidate.update({ where: { id: candidateId }, data: { reviewedAt: new Date() } });
  const flagged = c.insight ? JSON.parse(c.insight.flagsJson).needsReview : false;
  if (flagged) {
    await prisma.auditLog.create({
      data: { actor: "arjun", action: "candidate.reviewed", entity: `candidate:${candidateId}`, payloadJson: JSON.stringify({ flagged: true }) },
    });
  }
}

export type DetailsInput = { isAugustContact?: boolean; appliedDate?: Date; email?: string };

// Corrections Arjun can make that the upload couldn't know: the applied date,
// the August "let's chat" flag, and a missing email address.
export async function updateDetails(candidateId: string, input: DetailsInput): Promise<{ ok: boolean; error?: string }> {
  const c = await prisma.candidate.findUnique({ where: { id: candidateId }, include: { cvFiles: { take: 1, orderBy: { createdAt: "desc" } } } });
  if (!c) return { ok: false, error: "Candidate not found." };

  const data: Record<string, unknown> = {};
  const changes: Record<string, unknown> = {};
  if (input.isAugustContact !== undefined && input.isAugustContact !== c.isAugustContact) {
    data.isAugustContact = changes.isAugustContact = input.isAugustContact;
  }
  if (input.appliedDate && input.appliedDate.getTime() !== c.appliedDate.getTime()) {
    data.appliedDate = input.appliedDate;
    changes.appliedDate = input.appliedDate.toISOString().slice(0, 10);
  }
  if (input.email !== undefined) {
    const email = input.email.trim().toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "That doesn't look like an email address." };
    if (email && email !== c.email) {
      data.email = changes.email = email;
      // A CV that was only held back for a missing email can now be scored.
      if (c.status === S.NEEDS_MANUAL_LOOK && c.cvFiles[0]?.parseStatus === "ok") {
        data.status = S.PARSED;
        data.manualReason = null;
      }
    }
  }
  if (!Object.keys(data).length) return { ok: true };

  await prisma.$transaction([
    prisma.candidate.update({ where: { id: c.id }, data }),
    ...(data.status
      ? [prisma.statusEvent.create({ data: { candidateId: c.id, fromStatus: c.status, toStatus: S.PARSED, actor: "arjun", reason: "Email added" } })]
      : []),
    prisma.auditLog.create({
      data: { actor: "arjun", action: "candidate.details_updated", entity: `candidate:${c.id}`, payloadJson: JSON.stringify(changes) },
    }),
  ]);
  return { ok: true };
}
