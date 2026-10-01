import { test } from "node:test";
import assert from "node:assert/strict";
import { bandOfStatus, neighbourBand } from "./decisions";

test("post-send statuses still belong to their band", () => {
  assert.equal(bandOfStatus("SELECTED"), "SELECTED");
  assert.equal(bandOfStatus("INVITED"), "SELECTED");
  assert.equal(bandOfStatus("HOLD_NOTIFIED"), "HOLD");
  assert.equal(bandOfStatus("REGRET_SENT"), "REJECTED");
  assert.equal(bandOfStatus("PARSED"), null);
  assert.equal(bandOfStatus("NEEDS_MANUAL_LOOK"), null);
});

test("↑ / ↓ move one band and stop at the ends", () => {
  assert.equal(neighbourBand("REJECTED", "up"), "HOLD");
  assert.equal(neighbourBand("HOLD", "up"), "SELECTED");
  assert.equal(neighbourBand("SELECTED", "up"), null);
  assert.equal(neighbourBand("SELECTED", "down"), "HOLD");
  assert.equal(neighbourBand("REJECTED", "down"), null);
});
