import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseName, extractContact, nameFromFilename } from "./extract";
import { parseDate, parseManifest } from "./manifest";
import { resolveRole, roleFromCvText, roleFromPath } from "./roleTag";

test("contact line with pipes (Lavanya's CV format)", () => {
  const text = "Lavanya Iyer\n\nlavanya.iyer.pm@gmail.com  |  +91 98876 12340  |  Bengaluru  |  linkedin.com/in/lavanyaiyer\n\nSummary\n...";
  assert.deepEqual(extractContact(text), {
    name: "Lavanya Iyer",
    email: "lavanya.iyer.pm@gmail.com",
    phone: "+91 98876 12340",
    location: "Bengaluru",
  });
});

test("location keeps the state when given", () => {
  const text = "Vikram Nair\nvikramnair.pm@gmail.com  |  +91 96321 88740  |  Bengaluru, Karnataka\n";
  assert.equal(extractContact(text).location, "Bengaluru, Karnataka");
});

test("upper-case names are title-cased; missing name falls back to file name", () => {
  assert.equal(extractContact("PRIYA SHARMA\npriya@x.com\n").name, "Priya Sharma");
  assert.equal(extractContact("Summary\nno name here\n", "cv_07_lavanya_iyer.docx").name, "Lavanya Iyer");
  assert.equal(nameFromFilename("Resume_Karan_Mehta_SPM_final.pdf"), "Karan Mehta");
});

test("role from folder or file name", () => {
  assert.equal(roleFromPath("applications/SPM/karan.pdf"), "SPM");
  assert.equal(roleFromPath("applications/PM/priya.pdf"), "PM");
  assert.equal(roleFromPath("priya_sharma_pm.docx"), "PM");
  assert.equal(roleFromPath("Senior Product Manager - Anil.pdf"), "SPM");
  assert.equal(roleFromPath("cv_07_lavanya_iyer.docx"), null);
  assert.equal(roleFromPath("sample.pm"), null); // extension alone doesn't count
});

test("role from an 'Applying for' line in the CV", () => {
  assert.equal(roleFromCvText("Anil Rao\nApplying for: Senior Product Manager\n"), "SPM");
  assert.equal(roleFromCvText("Anil Rao\nPosition applied for: Product Manager\n"), "PM");
  assert.equal(roleFromCvText("Applied machine learning to route planning"), null);
});

test("role priority: CSV > file name > CV text > batch", () => {
  const cv = "Applying for: Product Manager";
  assert.deepEqual(resolveRole("x/SPM/a.pdf", cv, { role: "PM", appliedDate: null, isAugustContact: false }, null), { role: "PM", source: "manifest" });
  assert.deepEqual(resolveRole("x/SPM/a.pdf", cv, undefined, "PM"), { role: "SPM", source: "filename" });
  assert.deepEqual(resolveRole("a.pdf", cv, undefined, "SPM"), { role: "PM", source: "cv" });
  assert.deepEqual(resolveRole("a.pdf", "", undefined, "SPM"), { role: "SPM", source: "batch" });
  assert.deepEqual(resolveRole("a.pdf", "", undefined, null), { role: null, source: null });
});

test("manifest CSV", () => {
  const m = parseManifest('﻿Filename,Role,Applied Date,August Contact\n"priya, final.pdf",PM,14/07/2026,yes\nkaran.docx,Senior PM,2026-08-02,no\nbad.pdf,,31/31/2026,\n');
  assert.equal(m.rows.size, 3);
  assert.deepEqual(m.rows.get("priya, final.pdf"), { role: "PM", appliedDate: new Date(Date.UTC(2026, 6, 14)), isAugustContact: true });
  assert.equal(m.rows.get("karan.docx")?.role, "SPM");
  assert.equal(m.errors.length, 1);
  assert.equal(parseManifest("name,role\nx,PM").errors.length, 1);
});

test("dates: ISO and dd/mm/yyyy", () => {
  assert.deepEqual(parseDate("2026-08-05"), new Date(Date.UTC(2026, 7, 5)));
  assert.deepEqual(parseDate("05/08/2026"), new Date(Date.UTC(2026, 7, 5)));
  assert.equal(parseDate("nope"), null);
});

test("small PDFs parse even when Node pools their Buffer", async () => {
  const { readFileSync } = await import("node:fs");
  const { parseCv } = await import("./parse");
  const data = readFileSync("fixtures/neha_kulkarni.pdf"); // ~1 KB: lives in the shared pool
  for (let i = 0; i < 3; i++) {
    const r = await parseCv("neha_kulkarni.pdf", data);
    assert.ok(r.ok, r.ok ? "" : r.reason);
  }
});

test("section headings are never names; the file name wins unless the text agrees", () => {
  const nl = String.fromCharCode(10);
  const cv = (...lines: string[]) => lines.join(nl);
  assert.equal(extractContact(cv("Professional Work Experience", "Ernst & Young | Summer Intern"), "06_kavya_patel.pdf").name, "Kavya Patel");
  assert.equal(extractContact(cv("PROFESSIONAL SUMMARY", "AI-driven product leader"), "11_tarun_joseph.pdf").name, "Tarun Joseph");
  assert.equal(extractContact(cv("SUMMARY", "CORE SKILLS", "Pune / Mumbai"), "21_aryan_kulkarni.pdf").name, "Aryan Kulkarni");
  assert.equal(extractContact(cv("Scholastic Achievements and Research"), "x.pdf").name, null);
  // The CV's own spelling wins when it matches the file name.
  assert.equal(extractContact(cv("Rohan K. Mehta", "rohan@x.com"), "01_rohan_mehta.pdf").name, "Rohan K. Mehta");
  assert.equal(chooseName("Priya Sharma", "resume"), "Priya Sharma");
  assert.equal(chooseName(null, "Kavya Patel"), "Kavya Patel");
});
