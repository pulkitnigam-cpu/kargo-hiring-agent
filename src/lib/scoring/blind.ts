// Blinding (§6.1, §13.5): the AI never sees the candidate's name, contact
// details, age, gender, family, address or college. Arjun still sees
// everything on the dashboard; only the scoring input is blinded.

export const REDACTED = {
  name: "[Candidate]",
  contact: "[contact removed]",
  institution: "[institution]",
  education: "[Education section removed: institutions and grades are not scored]",
};

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /\+?\d[\d\s().-]{8,}\d/g;
const URL_RE = /\b(?:https?:\/\/\S+|www\.\S+|(?:linkedin|github|behance|medium)\.com\/\S*)/gi;

const PERSONAL_LINE =
  /^\s*(date of birth|d\.?o\.?b\.?|born|age|gender|sex|marital status|nationality|religion|caste|father'?s name|mother'?s name|spouse|husband|wife|children|family|dependents|permanent address|current address|address|residential address|languages known|passport|pan|aadhaar|photo)\b\s*[:\-–]/i;

const INLINE_PERSONAL: [RegExp, string][] = [
  [/\b\d{1,2}\s*(?:years?|yrs?)\s*old\b/gi, ""],
  [/\b(?:age|aged)\s*[:\-]?\s*\d{1,2}\b/gi, ""],
  [/\b(?:married|unmarried|single|divorced|widowed)\b(?=\s*[,.|;)]|\s*$)/gim, ""],
  [/\b(?:mother|father|parent) of (?:one|two|three|four|\d)\b[^.,;|]*/gi, ""],
  // Honorifics need the dot (or "Miss") so "MS Excel" is left alone.
  [/\b(?:Mr|Mrs|Ms|Mx|MR|MRS|MS)\.\s*(?=[A-Z])|\bMiss\s+(?=[A-Z])/g, ""],
];

// Gendered words → neutral. Keeps meaning without signalling gender.
const PRONOUNS: [RegExp, string][] = [
  [/\b(?:he|she)\b/g, "they"],
  [/\b(?:He|She)\b/g, "They"],
  [/\b(?:him|her)\b(?=\s+(?:a|an|the|to|with|as|on|in|for|and|,|\.|$))/gi, "them"],
  [/\b(?:his|her)\b/g, "their"],
  [/\b(?:His|Her)\b/g, "Their"],
  [/\b(?:hers|his)\b(?=[.,;]|$)/gi, "theirs"],
  [/\b(?:himself|herself)\b/gi, "themself"],
  [/\b(?:chairman|chairwoman)\b/gi, "chair"],
];

// Recognisable colleges (not FMS: in logistics CVs that is usually a
// Freight Management System), plus generic "X University", "Institute of X" etc.
const INSTITUTIONS: RegExp[] = [
  /\b(?:IIT|IIM|NIT|IIIT|BITS|IISc|IISER|ISB|XLRI|XIMB|MDI|SPJIMR|JBIMS|NMIMS|SIBM|IIFT|TISS|LSE|MIT|INSEAD|IMD|CEIBS)\b(?:[ ,\-]+(?:[A-Z][a-z]+|Delhi|Bombay|Madras|Kanpur|Kharagpur|Roorkee|Guwahati|Pilani|Goa|Hyderabad|Ahmedabad|Bangalore|Bengaluru|Calcutta|Kolkata|Lucknow|Indore|Kozhikode|Trichy|Tiruchirappalli|Surathkal|Warangal|Calicut|Jamshedpur|Mumbai|Pune))*/g,
  /\b(?:Harvard|Stanford|Wharton|Kellogg|Oxford|Cambridge|Columbia|Symbiosis|Manipal|Amity|Christ|Narsee Monjee|Jamnalal Bajaj|Loyola|St\.? Xavier'?s)\b(?:\s+(?:[A-Z][a-z]+))*/g,
  /\b(?:[A-Z][\w.&'-]*\s+){1,5}(?:University|College|Institute|Polytechnic)\b(?:\s+of\s+(?:[A-Z][\w.&'-]*\s*){1,5})?/g,
  /\b(?:University|Institute|College)\s+of\s+(?:[A-Z][\w.&'-]*\s*){1,5}/g,
  /\b(?:Indian|National)\s+Institute\s+of\s+(?:[A-Z][\w.&'-]*\s*){1,5}/g,
];

const EDU_HEADING = /^\s*(education|educational (?:background|qualifications?)|academic(?:s| background| qualifications?)?|qualifications?)\s*:?\s*$/i;
const ANY_HEADING =
  /^\s*(experience|work experience|professional experience|employment|skills|certifications?|certifications? & (?:skills|tools)|tools|projects|awards|achievements|publications|interests|languages|volunteering|summary|profile|references|additional information)\b.*$/i;

function stripEducationSection(lines: string[]): string[] {
  const out: string[] = [];
  let inEdu = false;
  for (const line of lines) {
    if (EDU_HEADING.test(line)) {
      inEdu = true;
      out.push(REDACTED.education);
      continue;
    }
    if (inEdu && ANY_HEADING.test(line) && line.trim().length < 60) inEdu = false;
    if (!inEdu) out.push(line);
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function blind(text: string, candidate: { name?: string | null }): string {
  let lines = text.split("\n");

  // Personal-detail lines ("Date of Birth: …", "Address: …") go entirely.
  lines = lines.filter((l) => !PERSONAL_LINE.test(l));
  lines = stripEducationSection(lines);

  let out = lines.join("\n");

  // Contact details first (an email often contains the name), then drop the
  // whole contact line: it also carries the home city.
  out = out.replace(EMAIL_RE, REDACTED.contact).replace(URL_RE, REDACTED.contact);
  // Phone numbers only where they look like phone numbers, not metrics.
  out = out.replace(PHONE_RE, (m) => (m.replace(/\D/g, "").length >= 10 ? REDACTED.contact : m));
  out = out
    .split("\n")
    .filter((l) => !l.includes(REDACTED.contact))
    .join("\n");

  // Name: full name, then each part (≥3 letters) on its own.
  const name = candidate.name?.trim();
  if (name) {
    out = out.replace(new RegExp(escapeRe(name), "gi"), REDACTED.name);
    for (const part of name.split(/\s+/).filter((p) => p.length >= 3)) {
      out = out.replace(new RegExp(`\\b${escapeRe(part)}\\b`, "gi"), REDACTED.name);
    }
  }

  for (const [re, rep] of INLINE_PERSONAL) out = out.replace(re, rep);
  for (const re of INSTITUTIONS) out = out.replace(re, REDACTED.institution);
  for (const [re, rep] of PRONOUNS) out = out.replace(re, rep);

  return out.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
