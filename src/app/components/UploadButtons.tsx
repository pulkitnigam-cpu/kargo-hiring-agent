"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { UploadSummary } from "@/lib/ingest/ingest";
import type { StartResult } from "@/lib/scoring/queue";

type UploadResponse = UploadSummary & { scoring: StartResult | null };

type Mode = "single" | "bulk";
type Picked = { file: File; path: string };

const ACCEPT_BULK = ".pdf,.docx,.doc,.zip,.csv";
const ACCEPT_SINGLE = ".pdf,.docx";
const CSV_TEMPLATE = "filename,role,applied_date,august_contact\npriya_sharma.pdf,PM,2026-07-14,no\nkaran_mehta.docx,SPM,2026-08-02,yes\n";

export default function UploadButtons() {
  const [mode, setMode] = useState<Mode | null>(null);
  return (
    <>
      <button className="btn btn-primary" onClick={() => setMode("bulk")}>Upload CVs</button>
      {mode && <UploadDialog key={mode} mode={mode} onClose={() => setMode(null)} />}
    </>
  );
}

function UploadDialog({ mode, onClose }: { mode: Mode; onClose: () => void }) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const [picked, setPicked] = useState<Picked[]>([]);
  const [role, setRole] = useState("");
  const [appliedDate, setAppliedDate] = useState("");
  const [august, setAugust] = useState(false);
  const [over, setOver] = useState(false);
  const [phase, setPhase] = useState<"pick" | "uploading" | "processing" | "done">("pick");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<UploadResponse | null>(null);

  const busy = phase === "uploading" || phase === "processing";

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  const close = useCallback(() => {
    if (busy) return;
    if (summary) router.refresh();
    onClose();
  }, [busy, summary, router, onClose]);

  const addFiles = useCallback(
    (items: Picked[]) => {
      setError(null);
      setPicked((prev) => {
        if (mode === "single") return items.slice(0, 1);
        const seen = new Set(prev.map((p) => p.path));
        return [...prev, ...items.filter((p) => !seen.has(p.path))];
      });
    },
    [mode],
  );

  const onInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? []);
    addFiles(list.map((file) => ({ file, path: file.webkitRelativePath || file.name })));
    e.target.value = "";
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setOver(false);
    const entries = Array.from(e.dataTransfer.items)
      .map((it) => it.webkitGetAsEntry?.())
      .filter((x): x is FileSystemEntry => !!x);
    if (entries.length) addFiles(await readEntries(entries));
    else addFiles(Array.from(e.dataTransfer.files).map((file) => ({ file, path: file.name })));
  };

  // Vercel takes at most 4.5 MB per request, so zips are unpacked here in the
  // browser and the files go up in small batches. The server checks every
  // batch for duplicates against what's already stored, so splitting is safe.
  const submit = async () => {
    if (!picked.length) return;
    setPhase("uploading");
    setProgress(0);
    setError(null);
    try {
      const files = await expandZips(picked);
      const csvs = files.filter((f) => /\.csv$/i.test(f.path));
      const cvs = files.filter((f) => !/\.csv$/i.test(f.path));
      const tooBig = cvs.filter((f) => f.file.size > MAX_FILE);
      const batches = toBatches(cvs.filter((f) => f.file.size <= MAX_FILE));
      if (!batches.length) throw new Error(tooBig.length ? "Every file is over 4 MB. Save them smaller (e.g. as PDF) and try again." : "No CV files found in what you picked.");

      const parts: UploadResponse[] = [];
      for (let i = 0; i < batches.length; i++) {
        const form = new FormData();
        for (const p of [...batches[i], ...csvs]) {
          form.append("files", p.file, p.file.name);
          form.append("paths", p.path);
        }
        form.append("mode", mode);
        form.append("role", role);
        if (appliedDate) form.append("appliedDate", appliedDate);
        if (mode === "single" && august) form.append("august", "true");
        const res = await fetch("/api/upload", { method: "POST", body: form });
        const body = await res.json().catch(() => null);
        if (!res.ok || !body) throw new Error(body?.error ?? `Upload failed (HTTP ${res.status}) after ${parts.length} of ${batches.length} batches.`);
        parts.push(body as UploadResponse);
        setProgress(Math.round(((i + 1) / batches.length) * 100));
        if (i === batches.length - 1) setPhase("processing");
      }
      setSummary(mergeSummaries(parts, tooBig.map((f) => f.path)));
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed. Try again.");
      setPhase("pick");
    }
  };

  const totalBytes = picked.reduce((n, p) => n + p.file.size, 0);
  const title = mode === "bulk" ? "Upload CVs" : "Upload a CV";

  return (
    <dialog
      ref={dialogRef}
      className="modal"
      onCancel={(e) => { e.preventDefault(); close(); }}
      aria-labelledby="upload-title"
    >
      <div className="modal-head">
        <h2 id="upload-title">{title}</h2>
        <button className="close-x" onClick={close} aria-label="Close" disabled={busy}>×</button>
      </div>

      {phase === "done" && summary ? (
        <SummaryView summary={summary} />
      ) : (
        <div className="modal-body">
          <div
            className={`drop${over ? " over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
          >
            <div>
              <strong>{mode === "bulk" ? "Drop CVs, a folder or a zip here" : "Drop one CV here"}</strong>
              <div className="small muted">
                {mode === "bulk" ? "PDF or DOCX, any mix. Zips and sub-folders are unpacked." : "PDF or DOCX"}
              </div>
            </div>
            <div className="drop-actions">
              <button className="btn btn-small" onClick={() => filesInput.current?.click()} disabled={busy}>
                {mode === "bulk" ? "Choose files or zip" : "Choose file"}
              </button>
              {mode === "bulk" && (
                <button className="btn btn-small" onClick={() => folderInput.current?.click()} disabled={busy}>
                  Choose folder
                </button>
              )}
            </div>
            <input ref={filesInput} type="file" hidden multiple={mode === "bulk"} accept={mode === "bulk" ? ACCEPT_BULK : ACCEPT_SINGLE} onChange={onInput} />
            {mode === "bulk" && (
              <input
                ref={folderInput}
                type="file"
                hidden
                multiple
                onChange={onInput}
                {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
              />
            )}
          </div>

          {picked.length > 0 && (
            <div className="field">
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <strong>{picked.length} file{picked.length === 1 ? "" : "s"} · {formatBytes(totalBytes)}</strong>
                {!busy && <button className="btn-link" onClick={() => setPicked([])}>Clear</button>}
              </div>
              <div className="filelist">
                {picked.map((p) => (
                  <div key={p.path}>
                    <span title={p.path}>{p.path}</span>
                    <span className="muted">{formatBytes(p.file.size)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="row2">
            <div className="field">
              <label htmlFor="role">Role applied for</label>
              <select id="role" value={role} onChange={(e) => setRole(e.target.value)} disabled={busy}>
                <option value="">Untagged (assign by rubric)</option>
                <option value="PM">Product Manager</option>
                <option value="SPM">Senior Product Manager</option>
              </select>
              {mode === "bulk" && (
                <span className="hint">
                  Used for files that don&apos;t carry their own tag. A tag in the CSV, a PM/SPM folder or file name, or an
                  &quot;Applying for&quot; line in the CV wins.
                </span>
              )}
            </div>
            <div className="field">
              <label htmlFor="applied">Applied on</label>
              <input id="applied" type="date" value={appliedDate} onChange={(e) => setAppliedDate(e.target.value)} disabled={busy} />
              <span className="hint">Blank means today. July and August applicants get a delay apology.</span>
            </div>
          </div>

          {mode === "single" ? (
            <label className="check">
              <input type="checkbox" checked={august} onChange={(e) => setAugust(e.target.checked)} disabled={busy} />
              <span>
                I told this candidate &quot;let&apos;s chat&quot; in August
                <div className="hint small muted">Their email will include your apology for dropping the ball.</div>
              </span>
            </label>
          ) : (
            <div className="small muted">
              Need a different date, role or the August &quot;let&apos;s chat&quot; flag per candidate? Add a CSV to the upload.{" "}
              <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(CSV_TEMPLATE)}`} download="kargo_upload_template.csv">
                Download the CSV template
              </a>
              .
            </div>
          )}

          {busy && (
            <div className="field">
              <div className="progress"><div style={{ width: `${phase === "processing" ? 100 : progress}%` }} /></div>
              <span className="small muted">
                {phase === "uploading" ? `Uploading… ${progress}%` : "Reading CVs, removing duplicates…"}
              </span>
            </div>
          )}
          {error && <div className="error" role="alert">{error}</div>}
        </div>
      )}

      <div className="modal-foot">
        {phase === "done" ? (
          <button className="btn btn-primary" onClick={close}>Done</button>
        ) : (
          <>
            <button className="btn" onClick={close} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" onClick={submit} disabled={busy || !picked.length}>
              {mode === "bulk" ? `Upload ${picked.length || ""} file${picked.length === 1 ? "" : "s"}` : "Upload"}
            </button>
          </>
        )}
      </div>
    </dialog>
  );
}

