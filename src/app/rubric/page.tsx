import { prisma } from "@/lib/db";
import TopBar from "../components/TopBar";
import { approveRubric } from "./actions";
import Link from "next/link";
import { outdatedCount } from "@/lib/scoring/queue";
import RescoreButton from "../components/RescoreButton";

export const dynamic = "force-dynamic";

type Criterion = { id: string; name: string; kind: string; anchors: Record<string, string>; notes?: string };
const LEVELS = ["4", "3", "2", "1", "0"] as const;

export default async function RubricPage() {
  const rubric = await prisma.rubricVersion.findFirst({ orderBy: { version: "desc" } });
  const jds = await prisma.jobDescription.findMany({ orderBy: { role: "asc" } });
  const versions = await prisma.rubricVersion.findMany({ orderBy: { version: "desc" }, select: { version: true, name: true, approvedAt: true, approvedBy: true } });

  if (!rubric) {
    return (
      <>
        <TopBar />
        <main className="wrap"><div className="empty">No rubric seeded. Run <code>npm run setup</code>.</div></main>
      </>
    );
  }

  const criteria: Criterion[] = JSON.parse(rubric.criteriaJson);
  const pm: Record<string, number> = JSON.parse(rubric.weightsPmJson);
  const spm: Record<string, number> = JSON.parse(rubric.weightsSpmJson);
  const sum = (w: Record<string, number>) => Object.values(w).reduce((a, b) => a + b, 0);
  const rules: string[] = rubric.rulesJson ? JSON.parse(rubric.rulesJson) : [];
  const outdated = await outdatedCount();

  return (
    <>
      <TopBar />
      <main className="wrap">
        <div className="page-head">
          <h1>Rubric v{rubric.version}: {rubric.name}</h1>
          <div className="muted">
            {rubric.approvedAt
              ? `Approved by ${rubric.approvedBy} on ${rubric.approvedAt.toLocaleDateString("en-IN")}`
              : "Not yet approved. Nothing is scored until it is."}
          </div>
        </div>

        {rubric.changeNote && <p className="small">{rubric.changeNote}</p>}
        <p><Link className="btn btn-small" href="/rubric/edit">Edit (creates v{rubric.version + 1})</Link></p>
        {outdated.count > 0 && outdated.version && <RescoreButton count={outdated.count} version={outdated.version} />}

        {!rubric.approvedAt && (
          <form action={approveRubric} className="card approve">
            <input type="hidden" name="rubricId" value={rubric.id} />
            <div>
              <strong>Approve this rubric to start scoring</strong>
              <div className="small muted">
                Every CV will be scored on these criteria and weights. Any change later creates v{rubric.version + 1}.
              </div>
            </div>
            <div className="approve-row">
              <input type="text" name="approvedBy" defaultValue="Arjun Mehta" aria-label="Approved by" />
              <button className="btn btn-primary" type="submit">Approve v{rubric.version}</button>
            </div>
          </form>
        )}

        <section className="section">
          <h2>Weights</h2>
          <div className="card table-wrap">
            <table>
              <thead>
                <tr><th>Criterion</th><th>Type</th><th>PM</th><th>SPM</th></tr>
              </thead>
              <tbody>
                {criteria.map((c) => (
                  <tr key={c.id}>
                    <td><strong>{c.id}</strong> {c.name}</td>
                    <td className="muted">{c.kind === "pattern" ? "Past-hire pattern" : "From the JD"}</td>
                    <td>{pm[c.id] ?? <span className="muted">–</span>}</td>
                    <td>{spm[c.id] ?? <span className="muted">–</span>}</td>
                  </tr>
                ))}
                <tr><td><strong>Total</strong></td><td /><td><strong>{sum(pm)}</strong></td><td><strong>{sum(spm)}</strong></td></tr>
              </tbody>
            </table>
          </div>
          <p className="small muted">Bands: 75 and above Selected · 60–74 Hold · below 60 Rejected. College prestige is never scored.</p>
        </section>

        {rules.length > 0 && (
          <section className="section">
            <h2>Scoring rules</h2>
            <ul className="rules">{rules.map((r) => <li key={r}>{r}</li>)}</ul>
          </section>
        )}

        <section className="section">
          <h2>Scoring levels (0–4)</h2>
          <div className="card table-wrap">
            <table className="anchors">
              <thead>
                <tr><th>Criterion</th>{LEVELS.filter((l) => criteria.some((c) => c.anchors[l])).map((l) => <th key={l}>{l}</th>)}</tr>
              </thead>
              <tbody>
                {criteria.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <strong>{c.id}</strong> {c.name}
                      {c.notes && <div className="small muted" style={{ marginTop: 4 }}>{c.notes}</div>}
                    </td>
                    {LEVELS.filter((l) => criteria.some((x) => x.anchors[l])).map((l) => (
                      <td key={l} className="small">{c.anchors[l] ?? <span className="muted">between the neighbouring levels</span>}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {versions.length > 1 && (
          <section className="section">
            <h2>Versions</h2>
            <ul className="small">
              {versions.map((v) => (
                <li key={v.version}>
                  v{v.version}: {v.name} · {v.approvedAt ? `approved by ${v.approvedBy} on ${v.approvedAt.toLocaleDateString("en-IN")}` : "not approved"}
                </li>
              ))}
            </ul>
            <p className="small muted">Scoring always uses the newest approved version. Each score records the version it used.</p>
          </section>
        )}

        <section className="section">
          <h2>Job descriptions</h2>
          <div className="grid2">
            {jds.map((jd) => (
              <div className="card" key={jd.role}>
                <div className="modal-head"><h3>{jd.title}</h3><span className="badge">{jd.role}</span></div>
                <div className="jd">{jd.text}</div>
              </div>
            ))}
          </div>
        </section>
      </main>
    </>
  );
}
