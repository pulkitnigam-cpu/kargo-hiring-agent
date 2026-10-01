import Link from "next/link";
import { prisma } from "@/lib/db";
import { CANDIDATE_STATUS, ROLE_TITLE, type Role } from "@/lib/constants";
import type { InsightFlags } from "@/lib/dashboard";
import { bandOfStatus, emailAlreadySent, markReviewed } from "@/lib/decisions";
import { HOLD_MIN, SELECTED_MIN, type Criterion } from "@/lib/scoring/rubric";
import { stageOf } from "@/lib/stage";
import CheckDecision from "./CheckDecision";
import DetailsForm from "./DetailsForm";
import DraftEmail from "./DraftEmail";
import MoveControl from "./MoveControl";
import RoleControl from "./RoleControl";

const S = CANDIDATE_STATUS;
type Detail = { rationale: string; strength: string; probe: string; confidence: string; rawScore: number };
export type PanelView = "check" | "email" | "score" | "details";

const STATUS_LABEL: Record<string, string> = {
  SELECTED: "Selected", HOLD: "Hold", REJECTED: "Rejected", PARSED: "Waiting to be scored", NEEDS_MANUAL_LOOK: "Can't read CV",
  INVITED: "Invited", HOLD_NOTIFIED: "Hold note sent", REGRET_SENT: "Regret sent", UPLOADED: "Uploaded",
};
const BAND_WORD: Record<string, string> = { SELECTED: "Interview", HOLD: "Hold", REJECTED: "Reject" };