function SummaryView({ summary: s }: { summary: UploadResponse }) {
  const parts = [
    `${s.uploaded} uploaded`,
    `${s.ready} ready for scoring`,
    `${s.needsManualLook.length} need${s.needsManualLook.length === 1 ? "s" : ""} manual look`,
    `${s.duplicates.length} duplicate${s.duplicates.length === 1 ? "" : "s"} skipped`,
  ];
  return (
    <div className="modal-body">
      <div className="summary-line">{parts.join(" · ")}</div>
      <div className="small muted">
        Roles: {s.roles.PM} PM · {s.roles.SPM} SPM · {s.roles.untagged} untagged (assigned by rubric at scoring)
        {s.manifest.used && ` · CSV matched ${s.manifest.matched} file${s.manifest.matched === 1 ? "" : "s"}`}
      </div>
      <div className="next-box">
        <strong>What happens next</strong>
        {s.ready > 0 && s.scoring?.started && (
          <p>
            The AI is scoring {s.ready} CV{s.ready === 1 ? "" : "s"} now, about {Math.max(1, Math.ceil((s.ready * 15) / 60))} minute
            {Math.ceil((s.ready * 15) / 60) === 1 ? "" : "s"}. You can close this window: candidates appear in the Selected, Hold and Rejected
            tabs as they finish, and the checklist on the dashboard tells you what to do next.
          </p>
        )}
        {s.ready > 0 && s.scoring && !s.scoring.started && <p className="warn-text">Not scored yet: {s.scoring.reason}</p>}
        {s.ready === 0 && <p>No new CVs to score from this upload.</p>}
        {s.duplicates.length > 0 && (
          <p className="muted">
            {s.duplicates.length} duplicate{s.duplicates.length === 1 ? " was" : "s were"} skipped automatically (the same file, or the same
            person uploaded twice). Nothing to do.
          </p>
        )}
        {s.needsManualLook.length > 0 && (
          <p className="muted">
            {s.needsManualLook.length} file{s.needsManualLook.length === 1 ? "" : "s"} couldn&apos;t be read (listed below). They&apos;re in the
            &quot;Needs manual look&quot; tab: open the original file there and read it yourself.
          </p>
        )}
      </div>
      <SummaryList title="Needs manual look" items={s.needsManualLook.map((m) => `${m.file}: ${m.reason}`)} />
      {s.sharedEmails?.length > 0 && (
        <div className="small muted">
          Shared email addresses kept as separate candidates:{" "}
          {s.sharedEmails.map((e) => `${e.email} (${e.count} CVs)`).join(", ")}. Emails to these candidates all go to that one inbox.
        </div>
      )}
      <SummaryList title="Duplicates skipped" items={s.duplicates.map((d) => `${d.file}: ${d.reason}`)} />
      <SummaryList title="Not processed" items={s.ignored.map((i) => `${i.file}: ${i.reason}`)} />
      <SummaryList title="CSV problems" items={s.manifest.errors} />
    </div>
  );
}

