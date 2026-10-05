import type { RawHeader } from "@/lib/mail/headers";

// Realistic header samples for stage 2 (resolve) and stage 3 (rules). Shapes follow what real
// ESPs emit in the allow-listed headers; addresses/tokens are made up.
// expected: brand registrable domain, "personal", or null (unresolvable: every candidate is an ESP/free-mail).

export const OWNER = { fullName: "Sara Alharbi", loginEmails: ["sara.alharbi@gmail.com"], employerDomains: ["acme-energy.com.sa"] };
export const SENT_TO = ["khalid.otaibi@gmail.com", "dr.lina@familyclinic-riyadh.com", "newsletter@thinkmedia.co"];

export type Expected = string | "personal" | null;
export type ResolveFixture = {
  name: string;
  headers: RawHeader[];
  labels: string[];
  expected: Expected;
  /** Rules expectation for the sender (stage 3), where the fixture pins one. */
  rules?: { labels: string[]; settled?: boolean };
};

type Opts = {
  from: string;
  subject: string;
  dkim?: string[]; // passing signatures, first one covers List-Unsubscribe(-Post)
  dkimFail?: string[];
  returnPath?: string;
  replyTo?: string;
  lu?: string; // List-Unsubscribe value
  oneClick?: boolean;
  listId?: string;
  feedbackId?: string;
  precedence?: string;
  autoSubmitted?: string;
  labels?: string[];
};

