import { NextResponse } from "next/server";
import { getOwnerSession } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { exportData } from "@/lib/privacy/export";

export const dynamic = "force-dynamic";

/** "Download my data (JSON)" (04-ux §3.6). Owner only; no tokens or ciphertexts (src/lib/privacy/export.ts). */
export async function GET(req: Request) {
  if (!(await getOwnerSession())) return new NextResponse("Forbidden", { status: 403 });
  const includeReplyBodies = new URL(req.url).searchParams.get("replies") === "1";
  const data = await exportData({ includeReplyBodies });
  await audit("data.exported", "owner", "owner", { includeReplyBodies });
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="stopdisturbance-export-${stamp}.json"`,
      "cache-control": "no-store",
    },
  });
}
