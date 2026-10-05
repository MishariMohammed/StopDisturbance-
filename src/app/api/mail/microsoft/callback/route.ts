import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { getOwnerSession } from "@/lib/auth/session";
import { connectMicrosoftMailbox } from "@/lib/mail/connect-microsoft";
import { STATE_COOKIE, verifyState } from "@/lib/mail/oauth-state";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!(await getOwnerSession())) return new NextResponse("Forbidden", { status: 403 });
  const url = new URL(req.url);
  const state = verifyState(url.searchParams.get("state"), (await cookies()).get(STATE_COOKIE)?.value);
  const locale = state?.locale ?? "ar";
  const back = (q: string) => NextResponse.redirect(`${env().APP_URL}/${locale}/connect?${q}`);

  if (!state) return back("error=state");
  const code = url.searchParams.get("code");
  if (!code) return back(`error=${encodeURIComponent(url.searchParams.get("error") ?? "denied")}`);

  try {
    const result = await connectMicrosoftMailbox(code);
    const res = result.ok ? back(result.partial ? "connected=microsoft&partial=1" : "connected=microsoft") : back(`error=${result.reason}`);
    res.cookies.delete(STATE_COOKIE);
    return res;
  } catch (err) {
    logger.error({ err: (err as Error).message }, "microsoft connect failed");
    return back("error=connect_failed");
  }
}
