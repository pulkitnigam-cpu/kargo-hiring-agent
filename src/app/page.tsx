import Link from "next/link";
import { prisma } from "@/lib/db";
import { CANDIDATE_STATUS, ROLES, type Role } from "@/lib/constants";
import { loadRows, type Row } from "@/lib/dashboard";
import { bandOfStatus } from "@/lib/decisions";
import { settleEmails } from "@/lib/email/send";
import { HOLD_MIN, SELECTED_MIN } from "@/lib/scoring/rubric";
import { stageOf, type Stage } from "@/lib/stage";
import ActionBar from "./components/ActionBar";
import CandidateDetail from "./components/CandidateDetail";
import FilterBar from "./components/FilterBar";
import MoveControl from "./components/MoveControl";
import TopBar from "./components/TopBar";

export const dynamic = "force-dynamic";

const S = CANDIDATE_STATUS;
const ALL = Object.values(S) as string[];

// Two filters instead of tabs: which group (Selected / Hold / Rejected) and
// whether anything is waiting on Arjun (Pending / Done).
const GROUPS = {
  selected: [S.SELECTED, S.INVITED],
  hold: [S.HOLD, S.HOLD_NOTIFIED],
  rejected: [S.REJECTED, S.REGRET_SENT],
} as const;
type Group = keyof typeof GROUPS;
type Act = "pending" | "done" | "all";

// Older links (?tab=…) still land in the right place.
const FROM_TAB: Record<string, { group?: Group; act?: Act }> = {
  todo: { act: "pending" }, manual: { act: "pending" }, all: { act: "all" }, ready: { act: "all" },
  interview: { group: "selected", act: "all" }, selected: { group: "selected", act: "all" },
  hold: { group: "hold", act: "all" }, rejected: { group: "rejected", act: "all" },
};

type Params = { tab?: string; group?: string; act?: string; role?: string; c?: string; view?: string; q?: string };
type Item = Row & { stage: Stage };

