"use client";

import { useState, useTransition } from "react";
import { rescoreAll } from "../rubric/actions";

export default function RescoreButton({ count, version }: { count: number; version: number }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="approve card">
      <div>
        <strong>{count} candidate{count === 1 ? " was" : "s were"} scored with an older rubric.</strong>
        <div className="small muted">
          Re-score them with v{version}? Scores are recalculated; anyone you moved, set a role for, or already emailed keeps your
          decision. Old scores stay on record under their version.
        </div>
        {msg && <div className="small" style={{ marginTop: 4 }}>{msg}</div>}
      </div>
      <button
        className="btn btn-primary"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await rescoreAll();
            setMsg(r.started ? "Re-scoring started. Progress shows on the dashboard." : r.reason ?? "Couldn't start.");
          })
        }
      >
        Re-score all with v{version}
      </button>
    </div>
  );
}
