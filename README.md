# StopDisturbance

A private, single-owner web app that scans your Gmail and Outlook headers, lists the companies that send you ads or hold your data, and sends deletion and stop-marketing requests from your own mailbox after you approve each one.

Specs live in `docs/`. Start with `docs/00-brief.md`.

## Status

| Milestone | State |
|---|---|
| M1 Skeleton, owner login, Gmail sync | done |
| M2 Outlook, resolve, classify | done |
| M3 Company list UI | done |
| M4 Contacts, jurisdiction, drafts, review | done |
| M5 Send, unsubscribe, tracker | done |
| M6 Hardening | done (live checks pending, see docs/RUNBOOK.md) |

## Local development

```bash
cp .env.example .env            # fill in Google client ID/secret and OWNER_EMAILS
openssl rand -base64 32         # put the output in TOKEN_ENC_KEYS {"1": "..."}
npx prisma migrate deploy
npm run dev                     # web on :3000
npm run worker:dev              # background jobs
npm test                        # 405 unit/integration tests; needs Postgres at TEST_DATABASE_URL (default sd:sd@localhost/stopdisturbance_test)
npx playwright test             # 71 e2e tests (ar/en, axe, keyboard journey, screenshots)
```

## Deploying (Railway)

Follow the owner setup checklist in `docs/00-brief.md` §10. Create two services from this repo's Dockerfile:

- **web**: default command (runs migrations, then `next start`)
- **worker**: start command `npm run worker`

Health check: `GET /api/healthz`.

## Privacy guarantees in code

- The scan can only call Gmail with `format=metadata` and a fixed header list (`src/lib/mail/gmail.ts`, tested).
- `To` addresses are stored as SHA-256 hashes only; sent mail itself is never stored.
- OAuth tokens and unsubscribe URLs are AES-256-GCM encrypted (`src/lib/crypto/tokens.ts`).
- Only emails in `OWNER_EMAILS` can sign in, and the first login pins the provider account ID.
