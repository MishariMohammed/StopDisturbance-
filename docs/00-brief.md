# 00 — Build Brief: StopDisturbance v1

Source of truth for the developer. Where this brief and a specialist doc disagree, **this brief wins**; decisions and reasons are in `00-review.md` (D1–D15). Specialist docs: 01-research, 02-capabilities, 03-legal, 04-ux.

---

## 1. Goal and non-goals

**Goal.** A private web app for one owner (a KSA resident). It scans the owner's Gmail and Outlook.com headers, groups senders into companies, and lets the owner choose Keep / Unsubscribe only / Remove for each company. It then drafts legally grounded requests from templates, with the law detected per company. After per-item approval it sends them from the owner's own mailbox, does RFC 8058 one-click unsubscribes, or guides web forms. Finally it tracks replies, deadlines, a single reminder and regulator escalation.

| v1 | Later | Never |
|---|---|---|
| Gmail + Outlook.com connect; headers-only scan; incremental sync by polling | Gmail Pub/Sub push | Multi-user / multi-tenant, signup, billing |
| Rules classification; optional DeepSeek for ambiguous senders (gated, default off) | LLM reply classification (built in M6 as opt-in, default off) | Google verification / CASA (not needed for personal use) |
| Contact cascade incl. datarequests.org + JustDeleteMe snapshots, privacy.txt, policy scrape, portal detection | "Known brokers" pack (off by default, 01 §3) | Authorized-agent flows, DRP, GPC |
| Jurisdiction detection (03 §5); templates 6a/6a-AR/6b/6c/6d/6e | Art. 15 access request 6 months after completion; PDF evidence export | Auto-send without per-item approval |
| Email send, one-click POST, mailto unsubscribe, web-form guide | Logo.dev logos; M365 for an employer tenant | CAPTCHA solving; LLM-written letters or citations |
| Tracker: statuses, deadlines, reminder, escalation wizard, "still emailing" flag, ZIP evidence export | Hijri-first display options beyond tooltip | Storing scanned email bodies; "unsubscribe" by filtering to Trash |
| M365 mailbox **only** if the owner is the tenant admin | Local / alternative LLM providers beyond `LLM_BASE_URL` swap | Filing complaints on the owner's behalf |
| Arabic + English UI (RTL), self-sent notifications, erase-everything | | |

---

## 2. Final decisions

| Topic | Decision | Source |
|---|---|---|
| Gmail scopes | `gmail.readonly` + `gmail.send` + `openid email profile`; one consent; scan uses `format=metadata` only | 00-review D1, D10; 02 §1 |
| Google publishing | External, **In production, unverified** (Internal if Workspace). Testing = fallback | D2; 02 §1.6 |
| Microsoft | `Mail.Read Mail.Send offline_access openid email profile User.Read`; `AzureADandPersonalMicrosoftAccount`, `/common`, tenant allow-list; Web (confidential) client | D1, D9; 02 §2 |
| App login | Better Auth (Google + Microsoft social, identity scopes only), allow-list `OWNER_EMAILS`, then pin `sub`/`oid` | D4; 02 §7.3 |
| Mailbox OAuth | Separate flows: `google-auth-library`, `@azure/msal-node`; tokens AES-256-GCM | D4; 02 §7.3 |
| Hosting | Railway: one image, `web` + `worker` services, Railway Postgres, daily backups, EU West | D4; 02 §8 |
| Jobs | pg-boss (direct DB URL), `schedule()` for crons | 02 §8 |
| LLM | DeepSeek via `openai` SDK, `baseURL=https://api.deepseek.com`, model `deepseek-flash`, thinking disabled, JSON mode; **default Rules only**; gated | D3; 02 §6 |
| LLM uses | Ambiguous sender classification, brand/alias merge suggestions, sector, contact extraction from public policy text. Reply classification: separate opt-in. **Never letters** | D3, D12 |
| Laws | PDPL always; GDPR/UK GDPR only with EU/UK establishment; CAN-SPAM for US marketing senders; CCPA only if owner sets US-state residence | 03 §5, M1–M3 |
| Deadlines | PDPL 30 (+30 notified); GDPR/UK 1 month (+2); CAN-SPAM 10 business days; reminder at due+3 (max 1); escalate at max(reminder+7, latest lawful deadline) | D8; 03 §5, M7, S3 |
| Statuses | `DRAFT APPROVED QUEUED SENT ACKNOWLEDGED NEEDS_ACTION COMPLETED REFUSED OVERDUE ESCALATED FAILED CLOSED` | D7; 04 §7.1 |
| Send safety | Per-item approval with draft hash; confirm dialog; 10 s undo; ≥30 s spacing; 50/mailbox/day | D5, D6, D14; 04 §5.7, §6.5 |
| Retention | Headers + subjects 90 days after the scan; evidence closed + 1 year (1–3 configurable); LLM payload ring buffer of 20 (≤7 days) | D11 |
| Notifications | Owner's mailbox to itself; weekly digest Sunday 09:00 Asia/Riyadh | D15; 04 §8 |
| Letter language | KSA company → Arabic + English; others → English (Arabic optional) | 03 §5, M13 |

