import type { Role } from "../constants";
import type { ManifestRow } from "./manifest";

// Finds a role tag carried by the file itself: its path/filename
// ("SPM/cv.pdf", "priya_pm.docx") or an "Applying for: ..." line in the CV.
// The spec says some CVs are tagged and some aren't; these are the tags we
// can see without guessing. Anything else stays untagged for §9 logic.

const SPM_RE = /(^|[^a-z])(spm|sr[\s_.-]*pm|senior[\s_.-]*product[\s_.-]*manager|senior[\s_.-]*pm)([^a-z]|$)/i;
const PM_RE = /(^|[^a-z])(pm|product[\s_.-]*manager)([^a-z]|$)/i;

export function roleFromString(s: string | null | undefined): Role | null {
  if (!s) return null;
  if (SPM_RE.test(s)) return "SPM";
  if (PM_RE.test(s)) return "PM";
  return null;
}

export function roleFromPath(relativePath: string): Role | null {
  // Folder names are checked too, so a zip laid out as PM/… and SPM/… works.
  // Drop the extension so "file.pm" style names don't count.
  return roleFromString(relativePath.replace(/\.[^./\\]+$/, ""));
}

const APPLYING_RE = /^(?:position|role|job)?\s*(?:applying|applied|application)\s*(?:for)?\s*[:\-–]?\s*(.{2,80})$/im;
const APPLYING_RE2 = /^(?:position|role)\s*(?:applied\s*for)?\s*[:\-–]\s*(.{2,80})$/im;

export function roleFromCvText(text: string): Role | null {
  const head = text.slice(0, 1500);
  const m = head.match(APPLYING_RE) ?? head.match(APPLYING_RE2);
  return m ? roleFromString(m[1]) : null;
}

// Priority: CSV manifest > folder/filename > "Applying for" line in the CV >
// the tag chosen for the whole batch.
export function resolveRole(
  filePath: string,
  text: string,
  manifest: ManifestRow | undefined,
  batchRole: Role | null,
): { role: Role | null; source: string | null } {
  if (manifest?.role) return { role: manifest.role, source: "manifest" };
  const fromPath = roleFromPath(filePath);
  if (fromPath) return { role: fromPath, source: "filename" };
  const fromText = text ? roleFromCvText(text) : null;
  if (fromText) return { role: fromText, source: "cv" };
  if (batchRole) return { role: batchRole, source: "batch" };
  return { role: null, source: null };
}
