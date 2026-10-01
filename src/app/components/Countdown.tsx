"use client";

import { useEffect, useState } from "react";

// "Sends in 9:41", ticking. Calls onDone once when it reaches zero.
export default function Countdown({ until, onDone }: { until: string; onDone?: () => void }) {
  const target = new Date(until).getTime();
  const [left, setLeft] = useState(() => target - Date.now());

  useEffect(() => {
    const t = setInterval(() => {
      const l = target - Date.now();
      setLeft(l);
      if (l <= 0) {
        clearInterval(t);
        onDone?.();
      }
    }, 1000);
    return () => clearInterval(t);
  }, [target, onDone]);

  if (left <= 0) return <span>sending now…</span>;
  const s = Math.ceil(left / 1000);
  return <span>sends in {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}</span>;
}
