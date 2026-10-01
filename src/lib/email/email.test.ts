import { test } from "node:test";
import assert from "node:assert/strict";
import { postChecks, tracesToQuotes } from "./checks";
import { emailTypeFor, reasonLineFor } from "./drafts";
import {
  assembleBody,
  experienceReason,
  LINES,
  needsDelayApology,
  needsRelocation,
  REASON_LINES,
  subjectFor,
  wordCount,
  type EmailFacts,
} from "./templates";

const base: EmailFacts = {
  type: "invite",
  firstName: "Priya",
  role: "PM",
  appliedRole: "PM",
  delayApology: true,
  augustContact: false,
  needsRelocation: true,
  calLink: "https://cal.com/arjun/45min",
};
const personal = {
  stoodOut: "Your time running carrier allocation and exception management at Mahindra Logistics stood out. You've done the work.",
  talkAbout: "I'm especially curious about how you decided to kill two features at Portwise.",
};

test("invite follows §12.2 and stays under 150 words", () => {
  const body = assembleBody(base, personal);
  assert.ok(body.startsWith("Hi Priya,"));
  assert.ok(body.includes("sorry this took longer than it should have"));
  assert.ok(body.includes("45 minutes"));
  assert.ok(body.includes("https://cal.com/arjun/45min"));
  assert.ok(body.includes(LINES.relocation));
  assert.ok(body.endsWith(LINES.signOff));
  assert.ok(wordCount(body) <= 150, `${wordCount(body)} words`);
  assert.equal(subjectFor("invite", "PM"), "Kargo: next conversation for the Product Manager role");
});

test("invite without a booking link asks for times instead", () => {
  const body = assembleBody({ ...base, calLink: "" }, personal);
  assert.ok(body.includes("Reply to this email with two or three times"));
  assert.ok(!body.includes("Pick a time"));
});

test("SPM invite: extra line, role switch line, and trimming keeps it ≤150", () => {
  const body = assembleBody({ ...base, role: "SPM", appliedRole: "PM", augustContact: true }, personal);
  assert.ok(body.includes(LINES.spmExtra));
  assert.ok(body.includes("You applied for the PM role, but given your experience, we'd like to talk to you about the Senior PM role instead."));
  assert.ok(body.includes(LINES.augustInvite));
  assert.ok(wordCount(body) <= 150, `${wordCount(body)} words`);
});

test("no relocation line for Mumbai metro, or unknown location", () => {
  assert.equal(needsRelocation("Mumbai, Maharashtra"), false);
  assert.equal(needsRelocation("Thane"), false);
  assert.equal(needsRelocation("Chennai / Mumbai"), false);
  assert.equal(needsRelocation("Bengaluru"), true);
  assert.equal(needsRelocation(null), false);
});

test("delay apology for July and August applicants only", () => {
  assert.equal(needsDelayApology(new Date(Date.UTC(2026, 6, 14))), true);
  assert.equal(needsDelayApology(new Date(Date.UTC(2026, 7, 31))), true);
  assert.equal(needsDelayApology(new Date(Date.UTC(2026, 8, 2))), false);
});

