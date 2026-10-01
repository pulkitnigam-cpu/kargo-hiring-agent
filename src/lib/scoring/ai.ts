import { FinishReason, GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { combine, needsTiebreak, type Consensus } from "./consensus";
import { CRITERION_IDS, LEVELS, type Criterion } from "./rubric";

// AI contract 1: scoring (§13.3), on Google Gemini. One call per candidate
// scores all nine criteria against the anchors, which don't depend on the
// role; the system then applies PM and SPM weights to the same scores (as the
// §8.4 back-test does). That keeps both role totals consistent and makes a
// role change a recalculation, not a new AI call.

// Pinned version, not a "-latest" alias, so scores don't shift when Google
// moves the alias. Override with GEMINI_MODEL.
export const DEFAULT_MODEL = "gemini-3.1-pro-preview";

const CriterionScore = z.object({
  id: z.enum(CRITERION_IDS),
  score: z.number().int(),
  evidence_quote: z.string(),
  rationale: z.string(),
  strength: z.string(),
  probe: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
});

export const ScoringOutput = z.object({
  years_pm_experience: z.number(),
  pm_experience_basis: z.string(),
  criteria: z.array(CriterionScore),
});
export type ScoringOutput = z.infer<typeof ScoringOutput>;

// Gemini's structured output takes JSON Schema; derive it from the zod schema
// so there is one definition.
const { $schema: _drop, ...RESPONSE_SCHEMA } = z.toJSONSchema(ScoringOutput) as Record<string, unknown>;
void _drop;

export class ScoringRejected extends Error {}

const LEVEL_LABEL: Record<string, string> = { "4": "4 (strong)", "3": "3", "2": "2 (partial)", "1": "1", "0": "0 (none)" };

function systemPrompt(criteria: Criterion[], jds: { role: string; title: string; text: string }[], rules: string[] = []): string {
  const fullyDefined = criteria.every((c) => LEVELS.every((l) => c.anchors[l]));
  const library = criteria
    .map((c) => {
      const levels = LEVELS.filter((l) => c.anchors[l]).map((l) => `  ${LEVEL_LABEL[l]}: ${c.anchors[l]}`).join("\n");
      return `${c.id} ${c.name}\n${levels}${c.notes ? `\n  Note: ${c.notes}` : ""}`;
    })
    .join("\n\n");
  const levelLine = fullyDefined
    ? "Every level from 0 to 4 is defined; use the one whose conditions the CV meets."
    : "1 and 3 sit between the neighbouring anchors.";
  const ruleText = rules.length ? `\n\nScoring rules (apply them strictly):\n${rules.map((r) => `- ${r}`).join("\n")}` : "";
  const jdText = jds.map((j) => `### ${j.title} (${j.role})\n${j.text}`).join("\n\n");

  return `You score CVs for Kargo, a logistics SaaS company in Mumbai, against a fixed rubric. Kargo is hiring a Product Manager (PM) and a Senior Product Manager (SPM). Your scores are a recommendation that the founder, Arjun, reviews candidate by candidate; every score he sees shows the CV line behind it, so evidence matters more than anything else.

Personal details have been removed from the CV. Judge only job-related evidence. Ignore college names or prestige, age, gender, location and career gaps, even if some of it slipped through.

Score every one of the nine criteria below from 0 to 4 using only these anchors. ${levelLine}${ruleText}

${library}

For each criterion:
- score: an integer 0–4.
- evidence_quote: for any score of 1 or more, copy the CV text that supports it exactly, word for word (one sentence or bullet is enough; join two short fragments with "..." only if needed). If nothing in the CV supports the criterion, score 0 and leave the quote empty. Never infer beyond the text.
- rationale: one plain sentence on why this score, in terms of the anchor.
- strength: if the score is 3 or 4, one short sentence naming what stands out, written for Arjun (e.g. "Ran carrier operations at a 3PL before moving into product"). Otherwise empty.
- probe: one interview question Arjun could ask to test the gap between this score and a 4. Specific to this CV, not generic.
- confidence: high when the CV is explicit, medium when it takes some reading between the lines, low when the evidence is thin or ambiguous.

Also estimate years_pm_experience: total years in roles with a product management title (Product Manager, Associate/Senior/Group PM, Product Owner, Head of Product). Don't count internships, or operations, engineering, sales or analyst roles, even if they were product-adjacent. Use the dates on the CV; treat "Present" as September 2026. In pm_experience_basis, list the roles you counted with their dates.

For context, the two job descriptions:

${jdText}`;
}

export type ScoreInput = {
  blindedText: string;
  criteria: Criterion[];
  jds: { role: string; title: string; text: string }[];
  rules?: string[];
};

export type ScoreCall = { output: ScoringOutput; model: string; attempts: number };

export class MissingKeyError extends Error {}

export function makeClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new MissingKeyError("No Gemini API key found. Set GEMINI_API_KEY in .env and restart the server.");
  // The SDK retries rate limits (429) and server errors with backoff.
  return new GoogleGenAI({ apiKey, httpOptions: { retryOptions: { attempts: 6, initialDelay: 2 } } });
}

