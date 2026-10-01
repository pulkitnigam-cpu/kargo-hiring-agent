"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { ROLES, type Role } from "@/lib/constants";
import * as decisions from "@/lib/decisions";
import { parseDate } from "@/lib/ingest/manifest";
import { startScoring } from "@/lib/scoring/queue";
import type { Band } from "@/lib/scoring/rubric";

const BANDS: Band[] = ["SELECTED", "HOLD", "REJECTED"];

export async function moveCandidate(id: string, to: string, reason: string) {
  if (!BANDS.includes(to as Band)) return { ok: false as const, error: "Unknown band." };
  const res = await decisions.moveCandidate(id, to as Band, reason.slice(0, 280));
  revalidatePath("/", "layout");
  return res;
}

export async function changeRole(id: string, to: string, reason: string) {
  if (!(ROLES as readonly string[]).includes(to)) return { ok: false as const, error: "Unknown role." };
  const res = await decisions.changeRole(id, to as Role, reason.slice(0, 280));
  revalidatePath("/", "layout");
  return res;
}

export async function previewRole(id: string, to: string) {
  if (!(ROLES as readonly string[]).includes(to)) return null;
  return decisions.previewRole(id, to as Role);
}

export async function updateDetails(id: string, form: { isAugustContact?: boolean; appliedDate?: string; email?: string }) {
  const appliedDate = form.appliedDate ? parseDate(form.appliedDate) : undefined;
  if (form.appliedDate && !appliedDate) return { ok: false, error: "Couldn't read that date." };
  const res = await decisions.updateDetails(id, {
    isAugustContact: form.isAugustContact,
    appliedDate: appliedDate ?? undefined,
    email: form.email,
  });
  // An added email can release a CV from Needs manual look into scoring.
  if (res.ok && form.email) after(() => startScoring().then(() => undefined));
  revalidatePath("/", "layout");
  return res;
}
