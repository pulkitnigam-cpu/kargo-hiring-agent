"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";
import { loadDraft, resend, saveDraftEdit, saveNote, sendOne, undo, type DraftView } from "../email-actions";
import Countdown from "./Countdown";

const TYPE: Record<string, string> = { invite: "Invite", hold: "Hold note", regret_close: "Regret", regret_clear: "Regret" };
const VERB: Record<string, string> = { invite: "invite", hold: "hold note", regret_close: "regret", regret_clear: "regret" };
const SENT: Record<string, { label: string; tone: string }> = {
  delivered: { label: "delivered", tone: "good" },
  sent: { label: "sent", tone: "good" },
  bounced: { label: "bounced", tone: "bad" },
  failed: { label: "failed", tone: "bad" },
  cancelled: { label: "cancelled", tone: "muted" },
};
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "";

// The Email view: what was sent (one line each), then the email due next.
export default function DraftEmail({ candidateId, name, nextHref }: { candidateId: string; name: string; nextHref?: string | null }) {
  const router = useRouter();
  const [v, setV] = useState<DraftView | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [note, setNoteText] = useState("");
  const [editing, setEditing] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [consent, setConsent] = useState(false);
  const [openSent, setOpenSent] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [justSent, setJustSent] = useState(false);
  const [pending, start] = useTransition();

  const refresh = useCallback(async () => {
    const d = await loadDraft(candidateId);
    setV(d);
    setSubject(d.email?.subject ?? "");
    setBody(d.email?.body ?? "");
    setNoteText(d.email?.customNote ?? "");
    setNoteOpen(!!d.email?.customNote);
    setConsent(false);
  }, [candidateId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!v) return <p className="muted small">Loading…</p>;

  const e = v.email;
  const first = name.split(" ")[0];
  const blocked = !!e && e.checks.length > 0;
  const editDirty = !!e && (subject !== e.subject || body !== e.body);
  const noteDirty = !!e && note.trim() !== (e.customNote ?? "");
  const act = (fn: () => Promise<void>) => start(async () => { setMsg(null); await fn(); await refresh(); router.refresh(); });

  const save = () => act(async () => {
    if (!e) return;
    const r = await saveDraftEdit(e.id, subject, body);
    if (r.ok) setEditing(false);
    if (!r.ok || r.problems.length) setMsg({ ok: false, text: r.error ?? r.problems[0] });
  });
  const applyNote = () => act(async () => {
    if (!e) return;
    const r = await saveNote(e.id, note);
    if (!r.ok || r.problems.length) setMsg({ ok: false, text: r.error ?? r.problems[0] });
  });
  const approveAsIs = () => act(async () => {
    if (!e) return;
    const r = await saveDraftEdit(e.id, e.subject, e.body);
    if (r.problems.length) setMsg({ ok: false, text: r.problems[0] });
  });
  const send = () => act(async () => {
    if (!e || !consent) return;
    const r = await sendOne(e.id, true);
    if (r.queued) setJustSent(true);
    else setMsg({ ok: false, text: r.skipped[0]?.reason ?? "Not sent." });
  });
  const doUndo = () => act(async () => { if (e) { const r = await undo(e.id); setJustSent(false); if (!r.ok) setMsg({ ok: false, text: r.error ?? "Couldn't undo." }); } });
  const again = (id: string) => act(async () => { const r = await resend(id); if (!r.queued) setMsg({ ok: false, text: r.skipped[0]?.reason ?? "Not queued." }); });

  return (
    <div className="mail">
      {v.history.filter((h) => h.status !== "cancelled").map((h) => {
        const st = SENT[h.status] ?? { label: h.status, tone: "muted" };
        const open = openSent === h.id;
        return (
          <div key={h.id} className={`mail-sent mail-${st.tone}`}>
            <button className="mail-sent-line" onClick={() => setOpenSent(open ? null : h.id)} aria-expanded={open}>
              <span className="mail-icon" aria-hidden>{st.tone === "good" ? "✓" : st.tone === "bad" ? "!" : "–"}</span>
              <span className="mail-what"><strong>{TYPE[h.type] ?? h.type}</strong> {st.label} · {when(h.sentAt)}</span>
              <span className="small muted">{open ? "Hide" : "View"}</span>
            </button>
            {open && (
              <div className="mail-view">
                <div className="small muted">To {h.toAddress ?? "–"} · {h.subject}</div>
                <pre className="mail-body">{h.body}</pre>
                {["sent", "delivered", "bounced", "failed"].includes(h.status) && (
                  <div><button className="btn btn-small" onClick={() => again(h.id)} disabled={pending}>Send again</button></div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {e && e.status !== "draft" && (
        <div className="mail-queued">
          <span>
            <strong>{TYPE[e.type]}</strong> queued ·{" "}
            {e.sendAfter && e.status === "queued" ? <Countdown until={e.sendAfter} onDone={() => setTimeout(() => void refresh(), 12_000)} /> : "sending…"}
          </span>
          {e.status === "queued" && <button className="btn btn-small" onClick={doUndo} disabled={pending}>Undo</button>}
          {justSent && nextHref && <Link className="btn btn-small btn-primary" href={nextHref} scroll={false}>Next to send →</Link>}
        </div>
      )}

      {e && e.status === "draft" && (
        <div className="mail-draft">
          {editing ? (
            <div className="mail-edit">
              <input type="text" value={subject} onChange={(x) => setSubject(x.target.value)} aria-label="Subject" disabled={pending} />
              <textarea rows={12} value={body} onChange={(x) => setBody(x.target.value)} aria-label="Email" disabled={pending} />
              <div className="row-actions">
                <button className="btn btn-small btn-primary" onClick={save} disabled={!editDirty || pending}>Save</button>
                <button className="btn btn-small" onClick={() => { setEditing(false); setSubject(e.subject); setBody(e.body); }} disabled={pending}>Cancel</button>
              </div>
            </div>
          ) : (
            <div className="mail-paper">
              <div className="mail-paper-head">
                <span className="mail-subject">{e.subject}</span>
                <button className="btn-link small" onClick={() => setEditing(true)}>Edit</button>
              </div>
              <pre className="mail-body">{e.body}</pre>
            </div>
          )}

          {e.checks.map((c) => (
            <div key={c} className="mail-block small">
              <span>✗ {c.replace(" Check it against the quotes, or edit it.", "")}</span>
              {/may not match the CV/.test(c) && <button className="btn-link small" onClick={approveAsIs} disabled={pending}>It&apos;s fine</button>}
            </div>
          ))}

          {!editing && (
            noteOpen ? (
              <div className="mail-note">
                <textarea rows={2} value={note} placeholder="Your message (goes above your sign-off)" onChange={(x) => setNoteText(x.target.value)} disabled={pending} aria-label="Your message" />
                {noteDirty && (
                  <div><button className="btn btn-small" onClick={applyNote} disabled={pending}>{note.trim() ? "Add to email" : "Remove message"}</button></div>
                )}
              </div>
            ) : (
              <button className="btn-link small add-note" onClick={() => setNoteOpen(true)}>+ Add your message</button>
            )
          )}

          {!editing && (
            <div className="mail-send">
              <label className="consent">
                <input type="checkbox" checked={consent} onChange={(x) => setConsent(x.target.checked)} disabled={blocked || noteDirty || !!v.configProblem || pending} />
                <span>Yes, send this {VERB[e.type]} to {first}</span>
              </label>
              <button className="btn btn-primary" onClick={send} disabled={!consent || blocked || noteDirty || !!v.configProblem || pending}>Send</button>
            </div>
          )}
          {v.testMode && !editing && <div className="small muted">Test mode: it goes to {v.testRecipient ?? "you"}. Undo for {v.undoMinutes} min.</div>}
          {v.configProblem && <div className="small bad-text">{v.configProblem}</div>}
        </div>
      )}

      {!e && v.history.length === 0 && <p className="small muted">{v.note ?? "No email needed right now."}</p>}
      {!e && v.history.length > 0 && nextHref && (
        <div><Link className="btn btn-small" href={nextHref} scroll={false}>Next to send →</Link></div>
      )}
      {msg && <div className={`small ${msg.ok ? "good-text" : "bad-text"}`}>{msg.text}</div>}
    </div>
  );
}
