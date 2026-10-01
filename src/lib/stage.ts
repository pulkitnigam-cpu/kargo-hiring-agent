import { CANDIDATE_STATUS } from "./constants";

// One plain-language status per candidate, combining the decision and the
// email: what has happened, and whether anything is waiting on Arjun.

const S = CANDIDATE_STATUS;

export type Tone = "action" | "good" | "warn" | "bad" | "muted" | "info";

export type Stage = {
  label: string; // "Invite to send", "Invited", "On hold until 5 Oct"…
  tone: Tone;
  needsAction: boolean; // shows in the To do tab
  action: string; // the row button: "Send invite", "Check", "Decide", "View"
  emailDue: "invite" | "hold" | "regret" | null; // which email is waiting to go
  sentLabel: string | null; // "Invite sent 29 Sep"
};

export type StageInput = {
  status: string;
  lastEmail: { type: string; status: string; at: Date | null } | null;
  holdDeadline: Date | null;
  needsReview: boolean; // ⚠ evidence flag
  reviewed: boolean;
};

const day = (d: Date | null) => (d ? d.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }) : "");

const EMAIL_NAME: Record<string, string> = { invite: "Invite", hold: "Hold note", regret_close: "Regret", regret_clear: "Regret" };

export function stageOf(c: StageInput, now = new Date()): Stage {
  const queued = c.lastEmail && (c.lastEmail.status === "queued" || c.lastEmail.status === "sending") ? c.lastEmail : null;
  const bounced = c.lastEmail && (c.lastEmail.status === "bounced" || c.lastEmail.status === "failed") ? c.lastEmail : null;
  const sent = c.lastEmail && ["sent", "delivered"].includes(c.lastEmail.status) ? c.lastEmail : null;
  const flagged = c.needsReview && !c.reviewed;
  const sentLabel = sent ? `${EMAIL_NAME[sent.type] ?? "Email"} sent ${day(sent.at)}` : null;

  const due = (label: string, email: Stage["emailDue"], verb: string): Stage =>
    queued
      ? { label: `${EMAIL_NAME[queued.type] ?? "Email"} queued`, tone: "info", needsAction: false, action: "View", emailDue: null, sentLabel }
      : flagged
        ? { label: `${label}: check first`, tone: "action", needsAction: true, action: "Check", emailDue: email, sentLabel }
        : { label, tone: "action", needsAction: true, action: verb, emailDue: email, sentLabel };

  if (bounced) {
    return { label: `${EMAIL_NAME[bounced.type] ?? "Email"} bounced`, tone: "bad", needsAction: true, action: "Fix", emailDue: null, sentLabel };
  }

  switch (c.status) {
    case S.PARSED:
    case S.UPLOADED:
      return { label: "Scoring…", tone: "muted", needsAction: false, action: "View", emailDue: null, sentLabel };
    case S.NEEDS_MANUAL_LOOK:
      return { label: "Can't read CV", tone: "bad", needsAction: true, action: "Open", emailDue: null, sentLabel };
    case S.SELECTED:
      return due("Invite to send", "invite", "Send invite");
    case S.HOLD:
      return due("Hold note to send", "hold", "Send hold note");
    case S.REJECTED:
      return due("Regret to send", "regret", "Send regret");
    case S.INVITED:
      return { label: `Invited ${day(sent?.at ?? null)}`.trim(), tone: "good", needsAction: false, action: "View", emailDue: null, sentLabel };
    case S.HOLD_NOTIFIED:
      if (c.holdDeadline && c.holdDeadline <= now) {
        return { label: "Hold: decide now", tone: "action", needsAction: true, action: "Decide", emailDue: null, sentLabel };
      }
      return { label: `On hold until ${day(c.holdDeadline)}`.trim(), tone: "warn", needsAction: false, action: "View", emailDue: null, sentLabel };
    case S.REGRET_SENT:
      return { label: `Regret sent ${day(sent?.at ?? null)}`.trim(), tone: "muted", needsAction: false, action: "View", emailDue: null, sentLabel };
    default:
      return { label: c.status, tone: "muted", needsAction: false, action: "View", emailDue: null, sentLabel };
  }
}
