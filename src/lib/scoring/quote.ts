// Quote verification (§13.3): every score ≥1 must cite text that really is in
// the CV. Matching is on word tokens, so line breaks, bullets, curly quotes
// and dash styles don't cause false failures; a quote passes when some
// window of the CV is ≥90% similar (token edit distance).

export const MATCH_THRESHOLD = 0.9;

export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[‘’“”]/g, "'")
    .match(/[a-z0-9]+(?:['.][a-z0-9]+)*/g) ?? [];
}

function editDistance(a: string[], b: string[]): number {
  const prev = new Array(b.length + 1);
  const cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

// Best similarity (0–1) of the quote against any window of the text.
export function quoteSimilarity(quote: string, textTokens: string[]): number {
  const q = tokens(quote);
  if (!q.length) return 0;
  const n = q.length;
  const joinedText = ` ${textTokens.join(" ")} `;
  if (joinedText.includes(` ${q.join(" ")} `)) return 1;

  let best = 0;
  const minLen = Math.max(1, Math.floor(n * 0.9));
  const maxLen = Math.ceil(n * 1.1);
  const first = new Set(q.slice(0, 3));
  for (let start = 0; start < textTokens.length; start++) {
    // Only try windows that start near a matching word; keeps this fast.
    if (!first.has(textTokens[start])) continue;
    for (let len = minLen; len <= maxLen && start + len <= textTokens.length; len++) {
      const sim = 1 - editDistance(q, textTokens.slice(start, start + len)) / Math.max(n, len);
      if (sim > best) best = sim;
      if (best === 1) return 1;
    }
  }
  return best;
}

// Quotes may join fragments with "..." — each fragment must be found.
export function verifyQuote(quote: string, text: string | string[]): boolean {
  const textTokens = Array.isArray(text) ? text : tokens(text);
  const parts = quote.split(/\.{3}|…/).map((p) => p.trim()).filter((p) => tokens(p).length > 0);
  if (!parts.length) return false;
  return parts.every((p) => quoteSimilarity(p, textTokens) >= MATCH_THRESHOLD);
}
