import { prisma } from "./db";
import type { Role } from "./constants";
import type { Flag } from "./scoring/roleAssign";
import type { Point } from "./scoring/rubric";

export type InsightFlags = { flags: Flag[]; needsReview: boolean; confirmRole: boolean; topReason: string | null };

export type Row = {
  id: string;
  name: string;
  email: string | null;
  location: string | null;
  appliedDate: Date;
  status: string;
  manualReason: string | null;
  isAugustContact: boolean;
  roleTag: string | null;
  roleTagSource: string | null;
  role: Role | null; // assigned role, or the tag before scoring
  roleSource: string | null;
  score: number | null;
  otherScore: number | null;
  topReason: string | null;
  flags: Flag[];
  needsReview: boolean;
  confirmRole: boolean;
  movedByArjun: boolean;
  reviewed: boolean;
  emailed: boolean;
  lastEmail: { type: string; status: string; at: Date | null } | null;
  holdDeadline: Date | null;
  filename: string | null;
};

export async function loadRows(statuses: string[], role?: Role): Promise<Row[]> {
  const candidates = await prisma.candidate.findMany({
    where: { status: { in: statuses } },
    include: {
      cvFiles: { select: { filename: true }, orderBy: { createdAt: "desc" }, take: 1 },
      scores: { orderBy: { createdAt: "desc" }, take: 2, select: { roleScored: true, total: true, otherRoleTotal: true } },
      insight: { select: { flagsJson: true, strongPointsJson: true } },
      emails: {
        where: { status: { in: ["queued", "sending", "sent", "delivered", "bounced", "failed"] } },
        select: { type: true, status: true, sentAt: true, sendAfter: true },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const rows = candidates.map((c): Row => {
    const assigned = (c.roleAssigned ?? c.roleTag) as Role | null;
    const score = c.scores.find((s) => s.roleScored === c.roleAssigned);
    const meta: InsightFlags | null = c.insight ? JSON.parse(c.insight.flagsJson) : null;
    const strong: Point[] = c.insight ? JSON.parse(c.insight.strongPointsJson) : [];
    return {
      id: c.id,
      name: c.name,
      email: c.email,
      location: c.location,
      appliedDate: c.appliedDate,
      status: c.status,
      manualReason: c.manualReason,
      isAugustContact: c.isAugustContact,
      roleTag: c.roleTag,
      roleTagSource: c.roleTagSource,
      role: assigned,
      roleSource: c.roleSource,
      score: score?.total ?? null,
      otherScore: score?.otherRoleTotal ?? null,
      topReason: meta?.topReason ?? strong[0]?.text ?? null,
      flags: meta?.flags ?? [],
      needsReview: meta?.needsReview ?? false,
      confirmRole: meta?.confirmRole ?? false,
      movedByArjun: c.movedByArjun,
      reviewed: c.reviewedAt !== null,
      emailed: c.emails.some((e) => ["sent", "delivered", "bounced"].includes(e.status)),
      lastEmail: c.emails[0] ? { type: c.emails[0].type, status: c.emails[0].status, at: c.emails[0].sentAt ?? c.emails[0].sendAfter } : null,
      holdDeadline: c.holdDeadline,
      filename: c.cvFiles[0]?.filename ?? null,
    };
  });

  return rows
    .filter((r) => !role || r.role === role)
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

export async function pipelineCounts() {
  const grouped = await prisma.candidate.groupBy({ by: ["status", "roleAssigned", "roleTag"], _count: true });
  const by = (pred: (g: (typeof grouped)[number]) => boolean) =>
    grouped.filter(pred).reduce((n, g) => n + g._count, 0);
  const roleOf = (g: (typeof grouped)[number]) => g.roleAssigned ?? g.roleTag;
  return { grouped, by, roleOf };
}
