import PgBoss from "pg-boss";

export const QUEUES = {
  syncInitial: "sync.initial",
  syncIncremental: "sync.incremental",
  syncAll: "sync.all",
} as const;

export type SyncJob = { accountId: string };

let boss: PgBoss | undefined;
let starting: Promise<PgBoss> | undefined;

export function connectionString() {
  return process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL!;
}

/** Shared pg-boss instance. The web process only sends; the worker also registers handlers. */
export async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;
  starting ??= (async () => {
    const b = new PgBoss({ connectionString: connectionString(), schema: "pgboss" });
    b.on("error", (err) => console.error("pg-boss error", err.message));
    await b.start();
    for (const q of Object.values(QUEUES)) await b.createQueue(q);
    boss = b;
    return b;
  })();
  return starting;
}

export async function enqueueInitialSync(accountId: string) {
  const b = await getBoss();
  // singletonKey: one initial sync per mailbox at a time.
  return b.send(QUEUES.syncInitial, { accountId } satisfies SyncJob, { singletonKey: accountId, retryLimit: 3, retryBackoff: true });
}
