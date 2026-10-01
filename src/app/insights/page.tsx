import Link from "next/link";
import { prisma } from "@/lib/db";
import type { CalibrationResults } from "@/lib/calibration";
import { latestAgreement, overrideRate, overrides, successMetrics, type AgreementItem } from "@/lib/insights";
import type { Criterion } from "@/lib/scoring/rubric";
import CalibrateButton from "../components/CalibrateButton";
import TopBar from "../components/TopBar";
import { beginAgreement } from "./actions";

export const dynamic = "force-dynamic";

const BAND: Record<string, string> = { SELECTED: "Selected", HOLD: "Hold", REJECTED: "Rejected" };

export default async function InsightsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const metrics = await successMetrics();
  const rate = await overrideRate();
  const list = await overrides();
  const agreement = await latestAgreement();
  const agreementRun = agreement ? await prisma.agreementRun.findUnique({ where: { id: agreement.runId } }) : null;
  const agreementItems: AgreementItem[] = agreementRun ? JSON.parse(agreementRun.itemsJson) : [];
  const openRun = await prisma.agreementRun.findFirst({ where: { completedAt: null }, orderBy: { createdAt: "desc" } });
  const calib = await prisma.calibrationRun.findFirst({ orderBy: { createdAt: "desc" } });
  const calibResults: CalibrationResults | null = calib?.resultsJson ? JSON.parse(calib.resultsJson) : null;
  const rubric = await prisma.rubricVersion.findFirst({ where: { approvedAt: { not: null } }, orderBy: { version: "desc" } });
  const criteria: Criterion[] = rubric ? JSON.parse(rubric.criteriaJson) : [];
  const nameOf = (id: string) => criteria.find((c) => c.id === id)?.name ?? id;
  const names = new Map(
    (await prisma.candidate.findMany({ where: { id: { in: agreementItems.map((i) => i.candidateId) } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]),
  );

  return (
    <>
      <TopBar />
      <main className="wrap">
        <div className="page-head">
          <h1>Insights</h1>
          <div className="muted">How the hiring process is doing against the spec&apos;s targets, and where the rubric and Arjun disagree. <Link href="/audit">Full audit log</Link></div>
        </div>
        {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
        {rate.rate > 0.3 && (
          <div className="nudge" style={{ marginBottom: 12 }}>
            ⚠ Arjun has overridden {Math.round(rate.rate * 100)}% of the rubric&apos;s bands. Above 30% means the rubric needs a review:
            look at the overrides below, then <Link href="/rubric/edit">edit the rubric</Link>.
          </div>
        )}

        <section className="section">
          <h2>Success metrics (§16)</h2>
          <div className="strip">
            {metrics.map((m) => (
              <div className="stat" key={m.label}>
                <div className="stat-label">{m.label}</div>
                <div className="stat-value metric-value">
                  {m.ok === true && <span className="dot dot-good" />} {m.ok === false && <span className="dot dot-bad" />} {m.value}
                </div>
                <div className="stat-sub">Target: {m.target}</div>
                {m.note && <div className="stat-sub">{m.note}</div>}
              </div>
            ))}
          </div>
        </section>

        <section className="section">
          <h2>Arjun agreement test (§15.3)</h2>
          <p className="small">
            Arjun makes his own Selected / Hold / Rejected call on 10 CVs <strong>without seeing the scores</strong>, and his calls are
            compared with the rubric. The target is at least 8 of 10.
          </p>
          <div className="popover-actions" style={{ justifyContent: "flex-start" }}>
            {openRun ? (
              <Link className="btn btn-primary btn-small" href={`/insights/agreement/${openRun.id}`}>Continue the open test</Link>
            ) : (
              <form action={beginAgreement}><button className="btn btn-primary btn-small" type="submit">Start a 10-CV blind test</button></form>
            )}
          </div>
          {agreement && (
            <div className="card table-wrap" style={{ marginTop: 10 }}>
              <table>
                <thead><tr><th>Candidate</th><th>Arjun</th><th>Rubric</th><th>Score</th></tr></thead>
                <tbody>
                  {agreementItems.map((i) => (
                    <tr key={i.candidateId}>
                      <td><Link href={`/candidates/${i.candidateId}`}>{names.get(i.candidateId) ?? "(removed)"}</Link></td>
                      <td>{i.arjun ? BAND[i.arjun] : "–"}</td>
                      <td>{BAND[i.rubric]}{i.arjun !== i.rubric && <span className="badge badge-warn" style={{ marginLeft: 6 }}>differs</span>}</td>
                      <td>{i.score}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="small pad">
                <strong>{agreement.agree} of {agreement.total} agree</strong> ({agreement.agree / agreement.total >= 0.8 ? "meets" : "below"} the 80% target).
                {agreement.agree / agreement.total < 0.8 && " Open the candidates that differ to see which criteria drove the gap, then adjust the rubric as a new version and re-test."}
              </p>
            </div>
          )}
        </section>

        <section className="section">
          <h2>Where Arjun overrode the rubric</h2>
          {list.length === 0 ? (
            <p className="muted small">No overrides yet.</p>
          ) : (
            <div className="card table-wrap">
              <table>
                <thead><tr><th>Candidate</th><th>Role</th><th>Score</th><th>Rubric</th><th>Arjun</th><th>Reason</th></tr></thead>
                <tbody>
                  {list.map((o) => (
                    <tr key={o.candidateId}>
                      <td><Link href={`/candidates/${o.candidateId}`}>{o.name}</Link></td>
                      <td>{o.role}</td>
                      <td>{o.score}</td>
                      <td>{BAND[o.rubric]}</td>
                      <td>{o.direction === "up" ? "↑" : "↓"} {BAND[o.arjun]}</td>
                      <td className="small">{o.reason ?? <span className="muted">–</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="small pad">
                {list.filter((o) => o.direction === "up").length} promoted, {list.filter((o) => o.direction === "down").length} demoted.
                A pattern here (e.g. many promotions of people strong in one criterion) is the signal to change its weight.
              </p>
            </div>
          )}
        </section>

        <section className="section">
          <h2>Calibration against past hires (Step 0)</h2>
          <p className="small">
            Scores the 8 past hires with rubric v{rubric?.version ?? "–"} and shows which criteria separate the Exceeds hires from the
            Meets/Below ones. It changes nothing by itself: if a criterion doesn&apos;t separate them, edit the rubric.
          </p>
          <CalibrateButton running={calib?.status === "running"} />
          {calib?.status === "failed" && <div className="error small" style={{ marginTop: 8 }}>Last run failed: {calib.error}</div>}
          {calibResults && calib && (
            <div className="grid2" style={{ marginTop: 10 }}>
              <div className="card table-wrap">
                <table>
                  <thead><tr><th>Criterion</th><th>Exceeds avg</th><th>Others avg</th><th>Gap</th></tr></thead>
                  <tbody>
                    {calibResults.gaps.map((g) => (
                      <tr key={g.id}>
                        <td><strong>{g.id}</strong> {nameOf(g.id)}</td>
                        <td>{g.strong}</td>
                        <td>{g.weaker}</td>
                        <td>{g.gap > 0 ? `+${g.gap}` : g.gap}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="card table-wrap">
                <table>
                  <thead><tr><th>Hire</th><th>Rating</th><th>PM</th><th>SPM</th></tr></thead>
                  <tbody>
                    {calibResults.hires.map((h) => (
                      <tr key={h.file}>
                        <td>{h.name}<div className="small muted">{h.role}{h.unstable.length ? ` · unstable: ${h.unstable.join(", ")}` : ""}</div></td>
                        <td>{h.rating}</td>
                        <td>{h.totals.PM}</td>
                        <td>{h.totals.SPM}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="small pad">
                  Rubric v{calib.rubricVersion}, {calib.finishedAt?.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}.
                  Lowest Exceeds on PM weights: {calibResults.lowestExceedsPm}; highest Meets/Below: {calibResults.highestWeakerPm}.
                </p>
              </div>
            </div>
          )}
        </section>
      </main>
    </>
  );
}