function mk(name: string, o: Opts, expected: Expected, rules?: ResolveFixture["rules"]): ResolveFixture {
  const h: RawHeader[] = [
    { name: "From", value: o.from },
    { name: "To", value: "Sara <sara.alharbi@gmail.com>" },
    { name: "Subject", value: o.subject },
    { name: "Message-ID", value: `<${name.replace(/\W+/g, ".")}@mta.example>` },
  ];
  const pass = o.dkim ?? [];
  pass.forEach((d, i) =>
    h.push({
      name: "DKIM-Signature",
      value: `v=1; a=rsa-sha256; c=relaxed/relaxed; d=${d}; s=s${i}; h=from:to:subject:date${i === 0 ? ":list-unsubscribe:list-unsubscribe-post" : ""}; bh=x; b=y`,
    }),
  );
  (o.dkimFail ?? []).forEach((d) => h.push({ name: "DKIM-Signature", value: `v=1; d=${d}; s=k; h=from:subject; b=z` }));
  const ar = [...pass.map((d) => `dkim=pass header.i=@${d} header.s=s`), ...(o.dkimFail ?? []).map((d) => `dkim=fail header.i=@${d}`)];
  if (ar.length) h.push({ name: "Authentication-Results", value: `mx.google.com; ${ar.join("; ")}; spf=pass` });
  if (o.returnPath) h.push({ name: "Return-Path", value: `<${o.returnPath}>` });
  if (o.replyTo) h.push({ name: "Reply-To", value: o.replyTo });
  if (o.lu) h.push({ name: "List-Unsubscribe", value: o.lu });
  if (o.oneClick) h.push({ name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" });
  if (o.listId) h.push({ name: "List-Id", value: o.listId });
  if (o.feedbackId) h.push({ name: "Feedback-ID", value: o.feedbackId });
  if (o.precedence) h.push({ name: "Precedence", value: o.precedence });
  if (o.autoSubmitted) h.push({ name: "Auto-Submitted", value: o.autoSubmitted });
  return { name, headers: h, labels: o.labels ?? ["INBOX"], expected, rules };
}

const ADS = { labels: ["ads"] };
const DATA = { labels: ["holds_data"] };
const PROMO = ["INBOX", "CATEGORY_PROMOTIONS"];
const UPDATES = ["INBOX", "CATEGORY_UPDATES"];

export const RESOLVE_FIXTURES: ResolveFixture[] = [
  // --- Brand-aligned DKIM, subdomains collapse via the PSL ---
  mk("noon promo via Braze/SES", {
    from: '"noon" <deals@em.noon.com>', subject: "White Friday: up to 70% off", dkim: ["em.noon.com", "amazonses.com"],
    returnPath: "0100018a@bounce.em.noon.com", lu: "<https://em.noon.com/u?t=abc>, <mailto:unsub@em.noon.com>", oneClick: true,
    feedbackId: "1.us-east-1.Zx9=:AmazonSES", precedence: "bulk", labels: PROMO,
  }, "noon.com", ADS),
  mk("noon order shipped", {
    from: "noon <no-reply@noon.com>", subject: "Your order NAEH40012345 has shipped", dkim: ["noon.com"], returnPath: "bounce@noon.com", labels: UPDATES,
  }, "noon.com", DATA),
  mk("Jarir .com.sa marketing", {
    from: "مكتبة جرير <news@mail.jarir.com.sa>", subject: "عروض العودة للمدارس — خصم حتى ٣٠٪", dkim: ["mail.jarir.com.sa"],
    lu: "<https://mail.jarir.com.sa/unsub?x=1>", oneClick: true, listId: "<offers.jarir.com.sa>", labels: PROMO,
  }, "jarir.com.sa", ADS),
  mk("STC bill .com.sa", {
    from: "stc <noreply@stc.com.sa>", subject: "فاتورتك لشهر سبتمبر جاهزة", dkim: ["stc.com.sa"], autoSubmitted: "auto-generated", labels: UPDATES,
  }, "stc.com.sa", DATA),
  mk("Tesco co.uk subdomain", {
    from: "Tesco <offers@email.tesco.co.uk>", subject: "Clubcard Prices this week", dkim: ["email.tesco.co.uk"],
    returnPath: "bounce-123@e.tesco.co.uk", lu: "<https://email.tesco.co.uk/u/abc>", oneClick: true, labels: PROMO,
  }, "tesco.co.uk", ADS),
  mk("BBC co.uk newsletter", {
    from: "BBC Newsletters <newsletters@bbc.co.uk>", subject: "Your weekly digest", dkim: ["bbc.co.uk"],
    lu: "<mailto:unsubscribe@bbc.co.uk>", listId: "BBC Weekly <weekly.bbc.co.uk>", precedence: "list",
  }, "bbc.co.uk", ADS),
  mk("Amazon order via amazon.com", {
    from: '"Amazon.com" <shipment-tracking@amazon.com>', subject: "Your Amazon.com order of \"USB-C cable\" has shipped!",
    dkim: ["amazon.com", "amazonses.com"], returnPath: "20260901@bounces.amazon.com", feedbackId: "1.us-east-1.abc=:AmazonSES", labels: UPDATES,
  }, "amazon.com", DATA),
  mk("Amazon.sa marketing", {
    from: "Amazon.sa <store-news@amazon.sa>", subject: "Deals picked for you", dkim: ["amazon.sa"],
    lu: "<https://www.amazon.sa/gp/unsub?x=1>", oneClick: true, labels: PROMO,
  }, "amazon.sa", ADS),
  mk("Careem receipt", {
    from: "Careem <no-reply@careem.com>", subject: "Your ride receipt", dkim: ["careem.com"], labels: UPDATES,
  }, "careem.com", DATA),
  mk("Uber trip receipt with SendGrid", {
    from: "Uber Receipts <noreply@uber.com>", subject: "Your Thursday evening trip with Uber", dkim: ["uber.com", "sendgrid.info"],
    returnPath: "bounces+123@em.uber.com", labels: UPDATES,
  }, "uber.com", DATA),
  mk("Booking.com confirmation", {
    from: "Booking.com <noreply@booking.com>", subject: "Booking confirmation – Hilton Jeddah", dkim: ["booking.com"],
    autoSubmitted: "auto-generated", labels: UPDATES,
  }, "booking.com", DATA),
  mk("Saudia via SFMC", {
    from: "SAUDIA <saudia@e.saudia.com>", subject: "Fly to Europe this summer — special fares", dkim: ["e.saudia.com"],
    returnPath: "bounce-12_HTML-3@bounce.s7.exct.net", lu: "<https://click.e.saudia.com/u?qs=1>", oneClick: true, labels: PROMO,
  }, "saudia.com", ADS),
  mk("Nike via Salesforce", {
    from: "Nike <nike@official.nike.com>", subject: "New arrivals just dropped", dkim: ["official.nike.com"],
    returnPath: "bounce-1@bounce.official.nike.com", lu: "<https://click.official.nike.com/u?x>", oneClick: true, labels: PROMO,
  }, "nike.com", ADS),
  mk("Spotify via SparkPost", {
    from: "Spotify <no-reply@spotify.com>", subject: "Your 2026 Wrapped is here", dkim: ["spotify.com", "sparkpostmail.com"],
    returnPath: "msprvs1=x@sparkpostmail.com", lu: "<https://www.spotify.com/account/unsub?x>", oneClick: true, labels: PROMO,
  }, "spotify.com", ADS),
  mk("Netflix account notice", {
    from: "Netflix <info@account.netflix.com>", subject: "A new device is using your account", dkim: ["account.netflix.com"],
    labels: UPDATES,
  }, "netflix.com", DATA),
  mk("Shein via Braze em subdomain", {
    from: "SHEIN <shein@shein-news.shein.com>", subject: "🔥 Flash sale: extra 20% off", dkim: ["shein-news.shein.com"],
    lu: "<https://link.shein.com/unsub?b=1>", oneClick: true, feedbackId: "camp1:shein:braze", labels: PROMO,
  }, "shein.com", ADS),
  mk("Talabat AR promo", {
    from: "طلبات <offers@news.talabat.com>", subject: "وجبتك المفضلة بخصم ٥٠٪ اليوم", dkim: ["news.talabat.com"],
    lu: "<https://news.talabat.com/u?x>", oneClick: true, labels: PROMO,
  }, "talabat.com", ADS),
  mk("HungerStation receipt AR", {
    from: "هنقرستيشن <noreply@hungerstation.com>", subject: "إيصال طلبك رقم 99812", dkim: ["hungerstation.com"], labels: UPDATES,
  }, "hungerstation.com", DATA),
  mk("Al Rajhi notification", {
    from: "Al Rajhi Bank <noreply@alrajhibank.com.sa>", subject: "Your e-statement is ready", dkim: ["alrajhibank.com.sa"],
    autoSubmitted: "auto-generated",
  }, "alrajhibank.com.sa", DATA),
  mk("Absher .gov.sa", {
    from: "Absher <noreply@absher.sa>", subject: "رمز التحقق الخاص بك", dkim: ["absher.sa"], autoSubmitted: "auto-generated",
  }, "absher.sa", DATA),
  mk("Medium digest", {
    from: "Medium Daily Digest <noreply@medium.com>", subject: "Stories for you", dkim: ["medium.com", "sendgrid.info"],
    returnPath: "bounces+1@sendgrid.net", lu: "<https://medium.com/me/settings/unsub?x>", oneClick: true, listId: "<digest.medium.com>",
  }, "medium.com", ADS),
  mk("LinkedIn notifications", {
    from: "LinkedIn <messages-noreply@linkedin.com>", subject: "You appeared in 12 searches this week", dkim: ["linkedin.com"],
    lu: "<https://www.linkedin.com/e/unsub?x>", oneClick: true, labels: ["INBOX", "CATEGORY_SOCIAL"],
  }, "linkedin.com", ADS),
  mk("GitHub security alert", {
    from: "GitHub <noreply@github.com>", subject: "[GitHub] A new SSH key was added to your account", dkim: ["github.com"],
    labels: UPDATES,
  }, "github.com", DATA),
  mk("IKEA via Mailgun subdomain", {
    from: "IKEA Saudi Arabia <news@ikea.sa>", subject: "New season, new home ideas", dkim: ["ikea.sa", "mailgun.org"],
    returnPath: "bounce+abc@mg.ikea.sa", lu: "<mailto:u@mg.ikea.sa>", feedbackId: "x:mailgun", labels: PROMO,
  }, "ikea.sa", ADS),
  mk("Namshi via Klaviyo", {
    from: "Namshi <hello@namshi.com>", subject: "Your cart misses you — 15% off", dkim: ["namshi.com", "klaviyomail.com"],
    returnPath: "bounce@send.klaviyomail.com", lu: "<https://manage.kmail-lists.com/subscriptions/unsubscribe?a=1>", oneClick: true,
    labels: PROMO,
  }, "namshi.com", ADS),
  mk("Airbnb with Reply-To brand", {
    from: "Airbnb <automated@airbnb.com>", subject: "Reservation confirmed for Oct 12", dkim: ["airbnb.com"],
    replyTo: "Airbnb <no-reply@airbnb.com>", labels: UPDATES,
  }, "airbnb.com", DATA),

  // --- From on an ESP/shared domain: fall back to brand d=, then List-Unsubscribe host, Reply-To, List-Id ---
  mk("Mailchimp shared From, brand DKIM", {
    from: "Riyadh Roasters <riyadhroasters@mail.mcsv.net>", subject: "New beans this week", dkim: ["riyadhroasters.com", "mcsv.net"],
    returnPath: "bounce-mc.us5_123@mail123.atl91.mcsv.net", lu: "<https://riyadhroasters.us5.list-manage.com/unsubscribe?u=1>",
    listId: "<abc123.mcsv.net>", feedbackId: "1:us5:mc", precedence: "bulk",
  }, "riyadhroasters.com", ADS),
  mk("Mailchimp only, brand via LU host? none — via Reply-To", {
    from: "Desert Yoga Studio <desertyoga@mcsv.net>", subject: "October class schedule", dkim: ["mcsv.net"],
    returnPath: "bounce-mc.us12_9@mail9.mcdlv.net", lu: "<https://desertyoga.us12.list-manage.com/unsubscribe?u=2>",
    replyTo: "Desert Yoga <hello@desertyoga.sa>", listId: "<xyz.mcsv.net>", feedbackId: "2:us12:mc",
  }, "desertyoga.sa", ADS),
  mk("SendGrid From + brand LU host", {
    from: "Bloom Flowers <info@sendgrid.net>", subject: "Spring bouquets are back", dkim: ["sendgrid.info"],
    returnPath: "bounces+9@sendgrid.net", lu: "<https://email.bloomflowers.ae/unsub?u=9>", oneClick: true,
  }, "bloomflowers.ae", ADS),
  mk("HubSpot shared From, brand DKIM", {
    from: "Acme Analytics <marketing@hubspotemail.net>", subject: "Webinar: dashboards that work", dkim: ["acmeanalytics.io", "hubspotemail.net"],
    returnPath: "1axbtd@bf03x.hubspotemail.net", lu: "<https://hs.hubspotlinks.com/unsub?x>", oneClick: true,
  }, "acmeanalytics.io", ADS),
  mk("Constant Contact From, Reply-To brand", {
    from: "Gulf Book Club <gulfbookclub@ccsend.com>", subject: "This month's pick", dkim: ["ccsend.com"],
    returnPath: "bounce@in.constantcontact.com", replyTo: "books@gulfbookclub.org", lu: "<https://visitor.constantcontact.com/do?p=un>",
  }, "gulfbookclub.org", ADS),
  mk("Campaign Monitor From, brand LU mailto", {
    from: "Design Week <designweek@cmail20.com>", subject: "Tickets on sale", dkim: ["cmail20.com"],
    returnPath: "bounce@cmail20.com", lu: "<mailto:unsubscribe@designweekdubai.com>",
  }, "designweekdubai.com", ADS),
  mk("Brevo From, brand List-Id", {
    from: "Tech Meetup <meetup@brevosend.com>", subject: "Next meetup: AI in Arabic NLP", dkim: ["brevosend.com"],
    returnPath: "bounces@sendibt3.com", listId: "Tech Meetup <list.techmeetupjed.org>", lu: "<https://r.sendibt3.com/unsub?x>",
  }, "techmeetupjed.org", ADS),
  mk("Mailgun From, brand DKIM (failing ESP sig too)", {
    from: "Fitness Time <noreply@mailgun.org>", subject: "Membership renewal reminder", dkim: ["fitnesstime.com.sa"],
    dkimFail: ["mailgun.org"], returnPath: "bounce@mailgun.org",
  }, "fitnesstime.com.sa", DATA),
  mk("Postmark transactional on brand", {
    from: "Basecamp <notifications@basecamp.com>", subject: "Password reset requested", dkim: ["basecamp.com", "pm.mtasv.net"],
    returnPath: "pm_bounces@pm-bounces.basecamp.com",
  }, "basecamp.com", DATA),
  mk("Zendesk helpdesk subdomain", {
    from: "Lulu Support <support@luluhypermarket.zendesk.com>", subject: "Re: [Request #48211] refund", dkim: ["zendesk.com"],
    replyTo: "support@luluhypermarket.com", returnPath: "bounce@zendesk.com",
  }, "luluhypermarket.com", DATA),
  mk("Klaviyo-only shop, no brand anywhere but display name of known brand", {
    from: "Namshi <namshi@klaviyomail.com>", subject: "Last chance: 15% off", dkim: ["klaviyomail.com"],
    returnPath: "bounce@send.klaviyomail.com", lu: "<https://manage.kmail-lists.com/u?a=2>", oneClick: true,
  }, "namshi.com", ADS),

  // --- Aliases: several addresses / subdomains of one brand ---
  mk("noon alias 2", {
    from: "noon Daily <daily@mail.noon.com>", subject: "Today's deals", dkim: ["mail.noon.com"],
    lu: "<https://mail.noon.com/u?t=x>", oneClick: true, labels: PROMO,
  }, "noon.com", ADS),
  mk("Amazon alias account", {
    from: '"Amazon.com" <account-update@amazon.com>', subject: "Your Amazon password has been changed", dkim: ["amazon.com"],
  }, "amazon.com", DATA),
  mk("STC alias marketing AR", {
    from: "stc <offers@email.stc.com.sa>", subject: "باقات جديدة لفترة محدودة", dkim: ["email.stc.com.sa"],
    lu: "<https://email.stc.com.sa/u?x>", oneClick: true, labels: PROMO,
  }, "stc.com.sa", ADS),
  mk("Brand without DKIM (unaligned From kept)", {
    from: "Al Baik <info@albaik.com>", subject: "New menu item", returnPath: "info@albaik.com",
  }, "albaik.com", { labels: [], settled: false }),
  mk("Brand signed only by ESP", {
    from: "Tamimi Markets <news@tamimimarkets.com>", subject: "Weekly offers", dkim: ["sendgrid.info"],
    returnPath: "bounces+1@sendgrid.net", lu: "<https://u.tamimimarkets.com/x>", feedbackId: "77:SG",
  }, "tamimimarkets.com", ADS),
  mk("Brand on .sa with Outlook labels (Other + junk)", {
    from: "Extra Stores <promo@extra.com>", subject: "Mega sale this weekend", dkim: ["extra.com"],
    lu: "<https://extra.com/unsub>", oneClick: true, labels: ["FOLDER_JUNK", "OTHER"],
  }, "extra.com", ADS),

  // --- Personal: free-mail individuals, sent-to correspondents, owner and employer ---
  mk("Gmail friend", { from: "Khalid <khalid.otaibi@gmail.com>", subject: "dinner Thursday?", dkim: ["gmail.com"] }, "personal", { labels: ["personal"] }),
  mk("Hotmail individual unknown", { from: "Ahmed Saleh <ahmed.saleh88@hotmail.com>", subject: "Photos from the trip", dkim: ["hotmail.com"] }, "personal"),
  mk("Outlook.sa individual", { from: "Noura <noura.q@outlook.sa>", subject: "مرحبا", dkim: ["outlook.sa"] }, "personal"),
  mk("Yahoo individual", { from: "John Smith <jsmith1970@yahoo.co.uk>", subject: "Re: catching up" }, "personal"),
  mk("iCloud individual", { from: "Lama <lama.f@icloud.com>", subject: "Fwd: recipe", dkim: ["icloud.com"] }, "personal"),
  mk("Proton individual", { from: "anon <quiet.writer@proton.me>", subject: "draft attached", dkim: ["proton.me"] }, "personal"),
  mk("Sent-to correspondent on a business domain", {
    from: "Dr. Lina <dr.lina@familyclinic-riyadh.com>", subject: "Follow-up", dkim: ["familyclinic-riyadh.com"],
  }, "personal"),
  mk("Owner writes to self", { from: "Sara <sara.alharbi@gmail.com>", subject: "note to self" }, "personal"),
  mk("Employer domain colleague", {
    from: "Fahad <fahad.m@acme-energy.com.sa>", subject: "Meeting notes", dkim: ["acme-energy.com.sa"],
  }, "personal"),
  mk("Employer HR newsletter (still employer)", {
    from: "Acme HR <hr-news@mail.acme-energy.com.sa>", subject: "Monthly HR newsletter", dkim: ["mail.acme-energy.com.sa"],
    lu: "<mailto:unsub@acme-energy.com.sa>",
  }, "personal"),

  // --- Not personal despite looking close ---
  mk("Sent-to newsletter address with list headers stays a brand", {
    from: "Think Media <newsletter@thinkmedia.co>", subject: "This week in podcasts", dkim: ["thinkmedia.co"],
    lu: "<https://thinkmedia.co/unsub>", oneClick: true,
  }, "thinkmedia.co", ADS),
  mk("Gmail small business via Mailchimp, brand in LU host", {
    from: "Henna by Reem <hennabyreem@gmail.com>", subject: "Eid henna offers are here", dkim: ["mcsv.net"],
    returnPath: "bounce-mc.us21_1@mail1.mcsv.net", lu: "<https://hennabyreem.com/unsubscribe>", listId: "<a1.mcsv.net>",
  }, "hennabyreem.com", ADS),
  mk("Gmail sender via Mailchimp with no brand anywhere", {
    from: "Bake Corner <bakecorner.jed@gmail.com>", subject: "Weekend bake sale", dkim: ["mcsv.net"],
    returnPath: "bounce-mc.us21_2@mail2.mcsv.net", lu: "<https://bakecorner.us21.list-manage.com/unsubscribe?u=3>", listId: "<a2.mcsv.net>",
  }, null),
  mk("Pure ESP system mail", {
    from: "SendGrid <noreply@sendgrid.net>", subject: "Delivery report", dkim: ["sendgrid.net"], returnPath: "bounces@sendgrid.net",
  }, null),
];
