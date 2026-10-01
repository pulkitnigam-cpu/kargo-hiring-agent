import JSZip from "jszip";
import { ZIP_EXTENSION } from "../constants";
import { extensionOf } from "./parse";

export type InFile = { path: string; data: Buffer };
export type Ignored = { file: string; reason: string };

// OS clutter that is safe to drop without telling Arjun about each file.
function isSystemJunk(path: string): boolean {
  const parts = path.split(/[\\/]/);
  const base = parts[parts.length - 1];
  return (
    parts.includes("__MACOSX") ||
    base.startsWith(".") ||
    base.startsWith("~$") || // Word lock files
    /^(thumbs\.db|desktop\.ini)$/i.test(base)
  );
}

// Flattens uploaded files and any zips (including zips inside zips) into one
// list, keeping each file's path so folder names can carry a role tag.
export async function unpack(files: InFile[], depth = 0): Promise<{ files: InFile[]; ignored: Ignored[] }> {
  const out: InFile[] = [];
  const ignored: Ignored[] = [];

  for (const f of files) {
    if (isSystemJunk(f.path)) continue;
    if (extensionOf(f.path) !== ZIP_EXTENSION) {
      out.push(f);
      continue;
    }
    if (depth >= 2) {
      ignored.push({ file: f.path, reason: "Zip nested too deep; unzip it and upload again." });
      continue;
    }
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(f.data);
    } catch {
      ignored.push({ file: f.path, reason: "Couldn't open the zip (corrupt or password-protected)." });
      continue;
    }
    const inner: InFile[] = [];
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      inner.push({ path: `${f.path.replace(/\.zip$/i, "")}/${entry.name}`, data: await entry.async("nodebuffer") });
    }
    const nested = await unpack(inner, depth + 1);
    out.push(...nested.files);
    ignored.push(...nested.ignored);
  }
  return { files: out, ignored };
}
