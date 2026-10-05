# 00 — Delivery Review (manager)

Date: 2026-10-05. Reviewed: 01-research, 02-capabilities, 03-legal, 04-ux. Build spec: `00-brief.md`.

## Verdicts

| Doc | Verdict | One-line reason |
|---|---|---|
| 01-research | **Accept with fixes** (applied) | Strong and well sourced. Its scope recommendation (`gmail.metadata`) and tracker timings conflicted with later decisions. |
| 02-capabilities | **Accept with fixes** (applied) | Most build-critical doc and mostly right. It allowed batch auto-approval, set a different send cap and retention period, and left hosting and auth as "X or Y". |
| 03-legal | **Accept with fixes** (applied) | Correct on the core points (PDPL base, GDPR only on Art. 3(1), no CCPA). It recommended Google Testing mode, wanted footers sent to the LLM, and had no stop-marketing-only or ID-reply template. |
| 04-ux | **Accept with fixes** (applied) | Detailed and usable. It contradicted the other docs on scopes, Testing mode, what goes to DeepSeek, CCPA and statuses, and named a retired model. |

---

## Decisions on known tensions

| # | Tension | Decision | Reason |
|---|---|---|---|
| D1 | `gmail.metadata` (UX/research/legal) vs `gmail.readonly` (capabilities) | **`gmail.readonly` + `gmail.send`**. Microsoft: **`Mail.Read` + `Mail.Send` + `offline_access`** (not `Mail.ReadBasic`). Scanning stays headers-only through code policy: `format=metadata` with a header allow-list, and Graph `$select` without `body`. Bodies (`format=full`) are fetched **only** for threads and conversations of requests the owner sent, and for DSN bounces that reference our Message-ID. | `metadata` forbids `q` and `format=full`, so reply bodies ("verify your identity" vs "deleted") cannot be read. Reply classification and complaint evidence need them. A token cannot usefully hold both scopes (metadata restrictions win). The app is personal and unverified, so no reviewer requires the narrower scope. UX copy now says "we can, but we don't, except replies to your requests" (UX §4.2 already required this honesty). |
| D2 | Google "Testing" (legal, UX) vs "In production, unverified" (capabilities, research) | **External + "In production", not submitted for verification** (Internal if the mailbox is Workspace). Testing is a fallback only. | Testing kills refresh tokens every 7 days, which breaks reply tracking. Personal use (<100 users) is exempt from verification and CASA. Residual risk: research notes that unverified restricted-scope apps may still get limited token life. **Day-1 spike in M1** checks that a token still refreshes after 8 days. The reconnect UX triggers on any `invalid_grant`, whatever the mode. |
| D3 | Google Limited Use (no training generalised AI on restricted-scope data) vs DeepSeek possibly training on inputs | **Default = Rules only.** DeepSeek can be selected only after a **`TrainingOptOutGate`**. The owner ticks "I turned off training / 'Improve the model' in my DeepSeek account" and enters a date (stored as `Setting.deepseekTrainingOptOutConfirmedAt`), **and** `[Test connection]` (`GET /models`) passes. Until then the DeepSeek radio is disabled and `LlmClient` refuses every call. Reply classification by LLM is a **separate opt-in, default off**. **Letters never use the LLM in v1.** The owner's identity is never sent. | Limited Use permits transfer to provide a user-facing feature, but not use to train generalised models. Whether DeepSeek's opt-out covers API traffic is **[VERIFY]**. The gate makes that a deliberate owner decision, and minimisation limits the exposure. `LLM_BASE_URL` / `LLM_MODEL` allow a switch to a no-training OpenAI-compatible provider (03-legal S6). |
| D4 | Hosting (Vercel implied) and auth (Auth.js) | **Railway**: one Docker image, two services (`web` = `next start`, `worker` = pg-boss), Railway Postgres with daily backups, region EU West **[VERIFY region list]**. Fly.io is the fallback. App login uses **Better Auth** (Google + Microsoft, `openid email profile` only) with an owner allow-list. Mailbox connections are **separate OAuth flows** (`google-auth-library`, `@azure/msal-node`) with AES-256-GCM token storage. | Scans run 17–60 min and pg-boss needs a persistent process, so Vercel would add a third vendor. Auth.js is in maintenance mode (security fixes only) and stores provider tokens in plaintext. Better Auth is its maintained successor. |
| D5 | Daily cap: 100 (capabilities) vs 50 (UX); spacing | **50 sends per mailbox per day.** At least 30 s between sends per mailbox (30–60 s jitter). One-click POSTs don't count toward the cap but are spaced ≥5 s. Self-notifications are exempt. | The more conservative figure protects a consumer account's reputation. Volume is ~1–2 messages per company. |
| D6 | Undo window | **10 s** server-held window (status `QUEUED`, `sendAfter = confirm + 10 s`). After that, a queued item can still be cancelled from the tracker until the worker actually sends it. | UX §1.4 / §6.5. Spacing means many items wait longer anyway. |
| D7 | Statuses | One canonical enum: `DRAFT, APPROVED, QUEUED, SENT, ACKNOWLEDGED, NEEDS_ACTION(reason), COMPLETED, REFUSED, OVERDUE, ESCALATED, FAILED, CLOSED`. Flags: `extensionClaimed`, `stillEmailing`, `bounced`. | Merges research §6.6, capabilities §5.2 reply classes and UX §7.1. UX lacked Refused, Queued and Failed. |
| D8 | Deadlines | PDPL 30 days (+30 only if the company notified, with reasons, inside the original period). GDPR/UK GDPR 1 calendar month (+2 if notified). CAN-SPAM 10 business days (Mon–Fri, opt-out only). CCPA only if the owner sets a US-state residence (never by default). `dueAt` = earliest applicable deadline. **Reminder offered at dueAt + 3 days, max 1.** **Escalation offered at max(reminderSentAt + 7 days, latest applicable deadline incl. notified extensions).** SDAIA window shown = PDPL due (incl. extension) + 90 days. "Still emailing" = marketing received >10 business days after send. | Reconciles 03-legal §5/M7/S3 (legal is source of truth), research's +3/+14 and UX's "≤14 / +7". The 7-day grace matches the "within 7 days" demand in template 6b. |
| D9 | Microsoft work/M365 | **v1: Outlook.com/Hotmail personal accounts.** M365 only if the owner is admin of that tenant. App registered as `AzureADandPersonalMicrosoftAccount` (`/common`). The callback accepts only the consumer tenant `9188040d-6c67-4c5b-b112-36a304b66dad` plus tenant IDs in `MS_ALLOWED_TENANTS`. Employer tenants are rejected with an explanatory message. | Since Nov 2025 the Microsoft-managed consent policy requires admin consent for `Mail.Read`. Using an employer tenant may also breach employer policy. |
| D10 | Consent sequencing (UX incremental send scope) | **One consent per mailbox** requesting read + send. If `send` is unticked in granular consent, a `ScopeRepairPrompt` appears before the first send. | Each extra consent shows another unverified-app warning and mints another refresh token (100-token cap per client). Incremental consent suits public apps, not a single owner. |
| D11 | Retention | Message header rows and example subjects: deleted **90 days after the scan**, leaving only sender aggregates. Evidence (requests, sent copies, reply bodies, post-request marketing headers): **case closed + 1 year**, configurable 1–3 years. LLM log: metadata 90 days. **Exact payloads of the last 20 calls only** are kept encrypted (ring buffer, max 7 days) so the owner can audit them (UX §3.6). | Legal §8 (1 year) is the source of truth over capabilities (3 years). UX needs a short payload audit, but capabilities said "never persist". The ring buffer satisfies both. |
| D12 | LLM in letters (UX said name + email go to DeepSeek "for letters") | **No LLM in letter drafting in v1.** All drafts are templates (label "Template"). LLM output is limited to groupings, tags, sector and contact extraction ("AI suggestion"). | 02 §7.1 and 03 §9 both forbid sending the owner's identity. Templates are deterministic, and the LLM must never write citations. |
| D13 | Footer/postal address to LLM (legal §9) | **Dropped.** v1 never reads scanned bodies, so there is no footer. `is_us_sender` comes from datarequests.org data, policy text and the TLD. | Consistent with D1 code policy and the "we don't read bodies to scan" promise. |
| D14 | Batch auto-approval of mailto unsubscribes (capabilities §5.3) and UX "Approve all shown" | **Removed.** Every send, mailto and one-click POST is approved individually (per-draft approval logged with a draft hash) and listed in the send confirmation. | 03-legal M4. |
| D15 | Notification emails (UX "we'll email you") | Sent **from the owner's connected mailbox to itself** (no third-party email service). | No extra vendor, and no extra data processor. |

