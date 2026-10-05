# 01 — Research: StopDisturbance

Status: research input for design. Date: 2026-10-05.
Scope: **single-user personal tool.** One person, based in Saudi Arabia, connects their own Gmail and Outlook accounts, picks companies, approves drafts, and sends deletion and stop-marketing requests from their own mailbox. Go-to-market topics are left out on purpose.

> Method note: many primary sites (arxiv, PETS, consumerreports.org, saymine.com, datarequests.org) could not be fetched from this sandbox. Some figures therefore come from search-result summaries of those pages. Every claim has a URL; claims marked **(unverified)** need a manual check before anything relies on them.

---

## TL;DR

1. **Copy Mine's model, not the data brokers' model.** Mine (saymine) is the closest prior product. It inferred companies from email metadata, drafted a deletion email that cited the date of the user's last interaction, showed the draft for approval, and sent it **from the user's own mailbox**. About 37% of its requests ended in deletion and 26% turned into back-and-forth replies. Tech companies complied about 5% of the time.
2. **The legal basis has to fit a Saudi resident.** CCPA and the other US state laws, including California's DROP, cover **residents of those states only**. What actually applies: **Saudi PDPL Art. 2**, which reaches foreign companies that process data of KSA residents, with a 30-day response deadline; and **GDPR** for companies that are *established in the EU* (Art. 3(1), Recital 14: "whatever their nationality or place of residence"). Every request should cite both, plus a fallback "please honor voluntarily" line.
3. **Expect most requests to go unanswered or be answered badly.** noyb found that 83.5% of access requests got no reply or an incomplete one. Erasure studies show 52–73% compliance. Response tracking, reminders, and escalation are the core features, not extras.
4. **Unsubscribing is not the same as objecting or deleting.** List-Unsubscribe (RFC 8058 one-click) stops one mailing list. It does not stop Customer Match or Custom Audience ad targeting, sale to third parties, or other channels. Do both: one-click unsubscribe where it is offered, and a GDPR Art. 21(3) / PDPL Art. 25 objection plus erasure request.
5. **Mailbox access for a personal tool is cheap.** Google's "personal use" exception (<100 known users) means no CASA audit for Gmail restricted scopes. The trade-offs are an "unverified app" screen and a **7-day refresh-token expiry in Testing mode**, so publish the consent screen "In production" (unverified) instead. Outlook.com now requires OAuth (basic auth and app passwords were turned off on 16 Sep 2024).
6. **Free, open contact data exists:** datarequests.org (CC0, GDPR-focused, JSON per company), JustDeleteMe (MIT, account-deletion links), and state broker registries (public records). Resolve contacts with a cascade: dataset → privacy policy scrape → known portal patterns → `privacy@` fallback.

---

## 1. Existing products

### 1.1 Comparison table

