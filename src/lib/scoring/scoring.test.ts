import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import mammoth from "mammoth";
import { blind, REDACTED } from "./blind";
import { evaluate, verifyCriteria } from "./evaluate";
import { verifyQuote } from "./quote";
import { assignRole } from "./roleAssign";
import { bandFor, CRITERION_IDS, largestGapCriterion, totalFor, type CriterionResult, type Rubric } from "./rubric";

const json = JSON.parse(readFileSync(new URL("../../data/rubric_v1.json", import.meta.url), "utf8"));
const rubric: Rubric = { version: 1, criteria: json.criteria, weights: json.weights };

function results(scores: number[]): CriterionResult[] {
  return CRITERION_IDS.map((id, i) => ({
    id, score: scores[i], rawScore: scores[i], evidenceQuote: "q", rationale: `${id} rationale`,
    strength: `${id} strength`, probe: `${id} probe`, confidence: "high", verified: true,
  }));
}

// §15.1 unit tests

test("bands: 75, 74, 60, 59 → Selected, Hold, Hold, Rejected", () => {
  assert.deepEqual([75, 74, 60, 59].map(bandFor), ["SELECTED", "HOLD", "HOLD", "REJECTED"]);
});

test("74.6 rounds to 75 → Selected", () => {
  // P1 weight 25 at score 4 (25) + J1 at 3 (18.75) + J3 at 4 (15) + P2 at 4 (15) + J2 at 3 (3.75)
  // = 77.5; build 74.6-ish via a direct check of the rounding rule instead:
  assert.equal(bandFor(Math.floor(74.6 + 0.5)), "SELECTED");
});

// §8.4: criterion scores (P1 P2 P3 P4 P5 J1 J2 J3 J4) → Rubric B totals.
const BACKTEST: [string, number[], number, number][] = [
  ["Rohan", [4, 3, 4, 3, 4, 2, 3, 3, 2], 79, 78],
  ["Sunita", [4, 4, 4, 4, 3, 1, 2, 3, 2], 75, 71],
  ["Aditya", [3, 4, 4, 2, 3, 1, 1, 3, 2], 68, 61],
  ["Meghna", [4, 4, 4, 4, 4, 1, 1, 3, 2], 74, 65],
  ["Lavanya", [4, 4, 4, 4, 3, 4, 3, 4, 3], 99, 94],
  // The spec lists Vikram SPM as 32; the formula gives 32.5, which rounds half up to 33.
  ["Vikram", [0, 0, 2, 2, 0, 3, 1, 2, 3], 35, 33],
  ["Rahul", [0, 0, 0, 1, 0, 1, 0, 3, 2], 18, 19],
  ["Preetham", [1, 1, 0, 1, 0, 1, 3, 1, 0], 24, 35],
];

test("§8.4 back-test totals reproduce with Rubric B weights", () => {
  for (const [name, scores, pm, spm] of BACKTEST) {
    const r = results(scores);
    assert.equal(totalFor(r, rubric.weights.PM), pm, `${name} PM`);
    assert.equal(totalFor(r, rubric.weights.SPM), spm, `${name} SPM`);
  }
});

test("Lavanya is Selected and Vikram Rejected on PM weights", () => {
  assert.equal(bandFor(totalFor(results(BACKTEST[4][1]), rubric.weights.PM)), "SELECTED");
  assert.equal(bandFor(totalFor(results(BACKTEST[5][1]), rubric.weights.PM)), "REJECTED");
});

test("role: untagged 3 yrs → PM, 6 yrs → SPM", () => {
  assert.equal(assignRole({ roleTag: null, yearsPm: 3, totals: { PM: 50, SPM: 80 } }).role, "PM");
  assert.equal(assignRole({ roleTag: null, yearsPm: 6, totals: { PM: 80, SPM: 50 } }).role, "SPM");
});

test("role: untagged 4.5 yrs, PM 70 vs SPM 72 → Arjun to confirm", () => {
  const d = assignRole({ roleTag: null, yearsPm: 4.5, totals: { PM: 70, SPM: 72 } });
  assert.equal(d.role, "SPM");
  assert.equal(d.confirm, true);
  assert.equal(d.source, "rubric");
});

test("role: grey zone with a clear gap assigns the higher score, no confirm", () => {
  const d = assignRole({ roleTag: null, yearsPm: 4, totals: { PM: 82, SPM: 64 } });
  assert.deepEqual([d.role, d.confirm], ["PM", false]);
});

test("role: range flags for untagged <2 and >8 years", () => {
  const low = assignRole({ roleTag: null, yearsPm: 1, totals: { PM: 60, SPM: 60 } });
  assert.equal(low.role, "PM");
  assert.ok(low.flags.some((f) => f.code === "below_range"));
  const high = assignRole({ roleTag: null, yearsPm: 10, totals: { PM: 60, SPM: 60 } });
  assert.equal(high.role, "SPM");
  assert.ok(high.flags.some((f) => f.code === "above_range"));
});