---

## 01-research.md

**Gaps against brief:** none material. Product survey, contact discovery, brokers, response evidence, unsubscribe mechanics and prioritised recommendations are all covered. Missing: **coverage of Saudi/GCC companies** in the open datasets. datarequests.org and JustDeleteMe are EU/US-centric, so noon, Jarir, STC and others will mostly fall through to policy scraping or guessing. The size of that gap is unmeasured, so M4 measures it (brief §9).

**Contradictions:** scopes `gmail.metadata` vs capabilities (→ D1). Tracker "+3 reminder / +14 complaint" vs legal and UX (→ D8). One-click "POST right away" vs per-item approval (→ D14). "30 or 31 days" vs calendar month (→ D8).

**Unverified claims that affect the build:** whether unverified In-production restricted-scope apps get long-lived refresh tokens (M1 spike). Licenses of YourDigitalRights, Optery and BADBOOL (not bundled in v1, so no blocker). Ketch portal pattern (pattern detection is best-effort). PDPL IR wording on the marketing opt-out timeline (affects letter wording only, held by 03-legal [VERIFY]).

**Fix list for 01-research (all applied):**
1. §6 P0.1: scopes → `gmail.readonly` + `gmail.send` with the headers-only scan policy.
2. §6 P0.6: deadline computation and reminder/escalation timing per D8.
3. §6 P0.7: one-click POST happens after owner approval.
4. TL;DR 5: say "publish In production" alongside the Testing caveat.

