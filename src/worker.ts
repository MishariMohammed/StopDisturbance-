import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { enqueueEnrich, enqueueScanProcess, getBoss, QUEUES, type SyncJob } from "@/lib/jobs/queue";
import { resolvePending } from "@/lib/scan/resolve";
import { classifySenders } from "@/lib/scan/classify";
import { classifyUnsettled } from "@/lib/llm/classify-unsettled";
import { enrichPending } from "@/lib/enrich/contacts";
import { refreshDatasets } from "@/lib/enrich/datasets";
import { applyJurisdiction } from "@/lib/legal/drafts";
import { incrementalSync, initialSync } from "@/lib/mail/gmail-sync";
import { outlookIncrementalSync, outlookInitialSync } from "@/lib/mail/outlook-sync";
import { ReconnectRequiredError } from "@/lib/mail/accounts";

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
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      logger.warn({ accountId: account.id }, "mailbox needs reconnect");
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
  await boss.schedule(QUEUES.datasets, "17 3 * * 0", {}, { tz });
  await boss.schedule(QUEUES.syncAll, "*/10 * * * *", {}, { tz });

  logger.info("worker started");
  const stop = async () => {
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
