import { unlink } from "fs/promises";
import { prisma } from "./db";
import { CANDIDATE_STATUS } from "./constants";
import { absPath } from "./storage";

// DPDP guardrail (§13.5): delete rejected candidates' data after 6 months.
// Only candidates whose regret email went out (their process is closed) and
// whose last status change is older than RETENTION_DAYS (default 180).
// Candidates still waiting to hear back are never deleted.

export function retentionDays(): number {
  const n = Number(process.env.RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 180;
}

export async function purgeExpired(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays() * 86_400_000);
  const expired = await prisma.candidate.findMany({
    where: {
      status: CANDIDATE_STATUS.REGRET_SENT,
      statusEvents: { none: { createdAt: { gt: cutoff } } },
    },
    include: { cvFiles: { select: { storagePath: true } } },
  });

  for (const c of expired) {
    for (const f of c.cvFiles) if (f.storagePath) await unlink(absPath(f.storagePath)).catch(() => undefined);
    await prisma.candidate.delete({ where: { id: c.id } }); // cascades to scores, emails, events
    // The audit trail keeps no personal data about a deleted candidate.
    await prisma.auditLog.updateMany({ where: { entity: `candidate:${c.id}` }, data: { payloadJson: null } });
    await prisma.auditLog.create({
      data: { actor: "system", action: "candidate.purged", entity: `candidate:${c.id}`, payloadJson: JSON.stringify({ retentionDays: retentionDays() }) },
    });
  }
  return expired.length;
}
