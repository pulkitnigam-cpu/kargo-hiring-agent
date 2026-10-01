import { test } from "node:test";
import assert from "node:assert/strict";
import { stageOf } from "./stage";

const base = { lastEmail: null, holdDeadline: null, needsReview: false, reviewed: false };
const at = new Date(Date.UTC(2026, 8, 29, 8));

test("each status gets one plain label, and only real to-dos need action", () => {
  assert.deepEqual(
    [stageOf({ ...base, status: "SELECTED" }).label, stageOf({ ...base, status: "SELECTED" }).needsAction, stageOf({ ...base, status: "SELECTED" }).action],
    ["Invite to send", true, "Send invite"],
  );
  assert.equal(stageOf({ ...base, status: "HOLD" }).label, "Hold note to send");
  assert.equal(stageOf({ ...base, status: "REJECTED" }).label, "Regret to send");
  assert.equal(stageOf({ ...base, status: "PARSED" }).label, "Scoring…");
  assert.equal(stageOf({ ...base, status: "NEEDS_MANUAL_LOOK" }).needsAction, true);
});

test("sent emails read as done, with their date", () => {
  const inv = stageOf({ ...base, status: "INVITED", lastEmail: { type: "invite", status: "delivered", at } });
  assert.equal(inv.label, "Invited 29 Sept");
  assert.equal(inv.needsAction, false);
  assert.equal(inv.sentLabel, "Invite sent 29 Sept");
  const reg = stageOf({ ...base, status: "REGRET_SENT", lastEmail: { type: "regret_clear", status: "delivered", at } });
  assert.equal(reg.label, "Regret sent 29 Sept");
});

test("holds: waiting until the deadline, then a decision is due", () => {
  const later = new Date(Date.now() + 3 * 86_400_000);
  assert.match(stageOf({ ...base, status: "HOLD_NOTIFIED", holdDeadline: later }).label, /^On hold until /);
  const due = stageOf({ ...base, status: "HOLD_NOTIFIED", holdDeadline: new Date(Date.now() - 1000) });
  assert.deepEqual([due.label, due.needsAction, due.action], ["Hold: decide now", true, "Decide"]);
});

test("queued, flagged and bounced states", () => {
  assert.equal(stageOf({ ...base, status: "SELECTED", lastEmail: { type: "invite", status: "queued", at } }).label, "Invite queued");
  const f = stageOf({ ...base, status: "REJECTED", needsReview: true });
  assert.deepEqual([f.label, f.action], ["Regret to send: check first", "Check"]);
  assert.equal(stageOf({ ...base, status: "REJECTED", needsReview: true, reviewed: true }).action, "Send regret");
  assert.equal(stageOf({ ...base, status: "INVITED", lastEmail: { type: "invite", status: "bounced", at } }).label, "Invite bounced");
});
