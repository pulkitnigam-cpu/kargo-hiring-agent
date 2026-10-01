import mammoth from "mammoth";
// Import the library entry directly: pdf-parse's index.js runs a debug
// self-test that reads a sample file from disk when bundled.
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { MIN_CV_TEXT_CHARS } from "../constants";

export type ParseResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}

export function mimeFor(ext: string): string {
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return "application/octet-stream";
}

export function normaliseText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function parseCv(filename: string, data: Buffer): Promise<ParseResult> {
  const ext = extensionOf(filename);
  let raw: string;
  try {
    if (ext === ".pdf") {
      // Copy into a standalone Uint8Array. Node keeps small Buffers (<4 KB)
      // inside a shared pool, and the pdf.js bundled with pdf-parse reads
      // from the pool's start, so small PDFs failed with "bad XRef entry".
      raw = (await pdfParse(new Uint8Array(data) as unknown as Buffer)).text;
    } else if (ext === ".docx") {
      raw = (await mammoth.extractRawText({ buffer: data })).value;
    } else if (ext === ".doc") {
      return { ok: false, reason: "Old Word format (.doc). Save it as .docx or PDF and re-upload." };
    } else {
      return { ok: false, reason: `Unsupported file type (${ext || "no extension"}). Only PDF and DOCX can be read.` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint = /password|encrypt/i.test(msg) ? "password-protected" : "corrupt or not a real " + ext.slice(1).toUpperCase();
    return { ok: false, reason: `Couldn't open the file (${hint}).` };
  }

  const text = normaliseText(raw);
  if (text.length < MIN_CV_TEXT_CHARS) {
    return {
      ok: false,
      reason: text.length === 0
        ? "No text found. It may be a scanned image; needs a manual read."
        : `Only ${text.length} characters of text found. It may be a scanned image; needs a manual read.`,
    };
  }
  return { ok: true, text };
}
