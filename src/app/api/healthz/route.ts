import { db } from "@/lib/db";
import { getBoss } from "@/lib/jobs/queue";

export const dynamic = "force-dynamic";

export async function GET() {
  const checks: Record<string, boolean> = { db: false, queue: false };
  try {
    await db.$queryRaw`SELECT 1`;
    checks.db = true;
  } catch {}
  try {
    const boss = await getBoss();
    await boss.getQueue("sync.initial");
    checks.queue = true;
  } catch {}
  const ok = Object.values(checks).every(Boolean);
  return Response.json({ ok, checks }, { status: ok ? 200 : 503 });
}
