import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

// Signed, short-lived OAuth state carried in both the URL and an HttpOnly cookie.
export const STATE_COOKIE = "sd_oauth_state";
const TTL_MS = 10 * 60 * 1000;

function sign(payload: string) {
  return createHmac("sha256", env().BETTER_AUTH_SECRET).update(payload).digest("base64url");
}

export function createState(data: Record<string, string> = {}) {
  const payload = Buffer.from(JSON.stringify({ ...data, n: randomBytes(16).toString("hex"), t: Date.now() })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifyState(fromUrl: string | null, fromCookie: string | undefined): Record<string, string> | null {
  if (!fromUrl || !fromCookie || fromUrl.length !== fromCookie.length) return null;
  if (!timingSafeEqual(Buffer.from(fromUrl), Buffer.from(fromCookie))) return null;
  const [payload, sig] = fromUrl.split(".");
  if (!payload || !sig || sign(payload) !== sig) return null;
  const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, string> & { t: number };
  if (Date.now() - Number(data.t) > TTL_MS) return null;
  return data;
}
