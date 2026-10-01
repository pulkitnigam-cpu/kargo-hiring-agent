import Link from "next/link";
import { prisma } from "@/lib/db";
import TopBar from "../components/TopBar";

export const dynamic = "force-dynamic";

// §11.2 #13: every score, move, role change, send and reason, with a
// timestamp and rubric version.

const ACTIONS: Record<string, string> = {
  "candidate.uploaded": "Uploaded",
  "candidate.scored": "Scored",
  "candidate.moved": "Moved",
  "candidate.role_changed": "Role changed",
  "candidate.reviewed": "Opened flagged candidate",
  "candidate.details_updated": "Details updated",
  "rubric.approved": "Rubric approved",
  "upload.bulk": "Bulk upload",
  "upload.single": "Single upload",
};

const FILTERS = [
  { key: "decisions", label: "Arjun's decisions", actions: ["candidate.moved", "candidate.role_changed", "candidate.details_updated", "rubric.approved", "candidate.reviewed"] },
  { key: "scores", label: "Scores", actions: ["candidate.scored"] },
  { key: "uploads", label: "Uploads", actions: ["upload.bulk", "upload.single", "candidate.uploaded"] },
  { key: "all", label: "Everything", actions: null },
] as const;

const BAND: Record<string, string> = { SELECTED: "Selected", HOLD: "Hold", REJECTED: "Rejected" };
const PAGE = 200;

type Payload = Record<string, unknown>;

function describe(action: string, p: Payload): string {
  const s = (k: string) => (p[k] == null ? "" : String(p[k]));
  switch (action) {
    case "candidate.scored": {
      const t = p.totals as Record<string, number> | undefined;
      return `${s("role")} ${t?.[s("role")] ?? ""} → ${BAND[s("band")] ?? s("band")} (other role ${t?.[s("role") === "PM" ? "SPM" : "PM"] ?? "–"}; ${s("roleSource") === "rubric" ? "role by rubric" : "tagged"}${(p.flags as string[] | undefined)?.length ? `; flags: ${(p.flags as string[]).join(", ")}` : ""})`;
    }
    case "candidate.moved":
      return `${BAND[s("from")]} → ${BAND[s("to")]} (score ${s("score")}, rubric proposed ${BAND[s("scoreBand")] ?? "–"})${p.afterEmail ? " · after an email was sent" : ""}`;
    case "candidate.role_changed":
      return `${s("from")} → ${s("to")}: new score ${s("total")}, proposed ${BAND[s("band")]}${p.previousBand ? ` (was ${BAND[s("previousBand")]})` : ""}${p.afterEmail ? " · after an email was sent" : ""}`;
    case "candidate.details_updated":
      return Object.entries(p).map(([k, v]) => `${k === "isAugustContact" ? "August contact" : k === "appliedDate" ? "applied" : k}: ${v === true ? "yes" : v === false ? "no" : String(v)}`).join(", ");
    case "candidate.uploaded":
      return `${s("file")} → ${s("status") === "PARSED" ? "ready for scoring" : "needs manual look"}${p.roleTag ? ` · ${s("roleTag")} (${s("roleTagSource")})` : ""}`;
    case "upload.bulk":
    case "upload.single":
      return `${s("uploaded")} uploaded · ${s("ready")} ready · ${(p.needsManualLook as unknown[] | undefined)?.length ?? 0} manual look · ${(p.duplicates as unknown[] | undefined)?.length ?? 0} duplicates`;
    case "rubric.approved":
      return `Approved by ${s("approvedBy")}`;
    default:
      return "";
  }
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  const { f } = await searchParams;
  const filter = FILTERS.find((x) => x.key === f) ?? FILTERS[0];

  const entries = await prisma.auditLog.findMany({
    where: filter.actions ? { action: { in: [...filter.actions] } } : {},
    orderBy: { createdAt: "desc" },
    take: PAGE,
  });

  const ids = [...new Set(entries.map((e) => e.entity).filter((e) => e.startsWith("candidate:")).map((e) => e.slice(10)))];
  const names = new Map((await prisma.candidate.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));

  return (
    <>
      <TopBar />
      <main className="wrap">
        <div className="page-head">
          <h1>Audit log</h1>
          <div className="muted">Every score, decision and change, newest first{entries.length === PAGE ? ` (latest ${PAGE})` : ""}.</div>
        </div>
        <nav className="seg" aria-label="Filter" style={{ display: "inline-flex", marginBottom: 12 }}>
          {FILTERS.map((x) => (
            <Link key={x.key} href={`/audit?f=${x.key}`} aria-current={x.key === filter.key ? "page" : undefined}>{x.label}</Link>
          ))}
        </nav>
        <div className="card table-wrap" style={{ marginBottom: 32 }}>
          {entries.length === 0 ? (
            <div className="empty">Nothing logged yet.</div>
          ) : (
            <table>
              <thead><tr><th>When</th><th>Who</th><th>What</th><th>Candidate</th><th>Details</th><th>Reason</th><th className="hide-sm">Rubric</th></tr></thead>
              <tbody>
                {entries.map((e) => {
                  const p: Payload = e.payloadJson ? JSON.parse(e.payloadJson) : {};
                  const cid = e.entity.startsWith("candidate:") ? e.entity.slice(10) : null;
                  return (
                    <tr key={e.id}>
                      <td className="small nowrap">{e.createdAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</td>
                      <td>{e.actor === "arjun" ? "Arjun" : "System"}</td>
                      <td>{ACTIONS[e.action] ?? e.action}</td>
                      <td>{cid ? <Link href={`/candidates/${cid}`}>{names.get(cid) ?? "(removed)"}</Link> : <span className="muted">–</span>}</td>
                      <td className="small">{describe(e.action, p)}</td>
                      <td className="small">{p.reason ? `“${String(p.reason)}”` : <span className="muted">–</span>}</td>
                      <td className="small hide-sm">{p.rubricVersion ? `v${String(p.rubricVersion)}` : <span className="muted">–</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </>
  );
}
