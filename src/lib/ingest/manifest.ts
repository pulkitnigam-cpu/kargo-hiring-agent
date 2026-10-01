import type { Role } from "../constants";
import { roleFromString } from "./roleTag";

// Optional CSV that travels with a bulk upload (spec §17: "optional CSV
// mapping"). It is the only way to set per-candidate applied dates and the
// August "let's chat" flag in one go. Header names are case-insensitive:
//   filename, role, applied_date, august_contact
export type ManifestRow = {
  role: Role | null;
  appliedDate: Date | null;
  isAugustContact: boolean;
};

export function isManifestName(filename: string): boolean {
  return /\.csv$/i.test(filename);
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const t = s.trim();
  // ISO yyyy-mm-dd
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return utcDate(+m[1], +m[2], +m[3]);
  // dd/mm/yyyy or dd-mm-yyyy (Indian convention)
  m = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return utcDate(+m[3], +m[2], +m[1]);
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : d;
}

// Rejects impossible dates like 31/31/2026 instead of rolling them over.
function utcDate(y: number, mo: number, d: number): Date | null {
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? date : null;
}

const TRUE_RE = /^(y|yes|true|1|x)$/i;

export type Manifest = {
  rows: Map<string, ManifestRow>;
  errors: string[];
};

export function parseManifest(csv: string): Manifest {
  const lines = csv.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  const rows = new Map<string, ManifestRow>();
  const errors: string[] = [];
  if (!lines.length) return { rows, errors };

  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/[\s-]+/g, "_"));
  const col = (names: string[]) => header.findIndex((h) => names.includes(h));
  const iFile = col(["filename", "file", "file_name", "cv"]);
  const iRole = col(["role", "role_tag", "applied_role"]);
  const iDate = col(["applied_date", "applied", "date", "application_date"]);
  const iAug = col(["august_contact", "is_august_contact", "august", "lets_chat"]);
  if (iFile === -1) {
    errors.push("CSV has no 'filename' column, so it was ignored.");
    return { rows, errors };
  }

  for (let n = 1; n < lines.length; n++) {
    const cells = splitCsvLine(lines[n]);
    const file = cells[iFile];
    if (!file) continue;
    const rawDate = iDate >= 0 ? cells[iDate] : "";
    const appliedDate = parseDate(rawDate);
    if (rawDate && !appliedDate) errors.push(`Row ${n + 1}: couldn't read date "${rawDate}".`);
    rows.set(baseKey(file), {
      role: iRole >= 0 ? roleFromString(cells[iRole]) : null,
      appliedDate,
      isAugustContact: iAug >= 0 ? TRUE_RE.test(cells[iAug] ?? "") : false,
    });
  }
  return { rows, errors };
}

export function baseKey(path: string): string {
  return path.replace(/^.*[\\/]/, "").toLowerCase();
}
