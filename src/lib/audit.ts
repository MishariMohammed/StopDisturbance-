import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export async function audit(action: string, entity?: string, entityId?: string, data: Prisma.InputJsonValue = {}) {
  await db.auditLog.create({ data: { action, entity, entityId, data } });
}
