import { readFile, readdir } from "fs/promises";
import path from "path";
import { prisma } from "./db";
import { extractContact } from "./ingest/extract";
import { parseCv } from "./ingest/parse";
import { makeClient, scoreConsensus } from "./scoring/ai";
import { blind } from "./scoring/blind";
import { evaluate, verifyCriteria } from "./scoring/evaluate";
import { CRITERION_IDS, type CriterionId } from "./scoring/rubric";
import { approvedRubric, loadJds } from "./scoring/score";

// Step 0 calibration (§5), run from the app: score the past hires in
// data/hires with the current rubric and show which criteria separate the
// Exceeds hires from the Meets/Below ones. It proposes nothing by itself;
// Arjun edits the rubric (creating a new version) if the result says so.

const HIRES_DIR = path.join(process.cwd(), "data", "hires");

export type HireResult = {
  file: string;
  name: string;
  role: string;
  rating: "Exceeds" | "Meets" | "Below";
  totals: { PM: number; SPM: number };
  scores: Record<CriterionId, number>;
  unstable: CriterionId[];
};

export type CalibrationResults = {
  hires: HireResult[];
  gaps: { id: CriterionId; strong: number; weaker: number; gap: number }[]; // mean 0–4 scores
  lowestExceedsPm: number;
  highestWeakerPm: number;
};

const g = globalThis as unknown as { kargoCalibrating?: boolean };

// `defer` hands the long-running part to the caller (Next's after()), so it
// keeps running after the response on serverless.
export async function startCalibration(defer: (job: () => Promise<void>) => void = (job) => void job()): Promise<{ started: boolean; reason?: string; runId?: string }> {
  const running = await prisma.calibrationRun.findFirst({ where: { status: "running", createdAt: { gt: new Date(Date.now() - 6 * 60_000) } } });
  if (g.kargoCalibrating || running) return { started: false, reason: "A calibration run is already in progress." };
  const rubric = await approvedRubric();
  if (!rubric) return { started: false, reason: "Approve a rubric first." };
  let client;
  try {
    client = makeClient();
  } catch (err) {
    return { started: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const ratings: Record<string, { name: string; role: string; rating: HireResult["rating"] }> = JSON.parse(
    await readFile(path.join(HIRES_DIR, "ratings.json"), "utf8"),
  );
  const files = (await readdir(HIRES_DIR)).filter((f) => ratings[f]);
  if (!files.length) return { started: false, reason: "No past-hire CVs in data/hires." };

  const run = await prisma.calibrationRun.create({ data: { rubricVersion: rubric.version, status: "running" } });
  g.kargoCalibrating = true;

  defer(async () => {
    try {
      const jds = await loadJds();
      const hires: HireResult[] = [];
      // Four at a time, so the run fits in one serverless request (5 min).
      const todo = [...files];
      const worker = async () => {
        for (let f = todo.shift(); f; f = todo.shift()) await scoreHire(f);
      };
      const scoreHire = async (f: string) => {
        const parsed = await parseCv(f, await readFile(path.join(HIRES_DIR, f)));
        if (!parsed.ok) return;
        const blinded = blind(parsed.text, { name: extractContact(parsed.text, f).name });
        const call = await scoreConsensus(client, { blindedText: blinded, criteria: rubric.criteria, jds, rules: rubric.rules });
        const results = verifyCriteria(call.output, blinded);
        const ev = evaluate(results, rubric, { roleTag: "PM", yearsPm: call.output.years_pm_experience, unstable: call.unstable });
        hires.push({
          file: f,
          ...ratings[f],
          totals: ev.totals,
          scores: Object.fromEntries(results.map((r) => [r.id, r.score])) as Record<CriterionId, number>,
          unstable: call.unstable,
        });
      };
      await Promise.all(Array.from({ length: 4 }, worker));
      hires.sort((a, b) => a.file.localeCompare(b.file));
      await prisma.calibrationRun.update({
        where: { id: run.id },
        data: { status: "done", resultsJson: JSON.stringify(summarise(hires)), finishedAt: new Date() },
      });
      await prisma.auditLog.create({
        data: { actor: "arjun", action: "rubric.calibrated", entity: `rubric:v${rubric.version}`, payloadJson: JSON.stringify({ runId: run.id, hires: hires.length }) },
      });
    } catch (err) {
      await prisma.calibrationRun.update({
        where: { id: run.id },
        data: { status: "failed", error: err instanceof Error ? err.message.slice(0, 300) : String(err), finishedAt: new Date() },
      });
    } finally {
      g.kargoCalibrating = false;
    }
  });
  return { started: true, runId: run.id };
}

export function summarise(hires: HireResult[]): CalibrationResults {
  const strong = hires.filter((h) => h.rating === "Exceeds");
  const weaker = hires.filter((h) => h.rating !== "Exceeds");
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const gaps = CRITERION_IDS.map((id) => {
    const s = mean(strong.map((h) => h.scores[id]));
    const w = mean(weaker.map((h) => h.scores[id]));
    return { id, strong: Math.round(s * 10) / 10, weaker: Math.round(w * 10) / 10, gap: Math.round((s - w) * 10) / 10 };
  }).sort((a, b) => b.gap - a.gap);
  return {
    hires,
    gaps,
    lowestExceedsPm: Math.min(...strong.map((h) => h.totals.PM)),
    highestWeakerPm: Math.max(...weaker.map((h) => h.totals.PM)),
  };
}