function SummaryList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="summary-group">
      <h3>{title} ({items.length})</h3>
      <ul className="small">{items.map((t, i) => <li key={i}>{t}</li>)}</ul>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Walks dropped folders (drag-and-drop gives entries, not a flat file list).
async function readEntries(entries: FileSystemEntry[], prefix = ""): Promise<Picked[]> {
  const out: Picked[] = [];
  for (const entry of entries) {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ file, path: prefix + entry.name });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries returns results in chunks; keep reading until empty.
      for (;;) {
        const chunk = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!chunk.length) break;
        out.push(...(await readEntries(chunk, `${prefix}${entry.name}/`)));
      }
    }
  }
  return out;
}

// ---- Batching for serverless upload limits ----------------------------------

const MAX_FILE = 4 * 1024 * 1024; // one request carries at most 4.5 MB
const BATCH_BYTES = 3.5 * 1024 * 1024;
const JUNK = (path: string) => /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)|(^|\/)~\$/i.test(path);

async function expandZips(items: Picked[], depth = 0): Promise<Picked[]> {
  const out: Picked[] = [];
  for (const p of items) {
    if (JUNK(p.path)) continue;
    if (!/\.zip$/i.test(p.path) || depth > 1) {
      out.push(p);
      continue;
    }
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(p.file);
    const inner: Picked[] = [];
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      const blob = await entry.async("blob");
      const name = entry.name.split("/").pop() ?? entry.name;
      inner.push({ file: new File([blob], name), path: `${p.path.replace(/\.zip$/i, "")}/${entry.name}` });
    }
    out.push(...(await expandZips(inner, depth + 1)));
  }
  return out;
}

