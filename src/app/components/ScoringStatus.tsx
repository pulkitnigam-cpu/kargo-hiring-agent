"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { QueueState } from "@/lib/scoring/queue";

// Shows scoring progress and keeps it moving: on Vercel each scoring step
// runs for a few minutes at most, so while CVs are waiting and no step is
// running, the open dashboard starts the next one.
export default function ScoringStatus({ waiting, approved }: { waiting: number; approved: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<QueueState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const inFlight = useRef(false);
  const lastWaiting = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;

    const step = () => {
      if (inFlight.current) return;
      inFlight.current = true;
      fetch("/api/score", { method: "POST" })
        .then((r) => r.json())
        .then((res) => {
          if (!res.started && res.reason) setMessage(res.reason);
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight.current = false;
        });
    };

    const poll = async () => {
      try {
        const s: QueueState = await (await fetch("/api/score", { cache: "no-store" })).json();
        if (!alive) return;
        setState(s);
        if (lastWaiting.current !== null && s.waiting !== lastWaiting.current) router.refresh();
        lastWaiting.current = s.waiting;
        if (approved && s.waiting > 0 && !s.running) step();
        timer = setTimeout(poll, s.waiting > 0 ? 4000 : 20000);
      } catch {
        timer = setTimeout(poll, 10000);
      }
    };
    poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [router, approved]);

  const left = state?.waiting ?? waiting;
  if (approved && left > 0) {
    const total = Math.max(state?.total ?? left, left);
    const pct = total ? Math.round(((total - left) / total) * 100) : 0;
    return (
      <div className="action-item action-info">
        <span>
          Scoring CVs: <strong>{left}</strong> to go. Keep this page open; the list updates by itself.
          {(state?.error || message) && <span className="small bad-text" style={{ display: "block" }}>{state?.error ?? message}</span>}
        </span>
        <div className="progress" style={{ width: 160 }}><div style={{ width: `${pct}%` }} /></div>
      </div>
    );
  }
  return state?.error ? <div className="action-item action-warn" role="alert"><span>{state.error}</span></div> : null;
}
