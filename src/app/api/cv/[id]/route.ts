import { readFile } from "fs/promises";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { absPath } from "@/lib/storage";

export const runtime = "nodejs";

// Serves the original CV file so Arjun can open it ("View original CV", and
// the only way to read files that landed in "Needs manual look").
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const file = await prisma.cvFile.findFirst({ where: { candidateId: id }, orderBy: { createdAt: "desc" } });
  if (!file) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Files are stored in the database; older local uploads may still be on disk.
  const data = file.data ? Buffer.from(file.data) : file.storagePath ? await readFile(absPath(file.storagePath)).catch(() => null) : null;
  if (!data) return NextResponse.json({ error: "File missing from storage" }, { status: 404 });

  const inline = file.mime === "application/pdf";
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": file.mime,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(file.filename)}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
