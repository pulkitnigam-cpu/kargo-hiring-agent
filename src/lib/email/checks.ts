import { MAX_WORDS, wordCount } from "./templates";

// Post-checks (§13.4). Any problem blocks the send until Arjun fixes the text.

const BANNED: [RegExp, string][] = [
  [/\brubrics?\b/i, "rubric"],
  [/\brank(?:ed|ing|s)?\b/i, "rank"],
  [/\bcriteri(?:a|on)\b/i, "criteria"],
  [/\bAI\b/, "AI"],
  [/\bartificial intelligence\b/i, "artificial intelligence"],
  [/\balgorithms?\b/i, "algorithm"],
  [/\bother candidates?\b/i, "other candidates"],
  [/\bscreening (?:tool|system|software)\b/i, "screening tool"],
];

// "82/100", "82 score", "score of 82", "scored 82". Not "points": CV facts
// like "cut delays by 28 percentage points" are fine.
const SCORE_LEAK = /\b\d{1,3}\s*\/\s*100\b|\b\d{1,3}\s*score\b|\bscor(?:e|ed|ing)\b[^.\n]{0,20}\b\d{1,3}\b/i;

export type CheckInput = {
  subject: string;
  body: string;
  firstName: string;
  reasonLine?: string; // regrets: must appear exactly (unless Arjun edited)
  editedByArjun: boolean;
};

export function postChecks(e: CheckInput): string[] {
  const problems: string[] = [];
  const text = `${e.subject}\n${e.body}`;

  if (SCORE_LEAK.test(text)) problems.push("Mentions a score.");
  for (const [re, word] of BANNED) if (re.test(text)) problems.push(`Uses the word "${word}".`);

  const words = wordCount(e.body);
  if (words > MAX_WORDS) problems.push(`${words} words; the limit is ${MAX_WORDS}.`);

  const greeting = e.body.split("\n").find((l) => l.trim())?.trim() ?? "";
  if (!new RegExp(`^(hi|hello|dear)\\s+${e.firstName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(greeting)) {
    problems.push(`The greeting doesn't use the candidate's first name (${e.firstName}).`);
  }

  // Arjun's own edit counts as the approved reason (§13.4).
  if (e.reasonLine && !e.editedByArjun && !e.body.includes(e.reasonLine)) {
    problems.push("The approved reason line is missing.");
  }
  if (/\{[a-z_]+\}/i.test(text)) problems.push("Has an unfilled {placeholder}.");
  return problems;
}

// "Every personalised line must trace back to a CV quote" (§12.1): the
// sentence must share at least two distinctive words with the quotes it was
// written from.
const STOP = new Set(
  "about above after again also and any are because been before being both but can could did does doing down during each few for from further had has have having here how into its itself just more most other our out over own same should some such than that the their them then there these they this those through too under until very was were what when where which while who whom why will with would you your yours".split(" "),
);

export function tracesToQuotes(sentence: string, quotes: string[]): boolean {
  const words = (s: string) =>
    new Set((s.toLowerCase().match(/[a-z0-9][a-z0-9'-]{3,}/g) ?? []).filter((w) => !STOP.has(w)));
  const source = new Set(quotes.flatMap((q) => [...words(q)]));
  let shared = 0;
  for (const w of words(sentence)) if (source.has(w) && ++shared >= 2) return true;
  return false;
}
