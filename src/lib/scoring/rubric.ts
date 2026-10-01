import type { Role } from "../constants";

// Pure scoring math (§8.3, §10.1, §11.3, §12.4). No I/O, so it is unit-tested
// directly and reused when Arjun changes a candidate's role.

export const CRITERION_IDS = ["P1", "P2", "P3", "P4", "P5", "J1", "J2", "J3", "J4"] as const;
export type CriterionId = (typeof CRITERION_IDS)[number];

export type Level = "4" | "3" | "2" | "1" | "0";
export const LEVELS: Level[] = ["4", "3", "2", "1", "0"];

export type Criterion = {
  id: CriterionId;
  kind: "pattern" | "jd";
  name: string;
  // v1 defines 4, 2 and 0 (1 and 3 sit between); v2 defines every level.
  anchors: Partial<Record<Level, string>> & Record<"4" | "2" | "0", string>;
  notes?: string;
};

export type Weights = Partial<Record<CriterionId, number>>;

export type Rubric = {
  id?: string;
  version: number;
  criteria: Criterion[];
  weights: Record<Role, Weights>;
  rules?: string[];
};

export type Band = "SELECTED" | "HOLD" | "REJECTED";

// One criterion's result after quote verification.
export type CriterionResult = {
  id: CriterionId;
  score: number; // 0–4, already capped if unverified
  rawScore: number; // what the AI gave
  evidenceQuote: string;
  rationale: string;
  strength: string;
  probe: string;
  confidence: "low" | "medium" | "high";
  verified: boolean;
};

// Bands [LOCKED]: ≥75 Selected · 60–74 Hold · <60 Rejected. Totals are rounded
// first, so 74.6 → 75 → Selected.
export const SELECTED_MIN = 75;
export const HOLD_MIN = 60;

export function bandFor(total: number): Band {
  if (total >= SELECTED_MIN) return "SELECTED";
  if (total >= HOLD_MIN) return "HOLD";
  return "REJECTED";
}

export function pointsFor(weight: number, score: number): number {
  return weight * (score / 4);
}

// Round half up (67.5 → 68), matching the §8.4 back-test totals.
export function totalFor(results: Pick<CriterionResult, "id" | "score">[], weights: Weights): number {
  const sum = results.reduce((n, r) => n + pointsFor(weights[r.id] ?? 0, r.score), 0);
  return Math.floor(sum + 0.5 + 1e-9);
}

export function weightedGap(weight: number, score: number): number {
  return weight * (4 - score);
}

export type Point = { criterionId: CriterionId; text: string; quote?: string };

export type Insights = {
  strongPoints: Point[];
  weakPoints: (Point & { gap: number })[];
  probes: string[];
  topReason: string | null;
};

// Strong points: highest weighted points among criteria scored 3+ (falls back
// to 2+). Weak points: largest weighted gap, weight × (4 − score). Probes are
// the AI's questions for those weak criteria.
export function insightsFor(results: CriterionResult[], weights: Weights): Insights {
  const weighted = results.filter((r) => (weights[r.id] ?? 0) > 0);

  const byPoints = [...weighted].sort(
    (a, b) => pointsFor(weights[b.id]!, b.score) - pointsFor(weights[a.id]!, a.score) || b.score - a.score,
  );
  let strong = byPoints.filter((r) => r.score >= 3);
  if (strong.length < 2) strong = byPoints.filter((r) => r.score >= 2);
  const strongPoints = strong.slice(0, 3).map((r) => ({
    criterionId: r.id,
    text: r.strength || r.rationale,
    quote: r.evidenceQuote || undefined,
  }));

  const weak = weighted
    .map((r) => ({ r, gap: weightedGap(weights[r.id]!, r.score) }))
    .filter((x) => x.gap > 0)
    .sort((a, b) => b.gap - a.gap)
    .slice(0, 3);
  const weakPoints = weak.map(({ r, gap }) => ({ criterionId: r.id, text: r.rationale, gap }));
  const probes = weak.map(({ r }) => r.probe).filter(Boolean).slice(0, 3);

  return { strongPoints, weakPoints, probes, topReason: strongPoints[0]?.text ?? null };
}

// The criterion behind a regret email's reason line (§12.4).
export function largestGapCriterion(results: CriterionResult[], weights: Weights): CriterionId | null {
  return insightsFor(results, weights).weakPoints[0]?.criterionId ?? null;
}

// Overall confidence: the weakest confidence among criteria that carry weight
// for either role.
export function overallConfidence(results: CriterionResult[], rubric: Rubric): "low" | "medium" | "high" {
  const used = results.filter((r) => (rubric.weights.PM[r.id] ?? 0) > 0 || (rubric.weights.SPM[r.id] ?? 0) > 0);
  if (used.some((r) => r.confidence === "low")) return "low";
  if (used.some((r) => r.confidence === "medium")) return "medium";
  return "high";
}

export function rubricFromRow(row: {
  id: string;
  version: number;
  criteriaJson: string;
  weightsPmJson: string;
  weightsSpmJson: string;
  rulesJson?: string | null;
}): Rubric {
  return {
    id: row.id,
    version: row.version,
    criteria: JSON.parse(row.criteriaJson),
    weights: { PM: JSON.parse(row.weightsPmJson), SPM: JSON.parse(row.weightsSpmJson) },
    rules: row.rulesJson ? JSON.parse(row.rulesJson) : undefined,
  };
}

// Builds a Rubric from a src/data/rubric_vN.json file (seed, back-test, tests).
export function rubricFromJson(json: {
  version: number;
  criteria: Criterion[];
  weights: Record<Role, Weights>;
  scoringRules?: string[];
}): Rubric {
  return { version: json.version, criteria: json.criteria, weights: json.weights, rules: json.scoringRules };
}
