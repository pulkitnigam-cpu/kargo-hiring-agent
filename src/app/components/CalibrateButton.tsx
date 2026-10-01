"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { runCalibration } from "../insights/actions";

export default function CalibrateButton({ running }: { running: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <span className="move" style={{ alignItems: "center", gap: 8 }}>
      <button
        className="btn btn-small"
        disabled={pending || running}
        onClick={() =>
          start(async () => {
            const r = await runCalibration();
            setMsg(r.started ? "Running: about 5 minutes. Refresh to see results." : r.reason ?? "Couldn't start.");
            router.refresh();
          })
        }
      >
        {running ? "Calibration running…" : "Run calibration on the 8 past hires"}
      </button>
      {msg && <span className="small muted">{msg}</span>}
    </span>
  );
}
