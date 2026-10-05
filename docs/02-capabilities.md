# 02 — Capabilities & Platform Constraints

Status: research draft, 2026-10-05. Scope: **personal, single-user** deployment (owner's own Gmail + Outlook mailboxes), hosted but not multi-tenant. LLM: **owner's DeepSeek API key** (replaces the Claude API).

> How to read the sources: the research sandbox could not open developers.google.com, support.google.com, learn.microsoft.com or api-docs.deepseek.com directly (they were blocked by the egress proxy). Facts below come from search-engine extracts of those official pages, and the URLs given are the official pages. Items marked **[verify]** come from a secondary source or were ambiguous. Check them during the Week-1 spike.

---

## 0. Scope change summary (what changed vs. the multi-tenant plan)

| Topic | Multi-tenant plan | Personal single-user plan (current) |
|---|---|---|
| Google verification | Restricted-scope verification + CASA (annual, paid) | **Not required.** This counts as a personal-use app under 100 users. You click through the "unverified app" screen once |
| Google refresh-token life | n/a | Set the consent screen to **In production** (not Testing) so tokens don't die after 7 days |
| Microsoft | Multi-tenant + publisher verification + admin-consent problems | App registration in the owner's own directory. Consumer accounts work with user consent. A work M365 mailbox in an employer tenant needs that employer's admin consent |
| LLM | Claude API | DeepSeek API (OpenAI-compatible). Data is processed in the PRC, so minimise what is sent |
| Hosting/security | KMS, audit trails, tenant isolation | One container + Postgres. App-level AES-GCM token encryption. Login locked to one allow-listed identity |

---

## 1. Gmail API

### 1.1 Scopes
Source: https://developers.google.com/workspace/gmail/api/auth/scopes

| Scope | Grants | Class |
|---|---|---|
| `https://www.googleapis.com/auth/gmail.metadata` | Message IDs, labels, headers, history. No bodies or attachments | **Restricted** |
| `https://www.googleapis.com/auth/gmail.readonly` | Read all messages, threads and settings, including bodies | **Restricted** |
| `https://www.googleapis.com/auth/gmail.send` | Send only. Cannot read | **Sensitive** |
| `openid email profile` | Identity | Non-sensitive |

Limits of `gmail.metadata`:
- `messages.list` / `threads.list` **reject the `q` search parameter**. You can filter only by `labelIds`, e.g. `CATEGORY_PROMOTIONS`.
- `format=full` and `format=raw` are not allowed. Only `format=metadata` (with optional `metadataHeaders=` allow-list) and `minimal` work. Sources: https://developers.google.com/workspace/gmail/api/release-notes and https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get
- Known pitfall: a token that carries **both** `gmail.metadata` and `gmail.readonly` keeps the metadata restrictions. `q` and `format=full` then fail with 403. Request one or the other, never both. (Nylas: https://developer.nylas.com/docs/cookbook/use-cases/build/google-oauth-scopes/ **[verify]**)

**Recommendation (personal use): `gmail.readonly` + `gmail.send`.**
- Verification is not in play, so there is no reviewer pushing for the narrowest scope.
- `readonly` gives you `q` search, e.g. `category:promotions newer_than:3y`, `has:list-unsubscribe`-style filtering, and `from:` lookups for replies.
- It also lets you read **reply bodies** ("please verify your identity" vs "your data was deleted") and body unsubscribe links as a fallback.
- Still fetch with `format=metadata` + `metadataHeaders` for the scan. Use `format=full` only for threads of requests you sent.

### 1.2 Reading replies
- `threads.get(id, format=metadata|full)` returns the whole conversation in one call. Store the `threadId` of every request you send and poll those threads.
- Matching rules are in §5.

### 1.3 Quotas
Source: https://developers.google.com/workspace/gmail/api/reference/quota

- Per project: 1,200,000 quota units/min.
- Per user: 15,000 units/min. Secondary sources report **6,000/min/user for Cloud projects created after 2026-05-01**. **[verify]** Design for 6,000 to be safe.
- Units per method: `messages.get` = 5, `messages.list` = 5, `history.list` = 2, `messages.send` = 100, `threads.get` = 10, `labels.list` = 1. (get/send/history are confirmed; list/threads/labels are standard values **[verify]**.)
- Implication: a full header scan of 50,000 messages costs about 50k × 5 = 250k units.
  - At 6,000 units/min that takes about 42 min.
  - At 15,000 units/min it takes about 17 min.
  - Run it as a background job with token-bucket throttling at about 80% of the limit, and use exponential backoff on 429 / `rateLimitExceeded`.
- Gmail also has daily sending limits per account (consumer accounts: about 500 recipients/day), set by Gmail rather than the API. This is irrelevant at this volume, but don't burst-send 200 requests at once. Space them out, e.g. 1 per 30–60 s.

### 1.4 Batch
Source: https://developers.google.com/workspace/gmail/api/guides/batch

- Max **100 calls per batch** HTTP request. Google says batches above **50** are likely to be rate-limited. Use ≤50.
- Each inner call still consumes its own quota units. Batching saves HTTP round-trips, not quota.

### 1.5 Incremental sync
Source: https://developers.google.com/workspace/gmail/api/guides/sync

1. Initial full sync: page through `messages.list` and record the highest `historyId` seen. `users.getProfile` also returns `historyId`.
2. Then call `history.list?startHistoryId=X&historyTypes=messageAdded` (2 units).
3. A `historyId` is typically valid for **at least a week**, sometimes only hours. **HTTP 404 means do a full sync again.**
4. Push is optional. `users.watch` → Cloud Pub/Sub topic. The watch expires after **7 days**; Google recommends renewing daily. Source: https://developers.google.com/workspace/gmail/api/guides/push
5. **For a single user, skip Pub/Sub.** Poll `history.list` every 10–15 min from the job runner. That is 2 units per poll and needs no GCP Pub/Sub setup or public push endpoint.

### 1.6 OAuth app configuration for personal use (lowest friction)
Sources: https://support.google.com/cloud/answer/13464323 (verification exemptions), https://support.google.com/cloud/answer/7454865 (unverified apps), https://developers.google.com/identity/protocols/oauth2#expiration, https://support.google.com/cloud/answer/15549945 (test users)

| Option | Applies when | Verification / CASA | Refresh token | Friction |
|---|---|---|---|---|
| **User type: Internal** | The mailbox is a **Google Workspace** account and the GCP project is in that Workspace org | **Exempt** (internal-use apps) | Long-lived | None. No warning screen. **Best if the owner's Gmail is a Workspace domain** |
| **External + In production, not submitted for verification** | Consumer `@gmail.com` | Exempt as **personal use (<100 users)**. **No CASA**, because CASA is triggered only by submitting restricted-scope verification | Long-lived. No 7-day expiry. Expires only if unused for 6 months, revoked, or (for Gmail scopes) **on password change** | One click-through on "Google hasn't verified this app" (Advanced → Go to app). The 100-new-user lifetime cap is irrelevant here |
| External + **Testing** | Any | Exempt | **Expires 7 days after consent.** This applies to any scope beyond name/email/profile | Weekly re-consent. **Avoid** |

**Recommendation:**
- Consumer Gmail: create a dedicated GCP project, use user type External, add the scopes, and **set Publishing status to "In production" without submitting for verification**.
- Workspace Gmail: use Internal.
- Either way, request `access_type=offline` and `prompt=consent` on first connect.

Other notes:
- Google issues at most 100 live refresh tokens per Google account per OAuth client. Re-consenting repeatedly silently invalidates the oldest one. Store only the latest token.
- **CASA is avoidable** while the app stays personal. If the app is ever opened to other users, restricted-scope verification plus an annual CASA assessment applies.
  - Tier 2 lab fees are reported at about $540–$1,800/yr (TAC Security). Gmail restricted scopes are reported as increasingly routed to Tier 3 (pen test, thousands of USD).
  - Sources: https://support.google.com/cloud/answer/13465431, https://deepstrike.io/blog/google-casa-security-assessment-2025 **[verify]**
- The Google API Services User Data Policy, including Limited Use, **still applies to unverified apps** (see §7).

---

## 2. Microsoft Graph (Outlook.com and Microsoft 365)

### 2.1 Delegated permissions
Sources: https://learn.microsoft.com/en-us/graph/permissions-reference, https://devblogs.microsoft.com/microsoft365dev/new-basic-read-access-to-a-users-mailbox/

| Permission | Grants | Personal MSA | Work/school |
|---|---|---|---|
| `Mail.ReadBasic` | All message properties **except** `body`, `previewBody`, attachments and extended properties | Yes | Yes |
| `Mail.Read` | Full read, including body | Yes | Yes |
| `Mail.Send` | Send as the signed-in user | Yes | Yes |
| `offline_access` | Refresh token | Yes | Yes |
| `User.Read`, `openid`, `email`, `profile` | Identity | Yes | Yes |

- `internetMessageHeaders` is **returned only when explicitly `$select`ed**. Source: https://learn.microsoft.com/en-us/graph/api/message-get
- It is not listed among the `Mail.ReadBasic` exclusions, but this is **[verify]** in the spike. If it fails under ReadBasic, use `Mail.Read`.
- Retrieve headers per message: `GET /me/messages/{id}?$select=internetMessageHeaders,from,sender,subject,receivedDateTime,conversationId,internetMessageId,inferenceClassification`.
  - Whether list/delta endpoints honour `$select=internetMessageHeaders` is **[verify]**. Plan for a per-message GET via `$batch`.
- **Recommendation:** use `Mail.Read` + `Mail.Send` + `offline_access` (bodies are needed for replies, same reasoning as Gmail).

### 2.2 App registration for personal use
Sources: https://learn.microsoft.com/en-us/entra/identity-platform/application-consent-experience, https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/manage-app-consent-policies, MC1163922 (https://mc.merill.net/message/MC1163922)

- Register the app in a directory the owner controls. A personal MSA can create a free Entra tenant via an Azure account.
- `signInAudience`:
  - `PersonalMicrosoftAccount` if only outlook.com/hotmail.
  - `AzureADandPersonalMicrosoftAccount` with authority `/common` if the owner also wants to connect a work mailbox.
- Use a **Web (confidential client)** redirect URI, **not SPA**. SPA refresh tokens expire after 24 h; other refresh tokens last **90 days** and roll forward on each use. Always persist the newly returned refresh token. Source: https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens
- **Consumer mailbox (outlook.com):** the user consents to their own app. No publisher verification is needed for personal use. The consent screen shows "unverified", which is cosmetic.
- **Work M365 mailbox:**
  - Since the Nov 2025 "secure by default" rollout, tenants on the **Microsoft-managed default user-consent policy** require **admin consent** for third-party apps requesting Exchange mail permissions. `Mail.Read` and `Mail.ReadBasic` are confirmed in the excluded list. `Mail.Send` is reported as included **[verify]**.
  - If the owner **is** the tenant admin (own M365 Business tenant), register the app single-tenant in that tenant and grant admin consent once.
  - If it is an employer tenant, expect "Need admin approval". That is out of scope for v1, and using it may breach employer policy.
- Publisher verification (needs a Microsoft AI Cloud Partner Program ID) is only needed for multi-tenant distribution. **Skip it.** Source: https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview

### 2.3 Delta sync
Sources: https://learn.microsoft.com/en-us/graph/delta-query-messages, https://learn.microsoft.com/en-us/graph/api/message-delta

- Delta works **per mail folder**: `GET /me/mailFolders/{id}/messages/delta`.
- Put `$select` / `$filter` / `changeType` on the **initial** request only. They are encoded into `@odata.nextLink` / `@odata.deltaLink`.
- Persist the `deltaLink` per folder and replay it on each poll.
- Folders to track: `inbox`, `junkemail` (marketing often lands there), `archive`, and optionally `sentitems` (to capture `internetMessageId` of your own sends).

### 2.4 Throttling
Source: https://learn.microsoft.com/en-us/graph/throttling-limits

- Outlook limits per app ID per mailbox:
  - **10,000 requests / 10 min**
  - **4 concurrent requests**
  - 150 MB upload / 5 min (older figure: 15 Mb / 30 s **[verify]**)
- Throttling returns 429 with `Retry-After`. Honour it exactly.
- JSON `$batch`: max **20** requests per batch. Each inner request counts toward the limits above, and the 4-concurrency limit applies inside batches. Source: https://learn.microsoft.com/en-us/graph/json-batching
- Implication: a 50k-message header pull ≈ 50k GETs, which takes ≥50 min at the 10k/10 min ceiling. Run it in the background at ≤3 concurrent requests.

### 2.5 Useful classification signals
- `inferenceClassification` (`focused` / `other`).
- `parentFolderId == junkemail`.
- `from` vs `sender` mismatch: ESP "on behalf of".

---

## 3. Header signals for classification

### 3.1 Standards-based signals

| Header | Meaning | Weight |
|---|---|---|
| `List-Unsubscribe: <https://…>, <mailto:…>` | Mailing list / bulk (RFC 2369) | Strong bulk signal |
| `List-Unsubscribe-Post: List-Unsubscribe=One-Click` | RFC 8058 one-click supported | Strong marketing/bulk signal. Enables automated unsubscribe |
| `List-Id` | Named list (RFC 2919) | Bulk/list |
| `Precedence: bulk` / `list` / `junk` | Non-personal bulk (legacy) | Medium |
| `Feedback-ID: a:b:c:SenderId` | Gmail FBL ID. Present = bulk sender. Middle fields often hold the campaign/customer/mail-type | Strong bulk. Mail-type field sometimes says `promo`/`marketing` |
| `Auto-Submitted: auto-generated` | Machine-generated (RFC 3834) | Transactional/system |
| `Authentication-Results` / `DKIM-Signature d=` | Signing domain(s) | Brand resolution (§4) |
| `Return-Path` / envelope sender | Bounce domain, often the ESP | ESP fingerprint |

Sources:
- RFC 8058: https://www.rfc-editor.org/rfc/rfc8058
- RFC 2369: https://www.rfc-editor.org/rfc/rfc2369
- RFC 2919: https://www.rfc-editor.org/rfc/rfc2919
- RFC 3834: https://www.rfc-editor.org/rfc/rfc3834
- Feedback-ID: https://support.google.com/a/answer/6254652
- Gmail bulk-sender rules (one-click unsubscribe required for senders >5,000/day to Gmail, honour within 2 days, since 2024): https://support.google.com/a/answer/81126

### 3.2 Gmail system labels
Source: https://developers.google.com/workspace/gmail/api/guides/labels

- `CATEGORY_PROMOTIONS`: marketing (strong)
- `CATEGORY_SOCIAL`: social networks
- `CATEGORY_UPDATES`: receipts, notifications (transactional-leaning)
- `CATEGORY_FORUMS`: lists/groups
- `CATEGORY_PERSONAL`: personal
- `SPAM`: (not included by `messages.list` unless `includeSpamTrash=true`. Include it, because spammy marketers are prime deletion targets)

### 3.3 ESP fingerprints
These are field observations, not official docs. Keep them in a data file (`esp-fingerprints.json`) with unit tests built from real header samples. **[verify each against your own mailbox]**

| ESP | Typical fingerprints |
|---|---|
| Mailchimp | `X-MC-User`. Return-Path/DKIM `mcsv.net`, `mcdlv.net`, `rsgsv.net`. `List-Id` contains `mcsv.net` |
| Mandrill (Mailchimp transactional) | `X-Mandrill-User`, `mandrillapp.com` |
| SendGrid / Twilio | `X-SG-EID`, `X-SG-ID`. Return-Path `sendgrid.net`. DKIM `d=sendgrid.info` (plus brand) |
| Salesforce Marketing Cloud | `X-SFMC-Stack`. Return-Path `*.exacttarget.com` / `*.exct.net` |
| Klaviyo | `X-Kmail-Account`. Return-Path/DKIM `klaviyomail.com` |
| HubSpot | `X-HS-Cid`. Return-Path `*.hubspotemail.net` / `bf*.hubspotemail.net` |
| Marketo | `mktomail.com` / `mkt*.com` Return-Path |
| Amazon SES (used by Braze, Iterable and others) | `X-SES-Outgoing`. `Feedback-ID` ends with `:amazonses.com`. DKIM `d=amazonses.com` |
| SparkPost / Bird (used by Braze, Iterable) | `X-MSFBL`. Return-Path `sparkpostmail.com` |
| Mailgun | `X-Mailgun-Sid`. `mailgun.org` |
| Postmark | `X-PM-Message-Id`. Mostly **transactional** |
| Braze / Iterable / Customer.io | Usually ride on SES / SparkPost / SendGrid. Detect via the underlying MTA plus brand-specific click-tracking subdomains (`*.braze.*`, `links.iterable.com`, `customeriomail.com`) |

### 3.4 Classes and rules
For each message, set three booleans (marketing, transactional, personal) plus a sender-level label.

1. **personal**: no `List-Unsubscribe`, no `Feedback-ID`, no ESP fingerprint, `CATEGORY_PERSONAL` (Gmail) or `focused` (Outlook), and the From address is a person on a consumer domain (gmail.com, outlook.com…) or is in contacts/sent-to history. **Exclude these from the company list.**
2. **marketing**: `List-Unsubscribe-Post: One-Click`, or `CATEGORY_PROMOTIONS`, or (List-Unsubscribe + an ESP marketing fingerprint + no transactional keywords).
3. **transactional**: `CATEGORY_UPDATES`, `Auto-Submitted`, transactional ESP (Postmark/Mandrill/SES with no List-Unsubscribe), subject patterns (receipt, order, invoice, password, verification, shipped).
4. Aggregate per sender (registrable domain): `marketing_ratio`, `has_one_click`, `first_seen`, `last_seen`, `msg_count`.
   - Any sender with ≥1 message proves the company **holds your personal data** (at least your email address). That makes it a valid GDPR Art. 17 / CCPA deletion target even if it is transactional only.
5. Only send senders the rules can't settle to the LLM (§6). Expected: 10–25% of senders.

---

## 4. Company resolution

1. **Registrable domain via the Public Suffix List**: `news.e.brand.co.uk` → `brand.co.uk`.
   - Use the `tldts` npm package. It bundles the PSL and handles ICANN + private sections.
   - Refresh the PSL via package updates. Source: https://publicsuffix.org/list/
2. **Candidate domains per message:** From, Reply-To, `DKIM-Signature d=` (all signatures), Return-Path, `List-Unsubscribe` URL host, and click-tracking hosts. Collapse them to the brand like this:
   - Prefer the From registrable domain if it is DKIM-aligned (`d=` equals or is a parent of From). Under DMARC this is the norm for bulk senders today.
   - If From is an ESP/shared domain (e.g. `mcsv.net`, `hubspotemail.net`, `klaviyomail.com`, `sendgrid.net`), fall back to the brand `d=` signature, then the display name, then the `List-Unsubscribe` host.
   - Maintain `esp-domains.json`. A domain in it is **never** a brand.
3. **Brand subdomains** such as `e.brand.com`, `email.brand.com` or `mail.brand.com` collapse automatically via the PSL. Separate marketing domains such as `brandmail.com` or `brand-news.com` need a merge. Use the LLM or manual merge in the UI, with a learned alias table (`domain_alias` → `company_id`).
4. **Display name**: take the most frequent From display name per registrable domain. Strip suffixes like "Team", "News", "via …", and emoji.
5. **Privacy contact**:
   - Resolve the DPO/privacy email by fetching `https://brand.com/privacy` (and `/privacy-policy`, `/legal/privacy`) and extracting mailto addresses with regex, plus the LLM on the stripped text.
   - Cache per company with `last_checked`. Fallback: `privacy@`, `dpo@`, `legal@` (mark as "unverified address").
6. **Logos**:
   - **Clearbit Logo API (`logo.clearbit.com`) was shut down on 2025-12-08.** HubSpot points to Logo.dev, which needs a publishable key and has a free tier. Sources: https://developers.hubspot.com/changelog/upcoming-sunset-of-clearbits-free-logo-api, https://www.logo.dev/clearbit
   - Alternatives: Google favicon service `https://www.google.com/s2/favicons?domain=brand.com&sz=64` (undocumented, may change), or fetch `/favicon.ico` / `<link rel=icon>` server-side and cache it.
   - v1: server-side favicon fetch + cache, with Logo.dev as an optional upgrade.

---

## 5. Sending and reply tracking

### 5.1 Sending from the user's own mailbox
- **Gmail:** `users.messages.send` with an RFC 5322 MIME message, base64url-encoded in `raw` (100 units).
  - Set your own `Message-ID: <uuid@stopdisturbance.local-or-your-domain>`, or read back the Gmail-assigned one via `messages.get(format=metadata, metadataHeaders=Message-ID)`.
  - Store `gmail_id`, `threadId` and `Message-ID`.
  - Source: https://developers.google.com/workspace/gmail/api/guides/sending
- **Graph:**
  - `POST /me/sendMail` returns 202 with no body, so you get no ID back.
  - Instead use `POST /me/messages` (create draft) → read `id`, `internetMessageId`, `conversationId` → `POST /me/messages/{id}/send`. This also lets the user review the exact draft in Outlook if wanted.
  - Source: https://learn.microsoft.com/en-us/graph/outlook-create-send-messages
- **Follow-ups / reminders in the same thread:**
  - Gmail: pass `threadId`, set `In-Reply-To: <orig Message-ID>` and `References: <chain>`, and keep the same `Subject` (an optional `Re:` prefix is fine). All three are needed for Gmail threading. Source: https://developers.google.com/workspace/gmail/api/guides/threads
  - Graph: `POST /me/messages/{id}/createReply` → patch body → send.

### 5.2 Matching replies, in priority order
1. Gmail `threadId` / Graph `conversationId` of the sent request.
2. `In-Reply-To` / `References` containing our `Message-ID`. This catches replies that the company's ticketing system split into a new thread.
3. A reference token in the subject, e.g. `[SD-7F3K]`. Many privacy desks (OneTrust, Zendesk) start new tickets but keep the subject.
4. The From registrable domain equals the company's domain or alias, within the open-request window. Mark these "probable match" and ask the user to confirm.

LLM-classify the matched reply into: `acknowledged`, `id_verification_requested`, `completed`, `refused`, `redirected_to_form`, `auto_reply`, `other`. Deadlines are tracked from the send timestamp (legal clocks: see the legal doc).

### 5.3 RFC 8058 one-click unsubscribe from the server
Source: https://www.rfc-editor.org/rfc/rfc8058

- Eligible only if **both** `List-Unsubscribe` (with an `https:` URI) and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` are present **and** a valid DKIM signature covers both headers. Check `Authentication-Results: dkim=pass`, and that `h=` includes `list-unsubscribe` and `list-unsubscribe-post`.
- Request: `POST <https-uri>` with `Content-Type: application/x-www-form-urlencoded` and body `List-Unsubscribe=One-Click`.
  - **No cookies, no auth headers, no Referer.**
  - Follow ≤3 redirects, 10 s timeout, generic UA.
  - Success = any 2xx.
- Log the URL host, status and timestamp. Never log full tokens in the URI, because they identify the user.
- If only a `mailto:` is present, send the unsubscribe email from the user's mailbox. This is covered by `gmail.send`/`Mail.Send` and can be auto-approved in a batch.
- If only a plain `https:` URL is present without `-Post`, it is a landing page that may need a click or CAPTCHA, so use the guided flow below.
- **SSRF guard**: resolve DNS and reject private, loopback and link-local IPs before POSTing.

### 5.4 Web forms with CAPTCHA (OneTrust, TrustArc, custom DSAR portals)
- Do **not** automate CAPTCHA solving.
- Use a guided human flow instead:
  - Open the form URL in a new tab.
  - Show a side panel with copy buttons for name, email and the pre-written request text.
  - Have a "Submitted" button that records the timestamp, plus an optional screenshot/confirmation-number field.
  - Set the deadline from that timestamp.

---

## 6. LLM usage — DeepSeek API (owner's key)

### 6.1 API facts
Sources:
- https://api-docs.deepseek.com/
- https://api-docs.deepseek.com/quick_start/pricing/
- https://api-docs.deepseek.com/guides/json_mode/
- https://api-docs.deepseek.com/guides/tool_calls/
- https://api-docs.deepseek.com/guides/thinking_mode/
- https://api-docs.deepseek.com/quick_start/rate_limit/
- https://api-docs.deepseek.com/updates/
- https://api-docs.deepseek.com/news/news260910/ (V4.1-Flash)

**API shape**
- OpenAI-compatible Chat Completions with `base_url = https://api.deepseek.com`.
- Use the official `openai` npm SDK with `baseURL` overridden.
- An Anthropic-format endpoint and a Responses API also exist.

**Models (as of Oct 2026)**
- `deepseek-flash`: currently serves **DeepSeek-V4.1-Flash**. Thinking and non-thinking modes.
- `deepseek-v4-pro`: V4-Pro, GA Aug 2026.
- The legacy names **`deepseek-chat` and `deepseek-reasoner` were discontinued after 2026-07-24**. Do not hard-code them.
- `deepseek-v4-flash` is still accepted and routes to V4.1-Flash.
- Call `GET /models` at boot and fail loudly if the configured model is missing.

**Context and modes**
- Context: **1M tokens**. Max output: up to 384K. **[verify]**
- Thinking toggle (OpenAI format): `"thinking": {"type": "disabled"}`. Use **disabled** for classification: cheaper and faster.

**JSON mode**
- Set `response_format: {"type": "json_object"}`.
- The prompt **must contain the word "json"** and an example schema.
- Set `max_tokens` with enough headroom. Without an instruction to produce JSON, the model can stream whitespace until it hits the limit.

**Tool calls**
- Supported on both models (OpenAI `tools` format). A `strict` schema mode exists (beta). **[verify]**
- For the classifier, JSON mode alone is enough. Validate with Zod and retry once on parse failure.

**Context caching**
- Automatic, prefix-based. Repeated prompt prefixes are billed at the cache-hit price. No API flag is needed.
- Put the static system prompt + few-shot examples first.

**Rate limits**
- Per-account concurrency caps: `deepseek-flash` 2,500, `deepseek-v4-pro` 500.
- Over the limit returns 429.
- The server closes the connection if inference hasn't started within 10 min.
- Use concurrency 4–8. That's plenty.

**Pricing (USD per 1M tokens; peak / off-peak)**
- Off-peak = 50% of peak.
- Peak hours are **01:00–04:00 and 06:00–10:00 UTC, Mon–Fri** (excluding Chinese public holidays). All other hours are off-peak.
- Figures are from a search extract of the pricing page. **[verify before budgeting]**

| Model | Input cache hit | Input cache miss | Output |
|---|---|---|---|
| `deepseek-flash` (V4.1-Flash) | $0.006 / $0.003 | $0.30 / $0.15 | $1.20 / $0.60 |
| `deepseek-v4-pro` | $0.044 / $0.022 | $1.32 / $0.66 | $3.96 / $1.98 |

### 6.2 What needs an LLM vs. rules

| Task | Rules | LLM |
|---|---|---|
| Bulk/marketing/transactional per message | ✅ headers + labels (§3) | — |
| Sender → registrable domain, ESP stripping | ✅ PSL + ESP list | — |
| Ambiguous senders (no list headers, odd domains), brand-name normalisation, merging alias domains | — | ✅ `deepseek-flash`, non-thinking |
| Sector tag (retail, data broker, finance…), "likely holds data beyond email" | — | ✅ flash |
| Extract privacy contact from privacy-policy page text | regex first | ✅ flash fallback |
| Draft deletion/stop-marketing letter | ✅ **legal templates** (deterministic, jurisdiction-specific) | Optional: flash fills company-specific fields / tone. **Never let the LLM invent legal citations** |
| Classify company replies (§5.2) | keyword pre-filter | ✅ flash. Use `deepseek-v4-pro` for hard cases (refusals, ID-verification demands) |

### 6.3 Cost estimate: classify per unique sender, not per message
Assumptions:
- 3,000 unique senders. Rules settle ~75%, but assume **all 3,000** go to the LLM for an upper bound.
- 50 senders per request = 60 requests.
- Static system prompt + few-shots = 1,500 tokens. Cached after the first request: ~1.5k miss + 88.5k hit.
- ~120 input tokens per sender (domain, display name, header flags, 3 redacted subjects) = 360k miss tokens.
- ~40 output tokens per sender = 120k output tokens.

| Model | Peak cost | Off-peak cost |
|---|---|---|
| `deepseek-flash` | 0.36×0.30 + 0.09×0.006 + 0.12×1.20 ≈ **$0.25** | **≈ $0.13** |
| `deepseek-v4-pro` | 0.36×1.32 + 0.12×3.96 ≈ **$0.95** | ≈ $0.48 |

- Reply classification: ~200 replies × (1.5k in + 100 out) on flash ≈ **$0.12**.
- Letter personalisation: ~300 letters × (1k in + 500 out) ≈ **$0.27**.
- **Total LLM spend per full run: under $1 on flash.** Cost is not a constraint.
- Schedule bulk classification jobs in off-peak hours anyway (it's free to do).
- Tokenizer differences mean ±30% on these numbers.
- For reference only, the same workload on Claude Haiku 4.5 ($1 in / $5 out per MTok, 50% off via Batch API) ≈ $0.97 standard / ≈ $0.49 batch. Source: https://platform.claude.com/docs/en/about-claude/pricing

---

## 7. Security and privacy architecture (single user)

### 7.1 DeepSeek data handling (factual)
Sources: https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html, https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html

- The DeepSeek privacy policy states that collected data is **processed and stored on servers in the People's Republic of China**. It may be shared with law enforcement / public authorities to comply with applicable law.
- The Open Platform Terms are governed by PRC law.
- Inputs/outputs may be used, after de-identification, to improve services. The policy describes an opt-out ("Improve the model for everyone"). It is unclear whether that toggle covers API traffic **[verify in platform settings]**.
- No zero-data-retention option is documented for the API.

**Data minimisation rules. Enforce them in code, in one `buildLlmPayload()` function with unit tests:**
- **Allowed:** sender registrable domain, From display name, boolean header flags (`has_list_unsub`, `one_click`, `feedback_id`, `esp=klaviyo`, `gmail_category`), message count, and up to 3 **redacted** subject lines.
- **Redact subjects:**
  - Replace digits ≥4 long, email addresses, URLs and the owner's first/last name with placeholders.
  - Drop subjects matching sensitive patterns: medical, bank, password, OTP, legal.
- **Never send:** bodies, attachments, recipient addresses, the owner's email/name/address, OAuth tokens, or full header blocks.
- **Reply classification:**
  - Send the reply body only after stripping quoted text, signatures and PII (the owner's name/email/phone/address, case numbers).
  - Alternative: run it rules-only and show the reply to the owner.
  - Make "send replies to LLM" a **setting, default OFF**.
- **Letters:** generate from local templates. Send only `{company_name, sector, jurisdiction}` to the LLM, never the owner's identity. Merge the identity locally afterwards.
- If PRC processing is unacceptable, swap providers by changing `base_url` + model: same OpenAI-compatible code, e.g. DeepSeek models hosted by a US/EU cloud, or any other OpenAI-compatible endpoint. Keep the provider behind an `LlmClient` interface.

### 7.2 Google Limited Use (applies to unverified/personal apps too)
Sources: https://developers.google.com/terms/api-services-user-data-policy, https://developers.google.com/workspace/workspace-api-user-data-developer-policy

- Use restricted-scope data only to provide/improve **user-facing features** prominent in the app.
- **No transfer** except to provide those features (with consent), for security, or for legal compliance.
- **No humans reading data** except with the user's affirmative consent for specific messages, for security/abuse, for legal reasons, or aggregated/anonymised internal ops.
  - Here the owner is the user, so this is satisfied. Still: no shared support access and no logs containing headers/subjects.
- **No use for ads, and no use to train generalised/non-personalised AI/ML models.**
  - Sending data to DeepSeek for inference is a "transfer to provide a user-facing feature". Document it in the app's privacy note and settings.
  - DeepSeek's possible training on inputs is in **tension** with the Workspace AI/ML clause. The minimisation in §7.1 and the training opt-out are the mitigations. The owner should decide knowingly.
- Applies to data **derived** from Gmail too: the company list, classifications.

### 7.3 Storage and secrets
- **Tokens:**
  - Encrypt refresh/access tokens with **AES-256-GCM** at the application layer before writing to Postgres.
  - Use a random 96-bit IV per record and store `{v, iv, tag, ciphertext}`.
  - The 32-byte key comes from the host's secret store (env var injected at runtime), never from the repo.
  - Include a `key_version` field so the key can be rotated.
  - **KMS envelope encryption is optional for single-user.** If deploying on GCP, use Cloud KMS to wrap the data key. Skip it on Railway/Fly.
- **Store headers only:**
  - Keep a whitelisted header subset per message: From, Sender, Reply-To, To (hashed), Subject (for UI), Date, Message-ID, List-*, Feedback-ID, Precedence, Auto-Submitted, DKIM `d=` values, Return-Path, labels/categories.
  - Do not store bodies, except for replies to our own requests (needed as legal evidence). Store those encrypted.
- **Retention:**
  - Raw per-message header rows: 90 days after the scan, then collapse to sender aggregates.
  - Sent requests, replies and their timestamps: keep until the case is closed + 3 years (evidence of the request). Make this configurable.
  - LLM payloads: don't persist; log only token counts.
- **Audit log** (append-only table): connect/disconnect mailbox, scan start/end, each send (to, company, template version, message IDs), each one-click POST (host, status), LLM call (model, tokens, payload hash, *not* payload), settings changes.
- **Account / data deletion ("disconnect & wipe"):**
  - Revoke tokens: Google `POST https://oauth2.googleapis.com/revoke?token=…`. Microsoft: delete the app consent in account.live.com/consent or call Graph to remove the oauth2PermissionGrant **[verify for MSA]**.
  - Delete all mailbox-derived rows, then confirm. Keep the audit log of sent legal requests only if the owner opts in.
- **App auth (single user):**
  - Sign in with Google or Microsoft, with an **allow-list of exactly the owner's account ID** (`sub`/`oid`). Reject everyone else at the callback.
  - Require secure cookies, CSRF protection (built into Auth.js / Better Auth), and HTTPS only.
  - Optionally add a passkey or TOTP, or put the app behind Cloudflare Access / Tailscale for zero public exposure.
- **Outbound safety:**
  - Sends require explicit approval: a batch approve screen showing the exact rendered email.
  - Rate-limit to ≤1 send / 30 s.
  - Use a hard daily cap (e.g. 100) to protect the owner's account reputation.

---

## 8. Hosting recommendation (single user)

Constraints:
- Long-running scans (17–60 min).
- Periodic polling (every 10–15 min).
- pg-boss needs a **persistent Node process**.
- Small, steady load.

| Option | Verdict |
|---|---|
| Vercel (web) + Neon (DB) + separate worker host | Works, but **three vendors** for one user. Vercel functions max 800 s on Pro (Fluid), so the scan must live elsewhere anyway. Source: https://vercel.com/docs/functions/limitations |
| **Railway or Fly.io: one Docker image, two processes (`web` = `next start`, `worker` = pg-boss) + managed Postgres** | **Recommended.** One vendor, one image, private networking, cron via pg-boss `schedule()`. About the cost of a small VM. Use the direct (non-pooled) Postgres URL for the worker |
| GCP Cloud Run (web) + Cloud Run worker (min-instances=1, CPU always on) + Cloud SQL + Cloud KMS | Good if you want Gmail Pub/Sub push + KMS in one place. More setup. Overkill for one user |
| Home server / VPS + Caddy | Cheapest and most private (data never leaves your box, except API calls). Requires you to patch/back it up yourself. Pair with Tailscale/Cloudflare Tunnel |

Pick **Railway or Fly.io**, with daily Postgres backups enabled, secrets in the platform secret store, and a single region close to the owner.

---

## 9. Capability matrix

| Capability | How | Dependency | Risk | v1 / later |
|---|---|---|---|---|
| Connect Gmail (long-lived) | OAuth External + **In production, unverified** (or Internal for Workspace). Scopes `gmail.readonly` + `gmail.send`, offline | GCP project | Unverified warning (cosmetic). Token revoked on Google password change → re-connect UX | v1 |
| Connect Outlook.com | Entra app (`PersonalMicrosoftAccount` or `AzureADandPersonalMicrosoftAccount`), Web redirect, `Mail.Read Mail.Send offline_access` | Entra tenant owned by user | 90-day rolling RT. Must persist rotated RT | v1 |
| Connect work M365 mailbox | Same app. Admin consent | Tenant admin | **Blocked by default** under the Microsoft-managed consent policy unless the owner is admin | Later (only if owner is admin) |
| Header scan + incremental sync | Gmail `messages.list`/`get(format=metadata)` batched ≤50, then `history.list` polling. Graph per-folder `delta` + per-message `$select=internetMessageHeaders` | pg-boss worker | Quota throttling (design for 6k units/min/user). historyId 404 → full resync. `internetMessageHeaders` on list/ReadBasic unverified | v1 |
| Classify per message (rules) | List-Unsubscribe, -Post, List-Id, Precedence, Feedback-ID, Auto-Submitted, Gmail categories, Outlook focused/junk, ESP fingerprints | `esp-fingerprints.json` | ESP fingerprints drift → test fixtures | v1 |
| Company resolution | `tldts` PSL + DKIM `d=` + ESP domain exclusion + alias table | `tldts` | Separate marketing domains need merge | v1 |
| LLM classify ambiguous senders | DeepSeek `deepseek-flash`, non-thinking, JSON mode, 50 senders/request, cached prefix, off-peak | DeepSeek key | PRC data processing; model renames (legacy names already retired) | v1 |
| Logos | Server-side favicon fetch + cache | none | Low quality icons | v1 (Logo.dev later) |
| Privacy contact discovery | Fetch privacy page → regex → LLM fallback. Manual override | Outbound HTTP | Wrong address → bounce detection + manual edit | v1 |
| Draft legal requests | Deterministic templates per jurisdiction (GDPR/UK GDPR/CCPA…). LLM fills only company fields | Legal doc (03) | Hallucinated law → never let LLM write citations | v1 |
| Send from user's mailbox | Gmail `messages.send` (raw MIME). Graph draft → send to capture `internetMessageId` | Scopes above | Account reputation → approve + rate cap | v1 |
| RFC 8058 one-click unsubscribe | Server POST `List-Unsubscribe=One-Click`, no cookies, DKIM-coverage check, SSRF guard | none | Fake/abused endpoints → only DKIM-pass senders | v1 |
| mailto unsubscribe | Auto-send from user mailbox | send scope | Low | v1 |
| Web-form/CAPTCHA requests | Guided human flow with copy panel + "submitted" timestamp | none | Manual effort | v1 |
| Reply matching | threadId/conversationId → In-Reply-To/References → subject token → domain + window | Sync | Ticket systems break threads → subject token | v1 |
| Reply classification | Keyword rules + optional LLM (default OFF, PII-stripped) | DeepSeek | Privacy → opt-in | v1 (rules), LLM opt-in |
| Deadlines & reminders | pg-boss schedules from send timestamp. Follow-up in same thread | Legal deadlines doc | Clock-start ambiguity (ID verification pauses) | v1 |
| Gmail push (Pub/Sub) | `users.watch` renewed daily | GCP Pub/Sub, public endpoint | Silent expiry | Later (polling suffices) |
| Token encryption | App-level AES-256-GCM, key in platform secrets, key_version | none | Key loss = reconnect | v1 |
| KMS envelope encryption | Cloud KMS / AWS KMS wraps DEK | Cloud KMS | Ops | Later (only if multi-user) |
| Multi-user / public launch | Restricted-scope verification + **annual CASA**, publisher verification, admin-consent docs | Budget, lab | Cost, time, annual reassessment | Later / not planned |

### Stack: confirm / amend

| Planned | Verdict | Reason |
|---|---|---|
| Next.js App Router + TypeScript + Tailwind | **Confirm** | Fine for a single-user dashboard. Use `output: "standalone"` for the Docker image |
| Postgres + Prisma | **Confirm** | Use the direct URL for the worker. Store encrypted token blobs as `Bytes` |
| pg-boss | **Confirm** | Uses `SKIP LOCKED` polling, no external Redis. Needs a persistent worker → hosts that support it (§8). Use `schedule()` for polling/deadline crons |
| Auth.js (Google + Entra) | **Amend** | Auth.js has been in **maintenance mode under Better Auth since Sept 2025** (security fixes only). Source: https://www.better-auth.com/blog/authjs-joins-better-auth. Use it (or Better Auth) **only for app login with an owner allow-list**. Implement **mailbox connections as separate OAuth flows** with `google-auth-library` and `@azure/msal-node` (or `openid-client`), so you control offline access, incremental scopes, RT rotation and encrypted storage. Auth.js does not refresh/rotate provider tokens for you and stores them in plaintext in the `Account` table |
| Claude API | **Replaced by DeepSeek** (user decision) | Use the `openai` SDK with `baseURL=https://api.deepseek.com`, model `deepseek-flash`. Keep an `LlmClient` interface so the provider can be swapped (privacy, §7.1) |
| Hosting (unspecified / Vercel) | **Amend → Railway or Fly.io** single image (web + worker) + managed Postgres | Long scans + persistent worker. One vendor for a single user |
| Add: `tldts` | New | PSL-based registrable domain |
| Add: `zod` | New | Validate LLM JSON output and API payloads |
| Add: `mailparser`/`mimetext` (or `nodemailer`'s MailComposer) | New | Build RFC 5322 raw MIME for Gmail send with custom Message-ID/References |
