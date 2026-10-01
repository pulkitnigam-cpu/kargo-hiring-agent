import { ApiError, type GoogleGenAI } from "@google/genai";
import { prisma } from "../db";
import { CANDIDATE_STATUS } from "../constants";
import { DEFAULT_MODEL, makeClient, MissingKeyError } from "./ai";
import { approvedRubric, loadJds, scoreCandidate } from "./score";

// Scoring in steps. On Vercel a request can run at most 5 minutes, so a step
// scores CVs for up to ~4 minutes and stops; the dashboard (while open) and
// each upload start the next step. A CV is "claimed" while a step works on
// it, so several steps can run at once without scoring the same CV twice.

const S = CANDIDATE_STATUS;
const CONCURRENCY = Math.max(1, Number(process.env.GEMINI_CONCURRENCY) || 3);
const STEP_BUDGET_MS = 230_000; // a CV takes up to ~60s; leave room before the 300s cap
const CLAIM_TTL_MS = 6 * 60_000; // a claim older than this belongs to a step that died
const SCORED_STATUSES = [S.SELECTED, S.HOLD, S.REJECTED, S.INVITED, S.HOLD_NOTIFIED, S.REGRET_SENT];

export type QueueState = {
  running: boolean; // some step is working right now
  waiting: number; // CVs not scored yet (incl. re-scores)
  total: number; // for the progress bar: waiting + scored in the last hour
  done: number;
  failed: number;
  error: string | null;
};

export type StartResult = { started: boolean; reason?: string };

const pendingWhere = () => ({ OR: [{ status: S.PARSED }, { rescoreRequested: true }] });

let lastError: string | null = null;

export async function queueState(): Promise<QueueState> {
  const fresh = new Date(Date.now() - CLAIM_TTL_MS);
  const [waiting, claimed, recent] = await Promise.all([
    prisma.candidate.count({ where: pendingWhere() }),
    prisma.candidate.count({ where: { AND: [pendingWhere(), { scoringClaimedAt: { gt: fresh } }] } }),
    prisma.auditLog.count({
      where: { action: { in: ["candidate.scored", "candidate.rescored"] }, createdAt: { gt: new Date(Date.now() - 3_600_000) } },
    }),
  ]);
  return { running: claimed > 0, waiting, total: waiting + recent, done: recent, failed: 0, error: lastError };
}

export async function outdatedCount(): Promise<{ count: number; version: number | null }> {
  const rubric = await approvedRubric();
  if (!rubric) return { count: 0, version: null };
  const count = await prisma.candidate.count({
    where: { status: { in: SCORED_STATUSES }, rescoreRequested: false, scores: { none: { rubricVersionId: rubric.id } } },
  });
  return { count, version: rubric.version };
}

// "Re-score all with vN?": mark everyone scored with an older version.
export async function requestRescore(): Promise<number> {
  const rubric = await approvedRubric();
  if (!rubric) return 0;
  const res = await prisma.candidate.updateMany({
    where: { status: { in: SCORED_STATUSES }, scores: { none: { rubricVersionId: rubric.id } } },
    data: { rescoreRequested: true },
  });
  return res.count;
}

// Claims one waiting CV for this step, or returns null when none is free.
async function claimOne(): Promise<string | null> {
  const stale = new Date(Date.now() - CLAIM_TTL_MS);
  for (let attempt = 0; attempt < 5; attempt++) {
    const next = await prisma.candidate.findFirst({
      where: { AND: [pendingWhere(), { OR: [{ scoringClaimedAt: null }, { scoringClaimedAt: { lt: stale } }] }] },
      orderBy: { createdAt: "asc" },
      select: { id: true, scoringClaimedAt: true },
    });
    if (!next) return null;
    // Only one step wins the update; the others try the next CV.
    const won = await prisma.candidate.updateMany({
      where: { id: next.id, scoringClaimedAt: next.scoringClaimedAt },
      data: { scoringClaimedAt: new Date() },
    });
    if (won.count) return next.id;
  }
  return null;
}

// Runs one scoring step. Safe to call from several places at once.
export async function startScoring(): Promise<StartResult> {
  const rubric = await approvedRubric();
  if (!rubric) return { started: false, reason: "The rubric hasn't been approved yet. Approve it on the Rubric page first." };
  if (!(await prisma.candidate.count({ where: pendingWhere() }))) return { started: false, reason: "No CVs are waiting to be scored." };

  let client: GoogleGenAI;
  try {
    client = makeClient();
  } catch (err) {
    if (err instanceof MissingKeyError) {
      lastError = err.message;
      return { started: false, reason: err.message };
    }
    throw err;
  }

  const jds = await loadJds();
  const deadline = Date.now() + STEP_BUDGET_MS;
  let stop = false;
  lastError = null;

  const worker = async () => {
    while (!stop && Date.now() < deadline) {
      const id = await claimOne();
      if (!id) return;
      try {
        await scoreCandidate(client, id, rubric, jds);
        await prisma.candidate.update({ where: { id }, data: { scoringClaimedAt: null, rescoreRequested: false } });
      } catch (err) {
        // Release the claim so a later step can retry this CV.
        await prisma.candidate.update({ where: { id }, data: { scoringClaimedAt: null } }).catch(() => undefined);
        if (err instanceof ApiError && (err.status === 401 || err.status === 403 || (err.status === 400 && /api key/i.test(err.message)))) {
          lastError = "The Gemini API key was rejected. Check GEMINI_API_KEY.";
          stop = true;
        } else if (err instanceof ApiError && err.status === 404) {
          lastError = `Model "${process.env.GEMINI_MODEL || DEFAULT_MODEL}" isn't available to this key. Check GEMINI_MODEL.`;
          stop = true;
        } else if (err instanceof ApiError && err.status === 429) {
          lastError = "Gemini rate limit or quota reached. Scoring continues automatically in a few minutes.";
          stop = true;
        } else {
          lastError = `Scoring error: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`;
        }
        console.error("[scoring]", id, err);
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { started: true };
}
