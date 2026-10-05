import type { GmailMessageMeta } from "@/lib/mail/gmail";

const h = (name: string, value: string) => ({ name, value });

export const marketingMsg: GmailMessageMeta = {
  id: "m1",
  threadId: "t1",
  labelIds: ["INBOX", "CATEGORY_PROMOTIONS"],
  internalDate: String(Date.UTC(2026, 8, 1)),
  payload: {
    headers: [
      h("From", '"Noon Deals" <deals@em.noon.com>'),
      h("To", "Owner <owner@gmail.com>"),
      h("Subject", "50% off this weekend"),
      h("Message-ID", "<abc@em.noon.com>"),
      h("List-Unsubscribe", "<mailto:unsub@em.noon.com?subject=u>, <https://em.noon.com/u?t=SECRET123>"),
      h("List-Unsubscribe-Post", "List-Unsubscribe=One-Click"),
      h("List-Id", "<promo.noon.com>"),
      h("Feedback-ID", "123:noon:braze"),
      h("Precedence", "bulk"),
      h("DKIM-Signature", "v=1; a=rsa-sha256; d=em.noon.com; s=s1; h=from:to:subject:list-unsubscribe:list-unsubscribe-post; b=xyz"),
      h("Authentication-Results", "mx.google.com; dkim=pass header.i=@em.noon.com header.s=s1; spf=pass"),
      h("Return-Path", "<bounce@bounce.em.noon.com>"),
    ],
  },
};

export const sentMsg: GmailMessageMeta = {
  id: "s1",
  threadId: "t2",
  labelIds: ["SENT"],
  internalDate: String(Date.UTC(2026, 8, 2)),
  payload: { headers: [h("From", "owner@gmail.com"), h("To", "Friend <friend@gmail.com>, other@hotmail.com"), h("Subject", "dinner")] },
};

export const trashMsg: GmailMessageMeta = {
  id: "x1",
  threadId: "t3",
  labelIds: ["TRASH"],
  internalDate: String(Date.UTC(2026, 8, 3)),
  payload: { headers: [h("From", "x@spam.example")] },
};

export const newMsg: GmailMessageMeta = {
  id: "n1",
  threadId: "t4",
  labelIds: ["INBOX"],
  internalDate: String(Date.UTC(2026, 9, 1)),
  payload: { headers: [h("From", "Receipts <no-reply@careem.com>"), h("Subject", "Your receipt")] },
};
