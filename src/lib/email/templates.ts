import { ROLE_TITLE, type Role } from "../constants";
import { JD_YEARS } from "../scoring/roleAssign";
import type { CriterionId } from "../scoring/rubric";

// Email spec §12 [LOCKED]. The system assembles every email from these fixed
// parts; the AI only writes the personal sentences (what stood out, what to
// talk about, one genuine specific). That keeps the decision, the reason
// line, the apology and the sign-off exactly as approved.

export type EmailType = "invite" | "hold" | "regret_close" | "regret_clear";

export const EMAIL_TYPE_LABEL: Record<EmailType, string> = {
  invite: "Invite",
  hold: "Hold note",
  regret_close: "Regret (close call)",
  regret_clear: "Regret",
};

export const MAX_WORDS = 150;

// §12.4 reason lines: what the role needs, never what the candidate lacks.
export const REASON_LINES: Partial<Record<CriterionId, string>> = {
  P1: "For this role, we're prioritising people who've worked hands-on inside freight or logistics operations.",
  P2: "We're looking for someone with more experience owning a product through failures and setbacks, not just launches.",
  P3: "This role works directly with freight forwarding teams every day, and we're prioritising people who've done that kind of frontline customer work.",
  J1: "We're looking for more hands-on product experience: shipping features, killing what didn't work, and measuring the results.",
  J2: "This role owns our integration and data layer, so we're prioritising people who've owned platform or integration work end to end.",
  J3: "This role has no one above it making product calls, so we're looking for people who've owned decisions on their own.",
};

export function experienceReason(role: Role): string {
  const [a, b] = JD_YEARS[role];
  return `For this role, we're looking for ${a}–${b} years of product management experience.`;
}

export const LINES = {
  augustInvite: "I said we'd talk in August and then dropped the ball. That's on me.",
  relocation: "The role is in-office in Mumbai. If you're relocating, we'll work with you on timing.",
  noPrep: "No prep needed. We'll talk about your work and how Kargo's customers operate.",
  spmExtra: "You'd be Kargo's most senior PM and help shape how our product team works.",
  closeCall: "It was a close call.",
  door: "If you're open to it, I'd like to keep your details and reach out when we open future product roles.",
  signOff: "Arjun Mehta\nFounder, Kargo",
} as const;

// §12.5: what the role owns.
export const ROLE_OWNS: Record<Role, string> = {
  PM: "The role owns Kargo's core operations platform: tracking, documentation and customer discovery.",
  SPM: "The role owns our integration and data layer: carrier systems, port portals, ERPs, and the build-vs-configure calls.",
};

export function roleSwitchedLine(applied: Role, assigned: Role): string {
  return `You applied for the ${applied === "SPM" ? "Senior PM" : "PM"} role, but given your experience, we'd like to talk to you about the ${assigned === "SPM" ? "Senior PM" : "PM"} role instead.`;
}

export type EmailFacts = {
  type: EmailType;
  firstName: string;
  role: Role; // role the decision is about
  appliedRole: Role | null; // what they applied for (tag), if known
  delayApology: boolean; // applied in July or August (§12.1)
  augustContact: boolean;
  needsRelocation: boolean; // CV location isn't Mumbai
  reasonLine?: string; // regrets only, chosen by the system
  holdDeadline?: Date; // hold notes only
  calLink: string; // empty: ask them to reply with times instead
};

export type Personal = {
  stoodOut?: string; // invite: 1–2 sentences from the top strong points
  talkAbout?: string; // invite: one softened probe
  specific?: string; // hold / regret: one genuine specific from the CV
};

export function subjectFor(type: EmailType, role: Role): string {
  const title = ROLE_TITLE[role];
  if (type === "invite") return `Kargo: next conversation for the ${title} role`;
  if (type === "hold") return `Your application for ${title} at Kargo: an update`;
  return `Your application for ${title} at Kargo`;
}

export function formatDeadline(d: Date): string {
  return d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Kolkata" });
}