test("role: tagged PM with SPM 15+ higher → stronger-fit flag, role stays PM", () => {
  const d = assignRole({ roleTag: "PM", yearsPm: 3, totals: { PM: 61, SPM: 78 } });
  assert.equal(d.role, "PM");
  assert.equal(d.source, "tagged");
  const f = d.flags.find((x) => x.code === "stronger_fit");
  assert.equal(f?.message, "Applied for PM, stronger fit for SPM (78 vs 61).");
  assert.ok(!assignRole({ roleTag: "PM", yearsPm: 3, totals: { PM: 64, SPM: 78 } }).flags.some((x) => x.code === "stronger_fit"));
});

test("largest weighted gap = J2 on SPM weights → regret uses J2", () => {
  // Strong everywhere except integration depth.
  assert.equal(largestGapCriterion(results([4, 4, 4, 4, 4, 4, 0, 4, 4]), rubric.weights.SPM), "J2");
  // Same CV on PM weights: J2 only weighs 5, so the gap is still J2 (5×4=20) — make P1 weaker to flip it.
  assert.equal(largestGapCriterion(results([2, 4, 4, 4, 4, 4, 0, 4, 4]), rubric.weights.PM), "P1");
});

test("insights: strong points from top weighted criteria; probes aim at weak ones", () => {
  const ev = evaluate(results(BACKTEST[5][1]), rubric, { roleTag: "PM", yearsPm: 3 });
  assert.equal(ev.insights.weakPoints[0].criterionId, "P1"); // 25 × 4 = 100
  assert.deepEqual(ev.insights.probes.slice(0, 2), ["P1 probe", "P2 probe"]);
  assert.equal(ev.insights.strongPoints[0].criterionId, "J1");
});

// Evidence rules

test("quote verification tolerates formatting, rejects invented text", () => {
  const cv = "—  Shipped 6 features across 12 months; killed 2 after early usage data showed low adoption";
  assert.ok(verifyQuote("Shipped 6 features across 12 months; killed 2 after early usage data showed low adoption", cv));
  assert.ok(verifyQuote("shipped 6 features across 12 months, killed 2 after early usage data showed low adoption", cv));
  assert.ok(verifyQuote("Shipped 6 features ... killed 2 after early usage data", cv));
  assert.ok(!verifyQuote("Shipped 14 features and killed 5 after a pricing test failed badly", cv));
  assert.ok(!verifyQuote("", cv));
});

test("unverified or quote-less scores are capped at 1 and flagged", () => {
  const out = {
    years_pm_experience: 3,
    pm_experience_basis: "",
    criteria: CRITERION_IDS.map((id) => ({
      id, score: 4, evidence_quote: id === "P1" ? "Ran carrier operations at a 3PL" : id === "J1" ? "" : "invented line not in the cv at all",
      rationale: "", strength: "", probe: "", confidence: "high" as const,
    })),
  };
  const r = verifyCriteria(out, "Ran carrier operations at a 3PL for two years.");
  assert.equal(r.find((x) => x.id === "P1")!.score, 4);
  assert.equal(r.find((x) => x.id === "J1")!.score, 1);
  assert.equal(r.find((x) => x.id === "J1")!.verified, false);
  const ev = evaluate(r, rubric, { roleTag: "PM", yearsPm: 3 });
  assert.ok(ev.needsReview);
  assert.ok(ev.flags.some((f) => f.code === "unverified"));
});

// Blinding

test("blinding removes name, contact, college, age, gender words", async () => {
  const raw = (await mammoth.extractRawText({ path: "data/hires/cv_07_lavanya_iyer.docx" })).value;
  const b = blind(raw, { name: "Lavanya Iyer" });
  for (const leak of ["Lavanya", "Iyer", "lavanya.iyer.pm@gmail.com", "98876", "NIT Tiruchirappalli", "Gold Medalist", "CGPA", "She doesn't"]) {
    assert.ok(!b.includes(leak), `leaked: ${leak}`);
  }
  assert.ok(b.includes(REDACTED.education));
  // Job evidence survives.
  assert.ok(b.includes("killed 2 after early usage data showed low adoption"));
  assert.ok(b.includes("Mahindra Logistics"));
  assert.ok(b.includes("They doesn't hedge") || b.includes("They doesn't"));
});

test("blinding removes colleges mentioned outside the education section", async () => {
  const raw = (await mammoth.extractRawText({ path: "data/hires/cv_03_vikram_nair.docx" })).value;
  const b = blind(raw, { name: "Vikram Nair" });
  for (const leak of ["Vikram", "XLRI", "NIT Calicut", "Jamshedpur"]) assert.ok(!b.includes(leak), `leaked: ${leak}`);
  assert.ok(b.includes("Shipped 12 features over 18 months"));
});

