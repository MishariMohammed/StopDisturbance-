# StopDisturbance runbook

Operational procedures for the owner (00-brief §10, §9 M6). Railway hosts two services from one image: `web` (`npm run start`) and `worker` (`npm run worker`), plus Postgres. All times are Asia/Riyadh.

Scheduled jobs (worker, pg-boss): sync every 10 min, reply poll at :05 past each 10 min, datasets Sunday 03:17, **retention daily 04:00**, deadline tick 06:00, weekly digest Sunday 09:00, send dispatch every 15 s.

---

## 1. Backup and restore drill (owner performs; once before first real send, then every 3 months)

Railway Postgres has daily backups once enabled (Project → Postgres → Backups). The drill proves a backup can be restored and the app works on it. Never restore over production to "test".

1. **Confirm backups exist:** Postgres service → Backups. There should be a backup from the last 24 h. If none, enable daily backups and take a manual one now.
2. **Create a preview environment:** Project → Environments → New environment → "Fork from production" (or duplicate it). Name it `restore-drill`. This creates separate `web`, `worker` and Postgres instances.
3. **Stop the drill worker first:** in `restore-drill`, set the `worker` service replicas to 0 (or remove its start command). A worker running on restored data would **send real letters and poll real mailboxes**.
4. **Restore:** in `restore-drill` → Postgres → Backups, choose the latest production backup → Restore. Wait until it reports done.
5. **Point the drill web service at a different URL:** give it its Railway-generated domain only (no custom domain). Do not change OAuth redirect URIs; you will not connect mailboxes here.
6. **Check:**
   - `GET https://<drill-domain>/api/healthz` returns 200.
   - Sign in and open `/tracker`: the request count and the newest request match production.
   - Open `/settings/data`: counts of companies and requests match production.
   - `npx prisma migrate status` against the drill database (Railway shell or `railway run --environment restore-drill npx prisma migrate status`) reports "Database schema is up to date".
7. **Record** the date, the backup timestamp used and the result in your notes.
8. **Delete** the `restore-drill` environment (it holds a full copy of your data).

To restore production for real (data loss incident): stop the production `worker` (replicas 0), restore the chosen backup on the production Postgres, run `npx prisma migrate deploy`, start `web`, check `/api/healthz` and `/tracker`, then start `worker`. Any request sent after the backup time is in your Sent folder but not in the app; re-add it by hand in the tracker or accept the gap.

---

## 2. TOKEN_ENC_KEYS rotation

`TOKEN_ENC_KEYS` is a JSON object of base64 32-byte AES-256-GCM keys by version, e.g. `{"1":"…"}`; `TOKEN_ENC_KEY_CURRENT` names the key used for new writes. It encrypts OAuth tokens, one-click URLs, reply bodies, evidence headers and LLM payload samples. Rotate if a key may have leaked, and otherwise yearly.

1. Generate a key: `openssl rand -base64 32`. Store it in your password manager **before** using it.
2. In Railway, **on both `web` and `worker`** (shared variable recommended), add it as the next version and switch the current version:
   `TOKEN_ENC_KEYS={"1":"<old>","2":"<new>"}` and `TOKEN_ENC_KEY_CURRENT=2`. Deploy both services.
   - New writes use key 2. Old values stay readable because key 1 is still listed.
3. Re-encrypt everything still under the old key:
   `railway run --service worker npx tsx scripts/reencrypt-keys.ts`
   It prints counts per table and exits non-zero if any value could not be decrypted. Run it twice; the second run must report all zeros.
4. Take a manual Postgres backup, then remove the old key: `TOKEN_ENC_KEYS={"2":"<new>"}`. Deploy both services.
5. Check: `/settings` shows every mailbox as Connected; the next 10-minute sync logs no `reconnect_required`; open one reply in `/tracker` to confirm reply bodies still decrypt.
6. **Never** remove a key that backups still need: a restored backup older than the rotation needs the old key. Keep old keys in the password manager (not in Railway) for as long as you keep backups.

If a key leaked: rotate as above, then also reconnect every mailbox from `/settings` (Reconnect) so new refresh tokens are issued, and revoke the old grants (Google: myaccount.google.com/permissions; Microsoft: account.live.com/consent/Manage).

---

## 3. Day 8: Gmail token check (M1 spike)

The Google project is published "In production" without verification (00-review). Testing-mode refresh tokens die after 7 days; this check confirms the production route works for restricted scopes.

