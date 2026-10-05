import { NextResponse } from "next/server";
import { getOwnerSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { buildEvidenceZip } from "@/lib/track/actions";

export const dynamic = "force-dynamic";

/** Evidence ZIP for one request (EML of sent mail and replies + JSON timeline). Owner only. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getOwnerSession())) return new NextResponse("Forbidden", { status: 403 });
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return new NextResponse("Not found", { status: 404 });
  const request = await db.request.findUnique({ where: { id }, select: { reference: true } });
  if (!request) return new NextResponse("Not found", { status: 404 });
  const zip = await buildEvidenceZip(id);
  await db.auditLog.create({ data: { action: "request.evidence_downloaded", entity: "request", entityId: id, data: {} } });
  return new NextResponse(new Uint8Array(zip), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="evidence-${request.reference}.zip"`,
      "cache-control": "no-store",
    },
  });
}