---

## 3. Architecture

**Processes** (same Docker image, `output: "standalone"`):
- `web`: `next start`. Serves UI, route handlers, OAuth callbacks. Never runs long jobs; it enqueues pg-boss jobs.
- `worker`: `node dist/worker.js`. Runs pg-boss handlers and crons: sync, resolve, classify, enrich, send dispatcher, reply poller, deadline tick, retention purge, dataset refresh.

**Stack (pin exact versions in `package.json` at M1; use the current stable major of each):**
`next`, `react`, `react-dom`, `typescript`, `tailwindcss`, `next-intl` (locale routes `/ar`, `/en`), `prisma` + `@prisma/client`, `pg-boss`, `better-auth`, `google-auth-library`, `@googleapis/gmail`, `@azure/msal-node` (Graph via `fetch` + JSON `$batch`), `openai`, `zod`, `tldts`, `nodemailer` (MailComposer only, for raw MIME), `mailparser` (reply/DSN parsing), `undici` (outbound HTTP), `ipaddr.js` (SSRF guard), `cheerio` (policy HTML → text/links), `date-fns` + `@date-fns/tz`, `pino` (with redaction), `archiver` (evidence ZIP). Dev: `vitest`, `@playwright/test`, `@axe-core/playwright`, `eslint` with a rule banning physical-direction Tailwind classes (04 §11.2).

**Data files in repo:** `data/esp-domains.json`, `data/esp-fingerprints.json`, `data/freemail-domains.json`, `data/portal-patterns.json`, `data/sensitive-subject-patterns.json` (EN+AR), `data/reply-keywords.json` (EN+AR). Snapshots in DB: datarequests.org `companies/` + `supervisory-authorities/` (CC0) and JustDeleteMe `sites.json` (MIT), refreshed weekly.

**Env vars / secrets** (Railway secret store; never in repo):

