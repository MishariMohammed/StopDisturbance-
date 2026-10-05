import { getOwnerSession } from "@/lib/auth/session";
import { loadScanStatus } from "@/lib/companies/scan-status";

export const dynamic = "force-dynamic";

/** Small status payload polled by /scan every 5 s (04-ux §3.2). */
export async function GET() {
  if (!(await getOwnerSession())) return new Response("Forbidden", { status: 403 });
  return Response.json(await loadScanStatus(), { headers: { "cache-control": "no-store" } });
}
