"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { redirect } from "next/navigation";
import { LEVELS, type Criterion } from "@/lib/scoring/rubric";
import { prisma } from "@/lib/db";
import { requestRescore, startScoring } from "@/lib/scoring/queue";

// Arjun signs off the rubric (§5 Step 0: "Nothing is scored before approval").
export async function approveRubric(formData: FormData) {
  const id = String(formData.get("rubricId") ?? "");
  const approvedBy = String(formData.get("approvedBy") ?? "").trim() || "Arjun Mehta";
  const rubric = await prisma.rubricVersion.findUnique({ where: { id } });
  if (!rubric || rubric.approvedAt) return;

  await prisma.rubricVersion.update({ where: { id }, data: { approvedBy, approvedAt: new Date() } });
  await prisma.auditLog.create({
    data: { actor: "arjun", action: "rubric.approved", entity: `rubric:v${rubric.version}`, payloadJson: JSON.stringify({ approvedBy }) },
  });

  // Anything uploaded while waiting for approval gets scored now.
  after(() => startScoring().then(() => undefined));
  revalidatePath("/", "layout");
}

// "Re-score all with vN?" after a new version is approved.
export async function rescoreAll() {
  await prisma.auditLog.create({ data: { actor: "arjun", action: "rubric.rescore_all", entity: "rubric", payloadJson: null } });
  const n = await requestRescore();
  if (n) after(() => startScoring().then(() => undefined));
  revalidatePath("/", "layout");
  return n ? { started: true } : { started: false, reason: "Everyone is already scored with the current rubric." };
}

// Saves an edited rubric as the next version (unapproved).
export async function saveRubricVersion(form: FormData) {
  const latest = await prisma.rubricVersion.findFirst({ orderBy: { version: "desc" } });
  if (!latest) redirect("/rubric");
  const fail = (msg: string) => redirect(`/rubric/edit?error=${encodeURIComponent(msg)}`);
  if (Number(form.get("baseVersion")) !== latest.version) fail(`v${latest.version + 1} was created meanwhile. Start again from the latest version.`);

  const criteria: Criterion[] = JSON.parse(latest.criteriaJson);
  const str = (k: string) => String(form.get(k) ?? "").trim();
  const pm: Record<string, number> = {};
  const spm: Record<string, number> = {};
  const next = criteria.map((c) => {
    const w = (k: string) => {
      const n = Number(form.get(k));
      if (!Number.isInteger(n) || n < 0 || n > 100) fail(`Weights must be whole numbers from 0 to 100 (${c.id}).`);
      return n;
    };
    const p = w(`pm_${c.id}`);
    const s = w(`spm_${c.id}`);
    if (p) pm[c.id] = p;
    if (s) spm[c.id] = s;
    const anchors: Record<string, string> = {};
    for (const l of LEVELS) {
      const v = str(`a_${c.id}_${l}`);
      if (v) anchors[l] = v;
      else if (["4", "2", "0"].includes(l)) fail(`${c.id} needs a definition for level ${l}.`);
    }
    const notes = str(`notes_${c.id}`);
    return { ...c, name: str(`name_${c.id}`) || c.name, anchors: anchors as Criterion["anchors"], ...(notes ? { notes } : { notes: undefined }) };
  });
  const total = (w: Record<string, number>) => Object.values(w).reduce((a, b) => a + b, 0);
  if (total(pm) !== 100) fail(`PM weights add up to ${total(pm)}; they must total 100.`);
  if (total(spm) !== 100) fail(`SPM weights add up to ${total(spm)}; they must total 100.`);
  const changeNote = str("changeNote");
  if (!changeNote) fail("Say what changed and why.");
  const rules = str("rules").split("\n").map((r) => r.trim()).filter(Boolean);

  const v = latest.version + 1;
  await prisma.rubricVersion.create({
    data: {
      version: v,
      name: latest.name.replace(/(, edited v\d+)?$/, `, edited v${v}`),
      criteriaJson: JSON.stringify(next),
      weightsPmJson: JSON.stringify(pm),
      weightsSpmJson: JSON.stringify(spm),
      rulesJson: JSON.stringify(rules),
      changeNote,
    },
  });
  await prisma.auditLog.create({
    data: { actor: "arjun", action: "rubric.version_created", entity: `rubric:v${v}`, payloadJson: JSON.stringify({ from: latest.version, changeNote, weightsPm: pm, weightsSpm: spm }) },
  });
  revalidatePath("/", "layout");
  redirect("/rubric");
}
