-- Phase 10: health alerts for administrators.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SYSTEM_ALERT';

CREATE TABLE "system_alerts" (
    "key" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "detail" TEXT,
    "since" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notifiedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "system_alerts_pkey" PRIMARY KEY ("key")
);
