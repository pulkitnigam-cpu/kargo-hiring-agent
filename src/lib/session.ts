// Signed session cookie for the single dashboard login. Uses Web Crypto so it
// runs in middleware (edge) and in route handlers alike.

export const SESSION_COOKIE = "kargo_session";
export const SESSION_DAYS = 14;

function secret(): string | null {
  return process.env.AUTH_SECRET || process.env.DASHBOARD_PASSWORD || null;
}

export function authRequired(): boolean {
  // Locally, no password means no login. In production, a password is required.
  return !!process.env.DASHBOARD_PASSWORD || process.env.NODE_ENV === "production";
}

async function hmac(data: string, key: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function makeToken(now = Date.now()): Promise<string | null> {
  const key = secret();
  if (!key) return null;
  const exp = String(now + SESSION_DAYS * 86_400_000);
  return `${exp}.${await hmac(exp, key)}`;
}

export async function verifyToken(token: string | undefined, now = Date.now()): Promise<boolean> {
  const key = secret();
  if (!key || !token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || !(Number(exp) > now)) return false;
  return safeEqual(sig, await hmac(exp, key));
}

export async function passwordMatches(input: string): Promise<boolean> {
  const pw = process.env.DASHBOARD_PASSWORD;
  if (!pw) return false;
  // Compare digests so the timing doesn't depend on where strings differ.
  const [a, b] = await Promise.all([hmac(input, "kargo-login"), hmac(pw, "kargo-login")]);
  return safeEqual(a, b);
}
