"use client";

import { useState, useTransition } from "react";
import { updateDetails } from "../actions";

// Facts the upload can't know: applied date (drives the delay apology), the
// August "let's chat" flag, and a missing email (the only fix that releases a
// readable CV from Needs manual look).
export default function DetailsForm({
  id,
  appliedDate,
  isAugustContact,
  email,
}: {
  id: string;
  appliedDate: string; // yyyy-mm-dd
  isAugustContact: boolean;
  email: string | null;
}) {
  const [date, setDate] = useState(appliedDate);
  const [august, setAugust] = useState(isAugustContact);
  const [mail, setMail] = useState(email ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const dirty = date !== appliedDate || august !== isAugustContact || mail.trim() !== (email ?? "");

  const save = () =>
    start(async () => {
      const res = await updateDetails(id, {
        appliedDate: date !== appliedDate ? date : undefined,
        isAugustContact: august !== isAugustContact ? august : undefined,
        email: mail.trim() !== (email ?? "") ? mail : undefined,
      });
      setMsg(res.ok ? { ok: true, text: "Saved." } : { ok: false, text: res.error ?? "Couldn't save." });
    });

  return (
    <div className="details-form">
      <div className="row2">
        <div className="field">
          <label htmlFor={`applied-${id}`}>Applied on</label>
          <input id={`applied-${id}`} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`email-${id}`}>Email</label>
          <input id={`email-${id}`} type="text" value={mail} placeholder="name@example.com" onChange={(e) => setMail(e.target.value)} />
        </div>
      </div>
      <label className="check small">
        <input type="checkbox" checked={august} onChange={(e) => setAugust(e.target.checked)} />
        <span>I told this candidate &quot;let&apos;s chat&quot; in August</span>
      </label>
      <div className="popover-actions" style={{ justifyContent: "flex-start" }}>
        <button className="btn btn-small" onClick={save} disabled={!dirty || pending}>{pending ? "Saving…" : "Save details"}</button>
        {msg && <span className="small" style={{ color: msg.ok ? "var(--good)" : "var(--bad)" }}>{msg.text}</span>}
      </div>
    </div>
  );
}
