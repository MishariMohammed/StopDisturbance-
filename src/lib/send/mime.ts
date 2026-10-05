import { randomUUID } from "node:crypto";
import MailComposer from "nodemailer/lib/mail-composer";
import { env } from "@/lib/env";

// Raw MIME for every email we send (00-brief §5 stage 8): text/plain + a simple HTML alternative,
// our own Message-ID `<uuid@MESSAGE_ID_DOMAIN>`, and In-Reply-To/References for follow-ups.

export function newMessageId(): string {
  return `<${randomUUID()}@${env().MESSAGE_ID_DOMAIN}>`;
}

/** Normalises `id`, `<id>` → `<id>`. */
export function angle(id: string): string {
  const t = id.trim();
  return t.startsWith("<") ? t : `<${t}>`;
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);

/**
 * Plain text → minimal HTML. Each paragraph gets dir="auto" so Arabic paragraphs render RTL and
 * English ones LTR inside the same Arabic+English letter. No links, images or tracking.
 */
export function textToHtml(text: string, opts: { lang?: string; dir?: "rtl" | "ltr" | "auto" } = {}): string {
  const paras = text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p dir="auto">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
  const lang = opts.lang ? ` lang="${escapeHtml(opts.lang)}"` : "";
  const dir = ` dir="${opts.dir ?? "auto"}"`;
  return `<!doctype html>\n<html${lang}${dir}><head><meta charset="utf-8"></head><body${dir}>\n${paras}\n</body></html>`;
}

export interface MimeInput {
  from: { address: string; name?: string | null };
  to: string;
  subject: string;
  text: string;
  messageId: string;
  /** Message-ID of the message this one answers (reminders, ID replies). */
  inReplyTo?: string | null;
  /** Full chain, oldest first. */
  references?: string[];
  date?: Date;
  /** Skip the HTML alternative (mailto unsubscribe: list servers parse plain text). */
  plainOnly?: boolean;
  lang?: string;
  dir?: "rtl" | "ltr" | "auto";
}

export async function buildMime(input: MimeInput): Promise<Buffer> {
  const composer = new MailComposer({
    from: input.from.name ? { name: input.from.name, address: input.from.address } : input.from.address,
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.plainOnly ? undefined : textToHtml(input.text, { lang: input.lang, dir: input.dir }),
    messageId: angle(input.messageId),
    inReplyTo: input.inReplyTo ? angle(input.inReplyTo) : undefined,
    references: input.references?.length ? input.references.map(angle) : undefined,
    date: input.date ?? new Date(),
    textEncoding: "quoted-printable",
  });
  return composer.compile().build();
}

/** Strips any number of leading Re:/AW:/رد: prefixes, then adds one "Re: " (Gmail threads on the same subject). */
export function replySubject(subject: string): string {
  return `Re: ${subject.replace(/^\s*((re|aw|fwd?|رد)\s*:\s*)+/i, "").trim()}`;
}

export function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
