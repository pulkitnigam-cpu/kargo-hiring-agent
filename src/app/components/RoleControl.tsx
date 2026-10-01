"use client";

import { useCallback, useState, useTransition } from "react";
import { changeRole, previewRole } from "../actions";
import { useAnchor } from "./useAnchor";

type Role = "PM" | "SPM";
const BAND: Record<string, string> = { SELECTED: "Selected", HOLD: "Hold", REJECTED: "Rejected" };

// One-click role change (§9.3) with a preview of the new score and band.
export default function RoleControl({ id, role, emailed }: { id: string; role: Role; emailed: boolean }) {
  const other: Role = role === "PM" ? "SPM" : "PM";
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<{ total: number; band: string } | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const close = useCallback(() => setOpen(false), []);
  const anchor = useAnchor<HTMLSpanElement>(open, close);

  const begin = () => {
    setError(null);
    setReason("");
    setOpen(true);
    start(async () => setPreview(await previewRole(id, other)));
  };

  const confirm = () =>
    start(async () => {
      const res = await changeRole(id, other, reason);
      if (res.ok) setOpen(false);
      else setError(res.error);
    });

  return (
    <span className="move" ref={anchor.ref}>
      <button className="btn btn-small" onClick={begin} disabled={pending}>Change role to {other}</button>
      {open && (
        <div className="popover" style={anchor.style} role="dialog" aria-label={`Change role to ${other}`}>
          <div className="popover-title">Change role to {other === "PM" ? "Product Manager" : "Senior Product Manager"}</div>
          {preview ? (
            <div className="small">
              Re-scored with {other} weights: <strong>{preview.total}</strong>, which proposes <strong>{BAND[preview.band]}</strong>.
              Any earlier move is replaced by this band; you can move them again after.
            </div>
          ) : (
            <div className="small muted">Working out the {other} score…</div>
          )}
          {emailed && <div className="warn-text small">⚠ An email has already been sent to this candidate.</div>}
          <input type="text" placeholder="Reason (optional, one line)" value={reason} maxLength={280} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => e.key === "Enter" && confirm()} />
          {error && <div className="small" style={{ color: "var(--bad)" }}>{error}</div>}
          <div className="popover-actions">
            <button className="btn btn-small" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
            <button className="btn btn-small btn-primary" onClick={confirm} disabled={pending || !preview}>Change role</button>
          </div>
        </div>
      )}
    </span>
  );
}
