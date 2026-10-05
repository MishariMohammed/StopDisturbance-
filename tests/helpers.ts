import { db } from "@/lib/db";

export async function resetDb() {
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(", ");
  if (list) await db.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;

/** Minimal fetch mock: first matching route wins; unmatched requests fail the test. */
export function mockFetch(routes: [RegExp, Route][]) {
  const calls: URL[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url);
    for (const [re, route] of routes) if (re.test(url.href)) return route(url, init);
    throw new Error(`Unmocked fetch: ${url.href}`);
  };
  return { fn, calls };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
