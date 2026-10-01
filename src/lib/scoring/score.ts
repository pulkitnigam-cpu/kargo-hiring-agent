import type { GoogleGenAI } from "@google/genai";
import { prisma } from "../db";
import { CANDIDATE_STATUS, type Role } from "../constants";
import { bandOfStatus } from "../decisions";
import { cancelPendingFor } from "../email/drafts";
import { scoreConsensus, ScoringRejected, type ConsensusCall } from "./ai";
import { blind } from "./blind";
import { evaluate, verifyCriteria } from "./evaluate";
import { bandFor, pointsFor, rubricFromRow, type Rubric } from "./rubric";

const S = CANDIDATE_STATUS;
const POST_SEND: string[] = [S.INVITED, S.HOLD_NOTIFIED, S.REGRET_SENT];

export async function approvedRubric(): Promise<Rubric | null> {
  const row = await prisma.rubricVersion.findFirst({
    where: { approvedAt: { not: null } },
    orderBy: { version: "desc" },
  });
  return row ? rubricFromRow(row) : null;
}

export async function loadJds() {
  return prisma.jobDescription.findMany({ orderBy: { role: "asc" } });
}

// Scores one candidate end to end and stores everything the dashboard needs.
// Also used to re-score under a new rubric version: then a role Arjun set,
// a move he made, and any status after an email are kept (§10.3: the
// decision is his); only the scores and the proposed band are new. API failures (key, quota, network) are thrown so the queue can
// stop or retry; a CV the AI can't score is moved to Needs manual look.
export async function scoreCandidate(
  client: GoogleGenAI,
  candidateId: string,
  rubric: Rubric,
  jds: { role: string; title: string; text: string }[],
): Promise<void> {
  const candidate = await prisma.candidate.findUniqueOrThrow({
    where: { id: candidateId },
    include: { cvFiles: { orderBy: { createdAt: "desc" }, take: 1, select: { rawText: true } } },
  });
  const rawText = candidate.cvFiles[0]?.rawText;
  if (!rawText) {
    await toManualLook(candidateId, candidate.status, "No readable CV text to score.");
    return;
  }

  const blindedText = blind(rawText, { name: candidate.name });

  let call: ConsensusCall;
  try {
    call = await scoreConsensus(client, { blindedText, criteria: rubric.criteria, jds, rules: rubric.rules });
  } catch (err) {
    if (err instanceof ScoringRejected) {
      await toManualLook(candidateId, candidate.status, err.message);
      return;
    }
    throw err;
  }

  const { output, model } = call;
  const results = verifyCriteria(output, blindedText);
  const rescore = candidate.status !== S.PARSED;
  const arjunRole = candidate.roleSource === "arjun" && candidate.roleAssigned ? (candidate.roleAssigned as Role) : undefined;
  const ev = evaluate(results, rubric, {
    roleTag: (candidate.roleTag as Role | null) ?? null,
    yearsPm: output.years_pm_experience,
    unstable: call.unstable,
    roleOverride: arjunRole,
  });
  // After an email, or after Arjun moved them, the status is his decision.
  const keepStatus = rescore && (POST_SEND.includes(candidate.status) || candidate.movedByArjun);
  const status = keepStatus ? candidate.status : ev.band;
  const movedByArjun = keepStatus && bandOfStatus(candidate.status) !== ev.band;
  const scoringMeta = { pmExperienceBasis: output.pm_experience_basis, model, runs: call.runs, disagreed: call.disagreed, unstable: call.unstable };
  const role = ev.decision.role;
  const other: Role = role === "PM" ? "SPM" : "PM";

  await prisma.$transaction(async (tx) => {
    await tx.profile.upsert({
      where: { candidateId },
      update: {
        blindedText,
        yearsPmExperience: output.years_pm_experience,
        structuredJson: JSON.stringify(scoringMeta),
      },
      create: {
        candidateId,
        blindedText,
        yearsPmExperience: output.years_pm_experience,
        structuredJson: JSON.stringify(scoringMeta),
      },
    });

    // One score row per role, both from the same criterion scores.
    for (const r of [role, other] as Role[]) {
      const weights = rubric.weights[r];
      await tx.score.create({
        data: {
          candidateId,
          rubricVersionId: rubric.id!,
          roleScored: r,
          total: ev.totals[r],
          band: bandFor(ev.totals[r]),
          otherRoleTotal: ev.totals[r === "PM" ? "SPM" : "PM"],
          confidence: ev.confidence,
          criteria: {
            create: results.map((c) => ({
              criterionId: c.id,
              score0to4: c.score,
              weight: weights[c.id] ?? 0,
              points: pointsFor(weights[c.id] ?? 0, c.score),
              evidenceQuote: c.evidenceQuote || null,
              rationale: JSON.stringify({
                rationale: c.rationale,
                strength: c.strength,
                probe: c.probe,
                confidence: c.confidence,
                rawScore: c.rawScore,
              }),
              verified: c.verified,
            })),
          },
        },
      });
    }

    await tx.insight.upsert({
      where: { candidateId },
      update: insightData(ev),
      create: { candidateId, ...insightData(ev) },
    });

    await tx.candidate.update({
      where: { id: candidateId },
      data: {
        roleAssigned: role,
        roleSource: arjunRole ? "arjun" : ev.decision.source,
        status,
        movedByArjun,
        manualReason: null,
      },
    });
    await tx.statusEvent.create({
      data: {
        candidateId,
        fromStatus: candidate.status,
        toStatus: status,
        actor: "system",
        reason: `${rescore ? "Re-scored with rubric" : "Rubric"} v${rubric.version}: ${role} ${ev.totals[role]} (other role ${ev.totals[other]})${keepStatus ? `; rubric now proposes ${ev.band}, your decision is kept` : ""}`,
      },
    });
    await tx.auditLog.create({
      data: {
        actor: "system",
        action: rescore ? "candidate.rescored" : "candidate.scored",
        entity: `candidate:${candidateId}`,
        payloadJson: JSON.stringify({
          rubricVersion: rubric.version,
          model,
          role,
          roleSource: ev.decision.source,
          totals: ev.totals,
          band: ev.band,
          statusKept: keepStatus ? candidate.status : null,
          yearsPm: output.years_pm_experience,
          runs: call.runs,
          disagreed: call.disagreed,
          flags: ev.flags.map((f) => f.code),
        }),
      },
    });
  });
  // Drafts were written from the old scores.
  if (rescore) await cancelPendingFor(candidateId, `Re-scored with rubric v${rubric.version}`);
}

function insightData(ev: ReturnType<typeof evaluate>) {
  return {
    strongPointsJson: JSON.stringify(ev.insights.strongPoints),
    weakPointsJson: JSON.stringify(ev.insights.weakPoints),
    probesJson: JSON.stringify(ev.insights.probes),
    flagsJson: JSON.stringify({ flags: ev.flags, needsReview: ev.needsReview, confirmRole: ev.decision.confirm, topReason: ev.insights.topReason }),
  };
}

async function toManualLook(candidateId: string, from: string, reason: string) {
  await prisma.candidate.update({
    where: { id: candidateId },
    data: { status: CANDIDATE_STATUS.NEEDS_MANUAL_LOOK, manualReason: reason },
  });
  await prisma.statusEvent.create({
    data: { candidateId, fromStatus: from, toStatus: CANDIDATE_STATUS.NEEDS_MANUAL_LOOK, actor: "system", reason },
  });
}
