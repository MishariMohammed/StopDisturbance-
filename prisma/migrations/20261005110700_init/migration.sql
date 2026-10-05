-- CreateEnum
CREATE TYPE "Provider" AS ENUM ('GOOGLE', 'MICROSOFT');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'NEEDS_RECONNECT', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "Confidence" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "DecisionValue" AS ENUM ('KEEP', 'UNSUBSCRIBE', 'REMOVE');

-- CreateEnum
CREATE TYPE "ContactKind" AS ENUM ('PRIVACY_EMAIL', 'WEB_FORM', 'ONE_CLICK', 'MAILTO_UNSUB', 'ACCOUNT_DELETE_URL', 'SUPPORT_EMAIL');

-- CreateEnum
CREATE TYPE "RequestType" AS ENUM ('ERASURE_OBJECTION', 'STOP_MARKETING', 'ONE_CLICK', 'MAILTO_UNSUB', 'WEB_FORM');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('DRAFT', 'APPROVED', 'QUEUED', 'SENT', 'ACKNOWLEDGED', 'NEEDS_ACTION', 'COMPLETED', 'REFUSED', 'OVERDUE', 'ESCALATED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Owner" (
    "id" TEXT NOT NULL DEFAULT 'owner',
    "fullName" TEXT NOT NULL DEFAULT '',
    "country" TEXT NOT NULL DEFAULT 'SA',
    "usState" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'ar',
    "numerals" TEXT NOT NULL DEFAULT 'latn',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Riyadh',
    "loginEmails" TEXT[],
    "googleSub" TEXT,
    "msOid" TEXT,
    "employerDomains" TEXT[],
    "setupDoneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Owner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailAccount" (
    "id" TEXT NOT NULL,
    "provider" "Provider" NOT NULL,
    "address" TEXT NOT NULL,
    "providerUserId" TEXT NOT NULL,
    "tenantId" TEXT,
    "grantedScopes" TEXT[],
    "tokenCipher" BYTEA NOT NULL,
    "tokenKeyVersion" INTEGER NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "syncCursor" JSONB,
    "scanFrom" TIMESTAMP(3) NOT NULL,
    "lastSyncAt" TIMESTAMP(3),
    "lastRefreshAt" TIMESTAMP(3),
    "scanProgress" JSONB,
    "sentToHashes" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageHeader" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerMsgId" TEXT NOT NULL,
    "threadId" TEXT,
    "internetMessageId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "fromName" TEXT,
    "fromDomain" TEXT NOT NULL,
    "replyToDomain" TEXT,
    "returnPathDomain" TEXT,
    "dkimDomains" TEXT[],
    "dkimPass" BOOLEAN NOT NULL DEFAULT false,
    "dkimCoversListUnsub" BOOLEAN NOT NULL DEFAULT false,
    "subject" TEXT,
    "listUnsubHttpsCipher" BYTEA,
    "listUnsubMailto" TEXT,
    "oneClick" BOOLEAN NOT NULL DEFAULT false,
    "listId" TEXT,
    "feedbackId" TEXT,
    "precedence" TEXT,
    "autoSubmitted" TEXT,
    "labels" TEXT[],
    "esp" TEXT,
    "isMarketing" BOOLEAN NOT NULL DEFAULT false,
    "isTransactional" BOOLEAN NOT NULL DEFAULT false,
    "isPersonal" BOOLEAN NOT NULL DEFAULT false,
    "isSent" BOOLEAN NOT NULL DEFAULT false,
    "senderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageHeader_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sender" (
    "id" TEXT NOT NULL,
    "registrableDomain" TEXT NOT NULL,
    "displayName" TEXT,
    "companyId" TEXT,
    "isEsp" BOOLEAN NOT NULL DEFAULT false,
    "isPersonal" BOOLEAN NOT NULL DEFAULT false,
    "msgCount" INTEGER NOT NULL DEFAULT 0,
    "marketingCount" INTEGER NOT NULL DEFAULT 0,
    "transactionalCount" INTEGER NOT NULL DEFAULT 0,
    "firstSeen" TIMESTAMP(3) NOT NULL,
    "lastSeen" TIMESTAMP(3) NOT NULL,
    "hasOneClick" BOOLEAN NOT NULL DEFAULT false,
    "exampleSubjects" TEXT[],
    "accountIds" TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sender_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "primaryDomain" TEXT NOT NULL,
    "holdsData" BOOLEAN NOT NULL DEFAULT false,
    "sendsAds" BOOLEAN NOT NULL DEFAULT false,
    "isBroker" BOOLEAN NOT NULL DEFAULT false,
    "confidence" "Confidence" NOT NULL DEFAULT 'LOW',
    "sector" TEXT,
    "jurisdiction" JSONB,
    "decision" "DecisionValue",
    "logoPath" TEXT,
    "enrichedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyDomain" (
    "domain" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "source" TEXT NOT NULL,

    CONSTRAINT "CompanyDomain_pkey" PRIMARY KEY ("domain")
);

-- CreateTable
CREATE TABLE "CompanyContact" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" "ContactKind" NOT NULL,
    "value" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "confidence" "Confidence" NOT NULL,
    "mxOk" BOOLEAN,
    "portalVendor" TEXT,
    "lastVerifiedAt" TIMESTAMP(3) NOT NULL,
    "ownerConfirmed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "CompanyContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Classification" (
    "id" TEXT NOT NULL,
    "senderId" TEXT,
    "companyId" TEXT,
    "method" TEXT NOT NULL,
    "labels" TEXT[],
    "ruleIds" TEXT[],
    "confidence" "Confidence" NOT NULL,
    "llmCallId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Classification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Decision" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "value" "DecisionValue" NOT NULL,
    "viaBulk" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Request" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "mailAccountId" TEXT NOT NULL,
    "type" "RequestType" NOT NULL,
    "status" "RequestStatus" NOT NULL DEFAULT 'DRAFT',
    "needsActionReason" TEXT,
    "reference" TEXT NOT NULL,
    "lawKeys" TEXT[],
    "citationsText" TEXT NOT NULL DEFAULT '',
    "lowConfidenceWording" BOOLEAN NOT NULL DEFAULT false,
    "clockStart" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "latestDueAt" TIMESTAMP(3),
    "extendedDueAt" TIMESTAMP(3),
    "reminderOfferedAt" TIMESTAMP(3),
    "reminderSentAt" TIMESTAMP(3),
    "escalationOpenAt" TIMESTAMP(3),
    "complaintWindowEndsAt" TIMESTAMP(3),
    "extensionClaimed" BOOLEAN NOT NULL DEFAULT false,
    "stillEmailing" BOOLEAN NOT NULL DEFAULT false,
    "bounced" BOOLEAN NOT NULL DEFAULT false,
    "complaintRef" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundMessage" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "templateVersion" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "toAddress" TEXT,
    "subject" TEXT,
    "bodyText" TEXT,
    "draftHash" TEXT NOT NULL,
    "approvedHash" TEXT,
    "approvedAt" TIMESTAMP(3),
    "sendAfter" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "providerMessageId" TEXT,
    "threadId" TEXT,
    "internetMessageId" TEXT,
    "httpStatus" INTEGER,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboundMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundReply" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "providerMsgId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyCipher" BYTEA NOT NULL,
    "matchMethod" TEXT NOT NULL,
    "probable" BOOLEAN NOT NULL DEFAULT false,
    "suggestedClass" TEXT,
    "ownerConfirmed" BOOLEAN,

    CONSTRAINT "InboundReply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceHeader" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "rawHeadersCipher" BYTEA NOT NULL,

    CONSTRAINT "EvidenceHeader_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequestEvent" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "data" JSONB NOT NULL,

    CONSTRAINT "RequestEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" BIGSERIAL NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" TEXT NOT NULL,
    "entity" TEXT,
    "entityId" TEXT,
    "data" JSONB NOT NULL,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "LlmCallLog" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purpose" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inTokens" INTEGER NOT NULL,
    "cacheHitTokens" INTEGER NOT NULL,
    "outTokens" INTEGER NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "fieldNames" TEXT[],
    "ok" BOOLEAN NOT NULL,

    CONSTRAINT "LlmCallLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LlmPayloadSample" (
    "id" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "payloadCipher" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmPayloadSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DatasetSnapshot" (
    "source" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "DatasetSnapshot_pkey" PRIMARY KEY ("source")
);

-- CreateTable
CREATE TABLE "AppEvent" (
    "id" BIGSERIAL NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT NOT NULL,
    "props" JSONB NOT NULL,

    CONSTRAINT "AppEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE UNIQUE INDEX "MailAccount_address_key" ON "MailAccount"("address");

-- CreateIndex
CREATE INDEX "MessageHeader_fromDomain_idx" ON "MessageHeader"("fromDomain");

-- CreateIndex
CREATE INDEX "MessageHeader_createdAt_idx" ON "MessageHeader"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MessageHeader_accountId_providerMsgId_key" ON "MessageHeader"("accountId", "providerMsgId");

-- CreateIndex
CREATE UNIQUE INDEX "Sender_registrableDomain_key" ON "Sender"("registrableDomain");

-- CreateIndex
CREATE UNIQUE INDEX "Company_primaryDomain_key" ON "Company"("primaryDomain");

-- CreateIndex
CREATE INDEX "CompanyContact_companyId_idx" ON "CompanyContact"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Request_reference_key" ON "Request"("reference");

-- CreateIndex
CREATE INDEX "OutboundMessage_requestId_idx" ON "OutboundMessage"("requestId");

-- CreateIndex
CREATE INDEX "InboundReply_requestId_idx" ON "InboundReply"("requestId");

-- CreateIndex
CREATE INDEX "RequestEvent_requestId_idx" ON "RequestEvent"("requestId");

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageHeader" ADD CONSTRAINT "MessageHeader_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AuditLog is append-only (00-brief §4). Deletes are allowed only for the erase-everything flow.
CREATE OR REPLACE FUNCTION auditlog_block_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER auditlog_no_update BEFORE UPDATE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION auditlog_block_update();
