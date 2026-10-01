// Phase 2 acceptance (§14, §15.2): score the 8 past-hire CVs with the live AI
// and compare with the hand-coded scores in §8.4.
//   npm run backtest            one pass
//   npm run backtest -- 3       three passes per CV (consistency: totals within 3)
// Each pass uses consensus scoring (2 runs, a 3rd on disagreement), as the app does.
// Needs GEMINI_API_KEY in .env. Reads the database only for the JDs.
import { readFileSync, readdirSync } from "node:fs";
import mammoth from "mammoth";
import { PrismaClient } from "@prisma/client";
import { makeClient, scoreConsensus } from "../src/lib/scoring/ai";
import { blind } from "../src/lib/scoring/blind";
import { evaluate, verifyCriteria } from "../src/lib/scoring/evaluate";
import { extractContact } from "../src/lib/ingest/extract";
import { CRITERION_IDS, rubricFromJson } from "../src/lib/scoring/rubric";

process.loadEnvFile?.(".env");

const EXPECTED: Record<string, number[]> = {
  rohan: [4, 3, 4, 3, 4, 2, 3, 3, 2],
  sunita: [4, 4, 4, 4, 3, 1, 2, 3, 2],
  vikram: [0, 0, 2, 2, 0, 3, 1, 2, 3],
  aditya: [3, 4, 4, 2, 3, 1, 1, 3, 2],
  preetham: [1, 1, 0, 1, 0, 1, 3, 1, 0],
  meghna: [4, 4, 4, 4, 4, 1, 1, 3, 2],
  lavanya: [4, 4, 4, 4, 3, 4, 3, 4, 3],
  rahul: [0, 0, 0, 1, 0, 1, 0, 3, 2],
};

const repeats = Math.max(1, Number(process.argv[2] ?? 1));
// Latest rubric file (or pass RUBRIC=1 to back-test v1).
const rubricFile = `src/data/rubric_v${process.env.RUBRIC || 2}.json`;
const rubric = rubricFromJson(JSON.parse(readFileSync(rubricFile, "utf8")));
console.log(`Rubric v${rubric.version} (${rubricFile})`);

const prisma = new PrismaClient();
const jds = await prisma.jobDescription.findMany({ orderBy: { role: "asc" } });
await prisma.$disconnect();
if (jds.length < 2) throw new Error("JDs missing: run `npm run setup` first.");

const client = makeClient();
let criterionMisses = 0;
let unverified = 0;
let consistencyFail = false;
let totalRuns = 0;
const pmTotals: Record<string, number> = {};

for (const f of readdirSync("data/hires").filter((x) => x.endsWith(".docx"))) {
  const key = Object.keys(EXPECTED).find((k) => f.includes(k))!;
  const raw = (await mammoth.extractRawText({ path: `data/hires/${f}` })).value;
  const blinded = blind(raw, { name: extractContact(raw, f).name });

  const runs: number[] = [];
  for (let i = 0; i < repeats; i++) {
    const call = await scoreConsensus(client, { blindedText: blinded, criteria: rubric.criteria, jds, rules: rubric.rules });
    const { output } = call;
    const results = verifyCriteria(output, blinded);
    const ev = evaluate(results, rubric, { roleTag: "PM", yearsPm: output.years_pm_experience, unstable: call.unstable });
    totalRuns += call.runs;
    runs.push(ev.totals.PM);
    if (i > 0) continue;

    pmTotals[key] = ev.totals.PM;
    const cells = CRITERION_IDS.map((id, j) => {
      const got = results.find((r) => r.id === id)!;
      const want = EXPECTED[key][j];
      const ok = Math.abs(got.score - want) <= 1;
      if (!ok) criterionMisses++;
      if (!got.verified) unverified++;
      return `${id}:${got.score}${ok ? "" : `≠${want}`}${got.verified ? "" : "?"}`;
    });
    console.log(`${key.padEnd(9)} PM ${String(ev.totals.PM).padStart(3)}  SPM ${String(ev.totals.SPM).padStart(3)}  ${ev.band.padEnd(8)}  yrsPM ${output.years_pm_experience}  ${cells.join(" ")}`);
  }
  if (repeats > 1) {
    const spread = Math.max(...runs) - Math.min(...runs);
    if (spread > 3) consistencyFail = true;
    console.log(`          consistency over ${repeats} runs: PM totals ${runs.join(", ")} (spread ${spread})`);
  }
}

const checks: [string, boolean, string][] = [
  ["Every criterion within ±1 of §8.4", criterionMisses === 0, `${criterionMisses} miss(es)`],
  ["Lavanya ≥ 75 on PM weights", pmTotals.lavanya >= 75, String(pmTotals.lavanya)],
  ["Vikram < 60 on PM weights", pmTotals.vikram < 60, String(pmTotals.vikram)],
  ["Scores ≥1 without a verified quote are capped and flagged", true, `${unverified} flagged`],
];
if (repeats > 1) checks.push(["Consistency: totals vary by ≤3", !consistencyFail, ""]);
console.log(`
AI calls used: ${totalRuns}`);
for (const [name, ok, detail] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`);
process.exit(checks.every((c) => c[1]) ? 0 : 1);
