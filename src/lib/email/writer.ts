import type { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { withNetworkRetry } from "../scoring/ai";
import { tracesToQuotes } from "./checks";
import type { EmailType, Personal } from "./templates";

// AI contract 2 (§13.4), narrowed: the AI writes only the personal sentences.
// A fast model is enough for this; override with GEMINI_EMAIL_MODEL.
export const DEFAULT_EMAIL_MODEL = "gemini-3.8-flash";

const Out = z.object({ stood_out: z.string(), talk_about: z.string(), specific: z.string() });
const { $schema: _drop, ...SCHEMA } = z.toJSONSchema(Out) as Record<string, unknown>;
void _drop;

export type WriterInput = {
  type: EmailType;
  role: "PM" | "SPM";
  strongPoints: { text: string; quote?: string }[];
  probe: string | null;
  quotes: string[]; // every verified CV quote, for the trace check
};

const SYSTEM = `You write one or two personal sentences for emails from Arjun Mehta, founder of Kargo (logistics SaaS, Mumbai), to job applicants. The rest of each email is fixed text you never see.

Voice: Arjun's own. Direct, warm, plain words, no corporate language, no exclamation marks, no flattery words like "impressive" or "incredible". Address the candidate as "you". Use only facts in the CV excerpts you are given, and name the concrete thing (a company, a number, a system) from them. Never mention scores, ratings, assessments, rubrics, criteria, AI, other candidates, salary, age, gender, college or family.`;

function prompt(i: WriterInput): string {
  const points = i.strongPoints.map((p, n) => `${n + 1}. ${p.text}${p.quote ? `\n   CV: "${p.quote}"` : ""}`).join("\n");
  const task =
    i.type === "invite"
      ? `stood_out: 1–2 sentences (max 40 words) on what stood out, from the points below, as natural sentences. Example: "Your time running carrier allocation and exception management at Mahindra Logistics stood out. Most PMs we meet have studied freight operations. You've done the work."
talk_about: one sentence (max 25 words) naming a topic Arjun wants to hear about, framed as curiosity, never as a weakness. Start with "I'm especially curious about". Base it on this interview question: ${i.probe ?? "(none: pick the most interesting point above)"}${i.role === "SPM" ? ' For the Senior PM role, lean towards platform or long-lived decisions ("a platform decision you\'ll still feel in two years").' : ' For the PM role, lean towards product calls ("how you decided what to kill").'}
specific: empty string.`
      : `specific: one sentence (max 25 words) naming one genuine thing from the CV that Arjun appreciated, e.g. "Your work building the returns workflow at Cartexa stood out." or "I did enjoy reading about the content programme you built at Proxima from scratch." ${i.type === "hold" ? "It must not hint at the outcome." : "It must not soften the decision or promise anything."}
stood_out and talk_about: empty strings.`;
  return `Email type: ${i.type}. Role: ${i.role === "SPM" ? "Senior Product Manager" : "Product Manager"}.

What stood out in this candidate's CV:
${points || "(nothing specific; use the CV excerpts)"}

Other CV excerpts:
${i.quotes.map((q) => `- "${q}"`).join("\n") || "(none)"}

Write:
${task}

Return JSON.`;
}

export type WriterResult = { personal: Personal; traced: boolean; model: string };

export async function writePersonal(client: GoogleGenAI, input: WriterInput): Promise<WriterResult> {
  const model = process.env.GEMINI_EMAIL_MODEL || DEFAULT_EMAIL_MODEL;
  const sources = [...input.quotes, ...input.strongPoints.map((p) => p.quote ?? ""), input.probe ?? ""].filter(Boolean);

  let last: Personal = {};
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await withNetworkRetry(() =>
      client.models.generateContent({
        model,
        contents: prompt(input),
        config: { systemInstruction: SYSTEM, responseMimeType: "application/json", responseJsonSchema: SCHEMA, maxOutputTokens: 4096 },
      }),
    );
    const parsed = Out.safeParse((() => { try { return JSON.parse(r.text ?? ""); } catch { return null; } })());
    if (!parsed.success) continue;
    const personal: Personal =
      input.type === "invite"
        ? { stoodOut: parsed.data.stood_out.trim(), talkAbout: parsed.data.talk_about.trim() }
        : { specific: parsed.data.specific.trim() };
    last = personal;
    // Every personalised line must trace to the CV (§12.1).
    const lines = input.type === "invite" ? [personal.stoodOut] : [personal.specific];
    if (lines.every((l) => !l || tracesToQuotes(l, sources))) return { personal, traced: true, model: r.modelVersion ?? model };
  }
  return { personal: last, traced: false, model };
}
