// Phase 0 seed: rubric v1 (Rubric B, §8) and both JDs as text.
// Plain CommonJS so it runs with `node` (esbuild/tsx can't run in every sandbox).
const { PrismaClient } = require("@prisma/client");
const mammoth = require("mammoth");
const path = require("path");
const RUBRICS = [require("../src/data/rubric_v1.json"), require("../src/data/rubric_v2.json")];

const prisma = new PrismaClient();

const JDS = [
  { role: "PM", title: "Product Manager", file: "data/jds/pm.docx" },
  { role: "SPM", title: "Senior Product Manager", file: "data/jds/spm.docx" },
];

async function main() {
  // Every version is seeded unapproved; Arjun approves on /rubric. Existing
  // rows are left alone so an approval is never undone by re-seeding.
  for (const rubric of RUBRICS) {
    await prisma.rubricVersion.upsert({
      where: { version: rubric.version },
      update: {},
      create: {
        version: rubric.version,
        name: rubric.name,
        criteriaJson: JSON.stringify(rubric.criteria),
        weightsPmJson: JSON.stringify(rubric.weights.PM),
        weightsSpmJson: JSON.stringify(rubric.weights.SPM),
        rulesJson: rubric.scoringRules ? JSON.stringify(rubric.scoringRules) : null,
        changeNote: rubric.changeNote ?? null,
      },
    });
  }

  for (const jd of JDS) {
    const { value } = await mammoth.extractRawText({ path: path.join(__dirname, "..", jd.file) });
    const text = value.replace(/\n{3,}/g, "\n\n").trim();
    await prisma.jobDescription.upsert({
      where: { role: jd.role },
      update: { title: jd.title, text },
      create: { role: jd.role, title: jd.title, text },
    });
  }
  console.log(`Seeded rubric v${RUBRICS.map((r) => r.version).join(", v")} and 2 JDs.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
