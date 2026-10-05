import { buildEvidenceZip as buildZip } from "@/lib/evidence/zip";
import type { Regulator } from "@/lib/legal/jurisdiction";
import { escalationPacket as packet, type EscalationPacket } from "@/lib/track/escalation";
import * as followups from "@/lib/track/followups";
import * as lifecycle from "@/lib/track/lifecycle";
import * as tracker from "@/lib/track/tracker";

// Public tracker API for the UI (/review, /tracker). Plain data in and out; errors are TrackError /
// DraftError with a `code`. Follow-up drafts (reminder, ID reply) use approveOutbound/queueOutbound/
// updateOutbound, which also accept first-letter items (they delegate to lib/legal/drafts).

export type { EscalationPacket } from "@/lib/track/escalation";
export type {
  NextAction,
  NextActionKind,
  TrackerDetail,
  TrackerEvent,
  TrackerGroup,
  TrackerOutbound,
  TrackerReply,
  TrackerRow,
} from "@/lib/track/tracker";
export type { ConfirmClass } from "@/lib/track/lifecycle";
export { TrackError } from "@/lib/track/state";

/** Cancel while QUEUED (10 s undo, waiting for the send slot / daily cap, or waiting for send permission). */
export async function cancelQueued(outboundId: string): Promise<void> {
  await followups.cancelQueued(outboundId);
}

/** "I submitted it" for a web form: sets clockStart + deadlines, status SENT. */
export async function markWebFormSubmitted(requestId: string, submittedAt: Date): Promise<void> {
  await lifecycle.markWebFormSubmitted(requestId, submittedAt);
}

/** Template 6b; at most one reminder and three messages per case; needs approval like any draft. */
export async function createReminderDraft(requestId: string): Promise<{ outboundId: string }> {
  return followups.createReminderDraft(requestId);
}

/** Template 6e (identity-verification reply); needs approval like any draft. */
export async function createIdReplyDraft(requestId: string): Promise<{ outboundId: string }> {
  return followups.createIdReplyDraft(requestId);
}

export async function confirmReply(
  replyId: string,
  cls: "ACKNOWLEDGED" | "COMPLETED" | "REFUSED" | "NEEDS_ID" | "EXTENSION" | "NOT_RELATED",
  extensionNoticeDate?: Date,
): Promise<void> {
  await lifecycle.confirmReply(replyId, cls, extensionNoticeDate);
}

export async function recordExtension(requestId: string, noticeDate: Date): Promise<void> {
  await lifecycle.recordExtension(requestId, noticeDate);
}

/** Template 6c (EN, or AR for SDAIA). Never files anything. `regulator` optionally picks another target (EN only). */
export async function escalationPacket(requestId: string, lang: "en" | "ar", regulator?: Regulator): Promise<EscalationPacket> {
  return packet(requestId, lang, regulator);
}

export async function markEscalated(requestId: string, complaintRef?: string): Promise<void> {
  await lifecycle.markEscalated(requestId, complaintRef);
}

export async function closeRequest(requestId: string, outcome: "COMPLETED" | "REFUSED" | "CANCELLED"): Promise<void> {
  await lifecycle.closeRequest(requestId, outcome);
}

/** ZIP: EML of sent mail and replies, raw headers of post-request marketing, timeline.json. */
export async function buildEvidenceZip(requestId: string): Promise<Buffer> {
  return buildZip(requestId);
}

export async function trackerRows(filter?: { status?: string[] }): Promise<tracker.TrackerRow[]> {
  return tracker.trackerRows(filter);
}

export async function trackerDetail(requestId: string): Promise<tracker.TrackerDetail> {
  return tracker.trackerDetail(requestId);
}

// ---------- additional helpers for the UI ----------

/** Approve any outbound item (follow-ups here; first letters via drafts.approveDraft). */
export async function approveOutbound(outboundId: string): Promise<{ approvedHash: string }> {
  return followups.approveOutbound(outboundId);
}

/** Confirm-dialog send for any outbound item: QUEUED with the 10 s undo window. */
export async function queueOutbound(outboundId: string): Promise<{ sendAfter: Date }> {
  return followups.queueOutbound(outboundId);
}

/** Edit any draft; clears approval. */
export async function updateOutbound(
  outboundId: string,
  patch: { subject?: string | null; body?: string | null; to?: string | null },
): Promise<{ draftHash: string; warnings: string[] }> {
  return followups.updateOutbound(outboundId, patch);
}

/** Full text of a stored reply ("Show full reply"). */
export async function replyText(replyId: string): Promise<string> {
  return lifecycle.replyText(replyId);
}
