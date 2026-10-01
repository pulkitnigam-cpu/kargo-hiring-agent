// One-off: copy everything from the local SQLite database (prisma/dev.db)
// into the Postgres database in DATABASE_URL (Neon), including CV files from
// storage/cvs into the database. Run once, after `prisma db push` on Neon:
//   node scripts/migrate-sqlite-to-neon.cjs            (refuses if Neon has candidates)
//   node scripts/migrate-sqlite-to-neon.cjs --replace  (wipes Neon's rows first)
const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");

process.loadEnvFile?.(".env");
const SQLITE = path.join(__dirname, "..", "prisma", "dev.db");
const STORAGE = path.join(__dirname, "..", "storage");
const replace = process.argv.includes("--replace");

// Model → [sqlite table, date fields, boolean fields]. Order respects foreign keys.
const MODELS = [
  ["rubricVersion", "RubricVersion", ["approvedAt", "createdAt"], []],
  ["jobDescription", "JobDescription", [], []],
  ["uploadBatch", "UploadBatch", ["createdAt"], []],
  ["candidate", "Candidate", ["appliedDate", "createdAt", "reviewedAt", "holdDeadline", "scoringClaimedAt"], ["isAugustContact", "movedByArjun", "rescoreRequested"]],
  ["cvFile", "CvFile", ["createdAt"], []],
  ["profile", "Profile", [], []],
  ["score", "Score", ["createdAt"], []],
  ["criterionScore", "CriterionScore", [], ["verified"]],
  ["insight", "Insight", [], []],
  ["statusEvent", "StatusEvent", ["createdAt"], []],
  ["email", "Email", ["queuedAt", "sendAfter", "sentAt", "createdAt", "updatedAt"], ["editedByArjun"]],
  ["auditLog", "AuditLog", ["createdAt"], []],
  ["calibrationRun", "CalibrationRun", ["createdAt", "finishedAt"], []],
  ["agreementRun", "AgreementRun", ["createdAt", "completedAt"], []],
];

const toDate = (v) => (v === null || v === undefined ? null : new Date(typeof v === "number" || /^\d+$/.test(v) ? Number(v) : v));

async function main() {
  if (!fs.existsSync(SQLITE)) throw new Error(`No local database at ${SQLITE}`);
  if (!/^postgres/.test(process.env.DATABASE_URL ?? "")) throw new Error("DATABASE_URL must point at Neon (postgres://…).");
  const lite = new DatabaseSync(SQLITE, { readOnly: true });
  const pg = new PrismaClient();
  const tables = new Set(lite.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name));

  const existing = await pg.candidate.count();
  if (existing && !replace) throw new Error(`Neon already has ${existing} candidates. Re-run with --replace to overwrite.`);
  if (replace) {
    for (const [model] of [...MODELS].reverse()) await pg[model].deleteMany();
    console.log("Cleared Neon.");
  }

  for (const [model, table, dates, bools] of MODELS) {
    if (!tables.has(table)) { console.log(`${table}: not in the local database, skipped`); continue; }
    const rows = lite.prepare(`select * from "${table}"`).all().map((r) => {
      const out = { ...r };
      for (const d of dates) if (d in out) out[d] = toDate(out[d]);
      for (const b of bools) if (b in out) out[b] = out[b] === 1 || out[b] === true;
      if (model === "cvFile") {
        // Files move from disk into the database.
        const rel = out.storagePath ? String(out.storagePath).replace(/^storage[\\/]/, "") : null;
        const file = rel ? path.join(STORAGE, rel) : null;
        if (file && fs.existsSync(file)) out.data = new Uint8Array(fs.readFileSync(file));
        else if (out.data) out.data = new Uint8Array(out.data);
      }
      return out;
    });
    for (let i = 0; i < rows.length; i += 200) await pg[model].createMany({ data: rows.slice(i, i + 200) });
    console.log(`${table}: ${rows.length}`);
  }

  const files = await pg.cvFile.count({ where: { data: { not: null } } });
  console.log(`Done. ${await pg.candidate.count()} candidates, ${files} CV files stored in the database.`);
  await pg.$disconnect();
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
