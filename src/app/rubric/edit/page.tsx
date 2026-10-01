import Link from "next/link";
import { prisma } from "@/lib/db";
import { LEVELS, type Criterion } from "@/lib/scoring/rubric";
import TopBar from "../../components/TopBar";
import { saveRubricVersion } from "../actions";

export const dynamic = "force-dynamic";

const LEVEL_LABEL: Record<string, string> = { "4": "4 (strong)", "3": "3", "2": "2 (partial)", "1": "1", "0": "0 (none)" };

// Edit criteria wording, weights and rules. Saving never changes a version in
// place: it creates the next version, unapproved, for Arjun to approve.
export default async function EditRubricPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const latest = await prisma.rubricVersion.findFirst({ orderBy: { version: "desc" } });
  if (!latest) return null;
  const criteria: Criterion[] = JSON.parse(latest.criteriaJson);
  const pm: Record<string, number> = JSON.parse(latest.weightsPmJson);
  const spm: Record<string, number> = JSON.parse(latest.weightsSpmJson);
  const rules: string[] = latest.rulesJson ? JSON.parse(latest.rulesJson) : [];

  return (
    <>
      <TopBar />
      <main className="wrap">
        <p className="small" style={{ marginTop: 16 }}><Link href="/rubric">← Back to the rubric</Link></p>
        <div className="page-head">
          <h1>Edit rubric: new version v{latest.version + 1}</h1>
          <div className="muted">
            Starts from v{latest.version}. Saving creates v{latest.version + 1}, unapproved. Scoring keeps using the current approved
            version until you approve the new one; then you can re-score everyone.
          </div>
        </div>
        {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

        <form action={saveRubricVersion} className="rubric-form">
          <input type="hidden" name="baseVersion" value={latest.version} />

          <section className="card pad">
            <h2>What changed and why</h2>
            <textarea name="changeNote" rows={2} required placeholder="e.g. Gave J2 more weight for SPM after the first 20 reviews" />
          </section>

          <section className="card pad">
            <h2>Weights (each role must total 100)</h2>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Criterion</th><th>PM</th><th>SPM</th></tr></thead>
                <tbody>
                  {criteria.map((c) => (
                    <tr key={c.id}>
                      <td><strong>{c.id}</strong> {c.name}</td>
                      <td><input className="num" type="number" name={`pm_${c.id}`} min={0} max={100} step={5} defaultValue={pm[c.id] ?? 0} /></td>
                      <td><input className="num" type="number" name={`spm_${c.id}`} min={0} max={100} step={5} defaultValue={spm[c.id] ?? 0} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card pad">
            <h2>Scoring rules (one per line)</h2>
            <textarea name="rules" rows={6} defaultValue={rules.join("\n")} />
          </section>

          {criteria.map((c) => (
            <section className="card pad" key={c.id}>
              <h2>{c.id} · <input className="inline-name" type="text" name={`name_${c.id}`} defaultValue={c.name} required /></h2>
              <div className="levels">
                {LEVELS.map((l) => (
                  <label key={l} className="field">
                    <span className="small muted">Level {LEVEL_LABEL[l]}{["4", "2", "0"].includes(l) ? " (required)" : ""}</span>
                    <textarea name={`a_${c.id}_${l}`} rows={2} defaultValue={c.anchors[l] ?? ""} required={["4", "2", "0"].includes(l)} />
                  </label>
                ))}
                <label className="field">
                  <span className="small muted">Note (edge cases)</span>
                  <textarea name={`notes_${c.id}`} rows={2} defaultValue={c.notes ?? ""} />
                </label>
              </div>
            </section>
          ))}

          <div className="popover-actions" style={{ justifyContent: "flex-start", marginBottom: 32 }}>
            <button className="btn btn-primary" type="submit">Save as v{latest.version + 1}</button>
            <Link className="btn" href="/rubric">Cancel</Link>
          </div>
        </form>
      </main>
    </>
  );
}
