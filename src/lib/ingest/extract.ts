// Pulls the contact block out of CV text without AI. These fields are for
// Arjun's dashboard and the email, never for scoring (blinding is Phase 2).

export type Contact = {
  name: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
};

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /(\+?\d[\d\s().-]{8,}\d)/;
const URL_RE = /(https?:\/\/|www\.|linkedin\.com|github\.com)/i;

const CITIES = [
  "Mumbai", "Navi Mumbai", "Thane", "Pune", "Bengaluru", "Bangalore", "Delhi", "New Delhi",
  "Gurugram", "Gurgaon", "Noida", "Hyderabad", "Chennai", "Kolkata", "Ahmedabad", "Surat",
  "Jaipur", "Kochi", "Cochin", "Coimbatore", "Indore", "Nagpur", "Lucknow", "Chandigarh",
  "Vadodara", "Visakhapatnam", "Bhubaneswar", "Goa", "Mysuru", "Mysore", "Singapore", "Dubai",
  "London",
];

// Words that make a line a section heading or a title, never a name
// ("Professional Summary", "Core Skills", "Scholastic Achievements").
const HEADING_WORDS = new Set(
  (
    "summary profile professional experience work employment history education academic academics qualifications " +
    "skills skill core key technical competencies objective about contact details information personal curriculum " +
    "vitae resume cv career achievements scholastic research publications projects project certifications awards " +
    "honours honors interests languages references volunteering leadership responsibilities positions extracurricular " +
    "activities strengths highlights overview expertise tools training internships internship product manager " +
    "senior associate lead head director consultant analyst engineer strategy operations growth founder"
  ).split(" "),
);

function isNameLike(line: string): boolean {
  if (line.length < 3 || line.length > 60) return false;
  if (EMAIL_RE.test(line) || URL_RE.test(line) || /\d/.test(line)) return false;
  const words = line.split(/\s+/);
  if (words.length < 2 || words.length > 5) return false;
  if (words.some((w) => HEADING_WORDS.has(w.toLowerCase().replace(/[^a-z]/g, "")))) return false;
  // Names are capitalised ("Priya Sharma" or "PRIYA SHARMA"); sentences aren't.
  return words.every((w) => /^[A-Z][A-Za-z.'-]*$/.test(w));
}

// Chooses between the name in the CV text and the one in the file name.
// Many CVs carry the name only in the file name ("06_kavya_patel.pdf") or in
// an image, so a two-word file name wins unless the text agrees with it.
export function chooseName(fromText: string | null, fromFile: string | null): string | null {
  const fileWords = fromFile?.toLowerCase().split(/\s+/) ?? [];
  if (fromFile && fileWords.length >= 2) {
    if (fromText && fromText.toLowerCase().split(/\s+/).some((w) => fileWords.includes(w))) return fromText;
    return fromFile;
  }
  return fromText ?? fromFile;
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/(^|[\s'-])([a-z])/g, (_m, sep: string, c: string) => sep + c.toUpperCase());
}

function findLocation(lines: string[]): string | null {
  // 1. An explicit "Location:" / "Based in" line.
  for (const line of lines) {
    const m = line.match(/^(?:location|address|based in|city)\s*[:\-–]\s*(.+)$/i);
    if (m) return m[1].split("|")[0].trim();
  }
  // 2. A segment of the contact line ("email | phone | City | linkedin").
  for (const line of lines) {
    if (!EMAIL_RE.test(line) && !PHONE_RE.test(line)) continue;
    for (const seg of line.split(/[|•·]/)) {
      const s = seg.trim();
      if (!s || EMAIL_RE.test(s) || PHONE_RE.test(s) || URL_RE.test(s)) continue;
      const city = CITIES.find((c) => new RegExp(`\\b${c}\\b`, "i").test(s));
      if (city) return s;
    }
  }
  // 3. Any known city in the header area.
  for (const line of lines) {
    const city = CITIES.find((c) => new RegExp(`\\b${c}\\b`, "i").test(line));
    if (city && line.length < 80) return city;
  }
  return null;
}

export function extractContact(text: string, filename?: string): Contact {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const header = lines.slice(0, 8);

  const email = text.match(EMAIL_RE)?.[0].toLowerCase() ?? null;

  let phone: string | null = null;
  for (const line of header) {
    const m = line.replace(EMAIL_RE, "").match(PHONE_RE);
    if (m && m[1].replace(/\D/g, "").length >= 10) {
      phone = m[1].trim();
      break;
    }
  }

  let textName = header.find(isNameLike) ?? null;
  if (textName && textName === textName.toUpperCase()) textName = titleCase(textName);
  const name = chooseName(textName, filename ? nameFromFilename(filename) : null);

  return { name, email, phone, location: findLocation(header) };
}

// "cv_07_lavanya_iyer.docx" -> "Lavanya Iyer"; used when the text has no clear name.
export function nameFromFilename(filename: string): string | null {
  const base = filename.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  const words = base
    .split(/[_\-\s.]+/)
    .filter((w) => /^[a-z]{2,}$/i.test(w))
    .filter((w) => !/^(cv|resume|final|updated|new|copy|pm|spm|senior|product|manager|application|v\d*)$/i.test(w));
  return words.length ? titleCase(words.join(" ")) : null;
}