| Var | Purpose |
|---|---|
| `DATABASE_URL` / `DATABASE_URL_DIRECT` | Prisma (web) / pg-boss + migrations (worker) |
| `APP_URL` | Public HTTPS origin; OAuth redirect base |
| `BETTER_AUTH_SECRET` | Session signing |
| `OWNER_EMAILS` | Comma list allowed to log in (first login pins `sub`/`oid` in `Owner`) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_PUBLISHING_MODE` (`production`\|`testing`) | Google login + Gmail |
| `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_ALLOWED_TENANTS` | Microsoft login + Graph; consumer tenant always allowed |
| `TOKEN_ENC_KEYS` | JSON `{ "1": "<base64 32 bytes>" }`; `TOKEN_ENC_KEY_CURRENT=1` |
| `DEEPSEEK_API_KEY`, `LLM_BASE_URL` (default `https://api.deepseek.com`), `LLM_MODEL` (default `deepseek-flash`) | LLM (optional) |
| `MESSAGE_ID_DOMAIN` | Right-hand side of our `Message-ID` (the app's domain) |
| `TZ_DEFAULT` = `Asia/Riyadh` | Deadlines and crons |

---

## 4. Data model (Prisma-style sketch)

```prisma
model Owner {            // exactly one row
  id String @id
  fullName String; country String @default("SA"); usState String?
  locale String @default("ar"); numerals String @default("latn"); timezone String @default("Asia/Riyadh")
  loginEmails String[]; googleSub String?; msOid String?
  employerDomains String[]           // never listed as companies (04 §5.1)
}
model MailAccount {
  id String @id; provider Provider   // GOOGLE | MICROSOFT
  address String @unique; providerUserId String; tenantId String?
  grantedScopes String[]; tokenCipher Bytes; tokenKeyVersion Int
  status AccountStatus               // ACTIVE | NEEDS_RECONNECT | DISCONNECTED
  syncCursor Json?                   // {historyId} or {folders:{inbox:deltaLink,...}}
  scanFrom DateTime; lastSyncAt DateTime?; scanProgress Json?
  sentToHashes String[]              // SHA-256 of addresses the owner wrote to (personal filter)
}
model MessageHeader {    // RETENTION: delete 90 days after createdAt
  id String @id; accountId String; providerMsgId String; threadId String?
  internetMessageId String?; receivedAt DateTime
  fromAddress String; fromName String?; fromDomain String  // registrable
  replyToDomain String?; returnPathDomain String?; dkimDomains String[]
  dkimPass Boolean; dkimCoversListUnsub Boolean
  subject String?                    // for UI only, never logged
  listUnsubHttps String? @db.Text    // encrypted at rest (contains user token)
  listUnsubMailto String?; oneClick Boolean; listId String?; feedbackId String?
  precedence String?; autoSubmitted String?; labels String[]; esp String?
  isMarketing Boolean; isTransactional Boolean; isPersonal Boolean
  senderId String?
  @@unique([accountId, providerMsgId])
}
model Sender {           // aggregates kept after header purge
  id String @id; registrableDomain String @unique; displayName String?
  companyId String?; isEsp Boolean; isPersonal Boolean
  msgCount Int; marketingCount Int; transactionalCount Int
  firstSeen DateTime; lastSeen DateTime; hasOneClick Boolean
  exampleSubjects String[]           // ≤3, redacted; RETENTION: cleared at 90 days
  accountIds String[]
}
model Company {
  id String @id; name String; primaryDomain String
  holdsData Boolean; sendsAds Boolean; isBroker Boolean @default(false)
  confidence Confidence              // HIGH | MEDIUM | LOW
  sector String?; jurisdiction Json? // {facts:[{key,value,confidence,source}], lawKeys, regulator, deadlineDays}
  decision DecisionValue?            // KEEP | UNSUBSCRIBE | REMOVE (current)
  logoPath String?; enrichedAt DateTime?
}
model CompanyDomain { domain String @id; companyId String; source String /* psl|llm|manual */ }
model CompanyContact {
  id String @id; companyId String
  kind ContactKind     // PRIVACY_EMAIL | WEB_FORM | ONE_CLICK | MAILTO_UNSUB | ACCOUNT_DELETE_URL | SUPPORT_EMAIL
  value String; source String  // override|datarequests|justdeleteme|privacy_txt|policy_scrape|portal_pattern|guess|sender
  confidence Confidence; mxOk Boolean?; portalVendor String?; lastVerifiedAt DateTime; ownerConfirmed Boolean
}
model Classification {
  id String @id; senderId String?; companyId String?
  method String /* RULES|LLM|MANUAL */; labels String[]; ruleIds String[]
  confidence Confidence; llmCallId String?; createdAt DateTime
}
model Decision { id String @id; companyId String; value DecisionValue; viaBulk Boolean; createdAt DateTime } // history
model Request {          // one case per company per decision; RETENTION: closedAt + retentionYears
  id String @id; companyId String; mailAccountId String
  type RequestType       // ERASURE_OBJECTION | STOP_MARKETING | ONE_CLICK | MAILTO_UNSUB | WEB_FORM
  status RequestStatus; needsActionReason String?  // ID_VERIFICATION | WEB_FORM | CLARIFICATION
  reference String @unique           // "SD-7F3K", in subject
  lawKeys String[]; citationsText String; lowConfidenceWording Boolean
  clockStart DateTime?; dueAt DateTime?; latestDueAt DateTime?; extendedDueAt DateTime?
  reminderOfferedAt DateTime?; escalationOpenAt DateTime?; complaintWindowEndsAt DateTime?
  extensionClaimed Boolean @default(false); stillEmailing Boolean @default(false); bounced Boolean @default(false)
  complaintRef String?; closedAt DateTime?
}
model OutboundMessage {
  id String @id; requestId String
  kind String /* INITIAL|REMINDER|ID_REPLY|UNSUB_MAILTO|ONE_CLICK_POST */
  templateId String; templateVersion String; language String
  toAddress String?; subject String?; bodyText String?; draftHash String
  approvedHash String?; approvedAt DateTime?; sendAfter DateTime?; sentAt DateTime?
  providerMessageId String?; threadId String?; internetMessageId String?
  httpStatus Int?; error String?; attempts Int @default(0)
}
model InboundReply {
  id String @id; requestId String; providerMsgId String; receivedAt DateTime
  fromAddress String; subject String; bodyCipher Bytes      // evidence, encrypted
  matchMethod String; probable Boolean; suggestedClass String?; ownerConfirmed Boolean?
}
model EvidenceHeader { id String @id; requestId String; receivedAt DateTime; rawHeadersCipher Bytes } // post-request marketing
model RequestEvent { id String @id; requestId String; type String; actor String /*OWNER|SYSTEM*/; at DateTime; data Json }
model AuditLog { id BigInt @id @default(autoincrement()); at DateTime; action String; entity String?; entityId String?; data Json } // append-only (DB trigger blocks UPDATE)
model Setting { key String @id; value Json } // aiMode, deepseekTrainingOptOutConfirmedAt, replyAiEnabled, retentionYears, sendCapPerDay, notifications, hideSubjects
model LlmCallLog { id String @id; at DateTime; purpose String; model String; inTokens Int; cacheHitTokens Int; outTokens Int; payloadHash String; fieldNames String[]; ok Boolean } // RETENTION 90 days
model LlmPayloadSample { id String @id; callId String; payloadCipher Bytes; createdAt DateTime } // ring buffer: newest 20, max 7 days
model DatasetSnapshot { source String @id; version String; fetchedAt DateTime; data Json }
model AppEvent { id BigInt @id @default(autoincrement()); at DateTime; name String; props Json } // 04 §14; no content/addresses; RETENTION 1 year
```

**Retention job (daily):**
- Delete `MessageHeader` rows and clear `Sender.exampleSubjects` older than 90 days.
- Delete requests (and their messages, replies, evidence and events) where `closedAt + retentionYears` has passed.
- Prune `LlmCallLog` older than 90 days. Keep only the newest 20 `LlmPayloadSample` rows, none older than 7 days.
- Delete `AppEvent` rows older than 1 year.

**Erase everything:**
1. Revoke Google tokens (`oauth2.googleapis.com/revoke`).
2. Remove the Microsoft grant where the API allows. Otherwise show the account.live.com/consent link.
3. Truncate all tables except `AuditLog` entries for sent requests, and keep those only if the owner opts in.

---

## 5. Pipeline

| Stage | Trigger / job | Input | Output | Rules |
|---|---|---|---|---|
| **1 Sync** | `sync.initial` on connect / range change; `sync.incremental` every 10 min | MailAccount + cursor | `MessageHeader` rows, cursor, progress | Gmail: `messages.list` with `q=newer_than:{N}y`, `includeSpamTrash=true`, skip `TRASH`; `get(format=metadata, metadataHeaders=[From, Sender, Reply-To, To, Subject, Date, Message-ID, In-Reply-To, References, List-Unsubscribe, List-Unsubscribe-Post, List-Id, Feedback-ID, Precedence, Auto-Submitted, DKIM-Signature, Authentication-Results, Return-Path])` batched ≤50; token bucket at 80% of 6,000 units/min; `history.list` incremental, 404 → full resync. Graph: per-folder delta (`inbox`, `junkemail`, `archive`, `sentitems`), per-message `$select=internetMessageHeaders,...` via `$batch` 20, ≤3 concurrent, honour `Retry-After`. Sent mail populates `sentToHashes` only; its content isn't stored. `To` is never stored in clear. **No `format=full` in this stage** (enforced by a single `gmailFetch()` wrapper with a unit test). |
| **2 Resolve** | after each sync page | MessageHeader | Sender, Company, CompanyDomain | `tldts` registrable domain. ESP domains are never brands. Prefer the DKIM-aligned From domain, then brand `d=`, then display name, then List-Unsubscribe host (02 §4). **Personal filter** (runs before anything else): free-mail sender with no list/ESP signals, or From in `sentToHashes`, or owner/employer domain → `isPersonal`, excluded from the company list and the LLM (03 §9). Manual merge/split writes CompanyDomain `manual` and is never overridden. |
| **3 Classify** | after resolve | Sender aggregates | Classification, Company flags + confidence | Rules first (02 §3.4; 04 §5.5 confidence). Unsettled senders go to the LLM only if `aiMode=DEEPSEEK` and the gate is met. Batches of 50, payload per §8. Output is checked with a Zod schema, with one retry on failure. LLM results are labelled "AI suggestion" and never override manual edits. |
| **4 Enrich contacts** | `enrich.company`, background after scan; decided companies first | Company domains, datasets, headers | CompanyContact, portal flag, JDM link, favicon | Cascade (01 §2.4): override → datarequests.org → JustDeleteMe → `/.well-known/privacy.txt` → policy page (footer links incl. Arabic "سياسة الخصوصية"; regex `mailto:` with `privacy|dpo|gdpr|dataprotection|datenschutz`; portal patterns 01 §2.3; LLM extraction from stripped text only in AI mode) → guess `privacy@` then `dpo@` with MX check (LOW, needs owner confirmation) → sender support address. Channels from headers: ONE_CLICK only if HTTPS URI + `List-Unsubscribe-Post`, `Authentication-Results dkim=pass`, and that signature's `h=` covers both headers. All fetches: SSRF guard (resolve DNS, reject private/loopback/link-local), 10 s timeout, ≤3 redirects, cache 30 days. |
| **5 Jurisdiction** | after enrich | Company facts | `Company.jurisdiction` | 03 §5 decision table, rows additive. Facts and confidence come from: `.sa` TLD / CR / Arabic site (KSA), datarequests `relevant_countries` and address, policy text naming the controller entity or an EU/UK establishment, US address → `is_us_sender`. Low confidence → include with "to the extent applicable" (M6). Never claim Art. 3(2). Regulator: SDAIA; EU lead SA from the datarequests authorities list; ICO; FTC. |
| **6 Draft** | "Create N drafts" | Company, decision, contacts, jurisdiction, Owner | Request (`DRAFT`) + OutboundMessage | REMOVE → 6a (email) + a ONE_CLICK item if eligible. UNSUBSCRIBE → ONE_CLICK, else MAILTO_UNSUB, else 6d letter, else WEB_FORM guide. Web-form-only contact → WEB_FORM with the 6a text as the copy block. Template placeholders are filled locally. Subject carries `Ref SD-XXXX`. `email_addresses` = mailboxes that received mail from this company. Sending mailbox = the one with most mail from it (changeable). `draftHash = sha256(to+subject+body)`. |
| **7 Approve** | owner action | Draft | `APPROVED`, `approvedHash`, RequestEvent + AuditLog | Any edit after approval clears approval. Confirmation dialog (04 §6.5) → `QUEUED`, `sendAfter = now + 10 s`. Undo → back to `APPROVED`. |
| **8 Send / unsubscribe** | `send.dispatch` cron every 15 s, serial per mailbox | QUEUED items | `SENT` / `FAILED`, provider IDs, `clockStart` | Precondition: `approvedHash == draftHash`, under cap (50/day/mailbox), ≥30–60 s since last send. Gmail: raw MIME (MailComposer; text/plain + simple HTML; our `Message-ID <uuid@MESSAGE_ID_DOMAIN>`; reminders set `threadId`, `In-Reply-To`, `References`, same subject). Graph: create message → read `internetMessageId`/`conversationId` → send; reminders via `createReply`. ONE_CLICK: POST `List-Unsubscribe=One-Click`, form-encoded, no cookies/auth/Referer, SSRF guard, 2xx = SENT. Log host + status only. One retry, then `FAILED` with reason. |
| **9 Track / remind / escalate** | `replies.poll` every 10 min; `deadline.tick` daily 06:00 Asia/Riyadh | Open requests, sync stream | InboundReply, status changes, notifications | Match order: thread/conversation → `In-Reply-To`/`References` → subject token → domain within the open window (probable, owner confirms) (02 §5.2). Reply bodies fetched (`threads.get format=full` / Graph `body`) only for matched replies, stored encrypted. Keyword classifier (EN+AR) suggests the class; LLM only if `replyAiEnabled`, after stripping. Owner confirms, except high-confidence auto-acknowledgements (undoable). DSN/bounce referencing our Message-ID → `FAILED` + `bounced`. Deadline maths below. "Still emailing": marketing from the company received more than 10 business days after `clockStart` → `stillEmailing` + EvidenceHeader (full raw headers via `format=metadata` without a header filter). Unsubscribe-only requests auto-complete when there has been no marketing for 10 business days after the POST/mail. |

**Deadline maths** (`lib/deadlines.ts`, pure functions, 100% unit-tested):
- `clockStart` = provider send time, or the web-form "I submitted it" date the owner enters.
- PDPL: +30 calendar days. Extension to +60 only if the owner records a company notice dated inside the original period.
- GDPR/UK GDPR: +1 calendar month (same day number; if missing, last day of month). Extension +2 more months if notified. **[LAWYER]**
- CAN-SPAM: +10 business days (Mon–Fri, no holiday calendar).
- `dueAt` = earliest applicable deadline (used for OVERDUE). `latestDueAt` = latest applicable deadline including notified extensions.
- Reminder offered at `dueAt + 3 days`. Max 1 reminder, and at most 3 messages per company per case (03 S3).
- `escalationOpenAt = max(reminderSentAt + 7 days, latestDueAt)`.
- `complaintWindowEndsAt` = PDPL due (incl. extension) + 90 days.
- All dates are end-of-day in Asia/Riyadh.

---

## 6. Pages (implement per 04-ux; references, not copies)

| Route | Key requirements |
|---|---|
| `/login` | 04 §2, §4.1. Better Auth; non-owner rejected with a neutral message |
| `/connect` | 04 §3.1, §4.1–4.4. First-run card (language, name, country, **AI assist default Rules only**). One consent per mailbox. Partial-grant handling. Google interstitial (always while unverified) |
| `/scan` | 04 §3.2. Per-account progress, rate-limit countdown, resumable, results visible while running |
| `/companies` | 04 §3.3, §5. Evidence drawer, three decisions, nothing pre-selected, low-confidence excluded from bulk Remove, >25 bulk Remove confirmation, recent-order warning, merge/split without drag, URL-synced filters. Brokers chip hidden in v1 |
| `/review` | 04 §3.4, §6. One-by-one default, list view with **per-row** approve, diff + guardrails, ChannelCard, LawExplainer (§6.3 table), WebFormGuide, SendConfirmDialog, 10 s UndoToast |
| `/tracker`, `/tracker/[id]` | 04 §3.5, §7. Canonical statuses (§7.1), one next action per row, deadline countdown, reply confirm, "I submitted it" for web forms (also usable later), template 6e for ID requests, EscalationWizard (never files), evidence ZIP download, cancel while `QUEUED` |
| `/settings`, `/settings/data` | 04 §3.6. Mailboxes + reconnect, AI assist with **TrainingOptOutGate**, reply-AI opt-in, last-20 AI call log, retention, JSON export, type-to-confirm erase |

Cross-cutting: RTL rules (04 §11), WCAG 2.2 AA checklist (04 §10), design tokens (04 §12), "What we can see" link on every page, analytics only to `AppEvent` (04 §14).

---

## 7. Legal requirements the code must satisfy (03-legal §10)

| Req | Where enforced |
|---|---|
| M1 PDPL always cited; M2 GDPR only on EU/UK establishment; M3 no CCPA unless US-state resident | `lib/jurisdiction.ts` (decision table 03 §5) + unit tests per table row |
| M4 per-item approval + logged hash; no auto-send | Stage 7/8 precondition; DB check `approvedHash = draftHash` in dispatcher; test that edits revoke approval |
| M5 own mailbox, own name; never "on behalf of"/"via StopDisturbance" | Templates; lint test greps rendered letters for banned phrases |
| M6 conditional wording at low confidence | `citationsText` builder uses "to the extent applicable" when any used fact is LOW |
| M7 deadlines incl. SDAIA 90-day window | `lib/deadlines.ts` |
| M8 evidence bundle | OutboundMessage + InboundReply + EvidenceHeader + RequestEvent; ZIP export (EML + JSON timeline) |
| M9 never ID documents by default; warn + redaction guidance | PersonalDataChips (ID off), edit guardrail, 6e template, NEEDS_ACTION copy |
| M10 LLM minimisation | §8 below; `buildLlmPayload()` |
| M11 DeepSeek training opt-out recorded before first use | TrainingOptOutGate + `LlmClient` refusal |
| M12 decided scopes, encrypted tokens, delete-all + revoke | §3, §4 erase |
| M13 Arabic + English PDPL letters | Templates 6a-AR, 6b-AR, 6c-AR, 6d-AR; [LAWYER] review flag in UI until the owner marks them reviewed |
| S1–S7 | S1 stage 4/5; S2 channel order; S3 deadline maths; S4 stillEmailing; S5 release checklist; S6 `LLM_BASE_URL`; S7 LawExplainer "why" line |

Templates live in `templates/{id}.{lang}.md` with a version string. Citations come **only** from 03-legal; changing a citation is a code review item.

---

## 8. Security and privacy

- **Access:** only the owner. Better Auth sessions use secure, HttpOnly, SameSite=Lax cookies with CSRF protection and HTTPS only. The allow-list check happens at the callback, and the first login pins `sub`/`oid`.
- **Tokens:** AES-256-GCM, random 96-bit IV, `{v, iv, tag, ct}` plus key version. Microsoft refresh tokens are rotated and persisted on every use. Only the latest Google refresh token is kept.
- **Logs:** pino redaction of `subject`, `from*`, `to*`, `body`, `token`, `authorization`, and URLs with query strings. Logs never contain header values or subjects.
- **Outbound HTTP:** a single `safeFetch()` with the SSRF guard (applies to policy scrape, privacy.txt, favicon, one-click).
- **Headers only for the scan:** `gmailFetch()` / `graphFetch()` wrappers allow body fetch only for message IDs in matched reply threads or DSNs. A test asserts this.
- **Backups:** Railway daily Postgres backups. Tokens and reply bodies stay encrypted inside them. A restore drill is part of M6.
- **Exactly what may be sent to DeepSeek** (Zod `.strict()` schemas in `buildLlmPayload(kind, input)`; anything else throws; unit tests per kind; `LlmClient` refuses unless `aiMode=DEEPSEEK` and `deepseekTrainingOptOutConfirmedAt` is set):
  1. `classifySenders`: per non-personal sender `{domain, displayName (owner name redacted), flags:{listUnsub, oneClick, listId, feedbackId, esp, gmailCategory, outlookFocused, junk, precedence, autoSubmitted}, msgCount, subjects[≤3]}`. Subjects are redacted (digits ≥4, emails, URLs, owner names → placeholders), and subjects matching sensitive patterns (medical, bank, password, OTP, legal; EN+AR) are dropped.
  2. `extractContact`: `{domain, policyUrl, policyText (public page, stripped, ≤20k chars)}`.
  3. `classifyReply` (only if `replyAiEnabled`): `{text}` with quoted text and signature removed, and owner name/emails/phone/address, reference numbers, digits ≥4, URLs and emails redacted. Max 4k chars.
  - **Never sent:** message bodies of scanned mail, attachments, To/CC, the owner's identity, tokens, letters, full header blocks, personal-correspondent data.
- **Erase and disconnect:** as in §4. The disconnect flow revokes the token and deletes that account's headers.

---

## 9. Milestones and acceptance criteria

**M1: Skeleton, auth, Gmail sync**
- Docker image runs `web` and `worker` on Railway. Prisma migrations apply. `/healthz` checks the DB and pg-boss.
- Login: an owner email signs in; any other Google account gets 403 (integration test with a mocked IdP).
- Gmail connect stores an encrypted token (DB inspection shows no plaintext). Granted scopes are checked, and the Partial state renders if `send` is missing.
- Initial sync of a test mailbox writes `MessageHeader` rows with the allow-listed headers only. A unit test proves that `format=full` is unreachable from the sync code. Incremental sync picks up a new message within 10 min, and a 404 history triggers a full resync.
- Throttle test: a simulated 429 backs off and resumes.
- **Spike:** the Gmail refresh token still refreshes on day 8 in "In production, unverified". Record the result in 00-review.

**M2: Outlook, resolve, classify**
- Outlook.com connect works. A token from a non-allowed tenant is rejected with a message. Rotated refresh tokens are persisted (test).
- Graph delta sync over 4 folders. Headers are fetched via `$batch` with ≤3 concurrent requests, and `Retry-After` is honoured.
- Resolve: fixture set of ≥50 real header samples (ESP-sent, subdomain, alias) maps to the expected company in ≥95% of cases. ESP domains never become companies. The personal filter excludes free-mail individuals and sent-to addresses (tests).
- Rules classifier passes the fixtures. The LLM path is behind the gate. `buildLlmPayload` tests reject any extra field. Rules-only mode makes zero network calls to `LLM_BASE_URL` (test with an intercepted fetch).

**M3: Company list UI**
- `/connect`, `/scan`, `/companies` per 04 in `ar` and `en`. Playwright + axe show 0 serious/critical issues on these pages in both locales.
- Nothing is pre-selected. Low-confidence companies are skipped on bulk Remove with a notice. Bulk Remove >25 shows the confirmation. Filters round-trip via URL. Merge/split works by keyboard only.
- Drawer shows evidence (counts, seen range, 3 subjects, rule) for every row. A company without evidence is not rendered (test).

**M4: Contacts, jurisdiction, drafts, review**
- Contact cascade with SSRF guard (test: a private IP target is refused). The datarequests and JDM snapshot refresh job works. Portal patterns are detected on fixtures.
- **Coverage report:** share of decided companies with a MEDIUM/HIGH contact. Report the number for the owner's mailbox and list KSA companies that fell back to guesses.
- Jurisdiction: one unit test per 03 §5 row (1–10). Low confidence produces "to the extent applicable". No CCPA citation when `usState` is null.
- Drafts render 6a, 6a-AR, 6d and the web-form copy block with all placeholders filled. A test asserts no `{{` remains and no banned phrases appear.
- `/review`: editing after approval clears approval. Diff view works. Per-row approval only.

**M5: Send, unsubscribe, tracker**
- Gmail and Graph sends from the test mailboxes land in Sent, and Message-ID/thread IDs are stored. A reminder threads correctly in Gmail and Outlook.
- Undo within 10 s prevents the send (test). Cap 50/day and ≥30 s spacing are enforced (test with fake clock).
- One-click: POST only when DKIM coverage passes (fixtures for pass/fail). No cookies or Referer are sent (request capture test).
- Reply matching for all 4 methods on fixtures. A bounce becomes `FAILED` + `bounced`.
- `lib/deadlines.ts` tests: PDPL 30/+30, GDPR month-end cases (31 Jan → 28/29 Feb), CAN-SPAM business days across a weekend, reminder/escalation timing, SDAIA window.
- Tracker statuses and next actions per 04 §7. EscalationWizard produces 6c (EN and AR). Evidence ZIP contains EML of sent mail and replies plus a JSON timeline.
- Notifications: self-sent digest and instant alerts arrive in the owner's inbox.

**M6: Hardening and tests**
- Retention job tests (90-day purge; closed + N years). Erase-everything test: tokens revoked (mocked endpoints called), all tables empty except the opt-in audit rows.
- Backup restore drill on a Railway preview environment.
- Full keyboard path connect → send in both locales. Axe 0 serious/critical on all pages. Visual snapshots in `ar` and `en`.
- Log redaction test (seeded subject and token never appear in logs).
- Optional: reply-AI opt-in with stripping tests.
- Release checklist: 03 S5 [VERIFY] items re-checked; Arabic templates reviewed by counsel (or flagged).

---

## 10. Owner setup checklist

1. **Domain and hosting:** create a Railway project (region EU West), add Postgres and enable daily backups. Connect the GitHub repo and create two services from the same image (`web`: `npm run start`; `worker`: `npm run worker`). Attach a custom domain with HTTPS and set `APP_URL`.
2. **Secrets:** generate `BETTER_AUTH_SECRET` and `TOKEN_ENC_KEYS` (`openssl rand -base64 32`), and store a copy in your password manager. Set `OWNER_EMAILS`, `MESSAGE_ID_DOMAIN` and `TZ_DEFAULT=Asia/Riyadh`.
3. **Google Cloud:**
   1. Create project "StopDisturbance" and enable the **Gmail API**.
   2. In Google Auth Platform → Branding, set the app name and your support email.
   3. In Audience, choose **External** (choose **Internal** if your mailbox is Google Workspace and the project is in that org).
   4. In Data access, add the scopes `openid`, `email`, `profile`, `gmail.readonly` and `gmail.send`.
   5. In Clients, create a **Web** client with redirect URIs `{APP_URL}/api/auth/callback/google` and `{APP_URL}/api/mail/google/callback`.
   6. In Audience, click **Publish app → In production**. **Do not submit for verification.**
   7. Put the ID and secret in Railway and set `GOOGLE_PUBLISHING_MODE=production`.
4. **Microsoft Entra:**
   1. In portal.azure.com → Microsoft Entra ID → App registrations → New registration, set account types to **"Any organizational directory and personal Microsoft accounts"**.
   2. Add **Web** platform redirect URIs `{APP_URL}/api/auth/callback/microsoft` and `{APP_URL}/api/mail/microsoft/callback`.
   3. Under API permissions (Delegated), add `openid`, `email`, `profile`, `offline_access`, `User.Read`, `Mail.Read` and `Mail.Send`.
   4. Under Certificates & secrets, create a new client secret (set a calendar reminder before it expires).
   5. Set `MS_CLIENT_ID` and `MS_CLIENT_SECRET`.
   6. Only if you are admin of your own M365 tenant: grant admin consent there and add its tenant ID to `MS_ALLOWED_TENANTS`.
5. **DeepSeek (optional, only if you want AI assist):**
   1. Create an API key at platform.deepseek.com and add a small balance (cost is under $1 per full run, 02 §6.3).
   2. In account settings, **turn off "Improve the model" / training** if offered, and note the date. **[VERIFY]** whether it covers API use.
   3. Set `DEEPSEEK_API_KEY`.
   4. In the app, open Settings → AI assist, tick the opt-out confirmation with the date, then run **Test connection**.
6. **First run:** sign in, complete the first-run card (name exactly as companies know you), connect Gmail (accept the unverified-app warning after checking that the app name and developer email are yours), then connect Outlook and start the scan.
7. **Day 8:** confirm in Settings that Gmail shows "OK · last refreshed" without a reconnect, and report the result (M1 spike).

---

## 11. Open risks and questions for the owner

| # | Question / risk | Recommended answer |
|---|---|---|
| Q1 | Is your Gmail a consumer `@gmail.com` or a Google Workspace domain? | If Workspace, use an **Internal** app (no warning, long-lived tokens); otherwise External + In production. |
| Q2 | Which Microsoft mailboxes: Outlook.com/Hotmail only, or an M365 tenant? | **Outlook.com only in v1.** Add M365 only if you are that tenant's admin; never an employer tenant. |
| Q3 | Will you enable DeepSeek at all, given PRC processing and an unconfirmed API training opt-out? | **Start in Rules only.** Decide after M3 using the misclassification rate. If you want AI, consider a no-training OpenAI-compatible provider via `LLM_BASE_URL`. |
| Q4 | Default letter language for non-Saudi companies? | **English**, with Arabic+English for KSA companies. |
| Q5 | What identifiers go in letters: full legal name, phone? | Name **as companies know you**; email addresses only; **no phone** by default; never ID numbers. |
| Q6 | Will you get a Saudi lawyer to review the Arabic templates and PDPL article numbers before real sends? | **Yes, before M5 go-live.** Until then, send English letters (PDPL cited in English) and keep Arabic as an optional, flagged extra. |
| Q7 | Evidence retention: case closed + 1 year OK? | **Yes** (configurable to 3 years if you expect long complaint processes). |
| Q8 | Risk: Google may still cap refresh-token life for unverified restricted-scope apps in production. | Accept and measure (day-8 check). If it happens, keep In production and rely on the reconnect banner. Switch to Internal if you have Workspace. |
