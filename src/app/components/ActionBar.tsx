import Link from "next/link";
import { prisma } from "@/lib/db";
import { CANDIDATE_STATUS } from "@/lib/constants";
import type { InsightFlags } from "@/lib/dashboard";
import { GROUP_STATUS, mailConfigProblem, undoMinutes, type BulkGroup } from "@/lib/email/send";
import BulkSend from "./BulkSend";
import ScoringStatus from "./ScoringStatus";
import UploadButtons from "./UploadButtons";

const S = CANDIDATE_STATUS;
const NOUN: Record<BulkGroup, [string, string]> = {
  invite: ["invite", "invites"],
  hold: ["hold note", "hold notes"],
  regret: ["regret", "regrets"],
  hold_due: ["close-call regret", "close-call regrets"],
};

const flaggedUnopened = (c: { reviewedAt: Date | null; insight: { flagsJson: string } | null }) =>
  !c.reviewedAt && !!c.insight && (JSON.parse(c.insight.flagsJson) as InsightFlags).needsReview;

// Only the things waiting on Arjun, one line each, each with its button.
export default async function ActionBar({ approved, total }: { approved: boolean; total: number }) {
  if (!total) {
    return (
      <section className="actions-bar" aria-label="To do">
        <div className="action-item action-start">
          <div>
            <strong>Start by uploading the CVs.</strong>
            <div className="small muted">Files, a folder or a zip. Scoring starts by itself.</div>
          </div>
          <UploadButtons />
        </div>
      </section>
    );
  }

  const undo = undoMinutes();
  const items: React.ReactNode[] = [];

  if (!approved) {
    items.push(
      <div className="action-item" key="rubric">
        <span>The rubric isn&apos;t approved, so nothing is scored.</span>
        <Link className="btn btn-primary btn-small" href="/rubric">Review and approve</Link>
      </div>,
    );
  }

  const problem = mailConfigProblem();
  if (problem) items.push(<div className="action-item action-warn" key="mail"><span>✉ {problem}</span></div>);

  // Everything the bar needs, fetched together in one round.
  const now = new Date();
  const [open, drafts, unreadable, bounced, waiting] = await Promise.all([
    prisma.candidate.findMany({
      where: { status: { in: Object.values(GROUP_STATUS) } },
      select: { id: true, status: true, reviewedAt: true, holdDeadline: true, insight: { select: { flagsJson: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.email.findMany({ where: { status: "draft", NOT: { checksJson: "[]" } }, select: { candidateId: true, checksJson: true } }),
    prisma.candidate.findMany({ where: { status: S.NEEDS_MANUAL_LOOK }, select: { id: true }, orderBy: { createdAt: "asc" } }),
    prisma.email.count({ where: { status: { in: ["bounced", "failed"] } } }),
    prisma.candidate.count({ where: { OR: [{ status: S.PARSED }, { rescoreRequested: true }] } }),
  ]);
  const inGroup = (group: BulkGroup) =>
    open.filter((c) => c.status === GROUP_STATUS[group] && (group !== "hold_due" || (!!c.holdDeadline && c.holdDeadline <= now)));

  // ⚠ candidates are kept out of bulk emails until they're opened.
  const unsent = open.filter((c) => c.status !== S.HOLD_NOTIFIED);
  const flagged = unsent.filter(flaggedUnopened);
  if (flagged.length) {
    const first = flagged[0];
    const tab = first.status === S.SELECTED ? "interview" : first.status === S.HOLD ? "hold" : "rejected";
    items.push(
      <div className="action-item" key="flagged">
        <span><strong>{flagged.length}</strong> flagged candidate{flagged.length === 1 ? "" : "s"} to check before emailing</span>
        <Link className="btn btn-primary btn-small" href={`/?tab=${tab}&c=${first.id}&view=check`} scroll={false}>Check next</Link>
      </div>,
    );
  }

  // Drafts whose checks failed can't go until Arjun fixes them.
  const blockedDrafts = new Set(
    drafts
      .filter((e) => e.checksJson && JSON.parse(e.checksJson).length)
      .map((e) => e.candidateId),
  );

  for (const group of ["invite", "hold", "regret", "hold_due"] as BulkGroup[]) {
    const cands = inGroup(group);
    if (!cands.length) continue;
    const toCheck = cands.filter((c) => flaggedUnopened(c));
    const toFix = cands.filter((c) => !flaggedUnopened(c) && blockedDrafts.has(c.id));
    const ready = cands.length - toCheck.length - toFix.length;
    const [one, many] = NOUN[group];
    const waitingOnCheck = toCheck.length;
    items.push(
      <div className="action-item" key={group}>
        <span>
          {group === "hold_due" ? (
            <><strong>{cands.length}</strong> hold{cands.length === 1 ? "" : "s"} past 7 days: promote anyone you want, then send the rest a close-call regret</>
          ) : (
            <><strong>{cands.length}</strong> {cands.length === 1 ? one : many} to send</>
          )}
          {(waitingOnCheck > 0 || toFix.length > 0) && (
            <span className="muted">
              {" "}({[waitingOnCheck && `${waitingOnCheck} to check first`, toFix.length && `${toFix.length} need a fix`].filter(Boolean).join(", ")})
            </span>
          )}
        </span>
        {ready > 0 ? (
          <BulkSend group={group} label={`Send ${ready} ${ready === 1 ? one : many}`} count={ready} undoMinutes={undo} plain />
        ) : toFix.length ? (
          <Link className="btn btn-small" href={`/?tab=todo&c=${toFix[0].id}&view=email`} scroll={false}>Fix next</Link>
        ) : (
          <span className="small muted">Check them first</span>
        )}
      </div>,
    );
  }

  const unreadableCount = unreadable.length;
  if (unreadableCount) {
    items.push(
      <div className="action-item" key="unreadable">
        <span><strong>{unreadableCount}</strong> CV{unreadableCount === 1 ? "" : "s"} couldn&apos;t be read: open the file and decide yourself</span>
        <Link className="btn btn-small" href={`/?tab=todo&c=${unreadable[0].id}`} scroll={false}>Open</Link>
      </div>,
    );
  }

  if (bounced) {
    items.push(
      <div className="action-item action-warn" key="bounced">
        <span><strong>{bounced}</strong> email{bounced === 1 ? "" : "s"} bounced</span>
        <Link className="btn btn-small" href="/outbox?f=problems">See which</Link>
      </div>,
    );
  }

  return (
    <section className="actions-bar" aria-label="To do">
      <ScoringStatus waiting={waiting} approved={approved} />
      {items.length ? items : waiting ? null : <div className="action-item action-done">✓ All caught up. Everyone who can be contacted has heard back.</div>}
    </section>
  );
}