export default async function Dashboard({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const { c: openId, view, q } = sp;
  const fromTab = FROM_TAB[sp.tab ?? ""] ?? {};
  const roleFilter = (ROLES as readonly string[]).includes(sp.role ?? "") ? (sp.role as Role) : undefined;
  const groupParam = (sp.group ?? fromTab.group) as Group | undefined;
  const group: Group | undefined = groupParam && groupParam in GROUPS ? groupParam : undefined;

  // Emails past their undo window have gone out; bring statuses up to date.
  await settleEmails().catch((e) => console.error("[email] settle", e));
  const now = new Date();
  const everyone: Item[] = (await loadRows(ALL)).map((r) => ({ ...r, stage: stageOf(r, now) }));
  const needle = (q ?? "").trim().toLowerCase();

  // Pending: still waiting on you. Done: you've acted (emailed or queued).
  const actOf = (r: Item): Act => (r.stage.needsAction ? "pending" : r.status === S.PARSED ? "all" : "done");
  const matches = (r: Item, f: { group?: Group; act?: Act }) =>
    (!roleFilter || r.role === roleFilter) &&
    (!needle || r.name.toLowerCase().includes(needle)) &&
    (!f.group || (GROUPS[f.group] as readonly string[]).includes(r.status)) &&
    (!f.act || f.act === "all" || actOf(r) === f.act);

  const requestedAct = (sp.act ?? fromTab.act) as Act | undefined;
  // Open on everyone; Pending is one click away (its count is highlighted).
  const act: Act = requestedAct && ["pending", "done", "all"].includes(requestedAct) ? requestedAct : "all";

  const rows = everyone.filter((r) => matches(r, { group, act })).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const groupCounts = {
    all: everyone.filter((r) => matches(r, { act })).length,
    selected: everyone.filter((r) => matches(r, { group: "selected", act })).length,
    hold: everyone.filter((r) => matches(r, { group: "hold", act })).length,
    rejected: everyone.filter((r) => matches(r, { group: "rejected", act })).length,
  };
  const actCounts = {
    pending: everyone.filter((r) => matches(r, { group, act: "pending" })).length,
    done: everyone.filter((r) => matches(r, { group, act: "done" })).length,
    all: everyone.filter((r) => matches(r, { group, act: "all" })).length,
  };

  const approved = !!(await prisma.rubricVersion.findFirst({ where: { approvedAt: { not: null } } }));
  const total = everyone.length;
  const heardBack = everyone.filter((r) => r.stage.sentLabel).length;
  const contactable = everyone.filter((r) => r.status !== S.NEEDS_MANUAL_LOOK).length;
  const outcome = (st: readonly string[]) => everyone.filter((r) => st.includes(r.status)).length;

  // Links keep the current filters.
  const keep = new URLSearchParams();
  if (group) keep.set("group", group);
  keep.set("act", act);
  if (roleFilter) keep.set("role", roleFilter);
  if (needle) keep.set("q", q!.trim());
  const closeHref = `/?${keep.toString()}`;
  const openHref = (id: string, to?: string) => `${closeHref}&c=${id}${to ? `&view=${to}` : ""}`;

  return (
    <>
      <TopBar />
      <div className={openId ? "layout with-panel" : "layout"}>
        <main className="wrap main-col">
          {total > 0 && (
            <section className="summary" aria-label="Summary">
              <div className="summary-counts">
                <span><strong>{total}</strong> candidates</span>
                <span className="sep">·</span>
                <span><span className="dot dot-good" /> {outcome(GROUPS.selected)} selected</span>
                <span><span className="dot dot-warn" /> {outcome(GROUPS.hold)} hold</span>
                <span><span className="dot dot-grey" /> {outcome(GROUPS.rejected)} rejected</span>
                {outcome([S.PARSED]) > 0 && <span className="muted">{outcome([S.PARSED])} scoring</span>}
              </div>
              <div className="summary-progress" title="Candidates who have received an email">
                <div className="bar"><div style={{ width: `${contactable ? Math.round((heardBack / contactable) * 100) : 0}%` }} /></div>
                <span className="small"><strong>{heardBack}</strong> of {contactable} have heard back</span>
              </div>
            </section>
          )}

          <ActionBar approved={approved} total={total} />

          {total > 0 && (
            <>
              <FilterBar group={group ?? ""} act={act} groupCounts={groupCounts} actCounts={actCounts} />

              <div className="card table-wrap list-card">
                {rows.length === 0 ? (
                  <div className="empty">
                    {act === "pending" ? "✓ Nothing waiting on you here." : "Nobody matches these filters."}
                  </div>
                ) : (
                  <table className="list">
                    <thead>
                      <tr>
                        <th>Candidate</th>
                        <th className="num">Score</th>
                        <th>Status</th>
                        <th className="actions-col"><span className="sr-only">Actions</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <ListRow key={r.id} r={r} open={r.id === openId} href={openHref(r.id)} actionHref={openHref(r.id, r.stage.action === "Check" ? "check" : r.stage.emailDue ? "email" : undefined)} />
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </main>

        {openId && (
          <aside className="panel" aria-label="Candidate details">
            <CandidateDetail key={openId} id={openId} closeHref={closeHref} view={view} />
          </aside>
        )}
      </div>
    </>
  );
}

function scoreClass(n: number) {
  return n >= SELECTED_MIN ? "pill pill-good" : n >= HOLD_MIN ? "pill pill-warn" : "pill pill-grey";
}

function ListRow({ r, open, href, actionHref }: { r: Item; open: boolean; href: string; actionHref: string }) {
  const band = bandOfStatus(r.status);
  const s = r.stage;
  const primary = s.action !== "View";
  return (
    <tr className={open ? "row-open" : undefined}>
      <td>
        <Link href={href} className="cand-link" scroll={false}>{r.name}</Link>
        <div className="row-sub">
          {r.role && <span className={`role-tag role-${r.role.toLowerCase()}`}>{r.role}</span>}
          {r.location && <span className="muted">{r.location}</span>}
          {r.confirmRole && <span className="muted">· role to confirm</span>}
        </div>
      </td>
      <td className="num">{r.score !== null ? <span className={scoreClass(r.score)}>{r.score}</span> : <span className="muted">–</span>}</td>
      <td>
        <span className={`status status-${s.tone}`}>{s.label}</span>
        {s.sentLabel && s.tone !== "good" && s.tone !== "muted" && <div className="row-sub muted">{s.sentLabel}</div>}
      </td>
      <td className="actions-col">
        <div className="row-actions">
          {band && <MoveControl id={r.id} band={band} emailed={r.emailed} />}
          <Link href={actionHref} className={`btn btn-small${primary ? " btn-primary" : ""}`} scroll={false}>
            {s.action}
          </Link>
        </div>
      </td>
    </tr>
  );
}
