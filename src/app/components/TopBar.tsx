import Link from "next/link";
import { prisma } from "@/lib/db";
import NavLinks from "./NavLinks";
import UploadButtons from "./UploadButtons";

export default async function TopBar() {
  const [rubric, queued] = await Promise.all([
    prisma.rubricVersion.findFirst({ where: { approvedAt: { not: null } }, orderBy: { version: "desc" }, select: { version: true } }),
    prisma.email.count({ where: { status: { in: ["queued", "sending"] } } }),
  ]);
  return (
    <header className="topbar">
      <div className="wrap">
        <Link href="/" className="brand">Kargo Hiring</Link>
        <NavLinks
          links={[
            { href: "/", label: "Candidates" },
            { href: "/outbox", label: queued ? `Outbox · ${queued} queued` : "Outbox" },
            { href: "/insights", label: "Insights" },
            { href: "/rubric", label: rubric ? `Rubric v${rubric.version}` : "Rubric ⚠" },
          ]}
        />
        <div className="topbar-actions">
          <UploadButtons />
        </div>
      </div>
    </header>
  );
}
