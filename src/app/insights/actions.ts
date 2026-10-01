"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { redirect } from "next/navigation";
import { startCalibration } from "@/lib/calibration";
import { recordCall, startAgreement } from "@/lib/insights";
import type { Band } from "@/lib/scoring/rubric";

export async function runCalibration() {
  // The run itself happens after the response, within this function's time limit.
  const res = await startCalibration((job) => after(job));
  revalidatePath("/insights");
  return res;
}

export async function beginAgreement() {
  const res = await startAgreement(10);
  if ("error" in res) redirect(`/insights?error=${encodeURIComponent(res.error)}`);
  redirect(`/insights/agreement/${res.id}`);
}

export async function callBand(runId: string, candidateId: string, band: string) {
  if (!["SELECTED", "HOLD", "REJECTED"].includes(band)) return;
  await recordCall(runId, candidateId, band as Band);
  revalidatePath(`/insights/agreement/${runId}`);
}