// The side panel, one task at a time: Check (is the score right?), Email
// (what was sent, what goes next), Score, Details.
export default async function CandidateDetail({ id, closeHref, view }: { id: string; closeHref: string; view?: string }) {
  const c = await prisma.candidate.findUnique({
    where: { id },
    include: {
      profile: true,
      insight: true,
      cvFiles: { orderBy: { createdAt: "desc" }, take: 1, select: { filename: true } },
      scores: { orderBy: { createdAt: "desc" }, take: 2, include: { criteria: true, rubricVersion: true } },
      statusEvents: { orderBy: { createdAt: "desc" } },
      emails: { where: { status: { not: "draft" } }, orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  if (!c) return <div className="empty">Candidate not found.</div>;

  const meta: InsightFlags | null = c.insight ? JSON.parse(c.insight.flagsJson) : null;
  const wasFlagged = !!meta?.needsReview && !c.reviewedAt;
  // Independent lookups, together: mark opened, sent-before check, and where "next" goes.
  const [, emailed, unsentOthers] = await Promise.all([
    c.reviewedAt ? null : markReviewed(c.id),
    emailAlreadySent(c.id),
    prisma.candidate.findMany({
      where: { id: { not: c.id }, status: { in: [S.SELECTED, S.HOLD, S.REJECTED] } },
      select: { id: true, reviewedAt: true, insight: { select: { flagsJson: true } } },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const role = (c.roleAssigned ?? c.roleTag) as Role | null;
  const score = c.scores.find((s) => s.roleScored === c.roleAssigned);
  const other = c.scores.find((s) => s.roleScored !== c.roleAssigned);
  const band = bandOfStatus(c.status);
  const last = c.emails[0];
  const stage = stageOf({
    status: c.status,
    lastEmail: last ? { type: last.type, status: last.status, at: last.sentAt ?? last.sendAfter } : null,
    holdDeadline: c.holdDeadline,
    needsReview: false,
    reviewed: true,
  });
  const criteria: Criterion[] = score ? JSON.parse(score.rubricVersion.criteriaJson) : [];
  const nameOf = (cid: string) => criteria.find((x) => x.id === cid)?.name ?? cid;
  const scoring = c.profile?.structuredJson ? JSON.parse(c.profile.structuredJson) : null;
  const unstable: string[] = scoring?.unstable ?? [];
  const rows = score
    ? [...score.criteria].filter((r) => r.weight > 0).sort((a, b) => b.weight - a.weight).map((r) => ({
        ...r,
        d: (r.rationale ? JSON.parse(r.rationale) : { rationale: "", confidence: "high", rawScore: r.score0to4 }) as Detail,
      }))
    : [];
  // The criteria the AI wasn't sure about, with the reason in a few words.
  const concerns = rows
    .map((r) => ({
      r,
      why: !r.verified ? "quote not found in the CV" : unstable.includes(r.criterionId) ? "AI runs disagreed" : r.d.confidence === "low" ? "low confidence" : null,
    }))
    .filter((x): x is { r: (typeof rows)[number]; why: string } => x.why !== null);
  const probes: string[] = c.insight ? JSON.parse(c.insight.probesJson) : [];

  const canEmail = !!band || [S.HOLD_NOTIFIED, S.INVITED, S.REGRET_SENT].includes(c.status as never);
  const defaultView: PanelView = wasFlagged && band ? "check" : canEmail ? "email" : score ? "score" : "details";
  const v: PanelView = (["check", "email", "score", "details"] as const).includes(view as PanelView) ? (view as PanelView) : defaultView;
  const href = (to: PanelView) => `${closeHref}&c=${c.id}&view=${to}`;

  // Where "next" goes after a check or a send.
  const isFlagged = (x: (typeof unsentOthers)[number]) => !x.reviewedAt && !!x.insight && (JSON.parse(x.insight.flagsJson) as InsightFlags).needsReview;
  const nextFlagged = unsentOthers.find(isFlagged);
  const nextToSend = unsentOthers.find((x) => !isFlagged(x));
  const nextCheckHref = nextFlagged ? `${closeHref}&c=${nextFlagged.id}&view=check` : closeHref;
  const nextSendHref = nextToSend ? `${closeHref}&c=${nextToSend.id}&view=email` : null;

  const when = (d: Date) => d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

  return (
    <article className="detail" aria-label={`Candidate ${c.name}`}>
      <header className="detail-head">
        <div style={{ minWidth: 0 }}>
          <h2 className="detail-name">{c.name}</h2>
          <div className="small muted">
            {role ? ROLE_TITLE[role] : "Role not set"}
            {c.profile?.yearsPmExperience != null && ` · ${Math.round(c.profile.yearsPmExperience * 10) / 10} yrs PM`}
          </div>
        </div>
        <div className="detail-score">
          {score && (
            <span className={score.total >= SELECTED_MIN ? "pill pill-good pill-lg" : score.total >= HOLD_MIN ? "pill pill-warn pill-lg" : "pill pill-grey pill-lg"}>
              {score.total}
            </span>
          )}
          <Link href={closeHref} className="close-x" aria-label="Close panel" scroll={false}>×</Link>
        </div>
      </header>

      <div className="detail-status">
        <span className={`status status-${stage.tone}`}>{stage.label}</span>
        {c.movedByArjun && <span className="small muted">moved by you</span>}
      </div>

      {band && (
        <div className="decision-bar">
          <MoveControl id={c.id} band={band} emailed={emailed} variant="buttons" />
        </div>
      )}

      <nav className="panel-tabs" aria-label="Panel">
        {(wasFlagged || v === "check") && band && <Link href={href("check")} aria-current={v === "check" ? "page" : undefined} scroll={false}>Check</Link>}
        {canEmail && <Link href={href("email")} aria-current={v === "email" ? "page" : undefined} scroll={false}>Email</Link>}
        {score && <Link href={href("score")} aria-current={v === "score" ? "page" : undefined} scroll={false}>Score</Link>}
        <Link href={href("details")} aria-current={v === "details" ? "page" : undefined} scroll={false}>Details</Link>
      </nav>

      {v === "check" && band && score && (
        <section className="detail-section">
          <p className="check-q">
            The rubric says <strong>{BAND_WORD[band]}</strong> ({score.total}). Is that right?
          </p>
          {concerns.length > 0 && (
            <div className="concerns">
              <div className="small muted">The AI wasn&apos;t sure about:</div>
              {concerns.map(({ r, why }) => (
                <div key={r.id} className="concern">
                  <div className="concern-head">
                    <strong>{nameOf(r.criterionId)}</strong>
                    <span className="concern-score">{r.score0to4}/4</span>
                    <span className="small warn-text">{why}</span>
                  </div>
                  {r.evidenceQuote && <q className="quote small clamp">{r.evidenceQuote}</q>}
                </div>
              ))}
            </div>
          )}
          <CheckDecision id={c.id} band={band} nextHref={nextCheckHref} emailed={emailed} />
        </section>
      )}

      {v === "email" && canEmail && (
        <section className="detail-section">
          <DraftEmail key={`${c.id}-${c.status}-${c.roleAssigned}`} candidateId={c.id} name={c.name} nextHref={nextSendHref} />
        </section>
      )}

      {v === "score" && score && (
        <section className="detail-section">
          <div className="crit-list">
            {rows.map((r) => (
              <details key={r.id} className="crit">
                <summary>
                  <span className="crit-name">{nameOf(r.criterionId)}</span>
                  <span className="crit-bar" aria-hidden><span style={{ width: `${(r.score0to4 / 4) * 100}%` }} /></span>
                  <span className="crit-score">{r.score0to4}/4</span>
                  {!r.verified && <span className="warn-text" title="Quote not found in the CV">⚠</span>}
                </summary>
                {r.evidenceQuote ? <q className="quote small">{r.evidenceQuote}</q> : <p className="small muted">No evidence in the CV.</p>}
                {r.d.rationale && <p className="small muted">{r.d.rationale}</p>}
              </details>
            ))}
          </div>
          <p className="small muted">
            {role} weights · {other ? `${other.roleScored} score ${other.total}` : ""} · tap a line for the CV quote
          </p>
          {band && role && (
            <div className="decision-row">
              <RoleControl id={c.id} role={role} emailed={emailed} />
            </div>
          )}
          {probes.length > 0 && (
            <details className="fold">
              <summary>Interview questions</summary>
              <ol>{probes.map((p) => <li key={p}>{p}</li>)}</ol>
            </details>
          )}
        </section>
      )}

      {v === "details" && (
        <section className="detail-section">
          {!score && <p className="small">{c.manualReason ?? STATUS_LABEL[c.status]}</p>}
          <dl className="facts">
            <dt>Email</dt><dd>{c.email ?? "–"}</dd>
            {c.phone && (<><dt>Phone</dt><dd>{c.phone}</dd></>)}
            {c.location && (<><dt>Location</dt><dd>{c.location}</dd></>)}
            <dt>CV</dt><dd><a href={`/api/cv/${c.id}`} target="_blank" rel="noreferrer">{c.cvFiles[0]?.filename ?? "Open"}</a></dd>
          </dl>
          <DetailsForm
            key={`${c.appliedDate.toISOString()}-${c.isAugustContact}-${c.email}`}
            id={c.id}
            appliedDate={c.appliedDate.toISOString().slice(0, 10)}
            isAugustContact={c.isAugustContact}
            email={c.email}
          />
          <details className="fold">
            <summary>History</summary>
            <ul className="history small">
              {c.statusEvents.map((e) => (
                <li key={e.id}>
                  <span className="muted">{when(e.createdAt)}</span> {e.actor === "arjun" ? "You" : "System"}:{" "}
                  {STATUS_LABEL[e.fromStatus ?? ""] ?? "–"} → {STATUS_LABEL[e.toStatus] ?? e.toStatus}
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}
    </article>
  );
}
