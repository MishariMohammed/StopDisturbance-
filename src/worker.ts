import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { enqueueEnrich, enqueueRepliesPoll, enqueueScanProcess, getBoss, QUEUES, type SyncJob } from "@/lib/jobs/queue";
import { resolvePending } from "@/lib/scan/resolve";
import { classifySenders } from "@/lib/scan/classify";
import { classifyUnsettled } from "@/lib/llm/classify-unsettled";
import { enrichPending } from "@/lib/enrich/contacts";
import { refreshDatasets } from "@/lib/enrich/datasets";
import { applyJurisdiction } from "@/lib/legal/drafts";
import { incrementalSync, initialSync } from "@/lib/mail/gmail-sync";
import { outlookIncrementalSync, outlookInitialSync } from "@/lib/mail/outlook-sync";
import { ReconnectRequiredError } from "@/lib/mail/accounts";
import { dispatchDue } from "@/lib/send/dispatcher";
import { pollReplies } from "@/lib/track/poll";
import { deadlineTick } from "@/lib/track/deadline-tick";
import { sendWeeklyDigest } from "@/lib/notify/digest";
import { sendAlert } from "@/lib/notify/alerts";
import { runRetention } from "@/lib/jobs/retention";

// send.dispatch runs every 15 s. pg-boss cron granularity is one minute, so the worker drives it with a
// non-overlapping setInterval loop instead of a schedule: it needs no queue round-trip, an in-flight
// guard prevents overlap, and the dispatcher's compare-and-set claim keeps a send single even if a
// second worker ever runs. Serial per mailbox and spacing/cap checks live in dispatchDue().
export const DISPATCH_INTERVAL_MS = 15_000;

async function runSync(job: SyncJob, mode: "initial" | "incremental") {
  const account = await db.mailAccount.findUnique({ where: { id: job.accountId } });
  if (!account || account.status !== "ACTIVE") return;
  try {
    if (account.provider === "GOOGLE") {
      if (mode === "initial") await initialSync(account.id);
      else await incrementalSync(account.id);
    } else {
      if (mode === "initial") await outlookInitialSync(account.id);
      else await outlookIncrementalSync(account.id);
    }
    await enqueueScanProcess();
    // Replies are matched after the incremental sync stored the new headers (stage 9).
    if (mode === "incremental") await enqueueRepliesPoll();
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      logger.warn({ accountId: account.id }, "mailbox needs reconnect");
      await sendAlert("MAILBOX_DISCONNECTED", { mailbox: account.address });
      return;
    }
    throw err;
  }
}

async function main() {
  const boss = await getBoss();
  const tz = process.env.TZ_DEFAULT ?? "Asia/Riyadh";

  await boss.work<SyncJob>(QUEUES.syncInitial, async ([job]) => runSync(job.data, "initial"));
  await boss.work<SyncJob>(QUEUES.syncIncremental, async ([job]) => runSync(job.data, "incremental"));
  await boss.work(QUEUES.syncAll, async () => {
    const accounts = await db.mailAccount.findMany({ where: { status: "ACTIVE" }, select: { id: true } });
    for (const a of accounts) {
      await boss.send(QUEUES.syncIncremental, { accountId: a.id } satisfies SyncJob, { singletonKey: a.id });
    }
  });
  await boss.work(QUEUES.scanProcess, async () => {
    const stats = await resolvePending();
    if (stats.senderIds.length) await classifySenders(stats.senderIds);
    // Makes no network call unless AI assist is on and the training opt-out is recorded.
    const llm = await classifyUnsettled();
    logger.info({ headers: stats.headers, senders: stats.senderIds.length, llm }, "scan processed");
    await enqueueEnrich();
  });
  await boss.work(QUEUES.enrich, async () => {
    // Decided companies first (REMOVE/UNSUBSCRIBE), then undecided; KEEP is skipped.
    const r = await enrichPending({ limit: 50 });
    for (const id of r.ids) await applyJurisdiction(id);
    logger.info({ enriched: r.enriched, failed: r.failed }, "enrich batch done");
    if (r.enriched + r.failed === 50) await enqueueEnrich();
  });
  await boss.work(QUEUES.datasets, async () => {
    const r = await refreshDatasets({ maxAgeDays: 7 });
    logger.info({ refreshed: r.results.length, errors: r.errors.length }, "datasets refreshed");
  });
  await boss.work(QUEUES.repliesPoll, async () => {
    // Several batches if a sync brought many headers; each call advances the cursor.
    for (let i = 0; i < 10; i++) {
      const r = await pollReplies();
      logger.info(r, "replies polled");
      if (r.scanned < 500) break;
    }
  });
  await boss.work(QUEUES.deadlineTick, async () => {
    const r = await deadlineTick();
    logger.info(
      { overdue: r.overdue.length, reminders: r.reminderOffered.length, escalations: r.escalationOpen.length, completed: r.autoCompleted.length },
      "deadline tick",
    );
  });
  await boss.work(QUEUES.digest, async () => {
    const sent = await sendWeeklyDigest();
    logger.info({ sent }, "weekly digest");
  });
  await boss.work(QUEUES.retention, async () => {
    await runRetention(); // logs its own counts
  });
  await boss.schedule(QUEUES.datasets, "17 3 * * 0", {}, { tz });
  await boss.schedule(QUEUES.syncAll, "*/10 * * * *", {}, { tz });
  // Fallback poll 5 minutes after each sync round, in case a sync job failed to enqueue it.
  await boss.schedule(QUEUES.repliesPoll, "5-59/10 * * * *", {}, { tz });
  await boss.schedule(QUEUES.deadlineTick, "0 6 * * *", {}, { tz });
  await boss.schedule(QUEUES.digest, "0 9 * * 0", {}, { tz });
  // Retention (00-brief §4): daily 04:00 Asia/Riyadh, before the 06:00 deadline tick.
  await boss.schedule(QUEUES.retention, "0 4 * * *", {}, { tz });

  let dispatching = false;
  const dispatchTimer = setInterval(async () => {
    if (dispatching) return;
    dispatching = true;
    try {
      const out = await dispatchDue();
      if (out.length) logger.info({ results: out.map((o) => o.result) }, "send dispatch");
    } catch (err) {
      logger.error({ err: (err as Error).message }, "send dispatch failed");
    } finally {
      dispatching = false;
    }
  }, DISPATCH_INTERVAL_MS);

  logger.info("worker started");
  const stop = async () => {
    clearInterval(dispatchTimer);
    await boss.stop({ graceful: true });
    await db.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((err) => {
  logger.error({ err: err.message }, "worker failed to start");
  process.exit(1);
});