export function wordCount(s: string): number {
  return (s.match(/[A-Za-z0-9][\w'’.-]*/g) ?? []).length;
}

const join = (...parts: (string | false | undefined | null)[]) => parts.filter(Boolean).join(" ");

// Builds the body. Optional lines are dropped in a fixed order if the email
// would run past 150 words; required lines are never dropped.
export function assembleBody(f: EmailFacts, p: Personal): string {
  const greet = `Hi ${f.firstName},`;
  const sign = LINES.signOff;
  const applied = f.appliedRole && f.appliedRole !== f.role ? f.appliedRole : null;

  if (f.type === "invite") {
    const variants = [
      { roleOwns: true, noPrep: true },
      { roleOwns: false, noPrep: true },
      { roleOwns: false, noPrep: false },
    ];
    let body = "";
    for (const v of variants) {
      const paras = [
        greet,
        join(
          `Thanks for applying to Kargo${f.delayApology ? ", and sorry this took longer than it should have" : ""}.`,
          f.augustContact && LINES.augustInvite,
        ),
        applied && roleSwitchedLine(applied, f.role),
        join(p.stoodOut, v.roleOwns && ROLE_OWNS[f.role], f.role === "SPM" && LINES.spmExtra),
        join("I'd like to meet for 45 minutes, in person in Mumbai or on video.", p.talkAbout),
        v.noPrep && LINES.noPrep,
        f.calLink
          ? `Pick a time that suits you: ${f.calLink}`
          : "Reply to this email with two or three times in the next 7–10 days that work for you.",
        f.needsRelocation && LINES.relocation,
        sign,
      ];
      body = paras.filter(Boolean).join("\n\n");
      if (wordCount(body) <= MAX_WORDS) break;
    }
    return body;
  }

  if (f.type === "hold") {
    const role = ROLE_TITLE[f.appliedRole ?? f.role];
    return [
      greet,
      join(
        `Thank you for applying for the ${role} role at Kargo${f.delayApology ? ", and I'm sorry for how long this has taken" : ""}.`,
        f.augustContact && LINES.augustInvite,
      ),
      join("I wanted to let you know where things stand rather than leave you waiting: your application is still under active review.", p.specific),
      `I'll get back to you with a clear answer by ${formatDeadline(f.holdDeadline ?? new Date())}.`,
      sign,
    ].filter(Boolean).join("\n\n");
  }

  // Regrets: the decision in the first three lines, then one reason line.
  const close = f.type === "regret_close";
  const role = f.appliedRole ?? f.role;
  return [
    greet,
    join(
      `Thank you for applying to Kargo${f.delayApology ? ", and I'm sorry it took this long to get back to you" : ""}.`,
      f.augustContact && LINES.augustInvite,
    ),
    join(
      `We won't be moving forward with your application for the ${role === "SPM" ? "Senior PM" : "PM"} role this time.`,
      f.reasonLine,
      close && LINES.closeCall,
      p.specific,
    ),
    close && LINES.door,
    close ? "Thank you for your time, and I wish you the very best." : "Thank you for your interest in Kargo, and all the best with your search.",
    sign,
  ].filter(Boolean).join("\n\n");
}

// §12.1: the delay apology goes to anyone who applied in July or August.
export function needsDelayApology(applied: Date): boolean {
  const m = applied.getUTCMonth();
  return m === 6 || m === 7;
}

// Mumbai metro counts as Mumbai. Unknown location: no relocation line.
export function needsRelocation(location: string | null): boolean {
  if (!location) return false;
  return !/\b(mumbai|bombay|navi mumbai|thane)\b/i.test(location);
}

export function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

// Arjun's own message (optional): its own paragraph just above the sign-off.
// Replaces the previous note if there was one, so editing it never stacks.
export function applyNote(body: string, oldNote: string | null | undefined, newNote: string | null | undefined): string {
  const next = (newNote ?? "").trim();
  let out = body;
  const prev = (oldNote ?? "").trim();
  if (prev && out.includes(prev)) {
    out = next ? out.replace(prev, next) : out.replace(`${prev}\n\n`, "").replace(`\n\n${prev}`, "").replace(prev, "");
    return out.replace(/\n{3,}/g, "\n\n").trim();
  }
  if (!next) return out;
  const sig = out.lastIndexOf(LINES.signOff);
  return sig === -1 ? `${out.trim()}\n\n${next}` : `${out.slice(0, sig).trimEnd()}\n\n${next}\n\n${out.slice(sig)}`;
}
