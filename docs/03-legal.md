# 03 — Legal Specification (StopDisturbance)

**Status:** product spec, not legal advice. Prepared 2026-10-05. Items marked **[LAWYER]** need review by qualified counsel (Saudi counsel for PDPL items) before you rely on them. Items marked **[VERIFY]** are article numbers or facts I could not confirm against the official consolidated text during research. The official SDAIA, EUR-Lex and ICO pages were not reachable from the research environment, so some citations rest on secondary sources (law-firm and regulator summaries), which are listed.

**Scope (per user decision):** **personal use only**. There is one user, the user's own Gmail/Outlook mailboxes, and every request is sent **in the user's own name from the user's own mailbox**, after the user approves each draft. The LLM is the user's own **DeepSeek API** key (servers in the PRC).

---

## 0. Key conclusions (read first)

1. **Saudi PDPL is the main law for a KSA resident.** It applies to any entity anywhere that processes personal data of people residing in the Kingdom (PDPL Art. 2). Every company, foreign or domestic, can be asked to destroy data (Art. 4) and to stop advertising (Art. 25/26; Implementing Regulations Art. 28). The deadline is **30 days**, plus at most 30 more if the company gives notice (IR Art. 4).
2. **GDPR protects the KSA user only against companies that have an EU establishment** (Art. 3(1)). Art. 3(2) "targeting" does **not** protect someone physically in KSA. UK GDPR works the same way for UK-established companies.
3. **CCPA/CPRA and other US state laws protect only residents of those states.** They give a KSA resident **no** rights. Do not cite them as rights. You can mention them only as a "your own published policy" argument.
4. **CAN-SPAM applies to commercial email whatever the recipient's country.** The opt-out must be honored within **10 business days**. It is the most useful universal hook for US senders.
5. Because the user sends in their own name from their own mailbox, **authorized-agent regimes (e.g. CCPA §7063) do not apply**. The app is a drafting and sending tool, legally similar to a mail client.
6. Under the **household/personal-use exemptions** (PDPL Art. 2; GDPR Art. 2(2)(c)), the app's own compliance burden is small. One gap remains: **sending third parties' data (correspondents' names/addresses) to DeepSeek in the PRC** may count as "disclosure to others" and fall outside the PDPL exemption. **Minimize: exclude personal correspondents before any LLM call.**

---

## 1. Saudi Arabia — PDPL + Implementing Regulations (IR)

**Instruments**
- Personal Data Protection Law, Royal Decree M/19 of 9/2/1443H (16 Sep 2021), amended by Royal Decree M/148 of 5/9/1444H (27 Mar 2023). In force 14 Sep 2023. One-year grace period, so **enforced from 14 Sep 2024**.
- Implementing Regulations (IR), published by SDAIA 7 Sep 2023. A third public consultation on IR amendments (direct marketing, complaints, DPO, registration) closed 27 May 2025. **Final amended text was not confirmed published as of research date [VERIFY before launch].**
- Regulation on Personal Data Transfer outside the Kingdom (SDAIA, 2023; amended 2024).
- Official sources: SDAIA National Data Governance Platform (DGP) https://dgp.sdaia.gov.sa ; SDAIA guide for controllers: https://dgp.sdaia.gov.sa/wps/wcm/connect/f579bc32-fda8-47bd-bc6f-66b8cb77985c/ENG-Guide+to+the+saudi+PDP+law+for+controllersprocessors.pdf?MOD=AJPERES

| Topic | Provision | Content (summary) |
|---|---|---|
| Scope, extraterritorial | **PDPL Art. 2(1)** | Applies to any processing of personal data relating to individuals that takes place in the Kingdom by any means, **including processing of data relating to individuals residing in the Kingdom by any party outside the Kingdom**. Covers residents of any nationality. |
| Household exemption | **PDPL Art. 2(2); IR Art. 2** | Does not apply to an individual's processing for purposes not beyond personal or family use, **as long as the data is not published or disclosed to others**. |
| Foreign controllers | IR (representative provision) **[VERIFY article no.]** | A controller outside KSA that processes residents' data must appoint a **representative in KSA licensed by SDAIA**. In practice few foreign companies have done so. That gap is useful leverage in escalation letters, but it does not change the company's duty to respond. |
| Rights | **PDPL Art. 4** | Rights to be informed, access, obtain a copy, correction, and **destruction** of personal data that is no longer needed. Destruction is subject to the **Art. 18** exceptions (legal retention, judicial proceedings). |
| Consent withdrawal | **PDPL Art. 5(2)** [VERIFY sub-para] | The data subject **may withdraw consent at any time**. IR set the controls. Withdrawal is not retroactive. |
| Destruction duty | **PDPL Art. 18** | The controller must destroy data once the purpose of collection ends, unless an exception applies. |
| Advertising / awareness materials | **PDPL Art. 25** | Except awareness material from public entities, a controller **may not use a person's personal communication means (incl. postal and email addresses) to send advertising/awareness materials** unless (1) the recipient has consented and (2) a **clear mechanism to stop** the materials is provided. |
| Direct marketing | **PDPL Art. 26** | Non-sensitive data may be processed for marketing only with the data subject's consent [VERIFY exact amended wording]. |
| Marketing detail | **IR Art. 28** (and 29) | Consent is needed before sending promotional/awareness materials. The opt-out must be **easy and no harder than giving consent**, and the controller must **stop sending immediately** on request. There is a partial exemption where a **prior interaction/relationship** exists, but the opt-out right is unaffected. |
| Response deadline | **IR Art. 4** | Respond **without delay and within 30 days**. One extension of **up to 30 more days** is allowed for disproportionate effort or multiple requests, **with prior notice and reasons** to the data subject. |
| Identity verification | IR Art. 4 (request handling) **[VERIFY]** | The controller may take reasonable steps to verify the requester's identity before acting. There is no express right to demand ID documents. The data-minimization principle (**PDPL Art. 11**) limits what it can ask for. |
| Complaint | **PDPL Art. 34** [VERIFY numbering; some sources number it Art. 33]; **IR Art. 37** | Data subjects may complain to the competent authority (SDAIA). IR Art. 37(1) requires the complaint **within 90 days** of the incident or of becoming aware of it. **The 2025 draft amendments propose deleting this 90-day limit [VERIFY status].** The app should use 90 days as the safe deadline. |
| Penalties | PDPL Art. 35–36 | Art. 35: criminal penalties for disclosing sensitive data. Art. 36: warnings or fines up to SAR 5 million, doubled for repeat violations. |
| Cross-border transfer | PDPL Art. 29 + Transfer Regulation | Relevant only to the app's own processing (see §9). |

**How to complain to SDAIA:** use the DGP complaints service at https://dgp.sdaia.gov.sa (personal data protection, then complaints). It is believed to require **Nafath** (national SSO) login **[VERIFY]**, so the **user files it personally**. The app prepares the text and the evidence bundle (template 6c). Background: https://saudipedia.com/en/national-data-governance-platform

**CST anti-spam rules (secondary).**
- CST (formerly CITC) *Regulations for Curbing Spam Messages & Calls*, Decision 493/1444. Promotional messages need **explicit prior consent, separate from privacy policies/contracts**, plus a working unsubscribe. Opt-outs must be honored **within 24 hours**.
- These rules mainly bind CST licensees and senders using Saudi telecom channels (SMS/calls). The older CITC *Regulation for the Reduction of SPAM* (IT-008) also covered email.
- Use: cite them **only for KSA-based senders**, alongside PDPL. **[LAWYER]** applicability to email from foreign senders is doubtful.
- Sources: https://cst.gov.sa/ar/RulesandSystems/RegulatoryDocuments/ReductionofSPAM/Documents/IT%20008%20E%20-%20Regulation_For_The_Reduction_of_SPAM_Eng.pdf ; https://www.tamimi.com/law-update-articles/congratulations-youre-a-winner-new-anti-spam-regulations-in-saudi-arabia

Secondary sources for PDPL/IR: https://www.clydeco.com/en/insights/2023/09/saudi-arabia-issues-implementing-regulations ; https://www.clydeco.com/en/insights/2025/05/saudi-arabia-new-pdp-law-consultation ; https://securiti.ai/saudi-arabia-personal-data-protection-law/ ; https://houranipartners.com/wp-content/uploads/2025/01/Direct-Marketing-Overview-Saudi-Arabia-Web-PDF.pdf ; https://www.dlapiperdataprotection.com/?c=SA

---

## 2. EU GDPR, UK GDPR, ePrivacy/PECR

Texts: GDPR https://eur-lex.europa.eu/eli/reg/2016/679/oj ; ePrivacy Directive 2002/58/EC https://eur-lex.europa.eu/eli/dir/2002/58/oj ; UK GDPR / DPA 2018 / PECR via https://ico.org.uk and https://www.legislation.gov.uk/uksi/2003/2426

| Topic | Provision | Content |
|---|---|---|
| Erasure | **Art. 17(1)** | Erasure "without undue delay", including where (c) the person objects under Art. 21(2), (b) consent is withdrawn, or (d) processing is unlawful. Art. 17(3) exceptions: legal obligation, legal claims, etc. |
| Withdraw consent | **Art. 7(3)** | At any time, and as easy as giving consent. |
| Object to direct marketing | **Art. 21(2)–(3)** | An **absolute** right. There is no balancing test, and once the person objects, the data "shall no longer be processed" for direct marketing, including related profiling. |
| Deadline | **Art. 12(3)** | Without undue delay, **within one month** of receipt. Extendable **by two further months** for complex or numerous requests, provided the person is told within the first month with reasons. |
| Identity | **Art. 12(6)** | If there are *reasonable doubts*, the controller may request additional information **necessary to confirm identity**. |
| Fees | Art. 12(5) | Free, unless requests are manifestly unfounded or excessive. |
| Scope, establishment | **Art. 3(1)** | Applies to processing in the context of an EU establishment's activities, **regardless of where the processing occurs and regardless of the data subject's location or nationality**. **So a KSA resident is protected against an EU-established company (e.g. a company HQ'd in Ireland, Germany or France).** |
| Scope, targeting | **Art. 3(2)** | Non-EU controllers are covered only for data subjects **"who are in the Union"** when goods/services are offered or behaviour is monitored. **A person in KSA dealing with a non-EU company is not protected** (EDPB Guidelines 3/2018). The only exception is data collected while the user was physically in the EU (e.g. travel). |
| EU representative | Art. 27 | Non-EU controllers under Art. 3(2) must appoint one. Its presence signals GDPR applicability, but under §2's logic it **does not** extend protection to a KSA resident. |
| Complaint | **Art. 77**; one-stop-shop **Art. 56** | Complain to any supervisory authority, normally the **lead SA** where the controller has its main EU establishment (e.g. Irish DPC for many US tech firms: https://www.dataprotection.ie). A non-EU resident can complain. EDPB list of SAs: https://www.edpb.europa.eu/about-edpb/about-edpb/members_en |

**ePrivacy Art. 13** (implemented nationally) requires prior consent for unsolicited marketing email to natural persons. The **soft opt-in** (Art. 13(2)) covers existing customers and similar products, and **every message must offer a free opt-out**. These national rules generally protect **subscribers in that member state**, so they rarely help a KSA resident. Cite them only for EU-established senders. **[LAWYER]**

**UK.**
- UK GDPR has the same article numbering. DPA 2018 s.122 relates to direct marketing.
- **PECR reg. 22** covers email/SMS marketing: consent or soft opt-in, plus an opt-out in every message.
- **Data (Use and Access) Act 2025** amends this area. It raises PECR fines to UK GDPR levels, adds a "stop the clock" for clarification, allows "reasonable and proportionate" searches for access requests, and requires controllers to handle complaints first. It is being commenced in phases **[VERIFY commencement status]**.
- **Complaint:** https://ico.org.uk/make-a-complaint/ . The ICO normally expects the person to complain to the company first and allow about one month.

---

## 3. United States

**CCPA as amended by CPRA** (Cal. Civ. Code §1798.100 et seq.; regs 11 CCR §7000 et seq.; https://cppa.ca.gov/regulations/ , https://oag.ca.gov/privacy/ccpa)
- **Protected persons: "consumers" = California residents only** (§1798.140(i)). **A KSA resident has no CCPA rights.**
- Deletion: §1798.105. Opt-out of sale/sharing: §1798.120. Limit use of sensitive personal information: §1798.121.
- Deadline: **45 calendar days**, extendable once by 45 days with notice (§1798.130(a)(2)). Opt-out of sale/sharing must be honored within **15 business days** and needs **no verification** (11 CCR §7026).
- Verification: 11 CCR §§7060–7062.
- **Authorized agents, 11 CCR §7063.** The business may require proof of the consumer's signed permission and may require the consumer to verify identity directly. It may not require a power of attorney. The agent must use data only to fulfil the request. Source: https://law.cornell.edu/regulations/california/11-CCR-7063
- **Delete Act / DROP:** since **1 Aug 2026**, California residents can send one deletion request to all registered data brokers via the CPPA's DROP platform. Brokers must process it at least every 45 days. Registry: https://cppa.ca.gov/data_broker_registry/ ; https://cppa.ca.gov/announcements/2025/20251113.html . **Only for California residents.**

**Other state comprehensive laws** (about 20 states in force by 2026). All protect **only residents of the state**. Typical terms: 45-day response + 45-day extension; deletion and opt-out of targeted advertising/sale; appeal right.
- **VA** (VCDPA, Va. Code §59.1-575 et seq.): 45 + 45 days; appeal to the AG.
- **CO** (CPA): universal opt-out required; authorized agent allowed for opt-outs.
- **CT** (CTDPA), **TX** (TDPSA), **OR** (OCPA): universal opt-out from 1 Jan 2026.
- Others: UT, IA, TN, MT, DE, NH, NJ, NE, MD, MN, IN, KY, RI (2026).
- **Use in the app:** cite them only if the user is a resident of that state. For a KSA user they are **not applicable**.

**CAN-SPAM Act** (15 U.S.C. §7701–7713; 16 CFR Part 316; FTC guide https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business)
- Applies to **commercial electronic mail messages** sent by or for US-based senders, and to messages sent into the US. **The Act does not limit protection by the recipient's residence or nationality.**
- Requirements: every commercial email must have a working opt-out (§7704(a)(3)–(5)), and **the sender must honor opt-outs within 10 business days**. After an opt-out, the sender may not sell or transfer the address.
- Limits: it is **opt-out only** and does not require erasure. "Transactional or relationship messages" are mostly exempt. There is **no private right of action** for individuals, so enforcement is by the FTC/state AGs/ISPs. Complaints: https://reportfraud.ftc.gov **[LAWYER]**: whether a non-US resident's complaint gets attention is uncertain.
- **Use in the app:** as a universal opt-out demand to any US sender, on top of PDPL.

---

## 4. Other jurisdictions (one-liners)

| Law | Rights relevant here | Deadline | Note |
|---|---|---|---|
| **UAE PDPL** (Federal Decree-Law 45/2021) | Erasure (Art. 15), object to direct marketing (Art. 17), withdraw consent | Not fixed in the law. Executive Regulations reportedly **still not issued** as of 2026 **[VERIFY]** | DIFC (DP Law 5/2020) and ADGM (DPR 2021) are separate GDPR-like regimes with a 1-month deadline. |
| **Brazil LGPD** (Law 13.709/2018) | Art. 18 (deletion, revocation of consent, objection) | Art. 19 II: **15 days** for a full statement of access. Others "without delay" | Complaint to ANPD. Protects data processed in Brazil or of people located in Brazil (Art. 3). |
| **Canada PIPEDA** | Withdraw consent (Principle 4.3.8), access/correction | **30 days** (s.8(3)), +30 extension | OPC complaint. Applies to Canadian organizations' commercial activity. |
| **Canada CASL** | Unsubscribe from commercial electronic messages | **10 business days** (s.11(3)) | Applies to messages sent from or accessed in Canada. |
| **India DPDP Act 2023 + Rules 2025** (notified 13 Nov 2025) | Erasure and withdrawal of consent (ss. 6(4), 12) | Grievance response ≤ **90 days**. Data-principal rights **commence 13 May 2027** | Applies to processing in India, or outside India when offering goods/services to people in India (s.3). |
| **Bahrain PDPL** (Law 30/2018) | Objection to direct marketing, erasure/blocking | Reportedly **10 working days** for rectification/erasure and 15 for information **[VERIFY]** | Complaint to the PDP Authority. |
| **Qatar PDPPL** (Law 13/2016) | Withdraw consent, object, erasure; electronic direct marketing needs prior consent (Art. 22) | "Reasonable period" (guidelines suggest 30 days) **[VERIFY]** | Complaint to NCGAA/Compliance & Data Protection Dept. |

---

## 5. Jurisdiction auto-detection algorithm

**Inputs** (per company)
- `user_residence` = SA (fixed for this user; store as setting). `user_state` = null unless US resident.
- `sender_domain`, sending IPs/ESP, postal address in the email footer (CAN-SPAM requires one for US commercial email), privacy policy URL and the controller entity it names.
- `hq_country`, `eu_establishment` (bool + country), `uk_establishment`, `eu_rep` / `uk_rep` named in the privacy policy, `ksa_presence` (KSA CR, .sa domain, SAR pricing, Arabic site, KSA representative).
- `is_us_sender` (US postal address or US entity), `is_data_broker` (CPPA/VT/TX/OR broker registries), `email_type` (marketing vs transactional, from the classifier).
- Confidence for each detected fact. **Low confidence → include, not exclude** (over-citation costs little; citing a law with an incorrect claim of fact costs some credibility).

**Output:** an ordered `law_citations[]`, `deadline_days`, `regulator`, `language` (`ar`+`en` when PDPL is primary).

**Decision table** (rows are additive; order = citation order)

| # | Condition | Cite | Deadline used for tracking | Escalation |
|---|---|---|---|---|
| 1 | Always, since `user_residence = SA` | PDPL Arts. 2, 4, 5, 18, 25, 26; IR Arts. 4, 28 | 30 days (+30 if notified) | SDAIA via DGP (user files) |
| 2 | Company is KSA-based (CR/.sa/address) | + CST anti-spam rules | 30 days; marketing stop "immediately" / CST 24 h | SDAIA; CST for SMS |
| 3 | `eu_establishment` = true (controller or relevant establishment in EU) | + GDPR Arts. 3(1), 7(3), 12(3), 17, 21(2)-(3); national ePrivacy law | 1 month (+2 if notified) | Lead SA (Art. 56) or any SA (Art. 77) |
| 4 | `uk_establishment` = true | + UK GDPR Arts. 3(1), 12, 17, 21; PECR reg. 22 | 1 month (+2) | ICO |
| 5 | Non-EU/UK company with only an EU/UK rep (Art. 27) | Do **not** claim GDPR rights. Optionally note: "to the extent GDPR applies" | n/a | none |
| 6 | `is_us_sender` and `email_type = marketing` | + CAN-SPAM 15 U.S.C. §7704(a)(4) | 10 business days (opt-out only) | FTC report (low expectation) |
| 7 | US company, user not a US-state resident | Do **not** cite CCPA/state laws as rights. Optionally: "consistent with your published privacy commitments to honor deletion requests globally" | 45 days (policy-based) | none |
| 8 | User is a resident of a US state with a privacy law | + that law; CCPA §§1798.105/.120/.121 for CA | 45 days (+45) | CPPA / state AG |
| 9 | UAE / Bahrain / Qatar / Brazil / Canada / India establishment | + local law per §4 (in addition to PDPL) | Shortest applicable | Local regulator |
| 10 | Unknown HQ / insufficient data | **Universal fallback** letter (below) | 30 days | SDAIA |

**Deadline rule:** track `min(all applicable deadlines)` as the "expected reply" date. Escalate after the **longest lawful deadline including notified extensions**. Track the complaint window: SDAIA **90 days from the deadline breach** (conservative).

**Universal fallback letter:** cite PDPL (always valid for a KSA resident), then "and any other data protection or anti-spam law that applies to you, including where applicable GDPR/UK GDPR Arts. 17 and 21, and CAN-SPAM 15 U.S.C. §7704". Use conditional language ("to the extent applicable") so the letter does not assert false facts.

---

## 6. Letter templates

Placeholders: `{{full_name}}`, `{{email_addresses}}` (all addresses to search), `{{company}}`, `{{company_contact}}`, `{{law_citations}}`, `{{response_days}}`, `{{deadline_date}}`, `{{original_send_date}}`, `{{reference_id}}`, `{{evidence_list}}`, `{{country_of_residence}}`.

### 6a. Combined erasure + objection to marketing (English)

> **Subject:** Request to delete my personal data and stop direct marketing — Ref {{reference_id}}
>
> To: {{company}} — Data Protection / Privacy Team ({{company_contact}})
>
> I, {{full_name}}, residing in {{country_of_residence}}, make this request under {{law_citations}}.
>
> 1. **Objection to and withdrawal of consent for direct marketing.** I withdraw any consent I may have given and object to all processing of my personal data for advertising, direct marketing and related profiling. Stop all marketing communications to me immediately, by every channel.
> 2. **Deletion.** Delete (destroy) all personal data you hold about me, including data received from third parties. You may keep only (a) a minimal suppression record of the email addresses below, solely so that you do not contact me again, and (b) data you are legally required to retain, and in that case tell me which data and on which legal basis.
> 3. **Third parties.** Tell any processors, partners or data recipients to whom you disclosed my data about this request, and tell me who they are.
> 4. **Confirmation.** Confirm in writing when you have done this, within {{response_days}} days of receiving this request (by {{deadline_date}}).
>
> Email addresses this request covers: {{email_addresses}}
>
> This request comes from my own email account. If you have reasonable doubt about my identity, tell me what minimal information you need. Do not ask for copies of identity documents unless strictly necessary. Do not use this request or any information it contains for marketing.
>
> {{full_name}}
> {{date}}

### 6a-AR. طلب إتلاف البيانات الشخصية والاعتراض على التسويق المباشر (Arabic — PDPL)

> **الموضوع:** طلب إتلاف بياناتي الشخصية وإيقاف الرسائل التسويقية — المرجع {{reference_id}}
>
> إلى: {{company}} — إدارة حماية البيانات الشخصية ({{company_contact}})
>
> أنا {{full_name}}، المقيم في المملكة العربية السعودية، أتقدم بهذا الطلب استناداً إلى نظام حماية البيانات الشخصية الصادر بالمرسوم الملكي رقم (م/19) وتاريخ 9/2/1443هـ وتعديلاته، ولائحته التنفيذية، ولا سيما المادة (الثانية) بشأن سريان النظام على الجهات خارج المملكة، والمادة (الرابعة) بشأن حق طلب إتلاف البيانات، والمادة (الخامسة) بشأن الرجوع عن الموافقة، والمادتين (الخامسة والعشرين) و(السادسة والعشرين) بشأن المواد الإعلانية والتسويق المباشر، والمادتين (4) و(28) من اللائحة التنفيذية{{law_citations_extra}}.
>
> 1. **الرجوع عن الموافقة والاعتراض على التسويق:** أرجع عن أي موافقة سابقة، وأطلب التوقف فوراً عن استخدام بياناتي ووسائل الاتصال الخاصة بي لإرسال أي مواد إعلانية أو تسويقية أو توعوية، عبر جميع القنوات.
> 2. **الإتلاف:** أطلب إتلاف جميع بياناتي الشخصية لديكم، بما فيها البيانات التي حصلتم عليها من أطراف أخرى. ويُستثنى من ذلك (أ) قائمة حظر تقتصر على عناوين البريد أدناه لضمان عدم مراسلتي مستقبلاً، و(ب) ما يلزمكم نظاماً الاحتفاظ به، مع إبلاغي بنوع البيانات المحتفظ بها وسندها النظامي.
> 3. **الأطراف الأخرى:** أطلب إبلاغ أي جهة أفصحتم لها عن بياناتي بهذا الطلب، وتزويدي بأسماء تلك الجهات.
> 4. **التأكيد:** أرجو تأكيد التنفيذ كتابياً خلال مدة لا تتجاوز ثلاثين (30) يوماً من تاريخ استلام هذا الطلب، أي في موعد أقصاه {{deadline_date}}، وفقاً للمادة (4) من اللائحة التنفيذية.
>
> عناوين البريد الإلكتروني المشمولة: {{email_addresses}}
>
> أُرسل هذا الطلب من بريدي الإلكتروني الشخصي. وإذا كان لديكم شك معقول في هويتي، فأرجو تحديد الحد الأدنى من المعلومات اللازمة للتحقق، دون طلب صور من وثائق الهوية إلا عند الضرورة القصوى. ولا يجوز استخدام هذا الطلب أو أي من بياناته لأغراض تسويقية.
>
> {{full_name}}
> {{date_hijri}} الموافق {{date}}

### 6b. Reminder after deadline (English)

> **Subject:** OVERDUE — request to delete personal data / stop marketing — Ref {{reference_id}}
>
> On {{original_send_date}} I asked {{company}} under {{law_citations}} to delete my personal data and stop all direct marketing (copy below). The legal deadline of {{deadline_date}} has passed and I have received {{no response / an incomplete response / further marketing on {{dates}}}}.
>
> Please do all of the following within 7 days:
> 1. Confirm deletion and that marketing has stopped.
> 2. If you claim an extension, show that you notified me within the original deadline and give your reasons.
>
> If you do not, I will complain to {{regulator}} without further notice. I keep a record of this request and of any further messages you send me.
>
> {{full_name}}

**Arabic reminder (PDPL).**

> **الموضوع:** تذكير — انقضاء المهلة النظامية لطلب إتلاف البيانات وإيقاف التسويق — المرجع {{reference_id}}
>
> بتاريخ {{original_send_date}} تقدمت إليكم بطلب إتلاف بياناتي الشخصية وإيقاف الرسائل التسويقية وفقاً لنظام حماية البيانات الشخصية ولائحته التنفيذية، وقد انقضت المهلة النظامية في {{deadline_date}} دون تنفيذ الطلب.
>
> أرجو تأكيد التنفيذ خلال سبعة (7) أيام. وفي حال ادعاء التمديد، أرجو إثبات إشعاري بذلك وبمسوّغاته قبل انقضاء المهلة الأصلية.
>
> وإلا فسأتقدم بشكوى إلى الهيئة السعودية للبيانات والذكاء الاصطناعي (سدايا) دون إشعار آخر.
>
> {{full_name}}

### 6c. Regulator complaint draft (English; Arabic for SDAIA)

> **Complaint against:** {{company}} ({{company_address_if_known}}, website {{company_domain}})
> **Complainant:** {{full_name}}, {{country_of_residence}}, contact {{user_email}}
> **Laws:** {{law_citations}}
>
> **Facts**
> 1. {{company}} has sent advertising emails to {{email_addresses}} since {{first_seen_date}} (examples attached), without my consent.
> 2. On {{original_send_date}} I asked for deletion and an end to marketing (copy attached).
> 3. The deadline of {{deadline_date}} has passed. A reminder was sent on {{reminder_date}}. Response: {{none / summary}}. Marketing emails received after my request: {{count}} (dates: {{dates}}).
>
> **Infringements alleged:** failure to act on a data subject request within the statutory period ({{IR Art. 4 / GDPR Art. 12(3)}}); continued marketing after objection/withdrawal ({{PDPL Art. 25–26, IR Art. 28 / GDPR Art. 21(3)}}); failure to delete ({{PDPL Art. 4, 18 / GDPR Art. 17}}).
>
> **Remedy sought:** order deletion and an end to marketing; take appropriate enforcement action.
>
> **Evidence:** {{evidence_list}} (original request with sent timestamp and Message-ID; reminder; company replies; post-request marketing emails with full headers).

**Arabic version for SDAIA.**

> **شكوى ضد:** {{company}}
> **مقدم الشكوى:** {{full_name}}
>
> **الوقائع:** تلقيت رسائل إعلانية من الجهة المذكورة على بريدي {{email_addresses}} دون موافقتي. وبتاريخ {{original_send_date}} طلبت إتلاف بياناتي وإيقاف التسويق، وانقضت المهلة النظامية في {{deadline_date}}، وأُرسل تذكير في {{reminder_date}} دون استجابة، واستمر إرسال الرسائل الإعلانية بعد الطلب ({{count}} رسالة).
>
> **المخالفات:** عدم الاستجابة خلال المهلة (المادة 4 من اللائحة التنفيذية)؛ ومواصلة إرسال المواد الإعلانية بعد الرجوع عن الموافقة (المادتان 25 و26 من النظام، والمادة 28 من اللائحة)؛ وعدم الإتلاف (المادتان 4 و18 من النظام).
>
> **الطلب:** إلزام الجهة بإتلاف البيانات وإيقاف التسويق، واتخاذ ما يلزم نظاماً.
>
> **المرفقات:** {{evidence_list}}

**[LAWYER]** A Saudi lawyer should review the Arabic legal phrasing and the article references (e.g. the Art. 33/34 numbering and the amended wording of Art. 26).

---

## 7. Identity verification

- **What companies may ask:** only what is *necessary* to confirm that the requester is the data subject (GDPR Art. 12(6); PDPL Art. 11 minimization; CCPA §7060–7062 graduated verification).
- **Low-risk requests:** a deletion or marketing objection tied to an email address is usually verified enough by **replying from that address** or **clicking a confirmation link**.
- **Opt-outs:** opt-out of marketing or of sale/sharing generally **needs no verification** (CCPA 11 CCR §7026(d)). Under GDPR Art. 21(3) a company cannot reasonably refuse an objection from the very address being marketed to.

**What the app should advise:**
1. Send from the mailbox that receives the marketing. Include all relevant addresses and nothing more.
2. If asked for ID, tell the user that this is **usually disproportionate** for an email-only relationship. Draft a reply offering confirmation from the mailbox or via a link.
3. Provide a **passport/Iqama copy only if the company plausibly holds identity-linked data** (bank, telecom, government-adjacent) and there is no lighter option. In that case, recommend **redacting** the ID number except the last 4 digits, the photo where possible, and the MRZ, plus a watermark: "For data request {{reference_id}} to {{company}} only".
4. Never send national ID number, Absher/Nafath credentials, passwords, or payment card data.
5. Use the company's own web form when it insists on one. Record that the email request was sent first, because that sets the start of the deadline under GDPR (the "receipt" date). **[LAWYER]** confirm the same for PDPL.

---

## 8. Acting on behalf: sending model, consent records, platform rules

**Sending model (decided): the user sends from their own mailbox, in their own name, after approving each draft.**
- **Legally, the user is exercising their own rights.** The app is a tool, like a mail client or template, and **not an "authorized agent" or representative**.
- So **CCPA §7063, the Colorado agent rules, and GDPR/PDPL representation questions do not arise**. Companies cannot demand an agent mandate.
- Do **not** phrase letters as "on behalf of" or from "StopDisturbance". That would bring in agent rules and give companies a pretext to delay.
- **GDPR Art. 80** (not-for-profit representation) is irrelevant here.

**Records the app should keep (as evidence, not as a compliance duty):**
- the per-draft approval (timestamp, draft hash, user action);
- the sent message with Message-ID, timestamp and recipients;
- delivery/bounce status;
- company replies;
- marketing emails received after the request (with headers);
- the computed deadlines and the laws cited.

These records support the reminder and complaint steps. Keep them while the case is open, plus about 1 year (or until the user deletes them).

**Accuracy safeguards** (to avoid sending false statements in the user's name):
- The user must confirm their residence and the email addresses.
- The app must never assert a fact (e.g. "you are established in the EU") at low confidence without "to the extent applicable" wording.
- Use no automatic sending without a per-message approval (also required by the user's design).

**Liability:** for personal use, the user is responsible for what is sent in their name. Risks to manage are defamation/harassment (repeated or abusive mail) and misidentifying a company. **Rate-limit reminders: at most 1 reminder before a complaint.** **[LAWYER]** only if the app is ever offered to others; then terms of service, liability caps and agent registration (California requires business-entity agents to be registered with the Secretary of State, 11 CCR §7001) become relevant.

**Google / Microsoft constraints**
- **Gmail API.** `gmail.readonly` and `gmail.metadata` are **restricted** scopes. `gmail.send` is **sensitive**.
  - Public apps need OAuth verification plus an annual **CASA security assessment** for restricted scopes, and must follow the **Google API Services User Data Policy / Limited Use** rules: use data only for user-facing features, no ads use, no human reading without consent, no transfer except as needed for the feature, and **no use to train generalised AI models**.
  - **For personal use:** keep the OAuth app in **"Testing"** with the user as the only test user. Verification is not required, but **refresh tokens expire after 7 days**, so the user must re-consent weekly. Alternatively use an "Internal" app if the user has a Workspace domain. Sources: https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification ; https://developers.google.com/workspace/workspace-api-user-data-developer-policy ; https://support.google.com/cloud/answer/15549945
  - Limited Use and DeepSeek: sending Gmail-derived data to a third-party LLM fits the Limited Use "transfer to provide user-facing features" category only if that LLM does not use the data for training. **DeepSeek trains on inputs by default.** For a self-use test app Google will not audit this, but **opt out of DeepSeek training** in any case (see §9).
- **Microsoft Graph.** Use delegated `Mail.Read` / `Mail.Send` on a single-tenant or personal app registration. Publisher verification is needed only for multi-tenant distribution. Respect Outlook.com sending limits and anti-spam rules (Microsoft Services Agreement prohibits spam). Volumes here are small. **[VERIFY]** current daily recipient limits.
- **Sending volume:** 1 request + 1 reminder per company is well below bulk-sender thresholds (Gmail bulk sender rules start at 5,000/day). Send plain, personalized messages; avoid identical blasts with BCC.

---

## 9. The app's own compliance (personal-use scope)

**Household / personal-use exemptions**
- **PDPL Art. 2(2) / IR Art. 2:** the law does not apply to an individual's processing for personal or family use, **"as long as it is not published or disclosed to others"**. The user processing their own mailbox metadata to exercise their own rights is within the exemption.
- **GDPR Art. 2(2)(c), Recital 18:** "purely personal or household activity" is excluded. It applies only if GDPR would otherwise touch the user, which it does not for a KSA user.
- **Consequence:** no privacy notice, registration, DPO, records of processing or DPIA obligations **for the user**. The hosting provider and DeepSeek are the user's own vendors, so no controller-processor DPA is legally required. Their terms still govern.

**Where the exemption is fragile: third-party data and DeepSeek (PRC)**
- **Data involved:**
  - *the user's own data*: addresses, names and message metadata;
  - *companies' data*: sender domains and business addresses, mostly not personal data;
  - *third parties' data*: personal correspondents' names and addresses in From/To/CC headers, and names of company employees in signatures.
- **The user's own data to DeepSeek.** A private individual sending their own data to a service of their choice is self-determination. PDPL Art. 29 and the Transfer Regulation impose duties on *controllers*, and the exempt individual is not acting as one. **Low legal risk; practical risk:** DeepSeek's privacy policy says data is **stored in the PRC**, is **used to train models by default** (an opt-out exists), and is subject to PRC law; there is no published zero-retention API option. Sources: DeepSeek Privacy Policy (https://platform.deepseek.com, privacy page) and secondary analysis https://venturebeat.com/ai/is-deepseek-really-sending-data-to-china-lets-decode/
- **Third parties' data to DeepSeek.** Sending correspondents' personal data to a foreign third party could count as "**disclosure to others**". That may take the processing **outside the PDPL Art. 2 household exemption**, which would make the user a controller subject to the transfer rules (Art. 29 and the Transfer Regulation's conditions/safeguards; the PRC is not known to have an SDAIA adequacy decision). **[LAWYER]** The risk is low in practice, but it is easy to avoid.

**Minimization requirements (do these, and the issue largely disappears)**
1. **Pre-filter locally, before any LLM call.** Exclude messages from personal correspondents: addresses in the user's contacts, free-mail domains (gmail.com, outlook.com, hotmail.com, yahoo.com, icloud.com, etc.), and threads where the user has replied. Send only messages that look like bulk/commercial mail (`List-Unsubscribe` header, ESP signatures, `Precedence: bulk`, known marketing domains).
2. **Send only what the LLM needs:** sender domain, display name, subject, `List-Unsubscribe`, and a truncated or redacted footer (for the postal address). **No full bodies. No To/CC lists** (replace them with a placeholder such as `USER`).
3. **Redact** the user's own name, phone and address in text sent to the LLM where they are not needed. Letters are filled from local templates, so the LLM never needs the user's identity.
4. **Turn off DeepSeek training/"improve the model"** in account settings, if available for the API. Record the date it was switched off. **[VERIFY]** API-level opt-out mechanics.
5. **Prefer deterministic code over the LLM** where possible (header parsing, domain-to-company lookup). Optional: support a local model, or a provider with no-training/zero-retention terms, as a drop-in alternative.

**Hosting and security (good practice, not legal obligation)**
- Encrypt OAuth tokens at rest. Use minimal scopes (prefer `gmail.metadata` + `gmail.send` over `gmail.readonly` if the footer can be skipped).
- Store no raw message bodies, only derived company records and evidence of the user's own requests.
- Make the instance single-user and authenticated. Provide one-click "delete everything and revoke tokens".
- A KSA-region or EU host is fine. Being the user's own data, there is no transfer issue beyond the third-party point above.

**If the app is ever offered to other users**, the full regime applies and this section must be rewritten:
- PDPL controller duties: privacy policy (Art. 12), DGP registration, DPO, transfer safeguards for DeepSeek/hosting, breach notice within 72 h;
- GDPR Art. 3(2) for EU users, with Art. 27 representative, DPIA and Art. 28 DPAs;
- Google CASA verification.
- **[LAWYER]**

---

## 10. Legal requirements checklist for the product

**MUST**
- [ ] M1. Treat PDPL as the always-applicable base law for the user (KSA resident). Cite PDPL Arts. 2, 4, 5, 18, 25, 26 and IR Arts. 4, 28.
- [ ] M2. Apply GDPR/UK GDPR **only** where the company has an EU/UK establishment (Art. 3(1)). Never claim Art. 3(2) protection for a KSA user.
- [ ] M3. Never cite CCPA or other US state laws as giving the user rights unless the user is a resident of that state. CAN-SPAM opt-out may be cited for US commercial senders.
- [ ] M4. Per-draft explicit user approval before any send. No auto-send. Log the approval (timestamp + draft hash).
- [ ] M5. Send from the user's own mailbox, in the user's own name. Never "on behalf of" or "via StopDisturbance".
- [ ] M6. Use conditional wording ("to the extent applicable") for any jurisdictional fact detected with low confidence.
- [ ] M7. Track deadlines: PDPL 30 (+30 only with notice), GDPR 1 month (+2 with notice), CAN-SPAM 10 business days, CCPA 45 (+45). Track the SDAIA complaint window of 90 days (conservative).
- [ ] M8. Keep an evidence bundle per company: request, Message-ID, timestamps, replies, post-request marketing emails with headers.
- [ ] M9. ID handling: never auto-send ID documents. Warn when a company asks, and give redaction guidance.
- [ ] M10. LLM minimization: local pre-filter to exclude personal correspondents; send only commercial-mail metadata; no To/CC; no full bodies; templates filled locally.
- [ ] M11. Opt out of DeepSeek model training before first use, and record that it was done.
- [ ] M12. Minimal OAuth scopes. Encrypted tokens. One-click delete-all + revoke.
- [ ] M13. Arabic + English output for PDPL letters. Arabic legal wording reviewed by Saudi counsel **[LAWYER]**.

**SHOULD**
- [ ] S1. Company enrichment: parse the privacy policy for the controller entity, EU/UK establishment and representative, and DPO/privacy email. Check the data-broker registries (CPPA, Vermont, Texas, Oregon).
- [ ] S2. Prefer the company's privacy email or web form over replying to a `noreply` address. Also trigger `List-Unsubscribe` (RFC 8058 one-click), since it is quick and creates evidence.
- [ ] S3. At most 1 reminder, then a complaint draft. Never more than 3 messages per company per case.
- [ ] S4. Detect post-request marketing automatically and attach it to the evidence bundle.
- [ ] S5. Re-check PDPL IR amendment status (90-day complaint limit; Art. 28 changes) and UAE Executive Regulations before release **[VERIFY]**.
- [ ] S6. Pluggable LLM provider (local model / no-training provider) as an alternative to DeepSeek.
- [ ] S7. Show the user a one-line "why these laws" explanation per company, based on the decision table.

**Open legal questions for counsel [LAWYER]**
1. The exact current numbering/wording of PDPL Arts. 26 and 33/34 and IR Arts. 4, 28, 37 after the 2023 amendments and any 2025/2026 IR amendments.
2. Whether a request sent by email counts as "received" for the PDPL 30-day clock when the company designates a web form.
3. Whether sending correspondents' header data to an LLM provider breaks the PDPL Art. 2 personal-use exemption.
4. Whether CST anti-spam rules can be enforced against foreign email senders.
