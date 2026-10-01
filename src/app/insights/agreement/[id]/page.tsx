import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { ROLE_TITLE, type Role } from "@/lib/constants";
import type { AgreementItem } from "@/lib/insights";
import TopBar from "../../../components/TopBar";
import { callBand } from "../../actions";

export const dynamic = "force-dynamic";

// §15.3: one CV at a time, no scores, no band, no flags. Arjun's call only.
export default async function AgreementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await prisma.agreementRun.findUnique({ where: { id } });
  if (!run) notFound();
  const items: AgreementItem[] = JSON.parse(run.itemsJson);
  const done = items.filter((i) => i.arjun).length;
  const next = items.find((i) => !i.arjun);

  if (!next) {
    const agree = items.filter((i) => i.arjun === i.rubric).length;
    return (
      <>
        <TopBar />
        <main className="wrap">
          <div className="page-head">
            <h1>Agreement test complete</h1>
            <div>You and the rubric agree on <strong>{agree} of {items.length}</strong> ({agree / items.length >= 0.8 ? "meets" : "below"} the 80% target).</div>
          </div>
          <p><Link href="/insights">See the comparison on Insights</Link></p>
        </main>
      </>
    );
  }

  const c = await prisma.candidate.findUniqueOrThrow({
    where: { id: next.candidateId },
    include: { cvFiles: { orderBy: { createdAt: "desc" }, take: 1, select: { rawText: true } } },
  });
  const role = (c.roleAssigned ?? c.roleTag) as Role | null;
  const decide = callBand.bind(null, run.id, c.id);

  return (
    <>
      <TopBar />
      <main className="wrap">
        <div className="page-head">
          <h1>Blind test: CV {done + 1} of {items.length}</h1>
          <div className="muted small">
            Make your own call from the CV alone. Scores are hidden here; please don&apos;t look this candidate up on the dashboard until the test is done.
          </div>
        </div>
        <div className="card pad agreement">
          <div className="agreement-head">
            <div>
              <h2>{c.name}</h2>
              <div className="small muted">{role ? `Considered for: ${ROLE_TITLE[role]}` : "Role not set"} · <a href={`/api/cv/${c.id}`} target="_blank" rel="noreferrer">Original file</a></div>
            </div>
            <div className="band-buttons">
              {(["SELECTED", "HOLD", "REJECTED"] as const).map((b) => (
                <form key={b} action={decide.bind(null, b)}>
                  <button className="btn" type="submit">{b === "SELECTED" ? "Interview" : b === "HOLD" ? "Hold" : "Reject"}</button>
                </form>
              ))}
            </div>
          </div>
          <pre className="cv-text">{c.cvFiles[0]?.rawText ?? "No text available; open the original file."}</pre>
        </div>
      </main>
    </>
  );
}
