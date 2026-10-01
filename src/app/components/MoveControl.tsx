"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { moveCandidate } from "../actions";
import { useAnchor } from "./useAnchor";

type Band = "SELECTED" | "HOLD" | "REJECTED";
const BANDS: Band[] = ["SELECTED", "HOLD", "REJECTED"];
const LABEL: Record<Band, string> = { SELECTED: "Interview", HOLD: "Hold", REJECTED: "Rejected" };

// Move a candidate to either of the other two groups (§10.3), with an
// optional one-line reason. "menu" is the row's "Move to…" button; "buttons"
// is the panel's always-visible Interview / Hold / Rejected bar.
export default function MoveControl({
  id,
  band,
  emailed,
  variant = "menu",
}: {
  id: string;
  band: Band;
  emailed: boolean;
  variant?: "menu" | "buttons";
}) {
  const [picking, setPicking] = useState(false);
  const [target, setTarget] = useState<Band | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const input = useRef<HTMLInputElement>(null);
  const close = useCallback(() => {
    setTarget(null);
    setPicking(false);
  }, []);
  const anchor = useAnchor<HTMLSpanElement>(picking || target !== null, close);

  useEffect(() => {
    if (target) input.current?.focus({ preventScroll: true });
  }, [target]);

  const others = BANDS.filter((b) => b !== band);

  const choose = (t: Band) => {
    setError(null);
    setReason("");
    setPicking(false);
    setTarget(t);
  };

  const confirm = () => {
    if (!target) return;
    start(async () => {
      const res = await moveCandidate(id, target, reason);
      if (res.ok) setTarget(null);
      else setError(res.error);
    });
  };

  return (
    <span className="move" ref={anchor.ref}>
      {variant === "menu" ? (
        <button className="btn btn-small btn-ghost" onClick={() => (picking ? close() : setPicking(true))} disabled={pending} aria-haspopup="menu" aria-expanded={picking}>
          Move to… ▾
        </button>
      ) : (
        <span className="band-buttons" role="group" aria-label="Move to">
          <span className="small muted">Move to</span>
          {BANDS.map((b) => (
            <button
              key={b}
              className={`btn btn-small band-${b.toLowerCase()}${b === band ? " current" : ""}`}
              onClick={() => choose(b)}
              disabled={b === band || pending}
              aria-pressed={b === band}
            >
              {LABEL[b]}
            </button>
          ))}
        </span>
      )}

      {picking && (
        <div className="popover menu-pop" style={anchor.style} role="menu" aria-label="Move to">
          <div className="small muted">Now in {LABEL[band]}. Move to:</div>
          {others.map((b) => (
            <button key={b} className={`btn menu-item band-${b.toLowerCase()}`} role="menuitem" onClick={() => choose(b)}>
              {LABEL[b]}
            </button>
          ))}
        </div>
      )}

      {target && (
        <div className="popover" style={anchor.style} role="dialog" aria-label={`Move to ${LABEL[target]}`}>
          <div className="popover-title">Move from {LABEL[band]} to {LABEL[target]}</div>
          {emailed && <div className="warn-text small">⚠ They&apos;ve already been emailed. The right new email will be drafted for you to send.</div>}
          <input
            ref={input}
            type="text"
            placeholder="Reason (optional)"
            value={reason}
            maxLength={280}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") confirm();
              if (e.key === "Escape") close();
            }}
          />
          {error && <div className="small bad-text">{error}</div>}
          <div className="popover-actions">
            <button className="btn btn-small" onClick={close} disabled={pending}>Cancel</button>
            <button className="btn btn-small btn-primary" onClick={confirm} disabled={pending}>{pending ? "Moving…" : `Move to ${LABEL[target]}`}</button>
          </div>
        </div>
      )}
    </span>
  );
}
