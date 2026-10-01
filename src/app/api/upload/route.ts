import { after, NextResponse } from "next/server";
import { MAX_UPLOAD_BYTES, ROLES, type Role } from "@/lib/constants";
import { ingest } from "@/lib/ingest/ingest";
import { parseDate } from "@/lib/ingest/manifest";
import type { InFile } from "@/lib/ingest/unpack";
import { startScoring } from "@/lib/scoring/queue";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 300;

// POST multipart/form-data
//   files[]      one or many files (PDF, DOCX, ZIP, optional CSV manifest)
//   paths[]      relative path for each file, same order (keeps folder names)
//   mode         "single" | "bulk"
//   role         "PM" | "SPM" | "" (untagged)
//   appliedDate  optional yyyy-mm-dd, default today
//   august       "true" for a single upload of an August "let's chat" candidate
export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Upload could not be read. Try again with fewer files." }, { status: 400 });
  }

  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  const paths = form.getAll("paths").map(String);
  if (!files.length) return NextResponse.json({ error: "No files were attached." }, { status: 400 });

  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: `Upload is ${Math.round(total / 1e6)} MB; the limit is ${MAX_UPLOAD_BYTES / 1e6} MB.` }, { status: 413 });
  }

  const mode = form.get("mode") === "single" ? "single" : "bulk";
  if (mode === "single" && files.length > 1) {
    return NextResponse.json({ error: "Single upload takes one file. Use Bulk upload for more." }, { status: 400 });
  }

  const roleRaw = String(form.get("role") ?? "");
  const batchRole = (ROLES as readonly string[]).includes(roleRaw) ? (roleRaw as Role) : null;
  const dateRaw = String(form.get("appliedDate") ?? "");
  const batchAppliedDate = dateRaw ? parseDate(dateRaw) : null;
  if (dateRaw && !batchAppliedDate) return NextResponse.json({ error: `Couldn't read the date "${dateRaw}".` }, { status: 400 });

  const input: InFile[] = await Promise.all(
    files.map(async (f, i) => ({ path: paths[i] || f.name, data: Buffer.from(await f.arrayBuffer()) })),
  );

  const summary = await ingest(input, {
    mode,
    batchRole,
    batchAppliedDate,
    batchAugustContact: mode === "single" && form.get("august") === "true",
  });
  // Journey step 3: scoring follows the upload without another click. It runs
  // after the response (up to the function's time limit); the dashboard keeps
  // it going from there.
  let scoring: { started: boolean; reason?: string } | null = null;
  if (summary.ready > 0) {
    const approved = await prisma.rubricVersion.count({ where: { approvedAt: { not: null } } });
    scoring = approved ? { started: true } : { started: false, reason: "The rubric hasn't been approved yet. Approve it on the Rubric page first." };
    if (approved) after(() => startScoring().then(() => undefined));
  }
  return NextResponse.json({ ...summary, scoring });
}
