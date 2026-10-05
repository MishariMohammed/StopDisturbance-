import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isOwnerEmail } from "@/lib/auth/owner";
import { ownerEmails } from "@/lib/env";

type OwnerSession = NonNullable<Awaited<ReturnType<ReturnType<typeof auth>["api"]["getSession"]>>>;

/**
 * Test-only bypass for Playwright (E2E_AUTH_BYPASS=1). Never active in production: Next.js inlines
 * NODE_ENV at build time, so this branch is removed from production bundles.
 */
function e2eBypassSession(): OwnerSession | null {
  if (process.env.NODE_ENV === "production" || process.env.E2E_AUTH_BYPASS !== "1") return null;
  const now = new Date();
  return {
    user: { id: "e2e-owner", name: "E2E Owner", email: ownerEmails()[0], emailVerified: true, image: null, createdAt: now, updatedAt: now },
    session: { id: "e2e", token: "e2e", userId: "e2e-owner", expiresAt: new Date(now.getTime() + 3600_000), createdAt: now, updatedAt: now, ipAddress: null, userAgent: null },
  } as OwnerSession;
}

export async function getOwnerSession(): Promise<OwnerSession | null> {
  const bypass = e2eBypassSession();
  if (bypass) return bypass;
  const session = await auth().api.getSession({ headers: await headers() });
  if (!session || !isOwnerEmail(session.user.email)) return null;
  return session;
}

export async function requireOwner(locale = "ar") {
  const session = await getOwnerSession();
  if (!session) redirect(`/${locale}/login`);
  return session;
}