// Finish reasons that mean Gemini refused or filtered the answer.
const BLOCKED = new Set<string>([
  FinishReason.SAFETY,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.BLOCKLIST,
  FinishReason.SPII,
  FinishReason.RECITATION,
]);

// Retries up to 2 times when the output fails validation (§13.3).
export async function scoreCv(client: GoogleGenAI, input: ScoreInput): Promise<ScoreCall> {
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const systemInstruction = systemPrompt(input.criteria, input.jds, input.rules);

  let lastProblem = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await withNetworkRetry(() => client.models.generateContent({
      model,
      contents: `Score this CV.\n\n<cv>\n${input.blindedText}\n</cv>`,
      config: {
        systemInstruction,
        // Spec §13.1 asks for temperature 0, but Google advises keeping Gemini 3
        // at its default of 1.0 (lower values can loop or degrade reasoning).
        // Consistency is measured instead: `npm run backtest -- 3`.
        seed: 7,
        maxOutputTokens: 32768,
        responseMimeType: "application/json",
        responseJsonSchema: RESPONSE_SCHEMA,
      },
    }));

    if (response.promptFeedback?.blockReason) {
      throw new ScoringRejected(`The AI declined to score this CV (${response.promptFeedback.blockReason}).`);
    }
    const finish = response.candidates?.[0]?.finishReason;
    if (finish && BLOCKED.has(finish)) {
      throw new ScoringRejected(`The AI declined to score this CV (${finish}).`);
    }
    if (finish === FinishReason.MAX_TOKENS) {
      lastProblem = "response was cut off";
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text ?? "");
    } catch {
      lastProblem = "response wasn't valid JSON";
      continue;
    }
    const result = ScoringOutput.safeParse(parsed);
    if (!result.success) {
      lastProblem = "response didn't match the schema";
      continue;
    }
    const problem = validate(result.data);
    if (!problem) return { output: result.data, model: response.modelVersion ?? model, attempts: attempt };
    lastProblem = problem;
  }
  throw new ScoringRejected(`AI output was invalid after 3 attempts (${lastProblem}).`);
}

export type ConsensusCall = Consensus & { model: string };

// Scores a CV by consensus (see consensus.ts): two runs in parallel, a third
// only if they disagree. SCORING_RUNS=1 turns this off (single run).
export async function scoreConsensus(client: GoogleGenAI, input: ScoreInput): Promise<ConsensusCall> {
  const single = Number(process.env.SCORING_RUNS) === 1;
  const attempt = () => scoreCv(client, input);

  const settled = await Promise.allSettled(single ? [attempt()] : [attempt(), attempt()]);
  // API, quota and network errors go to the queue; only declines are tolerated.
  const hard = settled.find((s) => s.status === "rejected" && !(s.reason instanceof ScoringRejected));
  if (hard) throw (hard as PromiseRejectedResult).reason;
  const calls = settled.filter((s): s is PromiseFulfilledResult<ScoreCall> => s.status === "fulfilled").map((s) => s.value);
  const firstDecline = settled.find((s) => s.status === "rejected") as PromiseRejectedResult | undefined;

  const extra = !single && (calls.length === 1 || (calls.length === 2 && needsTiebreak(calls[0].output, calls[1].output)));
  if (extra) {
    try {
      calls.push(await attempt());
    } catch (err) {
      if (!(err instanceof ScoringRejected)) throw err;
    }
  }
  if (!calls.length) throw firstDecline?.reason ?? new ScoringRejected("The AI couldn't score this CV.");

  const c = combine(calls.map((x) => x.output), input.blindedText);
  return { ...c, model: calls[0].model };
}

// The SDK retries error responses (429, 5xx) but not dropped connections
// ("fetch failed", ECONNRESET), which a long scoring call can hit. Retry those
// a few times with backoff before giving up.
export async function withNetworkRetry<T>(fn: () => Promise<T>, tries = 4, baseMs = 2000): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const network = err instanceof TypeError && /fetch failed/i.test(err.message);
      if (!network || i >= tries) throw err;
      await new Promise((r) => setTimeout(r, baseMs * 2 ** (i - 1)));
    }
  }
}

// Checks the schema can't express: all nine criteria exactly once, scores in range.
export function validate(out: ScoringOutput): string | null {
  const ids = out.criteria.map((c) => c.id);
  const missing = CRITERION_IDS.filter((id) => !ids.includes(id));
  if (missing.length) return `missing criteria ${missing.join(", ")}`;
  if (new Set(ids).size !== ids.length) return "a criterion was scored twice";
  const bad = out.criteria.find((c) => c.score < 0 || c.score > 4);
  if (bad) return `${bad.id} score ${bad.score} is outside 0–4`;
  if (!(out.years_pm_experience >= 0 && out.years_pm_experience < 60)) return "years of PM experience is not plausible";
  return null;
}
