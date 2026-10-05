import { inflateRawSync } from "node:zlib";
import type { Provider, RequestStatus, RequestType } from "@prisma/client";
import { db } from "@/lib/db";
import { encryptJson } from "@/lib/crypto/tokens";
import { computeDraftHash } from "@/lib/legal/drafts";
import { GMAIL_SCOPES } from "@/lib/mail/google-oauth";
import { NOTIFICATIONS_KEY } from "@/lib/notify/settings";
import { json } from "./helpers";

export const T0 = new Date("2026-10-05T10:00:00+03:00"); // Monday 10:00 Riyadh
export const FAR = Date.UTC(2035, 0, 1);

export async function seedOwner(locale: "en" | "ar" = "en") {
  return db.owner.create({ data: { id: "owner", fullName: "Sara Al-Harbi", loginEmails: ["sara@gmail.com"], locale } });
}

export async function seedAccount(opts: { provider?: Provider; address?: string; send?: boolean; status?: "ACTIVE" | "NEEDS_RECONNECT" } = {}) {
  const provider = opts.provider ?? "GOOGLE";
  const address = opts.address ?? (provider === "GOOGLE" ? "sara@gmail.com" : "sara@outlook.com");
  const send = opts.send ?? true;
  const scopes =
    provider === "GOOGLE"
      ? [GMAIL_SCOPES.read, ...(send ? [GMAIL_SCOPES.send] : [])]
      : ["Mail.Read", ...(send ? ["Mail.Send"] : []), "offline_access"];
  const { cipher, keyVersion } = encryptJson({ access_token: "AT", refresh_token: "RT", expires_at: FAR, scope: scopes.join(" ") });
  return db.mailAccount.create({
    data: {
      provider, address, providerUserId: address, grantedScopes: scopes, tokenCipher: cipher, tokenKeyVersion: keyVersion,
      scanFrom: new Date("2024-01-01"), status: opts.status ?? "ACTIVE",
    },
  });
}

export async function notificationsOff() {
  await db.setting.upsert({ where: { key: NOTIFICATIONS_KEY }, create: { key: NOTIFICATIONS_KEY, value: false }, update: { value: false } });
}

let refN = 0;
export function nextRef() {
  const A = "ABCDEFGHJKMNPQRSTVWXYZ";
  const n = refN++;
  return `SD-${A[n % 22]}${A[Math.floor(n / 22) % 22]}7K`;
}

export async function seedCompany(name = "Acme", domain = "acme.example") {
  const company = await db.company.create({ data: { name, primaryDomain: domain, sendsAds: true, decision: "REMOVE" } });
  return company;
}

/** A request with one outbound item. `queued` → approved + QUEUED with sendAfter; `sent` → SENT with provider ids. */
export async function seedRequest(opts: {
  companyId: string;
  accountId: string;
  status?: RequestStatus;
  type?: RequestType;
  kind?: string;
  to?: string;
  subject?: string;
  body?: string;
  sendAfter?: Date | null;
  sentAt?: Date | null;
  threadId?: string | null;
  internetMessageId?: string | null;
  providerMessageId?: string | null;
  reference?: string;
  lawKeys?: string[];
  extra?: Record<string, unknown>;
}) {
  const reference = opts.reference ?? nextRef();
  const to = opts.to ?? "privacy@acme.example";
  const subject = opts.subject === undefined ? `Request to delete my data — Ref ${reference}` : opts.subject;
  const body = opts.body ?? `Please delete my data. Ref ${reference}\n\nSara Al-Harbi\n`;
  const kind = opts.kind ?? "INITIAL";
  const request = await db.request.create({
    data: {
      companyId: opts.companyId,
      mailAccountId: opts.accountId,
      type: opts.type ?? "ERASURE_OBJECTION",
      status: opts.status ?? "QUEUED",
      reference,
      lawKeys: opts.lawKeys ?? ["PDPL"],
      citationsText: "the Saudi Personal Data Protection Law",
      ...(opts.extra ?? {}),
    },
  });
  const hash = computeDraftHash(to, subject, body);
  const out = await db.outboundMessage.create({
    data: {
      requestId: request.id, kind, templateId: kind === "ONE_CLICK_POST" ? "one-click" : "6a", templateVersion: "1", language: "en",
      toAddress: to, subject: kind === "ONE_CLICK_POST" ? null : subject, bodyText: body,
      draftHash: kind === "ONE_CLICK_POST" ? computeDraftHash(to, null, body) : hash,
      approvedHash: kind === "ONE_CLICK_POST" ? computeDraftHash(to, null, body) : hash,
      approvedAt: T0,
      sendAfter: opts.sendAfter === undefined ? new Date(T0.getTime() + 10_000) : opts.sendAfter,
      sentAt: opts.sentAt ?? null,
      threadId: opts.threadId ?? null,
      internetMessageId: opts.internetMessageId ?? null,
      providerMessageId: opts.providerMessageId ?? null,
    },
  });
  return { request, out };
}

// ---------- Gmail / Graph fakes ----------

export type Captured = { url: URL; method: string; body: string | null; headers: Record<string, string> };

