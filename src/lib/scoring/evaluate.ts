import type { Role } from "../constants";
import type { ScoringOutput } from "./ai";
import { tokens, verifyQuote } from "./quote";
import { assignRole, type Flag, type RoleDecision } from "./roleAssign";
import {
  bandFor,
  insightsFor,
  overallConfidence,
  totalFor,
  type Band,
  type CriterionId,
  type CriterionResult,
  type Insights,
  type Rubric,
} from "./rubric";

export type Evaluation = {
  results: CriterionResult[];
  totals: Record<Role, number>;
  decision: RoleDecision;
  band: Band;
  confidence: "low" | "medium" | "high";
  flags: Flag[];
  insights: Insights;
  needsReview: boolean; // ⚠ — excluded from bulk send until Arjun opens it (§10.4)
};

// A score of 1+ with no quote, or a quote not found in the CV, is capped at
// 1 and marked unverified (§8.1, §13.3).
export function verifyCriteria(out: ScoringOutput, blindedText: string): CriterionResult[] {
  const textTokens = tokens(blindedText);
  return out.criteria.map((c) => {
    const quote = c.evidence_quote.trim();
    const verified = c.score === 0 || (quote.length > 0 && verifyQuote(quote, textTokens));
    return {
      id: c.id,
      rawScore: c.score,
      score: verified ? c.score : Math.min(c.score, 1),
      evidenceQuote: quote,
      rationale: c.rationale.trim(),
      strength: c.strength.trim(),
      probe: c.probe.trim(),
      confidence: c.confidence,
      verified,
    };
  });
}

export function evaluate(
  results: CriterionResult[],
  rubric: Rubric,
  opts: { roleTag: Role | null; yearsPm: number; roleOverride?: Role; unstable?: CriterionId[] },
): Evaluation {
  const totals = {
    PM: totalFor(results, rubric.weights.PM),
    SPM: totalFor(results, rubric.weights.SPM),
  };
  const decision: RoleDecision = opts.roleOverride
    ? { role: opts.roleOverride, source: "rubric", confirm: false, flags: [] }
    : assignRole({ roleTag: opts.roleTag, yearsPm: opts.yearsPm, totals });

  const confidence = overallConfidence(results, rubric);
  const flags: Flag[] = [...decision.flags];
  const unverified = results.filter((r) => !r.verified && (rubric.weights[decision.role][r.id] ?? 0) > 0);
  if (unverified.length) {
    flags.push({
      code: "unverified",
      message: `Unverified evidence for ${unverified.map((r) => r.id).join(", ")}: the quote wasn't found in the CV, so the score is capped at 1.`,
    });
  }
  if (confidence === "low") flags.push({ code: "low_confidence", message: "Low AI confidence on at least one criterion." });
  // Criteria whose repeated runs spread 2+ points: the median is used, but a
  // human should look (only those that carry weight for this role).
  const unstable = (opts.unstable ?? []).filter((id) => (rubric.weights[decision.role][id] ?? 0) > 0);
  if (unstable.length) {
    flags.push({
      code: "unstable",
      message: `The AI's repeated runs disagreed by 2+ points on ${unstable.join(", ")}; the middle score is used. Worth a look.`,
    });
  }

  return {
    results,
    totals,
    decision,
    band: bandFor(totals[decision.role]),
    confidence,
    flags,
    insights: insightsFor(results, rubric.weights[decision.role]),
    needsReview: unverified.length > 0 || confidence === "low" || unstable.length > 0,
  };
}
