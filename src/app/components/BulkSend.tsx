"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { prepare, sendBulk } from "../email-actions";

type Group = "invite" | "hold" | "regret" | "hold_due";
type Prepared = Awaited<ReturnType<typeof prepare>>;

const NOUN: Record<Group, [string, string]> = {
  invite: ["invite", "invites"],
  hold: ["hold note", "hold notes"],
  regret: ["regret", "regrets"],
  hold_due: ["close-call regret", "close-call regrets"],
};

const TITLE: Record<Group, string> = {
  invite: "Send interview invites",
  hold: "Send hold notes",
  regret: "Send regrets",
  hold_due: "Send close-call regrets",
};

// Bulk send (§11.2 #9). Nothing goes without Arjun's explicit "Yes, send":
// he picks who's included, can add one message for everyone, ticks the
// consent box, and each email still waits out its undo window.
export default function BulkSend({ group, label, count, undoMinutes, plain }: { group: Group; label: string; count: number; undoMinutes: number; plain?: boolean }) {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<"preparing" | "confirm" | "sending" | "done">("preparing");
  const [prep, setPrep] = useState<Prepared | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [consent, setConsent] = useState(false);
  const [result, setResult] = useState<{ queued: number; sendAt: string | null; skipped: { name: string; reason: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) ref.current?.showModal();
  }, [open]);

  const begin = async () => {
    setOpen(true);
    setPhase("preparing");
    setPrep(null);
    setResult(null);
    setError(null);
    setNote("");
    setConsent(false);
    try {
      const p = await prepare(group);
      setPrep(p);
      setPicked(new Set(p.ready.map((r) => r.emailId)));
      setPhase("confirm");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("confirm");
    }
  };

  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      setConsent(false); // a changed list needs a fresh yes
      return n;
    });

  const confirm = async () => {
    if (!prep || !consent || !picked.size) return;
    setPhase("sending");
    const r = await sendBulk([...picked], note, true);
    setResult(r);
    setPhase("done");
    router.refresh();
  };

  const close = () => {
    if (phase === "preparing" || phase === "sending") return;
    ref.current?.close();
    setOpen(false);
    router.refresh();
  };

  const n = picked.size;
  const [one, many] = NOUN[group];
  const noun = n === 1 ? one : many;

  return (
    <>
      <button className="btn btn-primary btn-small" onClick={begin} disabled={count === 0}>{plain ? label : `✉ ${label} (${count})`}</button>
      {open && (
        <dialog ref={ref} className="modal" onCancel={(e) => { e.preventDefault(); close(); }} aria-labelledby={`bulk-${group}`}>
          <div className="modal-head">
            <h2 id={`bulk-${group}`}>{TITLE[group]}</h2>
            <button className="close-x" onClick={close} aria-label="Close" disabled={phase === "preparing" || phase === "sending"}>×</button>
          </div>
          <div className="modal-body">
            {phase === "preparing" && (
              <>
                <div className="progress"><div style={{ width: "60%" }} /></div>
                <div className="small muted">Writing a personal draft for each person… This can take a minute. Nothing is sent yet.</div>
              </>
            )}
            {error && <div className="error">{error}</div>}
            {prep?.configProblem && <div className="error">{prep.configProblem}</div>}

            {phase === "confirm" && prep && (
              <>
                {prep.ready.length > 0 ? (
                  <div className="field">
                    <div className="pick-head">
                      <strong>Who gets one ({n} of {prep.ready.length})</strong>
                      <span className="small">
                        <button className="btn-link" onClick={() => { setPicked(new Set(prep.ready.map((r) => r.emailId))); setConsent(false); }}>All</button>
                        {" · "}
                        <button className="btn-link" onClick={() => { setPicked(new Set()); setConsent(false); }}>None</button>
                      </span>
                    </div>
                    <div className="pick-list">
                      {prep.ready.map((r) => (
                        <label key={r.emailId} className="pick">
                          <input type="checkbox" checked={picked.has(r.emailId)} onChange={() => toggle(r.emailId)} />
                          <span>{r.name}</span>
                        </label>
                      ))}
                    </div>
                    <span className="small muted">Each email is already personalised. To read or edit one first, close this and open the candidate.</span>
                  </div>
                ) : (
                  <div className="summary-line">No {many} are ready to send.</div>
                )}

                {prep.ready.length > 0 && (
                  <div className="field">
                    <label htmlFor={`gnote-${group}`}><strong>Add a message to every email</strong> <span className="muted small">(optional)</span></label>
                    <textarea
                      id={`gnote-${group}`}
                      rows={3}
                      value={note}
                      onChange={(e) => { setNote(e.target.value); setConsent(false); }}
                      placeholder={group === "invite" ? "e.g. I'm in Mumbai all of next week if you'd rather meet in person." : "e.g. We'll be hiring again in the new year."}
                    />
                    <span className="small muted">Goes in as its own paragraph above your sign-off, after any note you&apos;ve already written for that person.</span>
                  </div>
                )}

                {prep.skipped.length > 0 && (
                  <div className="summary-group">
                    <h3>Not included ({prep.skipped.length})</h3>
                    <ul className="small">
                      {prep.skipped.map((s) => (
                        <li key={s.candidateId}>
                          <Link href={`/?tab=todo&c=${s.candidateId}&view=email`} onClick={close} scroll={false}>{s.name}</Link>: {s.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {prep.ready.length > 0 && (
                  <label className="consent consent-box">
                    <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} disabled={!n || !!prep.configProblem} />
                    <span>
                      <strong>Yes, send {n} {noun}.</strong> Each waits {undoMinutes} minutes in the Outbox before it goes, so you can still undo it.
                    </span>
                  </label>
                )}
              </>
            )}

            {phase === "sending" && <div className="small muted">Queueing…</div>}

            {phase === "done" && result && (
              <>
                <div className="summary-line">
                  {result.queued} {result.queued === 1 ? one : many} queued
                  {result.sendAt ? `, going out at ${new Date(result.sendAt).toLocaleTimeString("en-IN", { timeStyle: "short" })}` : ""}.
                </div>
                {result.queued > 0 && <div className="small">Changed your mind? <Link href="/outbox">Undo from the Outbox</Link>.</div>}
                {result.skipped.length > 0 && (
                  <>
                    <div className="small"><strong>Not sent:</strong></div>
                    <ul className="small">{result.skipped.map((s, i) => <li key={i}>{s.name ? `${s.name}: ` : ""}{s.reason}</li>)}</ul>
                  </>
                )}
              </>
            )}
          </div>
          <div className="modal-foot">
            {phase === "confirm" && (
              <>
                <button className="btn" onClick={close}>Cancel</button>
                <button className="btn btn-primary" onClick={confirm} disabled={!consent || !n || !!prep?.configProblem}>
                  Send {n} {noun}
                </button>
              </>
            )}
            {phase === "done" && <button className="btn btn-primary" onClick={close}>Done</button>}
          </div>
        </dialog>
      )}
    </>
  );
}
