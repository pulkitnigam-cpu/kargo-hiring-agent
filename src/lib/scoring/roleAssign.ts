import type { Role } from "../constants";

// Role assignment, SPEC §9 [LOCKED].

export type Flag = { code: string; message: string };

export type RoleDecision = {
  role: Role;
  source: "tagged" | "rubric";
  confirm: boolean; // "Role: Arjun to confirm"
  flags: Flag[];
};

// Years of PM experience each JD asks for (used for range flags and the
// regret reason line).
export const JD_YEARS: Record<Role, [number, number]> = { PM: [2, 4], SPM: [5, 8] };

const GREY_MIN = 4;
const GREY_MAX = 5;
const STRONGER_FIT_GAP = 15;
const TOO_CLOSE = 5;

const TITLE: Record<Role, string> = { PM: "PM", SPM: "SPM" };

function yearsText(y: number): string {
  return `${Math.round(y * 10) / 10} yrs PM`;
}

export function assignRole(input: {
  roleTag: Role | null;
  yearsPm: number;
  totals: Record<Role, number>;
}): RoleDecision {
  const { roleTag, yearsPm: y, totals } = input;
  const flags: Flag[] = [];

  if (roleTag) {
    // §9.1: use the tag, score the other role in the background, flag a 15+ gap.
    const other: Role = roleTag === "PM" ? "SPM" : "PM";
    if (totals[other] - totals[roleTag] >= STRONGER_FIT_GAP) {
      flags.push({
        code: "stronger_fit",
        message: `Applied for ${TITLE[roleTag]}, stronger fit for ${TITLE[other]} (${totals[other]} vs ${totals[roleTag]}).`,
      });
    }
    flags.push(...rangeFlags(roleTag, y));
    return { role: roleTag, source: "tagged", confirm: false, flags };
  }

  // §9.2: untagged. Step 1, years of product management experience.
  // Boundaries: [2,4) PM · [4,5] grey zone · (5,8] SPM.
  if (y >= GREY_MIN && y <= GREY_MAX) {
    // Step 2: grey zone, assign the higher score. Step 3: too close to call.
    const role: Role = totals.SPM > totals.PM ? "SPM" : "PM";
    const confirm = Math.abs(totals.PM - totals.SPM) <= TOO_CLOSE;
    if (confirm) {
      flags.push({
        code: "confirm_role",
        message: `Role: Arjun to confirm (${yearsText(y)}; PM ${totals.PM} vs SPM ${totals.SPM}).`,
      });
    }
    return { role, source: "rubric", confirm, flags };
  }

  const role: Role = y < GREY_MIN ? "PM" : "SPM";
  flags.push(...rangeFlags(role, y));
  return { role, source: "rubric", confirm: false, flags };
}

export function rangeFlags(role: Role, y: number): Flag[] {
  const [min, max] = JD_YEARS[role];
  if (y < min) return [{ code: "below_range", message: `Below range: ${yearsText(y)}, the ${TITLE[role]} JD asks for ${min}–${max}.` }];
  if (y > max) return [{ code: "above_range", message: `Above range: ${yearsText(y)}, the ${TITLE[role]} JD asks for ${min}–${max}.` }];
  return [];
}
