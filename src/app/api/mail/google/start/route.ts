import { NextResponse } from "next/server";
import { getOwnerSession } from "@/lib/auth/session";
import { buildAuthUrl } from "@/lib/mail/google-oauth";
import { createState, STATE_COOKIE } from "@/lib/mail/oauth-state";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!(await getOwnerSession())) return new NextResponse("Forbidden", { status: 403 });
  const url = new URL(req.url);
  const withSend = url.searchParams.get("send") === "1";
  const locale = url.searchParams.get("locale") === "en" ? "en" : "ar";
  const state = createState({ locale });
  const res = NextResponse.redirect(
    buildAuthUrl(state, { withSend, loginHint: url.searchParams.get("hint") ?? undefined }),
  );
  res.cookies.set(STATE_COOKIE, state, { httpOnly: true, sameSite: "lax", secure: url.protocol === "https:", path: "/api/mail", maxAge: 600 });
  return res;
}
