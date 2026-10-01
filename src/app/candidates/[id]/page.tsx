import Link from "next/link";
import CandidateDetail from "../../components/CandidateDetail";
import TopBar from "../../components/TopBar";

export const dynamic = "force-dynamic";

// Full-page version of the side panel, for a direct link to one candidate.
export default async function CandidatePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ view?: string }> }) {
  const { id } = await params;
  const { view } = await searchParams;
  return (
    <>
      <TopBar />
      <main className="wrap">
        <p className="small" style={{ marginTop: 16 }}><Link href="/">← Back to dashboard</Link></p>
        <div className="card" style={{ marginBottom: 32 }}>
          <CandidateDetail id={id} closeHref="/?tab=all" view={view} />
        </div>
      </main>
    </>
  );
}