test("hold note has the deadline and no outcome", () => {
  const body = assembleBody({ ...base, type: "hold", holdDeadline: new Date(Date.UTC(2026, 9, 5, 6)) }, { specific: "Your work building the returns workflow at Cartexa stood out." });
  assert.ok(body.includes("still under active review"));
  assert.match(body, /by Monday, 5 October\./);
  assert.ok(!/won't be moving forward/.test(body));
});

test("clear-no regret: decision in the first three lines, reason line, no door", () => {
  const reason = experienceReason("PM");
  const body = assembleBody({ ...base, type: "regret_clear", reasonLine: reason, delayApology: false }, { specific: "I did enjoy reading about the content programme you built at Proxima." });
  const firstThree = body.split("\n").filter(Boolean).slice(0, 3).join(" ");
  assert.ok(firstThree.includes("We won't be moving forward"));
  assert.ok(body.includes("For this role, we're looking for 2–4 years of product management experience."));
  assert.ok(!body.includes(LINES.door));
  assert.ok(!body.includes(LINES.closeCall));
});

test("close-call regret has the door line", () => {
  const body = assembleBody({ ...base, type: "regret_close", reasonLine: REASON_LINES.P3 }, { specific: "Your work building the returns workflow at Cartexa stood out." });
  assert.ok(body.includes(LINES.closeCall));
  assert.ok(body.includes(LINES.door));
  assert.ok(body.includes(REASON_LINES.P3!));
});

test("post-checks catch score leaks, banned words, length, greeting, reason, placeholders", () => {
  const ok = assembleBody({ ...base, type: "regret_clear", reasonLine: REASON_LINES.J1 }, { specific: "Your returns workflow at Cartexa stood out." });
  assert.deepEqual(postChecks({ subject: "x", body: ok, firstName: "Priya", reasonLine: REASON_LINES.J1, editedByArjun: false }), []);

  const has = (body: string, extra: Partial<Parameters<typeof postChecks>[0]> = {}) =>
    postChecks({ subject: "Hello", body, firstName: "Priya", editedByArjun: false, ...extra }).join(" | ");
  assert.match(has("Hi Priya,\nYou got 82/100."), /score/);
  assert.match(has("Hi Priya,\nYou scored 82 overall."), /score/);
  assert.match(has("Hi Priya,\nOur rubric says no."), /rubric/);
  assert.match(has("Hi Priya,\nOur AI screening flagged you."), /"AI"/);
  assert.match(has("Hi Priya,\nCompared with other candidates you were close."), /other candidates/);
  assert.match(has("Hi Priya,\n" + "word ".repeat(160)), /160|limit/);
  assert.match(has("Hi Karan,\nThanks."), /first name/);
  assert.match(has("Hi Priya,\nThanks.", { reasonLine: REASON_LINES.P1 }), /reason line/);
  assert.equal(has("Hi Priya,\nThanks.", { reasonLine: REASON_LINES.P1, editedByArjun: true }), ""); // Arjun's edit is the approved reason
  assert.match(has("Hi Priya,\nPick a time: {cal_link}"), /placeholder/);
  assert.equal(has("Hi Priya,\nYou cut delays by 28 percentage points at Mahindra, in the AIRLINE team."), "");
});

test("personal lines must trace to the CV quotes", () => {
  const quotes = ["Managed carrier allocation, capacity planning, and exception management for 3 FMCG client accounts"];
  assert.ok(tracesToQuotes("Your time running carrier allocation and exception management stood out.", quotes));
  assert.ok(!tracesToQuotes("Your leadership at Google Cloud stood out.", quotes));
});

// emailTypeFor / reasonLineFor on plain objects shaped like the DB rows.
type Cand = Parameters<typeof emailTypeFor>[0];
function cand(status: string, score: number, extra: Record<string, unknown> = {}): Cand {
  return {
    status,
    roleAssigned: "PM",
    holdDeadline: null,
    scores: [{ roleScored: "PM", total: score, criteria: [] }],
    emails: [],
    insight: {
      flagsJson: JSON.stringify({ flags: [], needsReview: false, confirmRole: false, topReason: null }),
      weakPointsJson: JSON.stringify([{ criterionId: "J2" }, { criterionId: "P1" }]),
    },
    ...extra,
  } as unknown as Cand;
}

test("email type follows the band; close call vs clear no", () => {
  assert.equal(emailTypeFor(cand("SELECTED", 82)), "invite");
  assert.equal(emailTypeFor(cand("HOLD", 66)), "hold");
  assert.equal(emailTypeFor(cand("REJECTED", 41)), "regret_clear");
  assert.equal(emailTypeFor(cand("REJECTED", 64)), "regret_close"); // Arjun demoted a Hold-band score
  assert.equal(emailTypeFor(cand("INVITED", 82)), null);
  const due = new Date(Date.now() - 1000);
  const later = new Date(Date.now() + 86_400_000);
  assert.equal(emailTypeFor(cand("HOLD_NOTIFIED", 66, { holdDeadline: due })), "regret_close");
  assert.equal(emailTypeFor(cand("HOLD_NOTIFIED", 66, { holdDeadline: later })), null);
});

test("reason line: largest weighted gap, or the experience line when the range rule fired", () => {
  assert.equal(reasonLineFor(cand("REJECTED", 40)), REASON_LINES.J2);
  const out = cand("REJECTED", 40, {
    insight: {
      flagsJson: JSON.stringify({ flags: [{ code: "below_range", message: "" }] }),
      weakPointsJson: JSON.stringify([{ criterionId: "J2" }]),
    },
  });
  assert.equal(reasonLineFor(out), experienceReason("PM"));
});

test("personal note: own paragraph above the sign-off, replaced not stacked, removable", async () => {
  const { applyNote } = await import("./templates");
  const body = assembleBody(base, personal);
  const one = applyNote(body, null, "I'm in Mumbai all next week.");
  const paras = one.split(String.fromCharCode(10) + String.fromCharCode(10));
  assert.equal(paras[paras.length - 2], "I'm in Mumbai all next week.");
  assert.ok(one.endsWith(LINES.signOff));
  const two = applyNote(one, "I'm in Mumbai all next week.", "Happy to meet on video too.");
  assert.ok(two.includes("Happy to meet on video too.") && !two.includes("Mumbai all next week"));
  assert.equal(applyNote(two, "Happy to meet on video too.", ""), body);
});

test("a note is checked like the rest of the email", () => {
  const body = assembleBody({ ...base, type: "regret_clear", reasonLine: REASON_LINES.J1 }, { specific: "Your returns workflow at Cartexa stood out." });
  const withLeak = body.replace(LINES.signOff, "Our AI gave you 41/100.\n\n" + LINES.signOff);
  const problems = postChecks({ subject: "x", body: withLeak, firstName: "Priya", reasonLine: REASON_LINES.J1, editedByArjun: false }).join(" ");
  assert.match(problems, /score/);
  assert.match(problems, /"AI"/);
});