## 02-capabilities.md

**Gaps:** bounce/DSN detection is not specified (now in brief §5). Outlook.com daily sending limits are not given (cap of 50 makes this moot; [VERIFY] stays in legal §8). No backup or restore procedure (brief §8). DKIM `h=` verification only checks `Authentication-Results`, and the app cannot re-verify a DKIM signature from metadata alone without the raw message. Brief §5 accepts `Authentication-Results: dkim=pass` from the receiving provider plus `h=` coverage parsed from the `DKIM-Signature` header.

**Contradictions:** CCPA used as a deletion basis (§3.4). Batch auto-approve of mailto (§5.3, → D14). Letter personalisation via LLM (§6.2/§7.1, → D12). Retention of 3 years vs legal's 1 year (→ D11). Daily cap of 100 vs UX's 50 (→ D5). Hosting and auth left open (→ D4).

**Unverified claims that affect the build:**
- 6,000 units/min/user for new GCP projects: throttle for it.
- `internetMessageHeaders` via Graph delta/list: plan per-message `$batch` GETs.
- DeepSeek model names, pricing and whether the API respects the training opt-out: boot-time `/models` check plus the D3 gate.
- `Mail.Send` in the admin-consent list: M365 is out of v1 anyway.
- MSA consent revocation via API: erase flow tells the owner to remove consent at account.live.com/consent if the API call is unavailable.
- Graph upload limit (irrelevant).

**Fix list for 02-capabilities (all applied):**
1. §3.4.4: PDPL Art. 4 / GDPR Art. 17 instead of CCPA.
2. §5.3: mailto unsubscribe needs individual approval.
3. §6.2, §6.3, §7.1: no LLM in letters in v1.
4. §7.3: evidence retention closed + 1 year (configurable to 3); cap 50/mailbox/day; spacing 30–60 s.
5. §8 and stack table: Railway decided, Fly.io fallback.
6. §9: Outlook audience and tenant allow-list. Draft row cites PDPL base + GDPR/UK GDPR/CAN-SPAM.
7. Stack table: Auth.js → Better Auth.

## 03-legal.md

**Gaps:** no **stop-marketing-only** letter for the UX "Unsubscribe only" decision when no one-click/mailto exists, and no **ID-verification reply** template for UX "Reply with details". **Added as 6d and 6e**, assembled only from wording and citations already in 6a and §7; marked [LAWYER] where Arabic is involved. Not specified: the business-day calendar for CAN-SPAM, and the calendar-month computation for GDPR. Brief §5 sets engineering rules (Mon–Fri, no holiday calendar; same day number next month, or last day of month) **[LAWYER]**.