1. On day 8 after connecting Gmail, open `/settings` → Mailboxes.
2. Expected: the Gmail row shows **"Connected"** and **"Gmail token: OK · last refreshed <today or yesterday>"**, with no reconnect prompt. The worker refreshes the access token roughly hourly during sync.
3. If it shows "Reconnect needed": check Google Cloud → Audience still says "In production". Note the date, reconnect, and tell the developer: the fallback is Testing mode with weekly reconnects (03-legal §8 [VERIFY]).
4. Record the result (pass/fail and date) in your notes.

---

## 4. Day 1: live checks (before any company receives a letter)

Run these on the first day with real mailboxes. Each check is a go/no-go for sending.

1. **Outlook.com returns `internetMessageHeaders`.** After connecting Outlook and the first scan page finishes, open `/companies` and the evidence drawer of an Outlook-only sender. It must show List-Unsubscribe / authentication flags. If every Outlook company has empty evidence, Graph is not returning headers for the consumer account: stop and report (the scan falls back to sender-only data and one-click is never offered).
2. **Graph delta `$filter` works.** The initial Outlook sync calls `/mailFolders/{folder}/messages/delta` with `$filter=receivedDateTime ge <scanFrom>`. In `/scan`, Outlook progress must move past 0 and the worker logs must show no `400` from `graph.microsoft.com`. If Graph rejects the filter, the scan fails visibly: report it and do not proceed.
3. **First real send goes to an address you control.** The app has no screen to change a draft's recipient, so do this once by hand before approving anything for a company:
   1. Pick one company in `/companies` and mark it Remove, but do **not** create drafts yet.
   2. Run `railway run --service web npx prisma studio`, open `CompanyContact`, and change that company's EMAIL contact `value` to a second address you own (note the original value).
   3. In `/review`, create the draft and confirm the recipient shown is your own address. Approve it, wait for the 10-second undo window, and check:
   - the message is in your Sent folder with the right subject (`Ref SD-…`) and body;
   - it arrives in the other mailbox, not in spam;
   - `/tracker` shows it as Sent with a deadline;
   - replying to it from the other mailbox is detected as a reply within ~10 minutes.
   4. Close that request in `/tracker`, restore the contact's original value in Prisma Studio, and only then approve real company letters, starting with one company.
4. **One-click unsubscribe:** the first one-click item must be for a sender you don't mind unsubscribing from. Confirm `/tracker` marks it Sent and the sender's mail stops within 10 business days.

---

## 5. Release checklist

Tick every item before each release that changes letters, legal text, deadlines or data handling.

- [ ] `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e` and `npm run build` pass.
- [ ] Axe reports 0 serious/critical issues on every page in `ar` and `en` (e2e).
- [ ] **03-legal [VERIFY] items re-checked** against official texts (SDAIA, EUR-Lex, ICO, FTC), at least:
  - [ ] S5: PDPL Implementing Regulations amendment status (90-day complaint limit; Art. 28 changes); UAE PDPL Executive Regulations.
  - [ ] PDPL article numbers used in letters: Art. 5(2) consent withdrawal, Art. 26 direct marketing, Art. 34/33 complaint numbering, IR Art. 4 identity verification, foreign-controller representative provision.
  - [ ] SDAIA complaint route (dgp.sdaia.gov.sa, Nafath login).
  - [ ] UK Data (Use and Access) Act 2025 commencement status.
  - [ ] Bahrain and Qatar response periods.
  - [ ] Google: refresh tokens for restricted scopes survive >7 days in unverified production (day-8 check above).
  - [ ] Microsoft: current Outlook.com daily recipient limits.
  - [ ] DeepSeek: API-level training opt-out mechanics.
- [ ] **Arabic templates reviewed by Saudi counsel.** Until then `/settings` → Arabic letters stays **off** and letters go out in English. Record the reviewer and date when turning it on.
- [ ] Retention job ran in the last 24 h (worker log line `retention done`).
- [ ] Backup drill done within the last 3 months (§1).
- [ ] Log sample checked: no email addresses, subjects, tokens or URL query strings in Railway logs (`logger.ts` redaction; `tests/log-redaction.test.ts`).

---

## 6. Erase and disconnect (reference)

- **Disconnect one mailbox** (`/settings` → Mailboxes → Disconnect): revokes the Google grant (oauth2.googleapis.com/revoke), wipes its tokens and deletes its stored headers. Microsoft has no revoke API for consumer accounts: remove the app at https://account.live.com/consent/Manage.
- **Erase everything** (`/settings/data`, type ERASE / امسح): revokes all Google grants, empties every table including sign-in data, optionally keeps the audit rows of requests that were actually sent, and shows the Microsoft consent link. Backups taken before the erase still contain the data until Railway expires them; delete them manually in Postgres → Backups if needed.
- **Export** (`/settings/data` → Download my data): JSON without tokens or encrypted values.
