import keywords from "../../../data/reply-keywords.json";

// EN+AR keyword classifier for matched replies (00-brief §5 stage 9). Suggests a class; the owner confirms,
// except a high-confidence auto-acknowledgement, which is applied automatically and can be undone.
// LLM reply classification is a separate opt-in (M6) and never runs here.

export type ReplyClass = "ACKNOWLEDGED" | "COMPLETED" | "REFUSED" | "NEEDS_ID" | "EXTENSION";
export type ReplyClassification = {
  cls: ReplyClass | null;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  /** True when this looks like an automatic acknowledgement (auto-applied when the match is certain). */
  autoAck: boolean;
  hits: Partial<Record<ReplyClass, string[]>>;
};

const KEY_TO_CLASS: Record<string, ReplyClass> = {
  needs_id: "NEEDS_ID",
  refused: "REFUSED",
  extension: "EXTENSION",
  completed: "COMPLETED",
  acknowledged: "ACKNOWLEDGED",
};
/** Precedence when several classes match: anything substantive beats an acknowledgement. */
const PRECEDENCE: ReplyClass[] = ["NEEDS_ID", "REFUSED", "EXTENSION", "COMPLETED", "ACKNOWLEDGED"];

/** Arabic normalisation: drop tashkeel/tatweel, unify alef forms, ya/alef maqsura, ta marbuta/ha. */
export function normalizeArabic(s: string): string {
  return s
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

const normalize = (s: string) => normalizeArabic(s.toLowerCase()).replace(/[’‘]/g, "'").replace(/\s+/g, " ");

const TABLE = Object.entries(keywords.classes).map(([key, langs]) => ({
  cls: KEY_TO_CLASS[key],
  phrases: [...langs.en, ...langs.ar].map(normalize),
}));
const AUTO_SUBJECTS = [...keywords.autoReplySubjects.en, ...keywords.autoReplySubjects.ar].map(normalize);

/** Removes quoted history ("> " lines and everything after an "On … wrote:" / "From:" separator). */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^(on .{4,200} wrote:|في .{4,200} كتب:|-{2,} ?original message ?-{2,}|-{2,} ?الرسالة الأصلية ?-{2,}|_{8,})$/i.test(t)) break;
    if (/^from: .+/i.test(t) && out.length > 0) break;
    if (t.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

export function classifyReply(input: { text: string; subject?: string | null; autoSubmitted?: string | null }): ReplyClassification {
  const text = normalize(stripQuoted(input.text));
  const subject = normalize(input.subject ?? "");
  const hits: Partial<Record<ReplyClass, string[]>> = {};
  for (const row of TABLE) {
    const found = row.phrases.filter((p) => text.includes(p) || subject.includes(p));
    if (found.length) hits[row.cls] = found;
  }
  const matched = PRECEDENCE.filter((c) => hits[c]?.length);
  const cls = matched[0] ?? null;
  const autoHeader = Boolean(input.autoSubmitted && input.autoSubmitted !== "no");
  const autoSubject = AUTO_SUBJECTS.some((p) => subject.includes(p));
  const onlyAck = cls === "ACKNOWLEDGED" && matched.length === 1;
  const autoAck = onlyAck && (autoHeader || autoSubject);

  let confidence: ReplyClassification["confidence"] = "LOW";
  if (cls) {
    const n = hits[cls]!.length;
    if (autoAck || (matched.length === 1 && n >= 2)) confidence = "HIGH";
    else confidence = "MEDIUM";
  }
  return { cls, confidence, autoAck: autoAck && confidence === "HIGH", hits };
}
