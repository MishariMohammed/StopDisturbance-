import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { checkAndPinSubject, isOwnerEmail } from "@/lib/auth/owner";

// Owner login only. Mailbox access is granted through separate OAuth flows in src/lib/mail.
const NOT_ALLOWED = "This app is private.";

function buildAuth() {
  const e = env();
  return betterAuth({
    baseURL: e.APP_URL,
    secret: e.BETTER_AUTH_SECRET,
    database: prismaAdapter(db, { provider: "postgresql" }),
    emailAndPassword: { enabled: false },
    socialProviders: {
      google: {
        clientId: e.GOOGLE_CLIENT_ID,
        clientSecret: e.GOOGLE_CLIENT_SECRET,
        scope: ["openid", "email", "profile"],
      },
      microsoft: {
        clientId: e.MS_CLIENT_ID,
        clientSecret: e.MS_CLIENT_SECRET,
        tenantId: "common",
        scope: ["openid", "email", "profile", "User.Read"],
      },
    },
    advanced: { useSecureCookies: e.APP_URL.startsWith("https://") },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!isOwnerEmail(user.email)) {
              await audit("login.rejected", "user", undefined, { reason: "not_owner" });
              throw new APIError("FORBIDDEN", { message: NOT_ALLOWED });
            }
          },
        },
      },
      account: {
        create: {
          before: async (account) => {
            if (!(await checkAndPinSubject(account.providerId, account.accountId))) {
              await audit("login.rejected", "account", undefined, { reason: "subject_mismatch" });
              throw new APIError("FORBIDDEN", { message: NOT_ALLOWED });
            }
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const user = await db.user.findUnique({ where: { id: session.userId } });
            if (!isOwnerEmail(user?.email)) throw new APIError("FORBIDDEN", { message: NOT_ALLOWED });
            await audit("login.ok", "user", session.userId);
          },
        },
      },
    },
    plugins: [nextCookies()],
  });
}

type Auth = ReturnType<typeof buildAuth>;
let instance: Auth | undefined;

export function auth(): Auth {
  if (!instance) instance = buildAuth();
  return instance;
}