function toBatches(items: Picked[]): Picked[][] {
  const batches: Picked[][] = [];
  let cur: Picked[] = [];
  let size = 0;
  for (const p of items) {
    if (cur.length && size + p.file.size > BATCH_BYTES) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(p);
    size += p.file.size;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

// One summary for the whole upload, however many batches it took.
function mergeSummaries(parts: UploadResponse[], tooBig: string[]): UploadResponse {
  const first = parts[0];
  const shared = new Map<string, number>();
  for (const p of parts) for (const s of p.sharedEmails ?? []) shared.set(s.email, Math.max(shared.get(s.email) ?? 0, s.count));
  return {
    batchId: parts[parts.length - 1]?.batchId ?? "",
    uploaded: parts.reduce((n, p) => n + p.uploaded, 0) + tooBig.length,
    ready: parts.reduce((n, p) => n + p.ready, 0),
    needsManualLook: parts.flatMap((p) => p.needsManualLook),
    duplicates: parts.flatMap((p) => p.duplicates),
    ignored: [...parts.flatMap((p) => p.ignored), ...tooBig.map((file) => ({ file, reason: "Over 4 MB; save it smaller (e.g. as PDF) and upload again." }))],
    roles: {
      PM: parts.reduce((n, p) => n + p.roles.PM, 0),
      SPM: parts.reduce((n, p) => n + p.roles.SPM, 0),
      untagged: parts.reduce((n, p) => n + p.roles.untagged, 0),
    },
    manifest: {
      used: parts.some((p) => p.manifest.used),
      matched: parts.reduce((n, p) => n + p.manifest.matched, 0),
      errors: [...new Set(parts.flatMap((p) => p.manifest.errors))],
    },
    sharedEmails: [...shared].map(([email, count]) => ({ email, count })),
    scoring: parts.find((p) => p.scoring)?.scoring ?? first?.scoring ?? null,
  };
}
