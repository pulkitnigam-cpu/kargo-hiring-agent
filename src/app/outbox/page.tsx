import Link from "next/link";
import { prisma } from "@/lib/db";
import { deliveryTrackingProblem, mailConfigProblem, settleEmails, testMode } from "@/lib/email/send";
import { EMAIL_TYPE_LABEL, type EmailType } from "@/lib/email/templates";
import TopBar from "../components/TopBar";
import UndoButton from "../components/UndoButton";

export const dynamic = "force-dynamic";

const FILTERS = [
  { key: "queued", label: "Queued", statuses: ["queued", "sending"] },
  { key: "sent", label: "Sent", statuses: ["sent", "delivered"] },
  { key: "problems", label: "Problems", statuses: ["bounced", "failed"] },
  { key: "all", label: "Everything", statuses: ["queued", "sending", "sent", "delivered", "bounced", "failed", "cancelled"] },
] as const;

const STATUS: Record<string, { label: string; cls: string }> = {
  queued: { label: "Queued", cls: "badge badge-warn" },
  sending: { label: "Sending", cls: "badge badge-warn" },
  sent: { label: "Sent", cls: "badge badge-pm" },
  delivered: { label: "Delivered ✓", cls: "badge badge-spm" },
  bounced: { label: "Bounced", cls: "badge badge-bad" },
  failed: { label: "Failed", cls: "badge badge-bad" },
  cancelled: { label: "Cancelled", cls: "badge" },
};

// §11.2 #11: queued emails with a countdown and Undo, then sent, delivered
// and bounced states.
export default async function OutboxPage({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  await settleEmails().catch((e) => console.error("[email] settle", e));
  const { f } = await searchParams;
  const counts = Object.fromEntries(
    await Promise.all(FILTERS.map(async (x) => [x.key, await prisma.email.count({ where: { status: { in: [...x.statuses] } } })] as const)),
  );
  const filter = FILTERS.find((x) => x.key === f) ?? (counts.queued > 0 ? FILTERS[0] : FILTERS[1]);
  const emails = await prisma.email.findMany({
    where: { status: { in: [...filter.statuses] } },
    include: { candidate: { select: { id: true, name: true, email: true } } },
    orderBy: [{ sendAfter: "asc" }, { sentAt: "desc" }],
    take: 300,
  });
  const problem = mailConfigProblem();
  const fmt = (d: Date | null) => (d ? d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "–");

  return (
    <>
      <TopBar />
      <main className="wrap">
        <div className="page-head">
          <h1>Outbox</h1>
          <div className="muted">
            Every email waits out its undo window here before it goes.
            {testMode() && ` Test mode is on: everything goes to ${process.env.TEST_RECIPIENT || "TEST_RECIPIENT (not set)"}.`}
          </div>
        </div>
        {problem && <div className="error" style={{ marginBottom: 12 }}>{problem}</div>}
        {deliveryTrackingProblem() && <div className="nudge" style={{ marginBottom: 12 }}>{deliveryTrackingProblem()}</div>}
        <nav className="seg" aria-label="Filter" style={{ display: "inline-flex", marginBottom: 12 }}>
          {FILTERS.map((x) => (
            <Link key={x.key} href={`/outbox?f=${x.key}`} aria-current={x.key === filter.key ? "page" : undefined}>
              {x.label} ({counts[x.key]})
            </Link>
          ))}
        </nav>
        <div className="card table-wrap" style={{ marginBottom: 32 }}>
          {emails.length === 0 ? (
            <div className="empty">Nothing here.</div>
          ) : (
            <table>
              <thead><tr><th>Candidate</th><th>Email</th><th>Status</th><th>When</th><th className="hide-sm">To</th></tr></thead>
              <tbody>
                {emails.map((e) => (
                  <tr key={e.id}>
                    <td><Link href={`/candidates/${e.candidate.id}`}>{e.candidate.name}</Link></td>
                    <td>
                      {EMAIL_TYPE_LABEL[e.type as EmailType] ?? e.type}
                      <div className="small muted">{e.subject}</div>
                    </td>
                    <td>
                      <span className={STATUS[e.status]?.cls ?? "badge"}>{STATUS[e.status]?.label ?? e.status}</span>
                      {e.lastEvent && !["sent", "delivered"].includes(e.lastEvent) && <div className="small muted">{e.lastEvent}</div>}
                      {e.error && <div className="small" style={{ color: "var(--bad)" }}>{e.error}</div>}
                    </td>
                    <td className="small">
                      {e.status === "queued" && e.sendAfter ? (
                        <UndoButton emailId={e.id} sendAfter={e.sendAfter.toISOString()} />
                      ) : (
                        fmt(e.sentAt ?? e.updatedAt)
                      )}
                    </td>
                    <td className="small hide-sm">{e.toAddress ?? (testMode() ? process.env.TEST_RECIPIENT : e.candidate.email) ?? "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </>
  );
}
