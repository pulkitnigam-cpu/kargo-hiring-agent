import path from "path";

// Where uploaded CV files live. Hosted, point STORAGE_DIR at the persistent
// disk (e.g. /data/storage); locally it's ./storage.
export function storageRoot(): string {
  return process.env.STORAGE_DIR || path.join(process.cwd(), "storage");
}

// CvFile.storagePath is stored relative to the storage root ("cvs/<hash>.pdf").
// Rows from before STORAGE_DIR existed start with "storage/".
export function absPath(storagePath: string): string {
  const rel = storagePath.replace(/^storage[\\/]/, "");
  return path.join(storageRoot(), rel);
}
