import type { ScoringOutput } from "./ai";
import { tokens, verifyQuote } from "./quote";
import { CRITERION_IDS, type CriterionId } from "./rubric";

// Gemini 3 runs at temperature 1.0 (Google's advice), so one CV can score
// differently from run to run. Scoring twice, and a third time only when the
// two disagree, then taking each criterion's median, brings totals within the
// spec's ≤3-point consistency target (§15.2).

export type Consensus = {
  output: ScoringOutput;
  runs: number;
  disagreed: CriterionId[]; // criteria where the runs didn't all agree
  unstable: CriterionId[]; // criteria whose runs spanned 2+ points
};

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : s[s.length / 2 - 1]; // lower middle for even counts
}

export function needsTiebreak(a: ScoringOutput, b: ScoringOutput): boolean {
  return CRITERION_IDS.some((id) => a.criteria.find((c) => c.id === id)?.score !== b.criteria.find((c) => c.id === id)?.score);
}

// Combines 1–3 runs. For each criterion it keeps the median score and takes
// the quote and wording from a run that gave that score, preferring one whose
// quote is really in the CV.
export function combine(outputs: ScoringOutput[], blindedText: string): Consensus {
  if (!outputs.length) throw new Error("combine() needs at least one run");
  const textTokens = tokens(blindedText);

  const disagreed: CriterionId[] = [];
  const unstable: CriterionId[] = [];

  const criteria = CRITERION_IDS.map((id) => {
    const runs = outputs.map((o) => o.criteria.find((c) => c.id === id)!);
    const scores = runs.map((r) => r.score);
    const m = median(scores);
    if (new Set(scores).size > 1) disagreed.push(id);
    if (Math.max(...scores) - Math.min(...scores) >= 2) unstable.push(id);

    const atMedian = runs.filter((r) => r.score === m);
    const pick =
      atMedian.find((r) => m === 0 || (r.evidence_quote.trim() && verifyQuote(r.evidence_quote, textTokens))) ?? atMedian[0];
    return { ...pick, score: m };
  });

  const years = outputs.map((o) => o.years_pm_experience);
  const y = median(years);
  const basis = outputs.find((o) => o.years_pm_experience === y)?.pm_experience_basis ?? outputs[0].pm_experience_basis;

  return {
    output: { years_pm_experience: y, pm_experience_basis: basis, criteria },
    runs: outputs.length,
    disagreed,
    unstable,
  };
}
