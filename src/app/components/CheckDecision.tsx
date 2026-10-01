"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { moveCandidate } from "../actions";

type Band = "SELECTED" | "HOLD" | "REJECTED";
const WORD: Record<Band, string> = { SELECTED: "Interview", HOLD: "Hold", REJECTED: "Reject" };

// The Check view's answer: agree (just move on), or put them elsewhere.
// Either way, go straight to the next flagged candidate.
export default function CheckDecision({ id, band, nextHref }: { id: string; band: Band; nextHref: string; emailed: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const others = (["SELECTED", "HOLD", "REJECTED"] as Band[]).filter((b) => b !== band);

  const go = (to?: Band) =>
    start(async () => {
      if (to) {
        const r = await moveCandidate(id, to, "Changed after checking the flagged evidence");
        if (!r.ok) return alert(r.error);
      }
      router.push(nextHref, { scroll: false });
    });

  return (
    <div className="check-actions">
      <button className="btn btn-primary" onClick={() => go()} disabled={pending}>Looks right · {WORD[band]}</button>
      {others.map((b) => (
        <button key={b} className="btn" onClick={() => go(b)} disabled={pending}>Move to {WORD[b]}</button>
      ))}
    </div>
  );
}