export function decodeRaw(raw: string) {
  return Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

/** Gmail fake: sends get sequential ids in thread t-<n> unless a threadId is given. */
export function gmailFake(opts: { messages?: Record<string, { threadId: string; headers: { name: string; value: string }[]; raw?: string }>; sendStatus?: number } = {}) {
  const calls: Captured[] = [];
  let n = 0;
  const sent: { id: string; threadId: string; raw: string; mime: string }[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url, method, body: typeof init?.body === "string" ? init.body : null, headers });
    if (url.pathname.endsWith("/messages/send") && method === "POST") {
      if (opts.sendStatus && opts.sendStatus >= 400) return new Response("err", { status: opts.sendStatus });
      const b = JSON.parse(String(init?.body)) as { raw: string; threadId?: string };
      const id = `g${++n}`;
      const threadId = b.threadId ?? `t-${id}`;
      sent.push({ id, threadId, raw: b.raw, mime: decodeRaw(b.raw) });
      return json({ id, threadId, labelIds: ["SENT"] });
    }
    const m = /\/messages\/([^/?]+)$/.exec(url.pathname);
    if (m && method === "GET") {
      const id = decodeURIComponent(m[1]);
      const s = sent.find((x) => x.id === id);
      if (s) {
        const mid = /^Message-ID: (.+)$/im.exec(s.mime)?.[1]?.trim();
        // No internalDate: the dispatcher's clock is the send time (keeps fake-clock tests consistent).
        return json({ id, threadId: s.threadId, payload: { headers: [{ name: "Message-ID", value: mid }] } });
      }
      const msg = opts.messages?.[id];
      if (!msg) return new Response("nf", { status: 404 });
      if (url.searchParams.get("format") === "raw") {
        return json({ id, threadId: msg.threadId, raw: Buffer.from(msg.raw ?? "").toString("base64url") });
      }
      const wanted = url.searchParams.getAll("metadataHeaders").map((h) => h.toLowerCase());
      const hs = wanted.length ? msg.headers.filter((h) => wanted.includes(h.name.toLowerCase())) : msg.headers;
      return json({ id, threadId: msg.threadId, internalDate: String(T0.getTime()), payload: { headers: hs } });
    }
    throw new Error(`Unmocked fetch: ${method} ${url.href}`);
  };
  return { fn, calls, sent };
}

/** Graph fake: create → draft id; createReply; PATCH; send (202); GET $select. */
export function graphFake() {
  const calls: Captured[] = [];
  const drafts = new Map<string, { id: string; internetMessageId: string; conversationId: string; subject?: string; to?: string; body?: string; sent?: boolean; replyTo?: string }>();
  let n = 0;
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({ url, method, body, headers });
    const path = decodeURIComponent(url.pathname.replace("/v1.0/me", ""));
    const parsed = body ? (JSON.parse(body) as { subject?: string; toRecipients?: { emailAddress: { address: string } }[]; body?: { content: string } }) : {};
    if (path === "/messages" && method === "POST") {
      const id = `AAMk${++n}`;
      const d = { id, internetMessageId: `<${id}@outlook.example>`, conversationId: `conv-${id}`, subject: parsed.subject, to: parsed.toRecipients?.[0]?.emailAddress.address, body: parsed.body?.content };
      drafts.set(id, d);
      return json(d, 201);
    }
    let m = /^\/messages\/([^/]+)\/createReply$/.exec(path);
    if (m && method === "POST") {
      const orig = drafts.get(m[1]);
      const id = `AAMk${++n}`;
      const d = { id, internetMessageId: `<${id}@outlook.example>`, conversationId: orig?.conversationId ?? "conv-x", replyTo: m[1], to: "sara@outlook.com" };
      drafts.set(id, d);
      return json(d, 201);
    }
    m = /^\/messages\/([^/]+)\/send$/.exec(path);
    if (m && method === "POST") {
      const d = drafts.get(m[1]);
      if (d) d.sent = true;
      return new Response(null, { status: 202 });
    }
    m = /^\/messages\/([^/]+)$/.exec(path);
    if (m && method === "PATCH") {
      const d = drafts.get(m[1])!;
      Object.assign(d, { subject: parsed.subject ?? d.subject, to: parsed.toRecipients?.[0]?.emailAddress.address ?? d.to, body: parsed.body?.content ?? d.body });
      return json(d);
    }
    if (m && method === "GET") {
      const d = drafts.get(m[1]);
      if (!d) return new Response("nf", { status: 404 });
      return json({ id: d.id, internetMessageId: d.internetMessageId, conversationId: d.conversationId });
    }
    throw new Error(`Unmocked fetch: ${method} ${url.href}`);
  };
  return { fn, calls, drafts };
}

// ---------- tiny ZIP reader (central directory + inflateRaw) ----------

export function readZip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    const lnlen = buf.readUInt16LE(local + 26);
    const lxlen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lnlen + lxlen;
    const data = buf.subarray(start, start + csize);
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    p += 46 + nlen + xlen + clen;
  }
  return out;
}
