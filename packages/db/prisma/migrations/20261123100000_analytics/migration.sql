-- Phase 9: report tables. No foreign keys: the figures outlive purged mail.

CREATE TABLE "analytics_response_facts" (
    "messageId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "departmentId" TEXT,
    "teamId" TEXT,
    "userId" TEXT,
    "waitingSince" TIMESTAMP(3) NOT NULL,
    "respondedAt" TIMESTAMP(3) NOT NULL,
    "clockMinutes" INTEGER NOT NULL,
    "businessMinutes" INTEGER,
    "isFirst" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "analytics_response_facts_pkey" PRIMARY KEY ("messageId")
);
CREATE INDEX "analytics_response_facts_respondedAt_idx" ON "analytics_response_facts"("respondedAt");
CREATE INDEX "analytics_response_facts_threadId_idx" ON "analytics_response_facts"("threadId");

CREATE TABLE "analytics_hourly" (
    "hour" TIMESTAMP(3) NOT NULL,
    "dimKey" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "departmentId" TEXT,
    "teamId" TEXT,
    "userId" TEXT,
    "incoming" INTEGER NOT NULL DEFAULT 0,
    "outgoing" INTEGER NOT NULL DEFAULT 0,
    "newThreads" INTEGER NOT NULL DEFAULT 0,
    "replies" INTEGER NOT NULL DEFAULT 0,
    "replyMinutes" BIGINT NOT NULL DEFAULT 0,
    "replyBizMinutes" BIGINT NOT NULL DEFAULT 0,
    "replyBizCount" INTEGER NOT NULL DEFAULT 0,
    "firstReplies" INTEGER NOT NULL DEFAULT 0,
    "firstReplyMinutes" BIGINT NOT NULL DEFAULT 0,
    "firstReplyBizMinutes" BIGINT NOT NULL DEFAULT 0,
    "firstReplyBizCount" INTEGER NOT NULL DEFAULT 0,
    "closed" INTEGER NOT NULL DEFAULT 0,
    "slaBreaches" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "analytics_hourly_pkey" PRIMARY KEY ("hour","dimKey")
);
CREATE INDEX "analytics_hourly_hour_departmentId_idx" ON "analytics_hourly"("hour", "departmentId");
CREATE INDEX "analytics_hourly_hour_userId_idx" ON "analytics_hourly"("hour", "userId");

CREATE TABLE "analytics_runs" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fromHour" TIMESTAMP(3) NOT NULL,
    "toHour" TIMESTAMP(3) NOT NULL,
    "rows" INTEGER NOT NULL DEFAULT 0,
    "facts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "analytics_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "analytics_runs_finishedAt_idx" ON "analytics_runs"("finishedAt" DESC);

-- Rollup inputs: messages and status changes by time.
CREATE INDEX IF NOT EXISTS "email_messages_receivedAt_idx" ON "email_messages"("receivedAt");
CREATE INDEX IF NOT EXISTS "status_history_toStatus_createdAt_idx" ON "status_history"("toStatus", "createdAt");
CREATE INDEX IF NOT EXISTS "email_threads_firstMessageAt_idx" ON "email_threads"("firstMessageAt");
CREATE INDEX IF NOT EXISTS "sla_events_firedAt_idx" ON "sla_events"("firedAt");
