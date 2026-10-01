import { createHash } from "crypto";
import { prisma } from "../db";
import { CANDIDATE_STATUS, type Role } from "../constants";
import { extractContact, nameFromFilename } from "./extract";
import { baseKey, isManifestName, parseManifest, type ManifestRow } from "./manifest";
import { extensionOf, mimeFor, parseCv } from "./parse";
import { resolveRole } from "./roleTag";
import { unpack, type Ignored, type InFile } from "./unpack";

export type UploadOptions = {
  mode: "single" | "bulk";
  batchRole: Role | null; // applies to files that don't carry their own tag
  batchAppliedDate: Date | null; // default: upload date (§14 Phase 1)
  batchAugustContact?: boolean; // single upload only
};

export type UploadSummary = {
  batchId: string;
  uploaded: number; // CV files received (after unzipping, excluding clutter/CSV)
  ready: number; // parsed and waiting for scoring
  needsManualLook: { file: string; name: string; reason: string }[];
  duplicates: { file: string; reason: string }[];
  ignored: Ignored[];
  roles: { PM: number; SPM: number; untagged: number };
  manifest: { used: boolean; matched: number; errors: string[] };
  sharedEmails: { email: string; count: number }[]; // one address on several CVs (kept, not merged)
};


type Seen = { hashes: Map<string, string>; people: Map<string, string>; emailCounts: Map<string, number> };

// Same person = same email AND same name. A shared or placeholder address
// (e.g. a team inbox on several CVs) never merges different people.
const personKey = (email: string, name: string | null) => `${email}|${(name ?? "").toLowerCase().replace(/[^a-z]/g, "")}`;

export async function ingest(input: InFile[], opts: UploadOptions): Promise<UploadSummary> {
  const now = new Date();
  const { files, ignored } = await unpack(input);

  // Split out CSV manifests; everything else is treated as a CV.
  const manifestRows = new Map<string, ManifestRow>();
  const manifestErrors: string[] = [];
  let manifestUsed = false;
  const cvFiles: InFile[] = [];
  for (const f of files) {
    if (isManifestName(f.path)) {
      const m = parseManifest(f.data.toString("utf8"));
      manifestErrors.push(...m.errors.map((e) => `${baseKey(f.path)}: ${e}`));
      if (m.rows.size) manifestUsed = true;
      m.rows.forEach((v, k) => manifestRows.set(k, v));
    } else {
      cvFiles.push(f);
    }
  }

  const batch = await prisma.uploadBatch.create({
    data: { mode: opts.mode, roleTag: opts.batchRole, summaryJson: "{}" },
  });

  const summary: UploadSummary = {
    batchId: batch.id,
    uploaded: cvFiles.length,
    ready: 0,
    needsManualLook: [],
    duplicates: [],
    ignored,
    roles: { PM: 0, SPM: 0, untagged: 0 },
    manifest: { used: manifestUsed, matched: 0, errors: manifestErrors },
    sharedEmails: [],
  };

  const seen: Seen = { hashes: new Map(), people: new Map(), emailCounts: new Map() };

  for (const f of cvFiles) {
    const display = f.path.replace(/^.*[\\/]/, "");
    const hash = createHash("sha256").update(f.data).digest("hex");

    // Dedupe rule: the exact same file, or the same person (same email and
    // same name), counts as one application. The first one uploaded wins.
    const dupOf = seen.hashes.get(hash) ?? (await existingByHash(hash));
    if (dupOf) {
      summary.duplicates.push({ file: display, reason: `Same file as ${dupOf}` });
      continue;
    }

    const parsed = await parseCv(display, f.data);
    const contact = parsed.ok
      ? extractContact(parsed.text, display)
      : { name: nameFromFilename(display), email: null, phone: null, location: null };

    if (contact.email) {
      const key = personKey(contact.email, contact.name);
      const personDup = seen.people.get(key) ?? (await existingPerson(contact.email, contact.name));
      if (personDup) {
        summary.duplicates.push({ file: display, reason: `Same person (${contact.name}, ${contact.email}) as ${personDup}` });
        continue;
      }
      const before = seen.emailCounts.get(contact.email) ?? (await prisma.candidate.count({ where: { email: contact.email } }));
      seen.emailCounts.set(contact.email, before + 1);
    }

    const manifest = manifestRows.get(baseKey(f.path));
    if (manifest) summary.manifest.matched++;

    const tagged = resolveRole(f.path, parsed.ok ? parsed.text : "", manifest, opts.batchRole);
    summary.roles[tagged.role ?? "untagged"]++;

    let manualReason: string | null = null;
    if (!parsed.ok) manualReason = parsed.reason;
    else if (!contact.email) manualReason = "No email address found, so this candidate can't be contacted.";

    const ext = extensionOf(display);

    const name = contact.name ?? display;
    const status = manualReason ? CANDIDATE_STATUS.NEEDS_MANUAL_LOOK : CANDIDATE_STATUS.PARSED;
    const candidate = await prisma.candidate.create({
      data: {
        name,
        email: contact.email,
        phone: contact.phone,
        location: contact.location,
        appliedDate: manifest?.appliedDate ?? opts.batchAppliedDate ?? now,
        roleTag: tagged.role,
        roleTagSource: tagged.source,
        status,
        manualReason,
        isAugustContact: manifest?.isAugustContact ?? opts.batchAugustContact ?? false,
        uploadBatchId: batch.id,
        cvFiles: {
          create: {
            filename: display,
            fileHash: hash,
            mime: mimeFor(ext),
            data: new Uint8Array(f.data), // kept in the database: private, survives serverless restarts
            rawText: parsed.ok ? parsed.text : null,
            parseStatus: parsed.ok ? "ok" : "failed",
          },
        },
        statusEvents: {
          create: { fromStatus: CANDIDATE_STATUS.UPLOADED, toStatus: status, actor: "system", reason: manualReason },
        },
      },
    });

    seen.hashes.set(hash, display);
    if (contact.email) seen.people.set(personKey(contact.email, contact.name), display);

    if (manualReason) summary.needsManualLook.push({ file: display, name, reason: manualReason });
    else summary.ready++;

    await prisma.auditLog.create({
      data: {
        actor: "system",
        action: "candidate.uploaded",
        entity: `candidate:${candidate.id}`,
        payloadJson: JSON.stringify({ file: display, status, roleTag: tagged.role, roleTagSource: tagged.source, batchId: batch.id }),
      },
    });
  }

  summary.sharedEmails = [...seen.emailCounts].filter(([, n]) => n > 1).map(([email, count]) => ({ email, count }));
  await prisma.uploadBatch.update({ where: { id: batch.id }, data: { summaryJson: JSON.stringify(summary) } });
  await prisma.auditLog.create({
    data: { actor: "arjun", action: `upload.${opts.mode}`, entity: `batch:${batch.id}`, payloadJson: JSON.stringify(summary) },
  });
  return summary;
}

async function existingByHash(hash: string): Promise<string | null> {
  const row = await prisma.cvFile.findUnique({ where: { fileHash: hash }, select: { filename: true } });
  return row ? `${row.filename} (uploaded earlier)` : null;
}

async function existingPerson(email: string, name: string | null): Promise<string | null> {
  const rows = await prisma.candidate.findMany({ where: { email }, select: { name: true } });
  const match = rows.find((r) => personKey(email, r.name) === personKey(email, name));
  return match ? `${match.name} (uploaded earlier)` : null;
}
