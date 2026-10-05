import pino, { type DestinationStream, type Logger } from "pino";

// Logs never carry header values, subjects, addresses, tokens or URL query strings (00-brief §8).
// Two layers: pino `redact` drops known sensitive keys wherever they sit, and `scrubForLog` rewrites
// every remaining string (including error messages and the log message itself) so that email
// addresses, bearer/OAuth/API tokens and URL query strings are replaced before serialisation.

const SENSITIVE_KEYS = [
  "subject", "subjects", "exampleSubjects",
  "from", "fromAddress", "fromName", "replyTo", "sender",
  "to", "toAddress", "cc", "bcc", "address", "email", "emails", "mailbox", "loginEmails",
  "body", "bodyText", "html", "raw", "rawHeaders",
  "token", "tokens", "access_token", "refresh_token", "id_token", "accessToken", "refreshToken", "idToken",
  "authorization", "cookie", "password", "secret", "apiKey", "api_key",
  "url", "href", "listUnsubHttps", "listUnsubMailto",
];

export const REDACT_PATHS = SENSITIVE_KEYS.flatMap((k) => [k, `*.${k}`]);

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// scheme://host/path?query  → keep scheme+host+path, drop the query and fragment.
const URL_QUERY_RE = /\b((?:https?|wss?):\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi;
const TOKEN_RES = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\bya29\.[A-Za-z0-9._-]+/g, // Google access tokens
  /\b1\/\/[A-Za-z0-9._-]{10,}/g, // Google refresh tokens
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, // JWTs (id_token, MS access tokens)
  /\bM\.[A-Z0-9]{2,}_[A-Za-z0-9!*.$-]{20,}/g, // Microsoft consumer refresh tokens
  /\bsk-[A-Za-z0-9_-]{8,}/g, // API keys
  /\b(?:access_token|refresh_token|id_token|code|token|key|t)=[^\s&"']+/gi,
];

export function scrubString(s: string): string {
  let out = s.replace(URL_QUERY_RE, "$1?[redacted]");
  for (const re of TOKEN_RES) out = out.replace(re, "[redacted]");
  return out.replace(EMAIL_RE, "[email]");
}

/** Deep copy with every string scrubbed. Errors become `{ type, message }` (scrubbed, no stack). */
export function scrubForLog(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value !== "object" || depth > 6) return value;
  if (value instanceof Error) return { type: value.name, message: scrubString(value.message) };
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((v) => scrubForLog(v, depth + 1));
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `[${value.length} bytes]`;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = scrubForLog(v, depth + 1);
  return out;
}

export function createLogger(destination?: DestinationStream, level = process.env.LOG_LEVEL ?? "info"): Logger {
  const options: pino.LoggerOptions = {
    level,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    formatters: { log: (obj) => scrubForLog(obj) as Record<string, unknown> },
    hooks: {
      logMethod(args, method) {
        const scrubbed = args.map((a) => (typeof a === "string" ? scrubString(a) : a)) as Parameters<typeof method>;
        return method.apply(this, scrubbed);
      },
    },
  };
  return destination ? pino(options, destination) : pino(options);
}

export const logger = createLogger();
