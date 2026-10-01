import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { summarise, type HireResult } from "./calibration";
import { absPath, storageRoot } from "./storage";
import { retentionDays } from "./retention";

const hire = (name: string, rating: HireResult["rating"], p1: number, pm: number): HireResult => ({
  file: `${name}.docx`, name, role: "x", rating, totals: { PM: pm, SPM: pm },
  scores: { P1: p1, P2: 2, P3: 2, P4: 2, P5: 2, J1: 2, J2: 2, J3: 2, J4: 2 }, unstable: [],
});

test("calibration: criterion gaps and separation", () => {
  const r = summarise([hire("a", "Exceeds", 4, 80), hire("b", "Exceeds", 4, 70), hire("c", "Meets", 0, 40), hire("d", "Below", 1, 30)]);
  assert.equal(r.gaps[0].id, "P1");
  assert.equal(r.gaps[0].gap, 3.5); // 4 vs 0.5
  assert.equal(r.gaps.find((g) => g.id === "J1")!.gap, 0);
  assert.equal(r.lowestExceedsPm, 70);
  assert.equal(r.highestWeakerPm, 40);
});

test("storage paths: new relative paths and legacy storage/ paths", () => {
  delete process.env.STORAGE_DIR;
  assert.equal(absPath("cvs/abc.pdf"), path.join(process.cwd(), "storage", "cvs", "abc.pdf"));
  assert.equal(absPath("storage/cvs/abc.pdf"), path.join(process.cwd(), "storage", "cvs", "abc.pdf"));
  process.env.STORAGE_DIR = "/data/storage";
  assert.equal(storageRoot(), "/data/storage");
  assert.equal(absPath("cvs/abc.pdf"), path.join("/data/storage", "cvs", "abc.pdf"));
  delete process.env.STORAGE_DIR;
});

test("retention defaults to 180 days", () => {
  delete process.env.RETENTION_DAYS;
  assert.equal(retentionDays(), 180);
  process.env.RETENTION_DAYS = "30";
  assert.equal(retentionDays(), 30);
  delete process.env.RETENTION_DAYS;
});