**Contradictions:** Google Testing mode (§8, → D2). Footer to LLM (§9, → D13). "Prefer gmail.metadata" (§9, → D1). "DeepSeek trains on inputs by default" vs capabilities "unclear for API". Both views are kept with [VERIFY], and D3 covers either case.

**Unverified claims that affect the build** (all keep their [VERIFY]/[LAWYER] markers):
- PDPL Art. 26 wording and Art. 33/34 complaint numbering. These appear in template text and need counsel review before real sends.
- IR Art. 37 90-day complaint limit (may be deleted). The app uses 90 days as a conservative display.
- SDAIA DGP needs Nafath, so the owner files complaints personally (already the design).
- Whether an email request counts as "received" when a web form is designated. The app records both dates.

**Fix list for 03-legal (all applied):**
1. §8 Google: In production, unverified; Testing as fallback; [VERIFY] token life.
2. §9 minimisation item 2: no footers or bodies to the LLM.
3. §9 hosting: scopes per D1.
4. §10 M12 reworded.
5. Added §6d (stop-marketing only) and §6e (ID-verification reply).

**Still open for counsel (not fixable by us):** the four [LAWYER] questions in §10. Review of the Arabic templates before first real sends (owner question Q6 in the brief).

## 04-ux.md

**Gaps:** no `/login` route in the IA (added). No DeepSeek training gate (added to §3.6 / §13). No Refused, Queued or Failed statuses (added). No spec for bounce handling beyond "back to Draft" (now `FAILED`, brief §5). The web-form flow is defined only inside /review. Tracker detail must also allow "I submitted it" late (brief §6).

**Contradictions fixed:**
- Scopes (`gmail.metadata`, `Mail.ReadBasic`, → D1)
- Testing mode as permanent (→ D2)
- DeepSeek default and payload, including the owner's name and email (→ D3, D12)
- Model `deepseek-chat`, which is retired (→ `deepseek-flash`)
- Incremental send consent (→ D10)
- "Approve all shown" (→ D14)
- CCPA offered as a law option and CPPA as an escalation target (→ 03-legal M3)
- Reply match window of 60 days (→ open request window)
- "Still emailing" at Sent + 15 days (→ 10 business days)
- Escalation timing (→ D8)
- RFC 8058 unsubscribe on self-notifications (→ D15)
- Brokers chip shown by default (→ only when the later "Known brokers" pack is on)
- "Don't re-host reply bodies" vs legal evidence (→ stored encrypted, D11)

**Unverified claims that affect the build:** none beyond D1/D2. The UX metrics are targets, not claims.

**Fix list for 04-ux (all applied):**
- §0 Microsoft row
- §2 IA (`/login`, Better Auth)
- §3.1 setup card, What-we'll-do card and access_denied text
- §3.6 Settings: token line, AI block with gate, model, payload list; AI mode behaviour
- §4.1 consent sequence
- §4.2 scope table and engineering note
- §4.3 disclosure EN/AR and draft labels
- §4.4 context, interstitial flag and banners
- §5.2 law filter and brokers note
- §5.7 cap and spacing
- §6.1 no approve-all
- §6.3 law table: UK GDPR and CAN-SPAM rows added; CCPA conditional; Unknown = PDPL fallback
- §7.1 canonical statuses
- §7.2 business days
- §7.3 match order and reply storage
- §7.4 next-action timing and regulators
- §8.2 notifications
- §13 components
- §14 reconnect metric
- Scope header line

---

## What I changed (edit log)

- `01-research.md`: TL;DR 5; §6 P0.1, P0.6, P0.7.
- `02-capabilities.md`: §3.4.4; §5.3 mailto; §6.2 letter row; §6.3 cost note; §7.1 letters; §7.3 retention, cap and spacing; §8 pick; §9 Outlook and draft rows; stack table auth and hosting rows.
- `03-legal.md`: §8 Google publishing mode; §9 minimisation item 2 and hosting bullet; §10 M12; **new §6d and §6e** (no new citations).
- `04-ux.md`: sections listed in its fix list above. Structure is unchanged except new rows in §6.3, §7.1 and §13 and the `/login` line in §2.
- No [VERIFY] or [LAWYER] marker was removed.
