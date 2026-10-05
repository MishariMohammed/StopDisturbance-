import { db } from "@/lib/db";
import { addBusinessDays, addCalendarDays } from "@/lib/deadlines";
import { sendAlert } from "@/lib/notify/alerts";
import { isListMail, STILL_EMAILING_BUSINESS_DAYS } from "@/lib/track/poll";
import { companyDomains, logEvent, UNSUB_ONLY_TYPES } from "@/lib/track/state";

// deadline.tick — daily 06:00 Asia/Riyadh (00-brief §5 stage 9, 04-ux §7.4):
// - SENT/ACKNOWLEDGED past dueAt → OVERDUE (+ alert);
// - reminder offered from dueAt + 3 days (once, alert);
// - escalation opens at escalationOpenAt (once, alert);
// - deadline in ≤3 days with no reply → alert (once);
// - unsubscribe-only requests auto-COMPLETE after 10 business days without marketing.

export interface TickResult {
  overdue: string[];
  reminderOffered: string[];
  escalationOpen: string[];
  deadlineSoon: string[];
  autoCompleted: string[];
}

async function once(requestId: string, type: string) {
  return (await db.requestEvent.count({ where: { requestId, type } })) === 0;
}

export async function deadlineTick(now = new Date()): Promise<TickResult> {
  const r: TickResult = { overdue: [], reminderOffered: [], escalationOpen: [], deadlineSoon: [], autoCompleted: [] };

  // Unsubscribe-only first: a quiet list should complete rather than go overdue.
  const unsub = await db.request.findMany({
    where: { type: { in: [...UNSUB_ONLY_TYPES] }, status: { in: ["SENT", "ACKNOWLEDGED", "OVERDUE"] }, clockStart: { not: null } },
  });
  for (const q of unsub) {
    if (now.getTime() < addBusinessDays(q.clockStart!, STILL_EMAILING_BUSINESS_DAYS).getTime()) continue;
    const domains = await companyDomains(q.companyId);
    const senders = await db.sender.findMany({ where: { companyId: q.companyId }, select: { id: true } });
    const recent = await db.messageHeader.findMany({
      where: {
        receivedAt: { gt: q.clockStart! },
        OR: [{ fromDomain: { in: domains } }, { senderId: { in: senders.map((s) => s.id) } }],
      },
      orderBy: { receivedAt: "desc" },
      take: 50,
    });
    const lastMarketing = recent.find(isListMail);
    // Quiet for 10 business days: no marketing since the POST/mail, or none in the last 10 business days.
    if (lastMarketing && addBusinessDays(lastMarketing.receivedAt, STILL_EMAILING_BUSINESS_DAYS).getTime() > now.getTime()) continue;
    await db.$transaction(async (tx) => {
      const n = await tx.request.updateMany({ where: { id: q.id, status: q.status }, data: { status: "COMPLETED", closedAt: now } });
      if (n.count) {
        await logEvent(tx, q.id, "AUTO_COMPLETED", "SYSTEM", { reason: "no_marketing_10_business_days", prevStatus: q.status }, now);
      }
    });
    r.autoCompleted.push(q.id);
  }

  const due = await db.request.findMany({ where: { status: { in: ["SENT", "ACKNOWLEDGED"] }, dueAt: { lt: now } } });
  for (const q of due) {
    await db.$transaction(async (tx) => {
      const n = await tx.request.updateMany({ where: { id: q.id, status: q.status }, data: { status: "OVERDUE" } });
      if (n.count) await logEvent(tx, q.id, "OVERDUE", "SYSTEM", { dueAt: q.dueAt!.toISOString(), prevStatus: q.status }, now);
    });
    r.overdue.push(q.id);
    await sendAlert("OVERDUE", { requestId: q.id, date: q.dueAt }, now);
  }

  const overdue = await db.request.findMany({ where: { status: "OVERDUE" } });
  for (const q of overdue) {
    if (q.reminderOfferedAt && q.reminderOfferedAt <= now && !q.reminderSentAt && (await once(q.id, "REMINDER_OFFERED"))) {
      await db.$transaction((tx) => logEvent(tx, q.id, "REMINDER_OFFERED", "SYSTEM", { reminderOfferedAt: q.reminderOfferedAt!.toISOString() }, now));
      r.reminderOffered.push(q.id);
      await sendAlert("REMINDER_AVAILABLE", { requestId: q.id }, now);
    }
    if (q.escalationOpenAt && q.escalationOpenAt <= now && (await once(q.id, "ESCALATION_OPEN"))) {
      await db.$transaction((tx) =>
        logEvent(tx, q.id, "ESCALATION_OPEN", "SYSTEM", {
          escalationOpenAt: q.escalationOpenAt!.toISOString(),
          complaintWindowEndsAt: q.complaintWindowEndsAt?.toISOString() ?? null,
        }, now),
      );
      r.escalationOpen.push(q.id);
      await sendAlert("ESCALATION_OPEN", { requestId: q.id }, now);
    }
  }

  // Deadline in ≤3 days with no reply yet (04-ux §8.2).
  const soon = await db.request.findMany({ where: { status: "SENT", dueAt: { gte: now, lte: addCalendarDays(now, 3) } } });
  for (const q of soon) {
    if ((await db.inboundReply.count({ where: { requestId: q.id } })) > 0) continue;
    if (!(await once(q.id, "DEADLINE_SOON"))) continue;
    await db.$transaction((tx) => logEvent(tx, q.id, "DEADLINE_SOON", "SYSTEM", { dueAt: q.dueAt!.toISOString() }, now));
    r.deadlineSoon.push(q.id);
    await sendAlert("DEADLINE_SOON", { requestId: q.id, date: q.dueAt }, now);
  }
  return r;
}
