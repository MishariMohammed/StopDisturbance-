import pino from "pino";

// Logs never carry header values, subjects, addresses or tokens (00-brief §8).
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "subject", "*.subject",
      "from", "*.from", "fromAddress", "*.fromAddress", "fromName", "*.fromName",
      "to", "*.to", "toAddress", "*.toAddress",
      "body", "*.body", "bodyText", "*.bodyText",
      "token", "*.token", "tokens", "*.tokens",
      "access_token", "*.access_token", "refresh_token", "*.refresh_token",
      "authorization", "*.authorization", "headers.authorization",
      "url", "*.url",
    ],
    censor: "[redacted]",
  },
});
