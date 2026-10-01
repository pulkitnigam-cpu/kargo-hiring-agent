// Builds fixtures/test_applications.zip for checking Bulk upload (Phase 1
// acceptance: accurate summary, corrupt file lands in "Needs manual look").
// Uses the 8 past-hire CVs from data/hires plus deliberately awkward files.
const fs = require("fs");
const path = require("path");
const JSZip = require("jszip");

const root = path.join(__dirname, "..");
const hire = (f) => fs.readFileSync(path.join(root, "data", "hires", f));

// A small but real text PDF, built by hand so the fixture needs no PDF tool.
function makePdf(lines) {
  const content = ["BT", "/F1 11 Tf", "14 TL", "50 780 Td"]
    .concat(lines.map((l) => `(${l.replace(/[()\\]/g, "\\$&")}) Tj T*`))
    .concat("ET")
    .join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const pdfCv = makePdf([
  "Neha Kulkarni",
  "neha.kulkarni@example.com | +91 98200 11223 | Mumbai",
  "Applying for: Senior Product Manager",
  "Experience",
  "Senior Product Manager, Freightline Systems, Mumbai, 2019 - Present",
  "Owned carrier and ERP integrations end to end for 40 freight forwarder customers.",
  "Killed a customs-portal connector after usage data showed 3 percent adoption.",
  "Operations Executive, Allcargo Logistics, JNPT, 2016 - 2019",
  "Ran daily import documentation and carrier coordination for 150 shipments a month.",
]);

async function main() {
  const inner = new JSZip();
  inner.file("late_additions/neha_kulkarni.pdf", pdfCv);

  const zip = new JSZip();
  const a = zip.folder("applications");
  a.file("PM/cv_07_lavanya_iyer.docx", hire("cv_07_lavanya_iyer.docx"));
  a.file("PM/cv_03_vikram_nair.docx", hire("cv_03_vikram_nair.docx"));
  a.file("SPM/cv_01_rohan_desai.docx", hire("cv_01_rohan_desai.docx"));
  for (const f of ["cv_02_sunita_krishnamurthy.docx", "cv_04_aditya_shetty.docx", "cv_05_preetham_rao.docx", "cv_06_meghna_tiwari.docx", "cv_08_rahul_bose.docx"]) {
    a.file(f, hire(f));
  }
  a.file("cv_07_lavanya_iyer (copy).docx", hire("cv_07_lavanya_iyer.docx")); // duplicate
  a.file("broken_cv.pdf", Buffer.from("%PDF-1.4\nthis is not really a pdf\n")); // corrupt
  a.file("old_format_cv.doc", Buffer.from("fake legacy word file")); // unsupported
  a.file(".DS_Store", Buffer.from("junk"));
  a.file("~$cv_02_sunita_krishnamurthy.docx", Buffer.from("word lock file"));
  zip.file("__MACOSX/applications/._cv_01_rohan_desai.docx", Buffer.from("junk"));
  a.file(
    "manifest.csv",
    "filename,role,applied_date,august_contact\n" +
      "cv_04_aditya_shetty.docx,SPM,2026-08-10,yes\n" +
      "cv_02_sunita_krishnamurthy.docx,PM,15/07/2026,no\n" +
      "cv_06_meghna_tiwari.docx,,2026-09-02,\n",
  );
  a.file("more.zip", await inner.generateAsync({ type: "nodebuffer" }));

  const outDir = path.join(root, "fixtures");
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, "test_applications.zip");
  fs.writeFileSync(out, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  fs.writeFileSync(path.join(outDir, "neha_kulkarni.pdf"), pdfCv);
  console.log("Wrote", path.relative(root, out));
  console.log("Expected: 12 uploaded · 9 ready · 2 need manual look · 1 duplicate skipped");
}

main();