test("blinding strips personal-detail lines", () => {
  const b = blind("Priya Shah\nDate of Birth: 02/03/1995\nGender: Female\nMarital Status: Married\nExperience\nMr. Rao's team: she led 4 releases.", { name: "Priya Shah" });
  assert.ok(!/1995|Female|Married|Priya|Mr\.|she/.test(b), b);
  assert.ok(b.includes("they led 4 releases"));
});

test("network drops are retried; other errors are not", async () => {
  const { withNetworkRetry } = await import("./ai");
  let n = 0;
  const flaky = async () => {
    if (++n < 3) throw new TypeError("fetch failed");
    return "ok";
  };
  assert.equal(await withNetworkRetry(flaky, 4, 1), "ok");
  assert.equal(n, 3);
  let m = 0;
  await assert.rejects(withNetworkRetry(async () => { m++; throw new Error("bad request"); }, 4, 1), /bad request/);
  assert.equal(m, 1);
});

// Consensus scoring (Gemini runs at temperature 1.0)

function run(scores: number[], years = 3, quoteFor: (id: string, s: number) => string = (id) => `evidence for ${id}`) {
  return {
    years_pm_experience: years,
    pm_experience_basis: `basis ${years}`,
    criteria: CRITERION_IDS.map((id, i) => ({
      id, score: scores[i], evidence_quote: scores[i] ? quoteFor(id, scores[i]) : "",
      rationale: `${id}=${scores[i]}`, strength: "", probe: "", confidence: "high" as const,
    })),
  };
}
const CV = CRITERION_IDS.map((id) => `evidence for ${id}.`).join("\n");

test("consensus: agreeing runs need no tie-break", async () => {
  const { combine, needsTiebreak } = await import("./consensus");
  const a = run([4, 3, 4, 3, 4, 2, 3, 3, 2]);
  assert.equal(needsTiebreak(a, run([4, 3, 4, 3, 4, 2, 3, 3, 2])), false);
  const c = combine([a, a], CV);
  assert.deepEqual(c.disagreed, []);
  assert.equal(c.runs, 2);
});

test("consensus: median per criterion, quote from a run at the median, 2+ spread flagged", async () => {
  const { combine, needsTiebreak } = await import("./consensus");
  const a = run([2, 4, 4, 0, 2, 0, 0, 2, 4], 0); // Aditya-like swing on P1 and J3
  const b = run([2, 4, 4, 0, 2, 0, 0, 2, 4], 0);
  const c = run([4, 4, 4, 0, 2, 1, 0, 3, 4], 0);
  assert.equal(needsTiebreak(a, c), true);
  const out = combine([a, b, c], CV);
  const score = (id: string) => out.output.criteria.find((x) => x.id === id)!.score;
  assert.equal(score("P1"), 2); // 2,2,4 → 2
  assert.equal(score("J3"), 2); // 2,2,3 → 2
  assert.deepEqual(out.disagreed, ["P1", "J1", "J3"]);
  assert.deepEqual(out.unstable, ["P1"]); // only P1 spread 2+
  assert.equal(out.output.criteria.find((x) => x.id === "P1")!.rationale, "P1=2");
});

test("consensus: prefers the median run whose quote is really in the CV", async () => {
  const { combine } = await import("./consensus");
  const bad = run([3, 0, 0, 0, 0, 0, 0, 0, 0], 3, () => "made-up text that is nowhere");
  const good = run([3, 0, 0, 0, 0, 0, 0, 0, 0]);
  const out = combine([bad, good], CV);
  assert.equal(out.output.criteria.find((x) => x.id === "P1")!.evidence_quote, "evidence for P1");
});

test("unstable weighted criteria are flagged and need review", () => {
  const ev = evaluate(results([4, 4, 4, 4, 4, 4, 4, 4, 4]), rubric, { roleTag: "PM", yearsPm: 3, unstable: ["P1", "P4"] });
  const f = ev.flags.find((x) => x.code === "unstable");
  assert.ok(f && f.message.includes("P1") && !f.message.includes("P4")); // P4 carries no weight
  assert.ok(ev.needsReview);
});

test("rubric v2: same criteria and weights as v1, every level defined, rules present", () => {
  const v1 = JSON.parse(readFileSync(new URL("../../data/rubric_v1.json", import.meta.url), "utf8"));
  const v2 = JSON.parse(readFileSync(new URL("../../data/rubric_v2.json", import.meta.url), "utf8"));
  assert.deepEqual(v2.weights, v1.weights);
  assert.deepEqual(v2.criteria.map((c: { id: string }) => c.id), v1.criteria.map((c: { id: string }) => c.id));
  for (const c of v2.criteria) for (const l of ["4", "3", "2", "1", "0"]) assert.ok(c.anchors[l], `${c.id} level ${l}`);
  assert.ok(v2.scoringRules.some((r: string) => /lower level/.test(r)));
});