| Product | How it discovers companies | How it sends requests | Status / scale | Main complaints / failures | Sources |
|---|---|---|---|---|---|
| **Mine (saymine)** | Inbox scan of **subject lines and senders only**. NLP finds purchases, bookings and signups, then cross-references company privacy policies to compute a per-company risk score. | Drafts a "smart" deletion email that includes the date of the user's last interaction. The user previews and approves it, and it is **sent from the user's own mailbox**. | About 2M users at its peak. MineOS pivoted to an enterprise privacy platform and **sold the consumer app to McAfee (Nov 2025)**. | Some companies have no published privacy email, so requests stay pending. Billing was confusing ("$1/mo" billed yearly). Weak support. Users disliked handing full mailbox access to a privacy tool. | [TechCrunch 2020](https://techcrunch.com/2020/10/21/mine-series-a/), [Chrome Unboxed](https://chromeunboxed.com/say-mine-app-reclaim-your-digital-footprint), [Jewish News – McAfee deal](https://www.jewishnews.co.uk/mcafee-buys-israeli-privacy-app-from-mineos-in-strategic-expansion/), [Trustpilot](https://uk.trustpilot.com/review/saymine.com), [NoCamels](https://nocamels.com/2022/02/data-digital-privacy-startup-control-mine/) |
| **Incogni** (Surfshark) | No inbox scan. Works from a **fixed list of 420+ data brokers**, using name, email, DOB and address the user supplies. | Signs an authorization (agent) form, then sends automated legal requests from Incogni, repeating every 60 days (public brokers) or 90 days (private brokers). | Deloitte ISAE 3000 limited assurance (Aug 2025): 245M+ requests since Jan 2022. | Users report no drop in spam. It cannot touch companies the user signed up with, and it does **not verify** that brokers actually deleted anything. | [Incogni/Deloitte](https://blog.incogni.com/deloitte-independent-limited-assurance-report/), [GlobeNewswire](https://www.globenewswire.com/news-release/2025/08/13/3132680/0/en/Incogni-s-data-removal-process-and-standards-limited-assurance-provided-by-Deloitte.html), [Fossbytes review](https://fossbytes.com/incogni-review-2026/), [Trustpilot](https://uk.trustpilot.com/review/incogni.com?page=10) |
| **DeleteMe** | Scans 750+ people-search and broker sites for the user's profile. | **Human privacy advisors** fill opt-out forms. Where a site needs the user to act (ID or extra forms), DeleteMe gives guided steps. Quarterly reports. | Long-running. | CR 2024 field test: much weaker than Optery (41 percentage points behind). Its privacy policy allows sharing anonymized data. | [CyberInsider](https://cyberinsider.com/data-removal/deleteme-review/), [Norton](https://lifelock.norton.com/learn/fraud/is-deleteme-legit), [Optery statement on CR study](https://www.optery.com/optery-statement-on-consumer-reports-people-search-removal-study/) |
| **Optery** | Scans 270–640+ broker sites using name, address and email. Free tier gives an exposure report. | Automated plus human-assisted opt-outs. **Before/after screenshots as proof of removal.** | Best performer in the CR 2024 test (68% removed in 4 months). Published an **open-source directory of 640+ brokers on GitHub**. | Paid tiers needed for broad coverage. | [PCWorld](https://www.pcworld.com/article/3132996/optery-review.html), [Optery help](https://help.optery.com/en/article/how-often-does-optery-run-scans-and-opt-outs-z8xpc2/), [Optery GitHub directory](https://www.optery.com/opterys-open-source-data-broker-directory-is-now-live-on-github/) |
| **Jumbo** | Connected to the user's social accounts (not email). | Changed privacy settings, deleted old posts, broker checks, breach monitoring. | Acquired by Coalition (Jul 2023). Removed from the App Store in June 2024. | Shut down. Consumer privacy apps have had trouble staying in business. | [Jumbo wind-down](https://blog.jumboprivacy.com/jumbo_wind_down), [TechCrunch](https://techcrunch.com/2023/01/31/privacy-assistant-jumbo-tears-down-its-paywall/embed/) |
| **Permission Slip** (Consumer Reports) | A curated catalog of companies with privacy-policy summaries. The user picks companies. No inbox scan. | **CCPA authorized agent**: CR sends "Do not sell" and "Delete my account" requests after collecting a signed authorization, address and phone. The Plus tier ($59.99/yr) covers 100+ brokers plus 25 concierge requests a year. | More than 2M requests sent. | Companies routinely **deny non-residents** (for example, CVS denies anyone outside CA/CO/CT/VA). "Do not sell" does not stop first-party use. Verification emails get mistaken for phishing or land in spam; one company gave a 30-minute verification window. | [CR Innovation – How it works](https://innovation.consumerreports.org/how-does-permission-slip-work/), [Permission Slip Plus](https://innovation.consumerreports.org/introducing-permission-slip-plus), [AJC review](https://www.ajc.com/news/is-the-privacy-app-permission-slip-worth-it-a-review/YHI6CUUAMNHSBO4USUIQTULLWQ), [Cornell PI spotlight](https://www.pi.tech.cornell.edu/spotlight/pegah) |
| **Unroll.me** | Full inbox access (OAuth) to find newsletters. | Unsubscribes or bundles newsletters into a "Rollup". | Owned by Slice, then Rakuten Intelligence, then NielsenIQ (2021). Left the EU/EEA on 23 May 2018 rather than comply with GDPR. | **The 2017 scandal**: parent company Slice extracted full e-receipts (name, billing and shipping address, items) and sold derived panel data, including Lyft receipts to Uber. **FTC order (Aug 2019 proposed, Dec 2019 final)**: no fine. Must not misrepresent its data use, must notify affected users, and must delete stored e-receipts unless users give express consent. Its "we won't touch your personal stuff" pop-up was found deceptive. | [FTC Aug 2019](https://www.ftc.gov/news-events/news/press-releases/2019/08/operator-email-management-service-settles-ftc-allegations-it-deceived-consumers-about-how-it), [FTC Dec 2019 final](https://www.ftc.gov/news-events/news/press-releases/2019/12/ftc-finalizes-settlement-company-misled-consumers-about-how-it-accesses-uses-their-email), [FTC case page](https://www.ftc.gov/legal-library/browse/cases-proceedings/172-3139-unrollme-inc-matter), [Leave Me Alone explainer (competitor source)](https://leavemealone.com/blog/unroll-me-ftc-settlement-explained/) |
| **Clean Email** | Reads **headers and envelope only**. Temporary metadata deleted after 45 days. | Uses List-Unsubscribe or link-following where possible, otherwise **blocks the sender and routes mail to Trash**. | Passes annual Gmail API (CASA) audits. | It sometimes "unsubscribes" by filtering, which hides mail rather than stopping it. Complaints about auto-renewal and refunds. Rules can quietly trash wanted mail. | [Clean Email unsubscriber](https://clean.email/unsubscriber), [usecarly review](https://www.usecarly.com/blog/clean-email-review/), [App Store](https://apps.apple.com/us/app/clean-email-inbox-cleanup/id1441250616) |
| **Leave Me Alone** | Scans connected Gmail, Outlook and Yahoo for subscriptions. Does not store email content. | Clicks the real unsubscribe link or mailto. | Paid, privacy-first, revenue from users. Passed Google's 2019 security assessment (Project Strobe). | Small indie team. The Google audit was a significant cost and hurdle. | [Our story](https://leavemealone.com/blog/our-story/amp/), [Privacy-focused alternative](https://leavemealone.com/blog/a-privacy-focused-alternative-to-unroll-me-and-unsubscriber/), [Wiki](https://en.everybodywiki.com/Leave_Me_Alone_(software)) |

### 1.2 Hard evidence on effectiveness

- **CR people-search removal study (Aug 2024)**: of 332 listings found, only 117 (35%) were removed within 4 months. Paid services removed 27–68%. **Manual opt-outs did best at 70%.** Optery reached 68% and EasyOptOuts 65%. [Cyware summary](https://social.cyware.com/news/consumer-reports-study-finds-data-removal-services-are-often-ineffective-7731ecb0), [Marketplace](https://origin-www.marketplace.org/episode/2024/10/09/do-paid-data-removal-services-pay-off), [Optery statement](https://www.optery.com/optery-statement-on-consumer-reports-people-search-removal-study/)
- **Mine's own data**: 37% of companies completed deletion and 26% were "in conversation". Tech companies complied with 5% of deletion requests. Amazon completed 29%, eBay 73%, AliExpress 88% (2020). [Verdict](https://www.verdict.co.uk/who-holds-my-data/), [Mine – privacy in action](https://saymine.com/privacy-in-action)
- **CR authorized agent study (2021)**, 21 companies receiving "Do not sell" requests: 57% confirmed. 24% said they "don't sell" and dismissed the request. 14% gave no confirmation. 5% asked for non-standard information. [CR press release](https://advocacy.consumerreports.org/press_release/consumer-reports-study-finds-authorized-agents-can-empower-people-to-exercise-their-digital-privacy-rights-in-california), [CR report PDF](https://innovation.consumerreports.org/CR_AuthorizedAgentCCPA_022021_VF_.pdf)

### 1.3 Lessons to copy

| # | Lesson | From |
|---|---|---|
| L1 | **Send from the user's own mailbox, with approval for each draft.** Replies come back to the user's inbox, where the tool can track them. There is no agent-authorization friction, and the user is clearly the requester. | Mine |
| L2 | **Discover companies from metadata only** (From domain, subject, List-Unsubscribe and List-Id headers). No email bodies. | Mine, Clean Email, Leave Me Alone |
| L3 | **Put the last-interaction date and the account email in the request.** This makes it easy for the company to find the record and lowers verification friction. | Mine |
| L4 | **Keep evidence**: the sent message ID, timestamps, and the reply thread (the equivalent of Optery's screenshots). Needed for escalation to a regulator. | Optery |
| L5 | **Re-check and re-send.** Data comes back. Incogni repeats every 60–90 days, and brokers rebuild profiles from new public records. | Incogni, [Offlist](https://www.offlist.me/why-does-my-data-reappear-on-data-brokers) |
| L6 | **Tell the user exactly what each request can and cannot do.** Unsubscribe, do-not-sell and deletion are different things. | Permission Slip, CR |

### 1.4 Mistakes to avoid

| # | Mistake | From |
|---|---|---|
| M1 | Using or storing email content beyond what the stated purpose needs. Keep no copies of receipts. Retention should be minimal and explained. | Unroll.me (FTC order) |
| M2 | Claiming "unsubscribe" when the tool only filters mail into Trash. | Clean Email |
| M3 | Citing laws that do not apply to the user (CCPA for a Saudi resident). Companies deny these requests automatically. | Permission Slip (CVS denial) |
| M4 | A fixed broker list that ignores the companies the user actually deals with. "Spam didn't stop." | Incogni complaints |
| M5 | No follow-up loop. Requests sit "pending" forever. | Mine complaints |
| M6 | Treating a company's acknowledgment as completion, without checking anything. | Incogni |

---

## 2. Finding a company's privacy contact automatically

### 2.1 Open datasets (use these first)

| Dataset | What it holds | License | Fit | Source |
|---|---|---|---|---|
| **datarequests.org / datenanfragen `data` repo** | One JSON file per company in `companies/`, following `schema.json`. Privacy email, address, web form, fax, required identification elements, and relevant countries. Also includes **supervisory authorities** and **request templates in several languages**. | **CC0 1.0** | Best primary source for GDPR-scope companies. | [Contribute page](https://www.datarequests.org/contribute/), [example: GitHub, Inc.](https://www.datarequests.org/company/github/), [GitHub repo](https://github.com/datenanfragen/data) |
| **JustDeleteMe** (`_data/sites.json`) | 500+ services: account-deletion URL, difficulty rating, notes, sometimes an email. | **MIT** | Good for an "also delete the account directly" link. | [jdm fork](https://github.com/thibaultmol/jdm/blob/master/_data/sites.json), [TechCrunch](https://techcrunch.com/?p=866816) |
| **YourDigitalRights.org** | Thousands of organizations with request channels. Covers 25+ privacy laws, with follow-up and regulator escalation. | "All code, data and methods are public and free to reuse" (exact license **unverified**) | Second source, plus templates for laws other than GDPR. | [About](https://yourdigitalrights.org/about) |
| **Optery data broker directory** | 640+ brokers: opt-out links, guides, contact emails. | Open source on GitHub (license **unverified**) | Optional broker list (§3). | [Optery announcement](https://www.optery.com/opterys-open-source-data-broker-directory-is-now-live-on-github/) |
| **Big Ass Data Broker Opt-Out List (BADBOOL)** | Curated broker opt-out instructions, updated 26 Jul 2026. | Free (license **unverified**) | Human-readable cross-check for broker steps. | [GitHub](https://github.com/yaelwrites/Big-Ass-Data-Broker-Opt-Out-List) |
| **Privacy Rights Clearinghouse broker DB** | 750 unique broker groups merged from CA (CPPA and AG), VT, TX and OR registries. Matching error rate under 2%. | Free to browse (terms **unverified**) | Optional broker list (§3). | [PRC](https://www.privacyrights.org/data-brokers), [EFF Appendix B 2025](https://www.eff.org/document/appendix-b-databrokerfullregistry2025) |
| **State registries** (CPPA, VT, TX, OR) | Broker name, email, website, opt-out method. | Government public records | Optional broker list. | §3 |

### 2.2 Machine-readable standards (immature, but worth probing)

| Mechanism | What it is | Adoption | Source |
|---|---|---|---|
| **`/.well-known/privacy.txt`** (IETF draft-colwell-privacy-txt-01, Jun 2024) | Like security.txt. A required privacy-office email, plus fields `Action-delete-account-and-data`, `Action-delete-personal-data`, `Action-opt-out-marketing`, `Action-opt-out-sharing`, each taking an email or a one-click URL. | Individual draft, very low adoption. Cheap to probe. | [IETF datatracker](https://datatracker.ietf.org/doc/draft-colwell-privacy-txt/) |
| **`/.well-known/gpc.json`** + `Sec-GPC: 1` | Global Privacy Control. A browser signal for opting out of sale or sharing. `gpc.json` declares that the site supports it. Legally recognized in CA, CO, CT (Jan 2025) and NJ (Jul 2025). | Widely supported. **Covers web tracking and sale only; it is not an email-request channel.** | [Wikipedia](https://en.wikipedia.org/wiki/Global_Privacy_Control), [Concord](https://www.concord.tech/blog/global-privacy-control-gpc-multi-state-mandate) |
| **Data Rights Protocol (DRP)** (Consumer Reports consortium) | API spec for authorized agent to business requests, with directory services for agents and businesses. | Pilot, for registered agents only. **Not usable by an individual.** | [CR DRP](https://innovation.consumerreports.org/initiatives/data-rights-protocol/), [CR press 2023](https://www.consumerreports.org/media-room/press-releases/2023/09/consumer-reports-advances-data-rights-protocol-to-uphold-consumer-data-rights-by-making-it-easier-for-companies-to-honor-them) |

### 2.3 Request-portal vendors (detect them, then send the user to the form)

Many large companies accept requests **only** through a hosted web form. Detect these by scanning the privacy-policy page for known link patterns:

| Vendor | Recognizable URL pattern | Source |
|---|---|---|
| OneTrust | `privacyportal.onetrust.com/webform/<uuid>/<uuid>`, `privacyportal-<region>.onetrust.com`, `<org>-privacy.my.onetrust.com` | [example form](https://privacyportal.onetrust.com/webform/45e4be25-919b-483f-9f95-12809576a2b3/b49a8daf-a03f-46f5-8376-57e2abd162c4), [Ping connector docs](https://docs.pingidentity.com/connectors/onetrust_connector.html) |
| TrustArc | `submit-irm.trustarc.com/...` (Individual Rights Manager) | [TrustArc IRM](https://trustarc.com/products/dsar-individual-rights/) |
| DataGrail | Privacy Request Center on the company's domain. Form hosted at `preferences.datagrail.io` | [DataGrail docs](https://docs.datagrail.io/docs/request-manager/request-intake/privacy-request-center/overview) |
| Transcend | Privacy Center, usually `privacy.<company>.com` (custom domain), backed by Transcend | [Transcend docs](https://docs.transcend.io/docs/articles/privacy-center) |
| Ketch | Hosted rights form (pattern **unverified**; detect by the Ketch script tag) | [G2 comparison](https://www.g2.com/compare/ketch-vs-trustarc) |

Portals often still email the requester a verification link, so the tool should watch for that email and flag it to the user (CR saw people mistake these for phishing). Email still works as a legal channel. Under GDPR a controller cannot insist on one specific channel, but a form is usually processed faster.

### 2.4 Recommended resolution cascade (per company domain)

1. Local overrides (user edits) → 2. **datarequests.org** match by domain → 3. **JustDeleteMe** for an account-deletion link → 4. fetch `/.well-known/privacy.txt` → 5. fetch the privacy policy (links in the footer: "privacy", "privacy-policy", "datenschutz", "سياسة الخصوصية"). Regex for `mailto:` addresses containing `privacy|dpo|gdpr|dataprotection|datenschutz`, and detect portal patterns from §2.3 → 6. guess `privacy@<domain>`, then `dpo@<domain>`. Check the MX record. **Show a low-confidence badge** and ask the user to confirm → 7. last resort: the support address the company emails from.
Record `source + confidence + last_verified` for each contact.

---

## 3. Data brokers

| Registry | Size | Notes | Source |
|---|---|---|---|
| California (CPPA, Delete Act) | 405 entries in Mar 2024. Above 500 by 2026 (DROP reaches "500+") | **DROP** launched 1 Jan 2026. Brokers process requests from 1 Aug 2026, every 45 days. Fines of $200 per day per request. **Only verified CA residents can use it** (CA Identity Gateway or Login.gov). | [CalPrivacy](https://privacy.ca.gov/2025/12/january-2026-drop-is-coming/), [CyberInsider](https://cyberinsider.com/california-launches-tool-enabling-mass-opt-out-from-data-brokers/), [Clym](https://www.clym.io/blog/california-cppa-publishes-data-broker-registry) |
| Vermont (Sec. of State) | 441 ever registered. 309 brokers registered elsewhere were missing | $100 fee. Bulk DB download available. | [PRC VT letter](https://privacyrights.org/sites/default/files/2025-06/2025-06-24%20-%20Vermont%20Data%20Broker%20Letter.pdf), [Monda](https://www.monda.ai/blog/data-broker-registries-in-the-us) |
| Texas (Sec. of State) | 226 | $300 a year. Bus. & Com. Code §510.006. | [TX SOS](https://www.sos.texas.gov/statdoc/data-brokers.shtml) |
| Oregon (DCBS/DFR) | 275. 475 brokers registered elsewhere were missing | Required since 1 Jan 2024 (HB 2052). | [Oregon DFR](https://dfr.oregon.gov/business/licensing/data-broker-registry), [PRC OR letter](https://privacyrights.org/sites/default/files/2025-06/2025-06-24%20-%20Oregon%20Data%20Broker%20Letter.pdf) |

**Broker compliance is poor.** CA brokers denied or ignored more than 1M deletion requests over two years. VisitIQ denied more than 270k of about 363k; HealthWise complied with fewer than 10k of 98k ([Bloomberg Law](https://news.bgov.com/privacy-and-data-security/data-brokers-deny-a-million-pleas-to-delete-personal-information)). A July 2026 study of all CA-registered brokers, using synthetic identities, found many did not reply and some demanded intrusive ID verification for opt-outs, which CCPA prohibits ([van Kempen & Tsudik, arXiv 2607.04552](https://arxiv.org/abs/2607.04552)).

**Should they be included?** Yes, but as an **optional, off-by-default "known brokers" list, kept separate from the inbox-discovered list**:
- Most registered brokers are US-focused and hold US public-records data. A Saudi resident is probably in fewer of these databases, and CCPA, DROP and other state rights **do not apply** to them. Some brokers honor requests regardless of residency (for example, [Acxiom](https://www.acxiom.com/optout/)). Of these brokers, only the **global ad-tech and marketing-data** ones (identity graphs, email-hash brokers) are likely to hold the user's email.
- Recommendation: ship a small curated set of global brokers that are likely to hold an email or ad identifier, built from PRC/Optery data and filtered to broker types like "marketing" or "identity resolution". Use generic GDPR/PDPL requests where the broker has an EU establishment. Make it opt-in, and label it "may not have your data".

---

## 4. Response rates and what gets requests honored

| Study | Sample | Finding | Source |
|---|---|---|---|
| Herrmann & Lindemann (2016) | Apps and websites | Erasure honored in **52–57%**. Under half answered access requests satisfactorily. **About 20% would disclose data to impostors.** | [arXiv 1602.01804](https://arxiv.org/abs/1602.01804) |
| Talend (2018) | 103 companies | **70% missed** the one-month deadline for access/portability. Retail failed 76%. | [IDM](https://idm.net.au/node/12185) |
| Urban et al., DPM 2019 | 38 ad-tech companies | 55% disclosed within the deadline. 34% sent a data copy in time. | [CISPA](https://cispa.de/de/research/publications/68634-a-study-on-subject-data-access-in-online-advertising-after-the-gdpr) |
| Di Martino et al., SOUPS 2019 | 55 organizations | Impersonation succeeded at **15 of 55** using public or forged information. | [USENIX](https://www.usenix.org/conference/soups2019/presentation/dimartino) |
| Pavur, Black Hat 2019 | 150+ businesses | 72% handled the request. Of the 83 holding the subject's PII, **24% gave it to an impostor**. | [arXiv 1912.00731](https://arxiv.org/pdf/1912.00731), [BH slides](https://i.blackhat.com/USA-19/Thursday/us-19-Pavur-GDPArrrrr-Using-Privacy-Laws-To-Steal-Identities.pdf) |
| Rupp, Syrmoudis, Grossklags, PoPETs 2022 | 90 online services | **27% non-compliant** with Art. 17. Results differed between a dedicated "delete" button and a formal Art. 17 request. Follow-up Art. 15 requests after 6 months were used to check that data was really gone. | [PoPETs](https://petsymposium.org/popets/2022/popets-2022-0080.php) |
| noyb (8 years of cases, 2025) | Many, incl. big tech | Only **16.5% satisfactory**. 53.7% incomplete. About 30% no answer. | [noyb](https://noyb.eu/node/1626) |
| EDPB CEF 2024 (access) | 1,185 controllers, 30 DPAs | Barriers: onerous formal requirements, **excessive ID demands**, over-use of exceptions. | [Freevacy](https://www.freevacy.com/news/edpb/edpb-publishes-2024-coordinated-enforcement-report/6076) |
| EDPB CEF 2025 (erasure), Feb 2026 | 764 controllers, 32 DPAs | Missing procedures, retention-period confusion, "anonymisation" used instead of deletion, backups not purged. | [EDPB news](https://www.edpb.europa.eu/news/edpb-identifies-challenges-hindering-the-full-implementation-of-the-right-to-erasure_en), [Report PDF](https://www.edpb.europa.eu/system/files/2026-02/edpb_cef-report_2025_right-to-erasure_en.pdf) |
| CR authorized agent (2021, 2022) | 21 companies | 57% confirmed opt-out. Verification emails were treated as spam or phishing. One company allowed a 30-minute window. CR recommends at least 3 days. | [CR PDF](https://innovation.consumerreports.org/CR_AuthorizedAgentCCPA_022021_VF_.pdf), [CR early look](https://innovation.consumerreports.org/an-early-look-at-how-companies-handle-ccpa-requests-submitted-by-authorized-agents/) |

**What gets requests honored, per the evidence above:**
1. **Send from the email address the company already knows.** This is the main identity signal, and most of the impostor studies relied on mismatched channels. Sending from the account address avoids most ID demands. Never send ID documents by default; a controller may only ask for more information if it has "reasonable doubts" (GDPR Art. 12(6)).
2. **Cite a law that actually applies, with article numbers and a deadline**: PDPL 30 days (+30 extension), GDPR one month (Art. 12(3)). Formal Art. 17 requests produced different results from "delete" buttons (Rupp et al.).
3. **Name the specific data**: account email, any customer or order ID found in metadata, last interaction date.
4. **Follow up on a fixed schedule** and **escalate to a regulator** (the datarequests.org dataset includes supervisory authorities; SDAIA for PDPL).
5. **Combine erasure with an objection to marketing** (Art. 21(3) is absolute, so no balancing test applies) and with a request to notify recipients (GDPR Art. 19).
6. **Verify afterwards** with an access request months later (Rupp et al. method), or simply watch the inbox for new mail from that sender.

### 4.1 Legal basis for a Saudi-resident user

| Law | Applies when | Deadline | Notes | Source |
|---|---|---|---|---|
| **Saudi PDPL** (in force 14 Sep 2023, enforced from 14 Sep 2024) | **Any** processing of data of KSA residents, **including by parties outside the Kingdom** (Art. 2). No targeting test, so broader than GDPR. | 30 days, extendable by 30 | Rights to access, correction and destruction. **Art. 25: marketing by email needs consent, and opt-out must be honored** (implementing rules: stop within 24h is cited in commentary). Fines up to SAR 5M. Regulator: **SDAIA**. | [Akin Gump](https://www.akingump.com/en/insights/alerts/kingdom-of-saudi-arabias-new-personal-data-protection-law-and-implementing-regulations-key-obligations-responsibilities-and-rights), [Latham](https://www.lw.com/en/insights/2023/12/Saudi-Arabias-data-protection-law-enters-into-force), [Usercentrics](https://usercentrics.com/knowledge-hub/saudi-arabia-personal-data-protection-law-pdpl), [Al Tamimi on marketing consent](https://turtl.tamimi.com/story/law-update-issue-367-saudi-arabia-and-competition/page/11) |
| **GDPR** | Controller **established in the EU/EEA** (Art. 3(1)), whatever the data subject's residence (Recital 14). Non-EU companies that target only Saudi users are generally outside GDPR. | 1 month (+2) | Art. 15/17/21(3). For companies in the UK, UK GDPR applies in the same way. | [GDPR Recital 14](https://gdpr-info.eu/recitals/no-14/), [datarequests.org on territorial scope](https://www.datarequests.org/blog/gdpr-territorial-scope/), [noyb Art. 21](https://noyb.eu/node/252) |
| CCPA / US state laws | **State residents only.** | 45 days | Do not cite them. Some companies honor requests anyway, so add a voluntary-compliance line. | [Clifford Chance](https://www.cliffordchance.com/insights/resources/blogs/talking-tech/en/articles/2021/07/colorado-joins-california-and-virginia-with-a-comprehensive-data-privacy-law.html), [Acxiom](https://www.acxiom.com/optout/) |

The enforcement reach of PDPL against foreign companies with no Saudi presence is untested. In practice, foreign companies respond to PDPL citations voluntarily; that is my inference, not a finding. GDPR is the strongest lever wherever an EU establishment exists, and the datarequests.org dataset helps identify those.

---

## 5. Unsubscribe mechanics

| Mechanism | Detail | Source |
|---|---|---|
| `List-Unsubscribe` (RFC 2369) | `<mailto:...>` and/or `<https://...>` header. | [RFC 8058 datatracker](https://datatracker.ietf.org/doc/rfc8058) |
| **RFC 8058 one-click** | Header `List-Unsubscribe-Post: List-Unsubscribe=One-Click` plus an HTTPS URI. The client sends a **POST** with that body and **no cookies or auth**. The sender must not redirect. Only trust it if a **valid DKIM signature covers both headers**. Unsubscribe happens within 48h. | [RFC 8058](https://datatracker.ietf.org/doc/rfc8058), [Customer.io](https://docs.customer.io/journeys/custom-unsubscribe-links/) |
| **Gmail/Yahoo bulk-sender rules (Feb 2024, enforced from Jun 2024)** | Senders of more than 5,000/day to Gmail need SPF, DKIM and DMARC, **one-click unsubscribe**, unsubscribes **honored within 2 days**, and a spam rate under 0.3%. | [Resend](https://resend.com/blog/gmail-and-yahoo-bulk-sending-requirements-for-2024), [Red Sift](https://redsift.com/guides/google-and-yahoos-bulk-email-sender-requirements) |
| **Outlook.com (5 May 2025)** | Same idea for more than 5,000/day: SPF, DKIM and DMARC (p=none or stricter), working unsubscribe. Non-compliant mail goes to Junk, with rejection to follow. | [Mailtrap](https://mailtrap.io/blog/outlook-new-email-sender-requirements/), [EasyDMARC](https://support.easydmarc.com/knowledge-base/outlooks-new-email-authentication-requirements-for-high-volume-senders-effective-may-2025) |

**Does unsubscribe stop ads?** No, on its own it does not:
- It removes the user from **one list or stream**. The company keeps the email address on a **suppression list**, and suppression lists are often shared with partners as MD5 hashes ([UnsubCentral](https://www.unsubcentral.com/share-suppression-lists/), [Suped](https://www.suped.com/knowledge/email-deliverability/compliance/what-are-the-pros-and-cons-of-using-unsubcentral-for-managing-suppression-lists)).
- It does not stop **Customer Match or Meta Custom Audiences**, where companies upload hashed customer emails to target ads on Google and Meta ([Adtribute](https://www.adtribute.io/glossary/customer-match), [BusinessTech FAQ](https://faq.businesstech.fr/faq/527)). It also does not stop SMS, post, sale to brokers, or other brands in the same group.
- A **formal objection** (GDPR Art. 21(3), absolute; PDPL Art. 25) covers **all direct-marketing processing**, which includes ad audiences. **Erasure** goes further. Note the tension: if the company deletes everything, it cannot suppress the address, and a later re-import can bring it back. Templates should ask for "erase, but keep only the minimum needed to honor my objection".
- **Opt-out of sale/sharing** (CCPA) is a separate right again, and not available to the user anyway.

---

## 6. Recommendations for the product (single-user, prioritized)

**P0: must have for v1**

1. **Mailbox access with personal-use OAuth, no audit.**
   - Gmail: create your own GCP project and use the **personal-use exception** (under 100 known users, so no verification or CASA). Accept the "unverified app" screen. **Publish the consent screen "In production"** rather than leaving it in "Testing", or refresh tokens expire every 7 days. Note: for an unverified app with restricted scopes, Google's docs mention a limited refresh-token lifetime even in production, so test this early and build a clean "reconnect" flow. Scopes: **`gmail.readonly` + `gmail.send`** (decided in 00-review.md). `gmail.metadata` was the first choice, but it forbids `q` search and `format=full`, so replies could not be read. The scan still fetches headers only (`format=metadata`); bodies are fetched only for threads of requests the owner sent. [Google: when verification is not needed](https://support.google.com/cloud/answer/13464323?hl=en), [Unverified apps](https://support.google.com/cloud/answer/7454865?hl=en), [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [token expiry in Testing mode](https://tech.sailjada.com/posts/2026-05-06-1924.html)
   - Outlook.com/Hotmail: register an Entra app ("personal Microsoft accounts" audience) and use Microsoft Graph `Mail.Read` + `Mail.Send` + `offline_access`. Basic auth and app passwords stopped working on 16 Sep 2024, so OAuth is required. [Microsoft notice](https://support.microsoft.com/sr-latn-rs/support/known-issues/modern-authentication-methods-now-needed-to-continue-syncing-outlook-email-in-non-microsoft-email-ap)
2. **Discovery from headers only.** Group by registrable sender domain and map ESP sending domains (e.g. `*.sendgrid.net`, `mcsv.net`) back to the brand using the From display name and DKIM `d=`. Classify each as marketing (has List-Unsubscribe or List-Id), transactional (receipt or order keywords in the subject), or account (signup or verify). Store only domain, counts, first and last seen dates, and the list headers. **Never store bodies** (the Unroll.me lesson, even for one user: it limits breach impact).
3. **Contact resolver** using the §2.4 cascade. Bundle **datarequests.org (CC0)** and **JustDeleteMe (MIT)** snapshots locally and refresh them weekly from GitHub. Show the source and confidence for every contact, and let the user edit it.
4. **Request templates that fit a Saudi resident**: one combined letter with
   (a) PDPL Art. 4 destruction, plus Art. 25 marketing opt-out, 30 days;
   (b) GDPR Art. 17 erasure plus **Art. 21(3) objection** plus Art. 19 notify recipients, included only when the company has an EU/UK establishment (from the dataset or the policy text);
   (c) "if neither applies, please honor this voluntarily as you do for other jurisdictions";
   (d) the identifiers: account email, last-interaction date, order or customer IDs taken from subjects only;
   (e) an explicit "do not require ID documents; I am writing from the registered address" line, citing Art. 12(6).
   Offer English by default, with Arabic and German templates from datarequests.org.
5. **Send from the user's own mailbox, approving each draft.** Store the message ID and thread ID.
6. **Tracker**: states `drafted → sent → acknowledged → needs-action (verify / portal / ID) → completed / refused / overdue`. Compute the deadline from the law (PDPL 30 days; GDPR one calendar month; see 00-brief §5). **Reminder draft offered at deadline + 3 days** (at most one reminder, 03-legal S3), and a **regulator-complaint draft** offered 7 days after the reminder (EU DPA from the datarequests.org authorities list; SDAIA for PDPL). Thread-match replies, and use simple keyword classification ("deleted", "verify", "we are unable", "portal") with the user confirming.
7. **One-click unsubscribe first**: if RFC 8058 headers are present and DKIM covers them, do the POST once the owner approves it in the send confirmation (cheap, honored within 2 days for compliant senders), then queue the legal letter if the user also ticked "delete".

**P1: next**

8. **Portal detection**: recognize OneTrust, TrustArc, DataGrail and Transcend links and show "this company uses a web form", with the link, a pre-filled text block to paste, and a checklist item. Watch the inbox for the portal's verification email and alert the user (CR's phishing and spam lesson).
9. **Verification loop**: after a request is marked complete, keep watching for new mail from that domain. If any arrives, flag "re-appeared" and offer a reminder or escalation. Optionally send an Art. 15 access request 6 months later to confirm deletion.
10. **Evidence export**: per-company PDF or EML bundle (sent request, replies, timeline) for regulator complaints.
11. **`/.well-known/privacy.txt` probe**: cheap, and future-proof if adoption grows.

**P2: optional**

12. **"Known brokers" pack (off by default)**: a curated set of global marketing and identity-graph brokers from the PRC registry merge or Optery's GitHub directory, using GDPR/PDPL templates and labeled "may not hold your data". Skip DROP and US people-search sites; CCPA does not cover a Saudi resident.
13. **Account-deletion deep links** from JustDeleteMe for services where the user has an account. Deleting the account is often faster than a legal request.

**Do not build**: authorized-agent flows (not needed when the user sends their own requests), the DRP protocol (for registered agents only), GPC (a browser signal, not a mail channel), or any storage of email bodies or receipts.

**Open questions to verify by hand**: the exact licenses of YourDigitalRights, Optery's directory and BADBOOL; Ketch's portal URL pattern; whether Google's "unverified + In production" status still limits refresh tokens for restricted Gmail scopes (test on day 1); the current exact wording of the PDPL implementing regulations on the marketing opt-out timeline.
