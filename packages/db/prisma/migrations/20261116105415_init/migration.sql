-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "PermissionScope" AS ENUM ('OWN', 'ASSIGNED', 'TEAM', 'DEPARTMENT', 'ALL');

-- CreateEnum
CREATE TYPE "OverrideEffect" AS ENUM ('GRANT', 'DENY');

-- CreateEnum
CREATE TYPE "MailProvider" AS ENUM ('GMAIL', 'MICROSOFT', 'IMAP');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('CONNECTING', 'INITIAL_SYNC', 'ACTIVE', 'NEEDS_REAUTH', 'ERROR', 'PAUSED', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "CredentialKind" AS ENUM ('OAUTH', 'PASSWORD');

-- CreateEnum
CREATE TYPE "TransportSecurity" AS ENUM ('TLS', 'STARTTLS');

-- CreateEnum
CREATE TYPE "MailboxAccessLevel" AS ENUM ('READ', 'REPLY', 'MANAGE');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'FAILED', 'DELETED');

-- CreateEnum
CREATE TYPE "FolderType" AS ENUM ('INBOX', 'SENT', 'DRAFTS', 'ARCHIVE', 'SPAM', 'TRASH', 'STARRED', 'IMPORTANT', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('NEW', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_FOR_CLIENT', 'PENDING_REPLY', 'FOLLOW_UP_REQUIRED', 'REPLY_NOT_NEEDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('PENDING', 'CLEAN', 'INFECTED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "DraftMode" AS ENUM ('NEW', 'REPLY', 'REPLY_ALL', 'FORWARD');

-- CreateEnum
CREATE TYPE "DraftSource" AS ENUM ('USER', 'AI');

-- CreateEnum
CREATE TYPE "DraftStatus" AS ENUM ('EDITING', 'QUEUED', 'SENDING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "AssignmentMethod" AS ENUM ('MANUAL', 'BULK', 'RULE', 'ROUND_ROBIN', 'LEAST_LOADED', 'AUTOMATION', 'ABSENCE_REASSIGN', 'LEAD_ROUTING');

-- CreateEnum
CREATE TYPE "AssignmentTargetType" AS ENUM ('USER', 'TEAM', 'DEPARTMENT');

-- CreateEnum
CREATE TYPE "AssignmentStrategy" AS ENUM ('DIRECT', 'ROUND_ROBIN', 'LEAST_LOADED');

-- CreateEnum
CREATE TYPE "ChangeSource" AS ENUM ('USER', 'SYSTEM', 'INBOUND_MESSAGE', 'OUTBOUND_MESSAGE', 'AUTOMATION', 'SLA');

-- CreateEnum
CREATE TYPE "ContactType" AS ENUM ('CLIENT', 'PROSPECT', 'VENDOR', 'PARTNER', 'CANDIDATE', 'OTHER');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'CONTACTED', 'FOLLOW_UP', 'INTERESTED', 'PROPOSAL_SENT', 'NEGOTIATION', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "LeadSource" AS ENUM ('INBOUND_EMAIL', 'MANUAL');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('ASSIGNED', 'REASSIGNED', 'CLIENT_REPLIED', 'FOLLOW_UP_DUE', 'SLA_REMINDER', 'SLA_OVERDUE', 'SLA_ESCALATED', 'NOTE_MENTION', 'MANAGER_NOTE', 'LEAD_ASSIGNED', 'URGENT_EMAIL', 'ACCOUNT_NEEDS_REAUTH', 'TASK_DUE');

-- CreateEnum
CREATE TYPE "SlaAction" AS ENUM ('NOTIFY_ASSIGNEE', 'REMIND_ASSIGNEE', 'ALERT_MANAGER', 'ESCALATE');

-- CreateEnum
CREATE TYPE "AutomationTrigger" AS ENUM ('MESSAGE_RECEIVED', 'MESSAGE_SENT', 'THREAD_ASSIGNED', 'STATUS_CHANGED', 'SLA_STEP', 'LEAD_DETECTED', 'USER_ABSENT', 'SCHEDULE');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('SUCCEEDED', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "AiInsightKind" AS ENUM ('SUMMARY', 'CATEGORY', 'SENTIMENT', 'URGENCY', 'LEAD_DETECTION', 'FOLLOW_UP');

-- CreateEnum
CREATE TYPE "AiSuggestionKind" AS ENUM ('REPLY', 'IMPROVE_GRAMMAR', 'ADJUST_TONE');

-- CreateEnum
CREATE TYPE "AiSuggestionStatus" AS ENUM ('PROPOSED', 'USED_AS_DRAFT', 'DISCARDED');

-- CreateEnum
CREATE TYPE "SyncKind" AS ENUM ('INITIAL', 'INCREMENTAL', 'WEBHOOK', 'POLL', 'IDLE', 'SEND', 'FLAG_PUSH', 'SUBSCRIPTION_RENEW');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'SYSTEM', 'AUTOMATION', 'AI');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'INVITED',
    "roleId" TEXT NOT NULL,
    "departmentId" TEXT,
    "managerId" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "passwordHash" TEXT,
    "mfaSecretEnc" BYTEA,
    "mfaEnabledAt" TIMESTAMP(3),
    "isAbsent" BOOLEAN NOT NULL DEFAULT false,
    "absentUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_action_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdById" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_action_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_identities" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerSubject" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "authMethod" TEXT NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,
    "scope" "PermissionScope" NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("roleId","permissionId")
);

-- CreateTable
CREATE TABLE "user_permission_overrides" (
    "userId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,
    "effect" "OverrideEffect" NOT NULL,
    "scope" "PermissionScope",
    "reason" TEXT,
    "grantedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "user_permission_overrides_pkey" PRIMARY KEY ("userId","permissionId")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "managerId" TEXT,
    "calendarId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "leaderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "inRotation" BOOLEAN NOT NULL DEFAULT true,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("teamId","userId")
);

-- CreateTable
CREATE TABLE "email_accounts" (
    "id" TEXT NOT NULL,
    "provider" "MailProvider" NOT NULL,
    "emailAddress" TEXT NOT NULL,
    "displayName" TEXT,
    "departmentId" TEXT,
    "status" "AccountStatus" NOT NULL DEFAULT 'CONNECTING',
    "connectedById" TEXT NOT NULL,
    "syncFromDate" TIMESTAMP(3),
    "gmailHistoryId" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "disconnectedAt" TIMESTAMP(3),
    "purgeAfter" TIMESTAMP(3),

    CONSTRAINT "email_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_credentials" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "kind" "CredentialKind" NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "wrappedDataKey" BYTEA NOT NULL,
    "keyId" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "scopes" TEXT[],
    "accessTokenExpiresAt" TIMESTAMP(3),
    "username" TEXT,
    "imapHost" TEXT,
    "imapPort" INTEGER,
    "imapSecurity" "TransportSecurity",
    "smtpHost" TEXT,
    "smtpPort" INTEGER,
    "smtpSecurity" "TransportSecurity",
    "rotatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_account_access" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "userId" TEXT,
    "teamId" TEXT,
    "departmentId" TEXT,
    "level" "MailboxAccessLevel" NOT NULL,
    "grantedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_account_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_webhook_subscriptions" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "provider" "MailProvider" NOT NULL,
    "externalId" TEXT,
    "resource" TEXT NOT NULL,
    "clientStateHash" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_webhook_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "provider" "MailProvider" NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_folders" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "providerFolderId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "path" TEXT,
    "type" "FolderType" NOT NULL,
    "syncEnabled" BOOLEAN NOT NULL DEFAULT true,
    "uidValidity" BIGINT,
    "lastUid" BIGINT,
    "highestModSeq" BIGINT,
    "deltaLink" TEXT,
    "lastSyncedAt" TIMESTAMP(3),

    CONSTRAINT "email_folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_threads" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "providerThreadId" TEXT,
    "subject" TEXT NOT NULL,
    "normalizedSubject" TEXT NOT NULL,
    "snippet" TEXT,
    "status" "ConversationStatus" NOT NULL DEFAULT 'NEW',
    "priority" "Priority" NOT NULL DEFAULT 'NORMAL',
    "assigneeId" TEXT,
    "teamId" TEXT,
    "departmentId" TEXT,
    "contactId" TEXT,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "hasAttachments" BOOLEAN NOT NULL DEFAULT false,
    "isStarred" BOOLEAN NOT NULL DEFAULT false,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "isSpam" BOOLEAN NOT NULL DEFAULT false,
    "isTrashed" BOOLEAN NOT NULL DEFAULT false,
    "snoozedUntil" TIMESTAMP(3),
    "firstMessageAt" TIMESTAMP(3) NOT NULL,
    "lastMessageAt" TIMESTAMP(3) NOT NULL,
    "lastInboundAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "awaitingReplySince" TIMESTAMP(3),
    "firstResponseAt" TIMESTAMP(3),
    "slaPolicyId" TEXT,
    "slaDueAt" TIMESTAMP(3),
    "slaBreachedAt" TIMESTAMP(3),
    "followUpAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_messages" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "providerMessageId" TEXT NOT NULL,
    "internetMessageId" TEXT,
    "inReplyTo" TEXT,
    "references" TEXT[],
    "direction" "MessageDirection" NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "fromName" TEXT,
    "toRecipients" JSONB NOT NULL,
    "ccRecipients" JSONB NOT NULL DEFAULT '[]',
    "bccRecipients" JSONB NOT NULL DEFAULT '[]',
    "replyTo" JSONB NOT NULL DEFAULT '[]',
    "subject" TEXT NOT NULL,
    "snippet" TEXT,
    "bodyText" TEXT,
    "bodyHtml" TEXT,
    "headers" JSONB,
    "sizeBytes" INTEGER,
    "hasAttachments" BOOLEAN NOT NULL DEFAULT false,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "isDraft" BOOLEAN NOT NULL DEFAULT false,
    "sentAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "sentByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "searchVector" tsvector,

    CONSTRAINT "email_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_folders" (
    "messageId" TEXT NOT NULL,
    "folderId" TEXT NOT NULL,
    "imapUid" BIGINT,

    CONSTRAINT "message_folders_pkey" PRIMARY KEY ("messageId","folderId")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" TEXT NOT NULL,
    "messageId" TEXT,
    "draftId" TEXT,
    "providerAttachmentId" TEXT,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "contentId" TEXT,
    "isInline" BOOLEAN NOT NULL DEFAULT false,
    "storageKey" TEXT,
    "sha256" TEXT,
    "scanStatus" "ScanStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drafts" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "threadId" TEXT,
    "authorId" TEXT NOT NULL,
    "mode" "DraftMode" NOT NULL,
    "source" "DraftSource" NOT NULL DEFAULT 'USER',
    "inReplyToMessageId" TEXT,
    "toRecipients" JSONB NOT NULL DEFAULT '[]',
    "ccRecipients" JSONB NOT NULL DEFAULT '[]',
    "bccRecipients" JSONB NOT NULL DEFAULT '[]',
    "subject" TEXT NOT NULL DEFAULT '',
    "bodyHtml" TEXT NOT NULL DEFAULT '',
    "signatureId" TEXT,
    "status" "DraftStatus" NOT NULL DEFAULT 'EDITING',
    "idempotencyKey" TEXT,
    "baseThreadVersion" INTEGER,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "sentMessageId" TEXT,
    "sendError" TEXT,
    "scheduledFor" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signatures" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emailAccountId" TEXT,
    "name" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signatures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT,
    "bodyHtml" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "departmentId" TEXT,
    "isShared" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignments" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "assigneeId" TEXT,
    "teamId" TEXT,
    "departmentId" TEXT,
    "assignedById" TEXT,
    "method" "AssignmentMethod" NOT NULL,
    "ruleId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignment_rules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "conditions" JSONB NOT NULL,
    "targetType" "AssignmentTargetType" NOT NULL,
    "targetUserId" TEXT,
    "teamId" TEXT,
    "departmentId" TEXT,
    "strategy" "AssignmentStrategy" NOT NULL DEFAULT 'DIRECT',
    "setPriority" "Priority",
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assignment_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "round_robin_cursors" (
    "teamId" TEXT NOT NULL,
    "lastUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "round_robin_cursors_pkey" PRIMARY KEY ("teamId")
);

-- CreateTable
CREATE TABLE "status_history" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "fromStatus" "ConversationStatus",
    "toStatus" "ConversationStatus" NOT NULL,
    "changedById" TEXT,
    "source" "ChangeSource" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "internal_notes" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "internal_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "note_mentions" (
    "noteId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "note_mentions_pkey" PRIMARY KEY ("noteId","userId")
);

-- CreateTable
CREATE TABLE "thread_shares" (
    "threadId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sharedById" TEXT NOT NULL,
    "canReply" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "thread_shares_pkey" PRIMARY KEY ("threadId","userId")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#64748b',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "thread_tags" (
    "threadId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "addedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "thread_tags_pkey" PRIMARY KEY ("threadId","tagId")
);

-- CreateTable
CREATE TABLE "companies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "website" TEXT,
    "country" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "phone" TEXT,
    "companyId" TEXT,
    "website" TEXT,
    "country" TEXT,
    "type" "ContactType" NOT NULL DEFAULT 'OTHER',
    "ownerId" TEXT,
    "departmentId" TEXT,
    "notes" TEXT,
    "lastContactedAt" TIMESTAMP(3),
    "mergedIntoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_emails" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "contact_emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_tags" (
    "contactId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    CONSTRAINT "contact_tags_pkey" PRIMARY KEY ("contactId","tagId")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "companyId" TEXT,
    "sourceThreadId" TEXT,
    "source" "LeadSource" NOT NULL,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "ownerId" TEXT,
    "estimatedValue" DECIMAL(14,2),
    "currency" TEXT DEFAULT 'USD',
    "serviceInterest" TEXT,
    "aiConfidence" DOUBLE PRECISION,
    "lostReason" TEXT,
    "wonAt" TIMESTAMP(3),
    "lostAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_status_history" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "fromStatus" "LeadStatus",
    "toStatus" "LeadStatus" NOT NULL,
    "changedById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "dueAt" TIMESTAMP(3),
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "assigneeId" TEXT NOT NULL,
    "createdById" TEXT,
    "threadId" TEXT,
    "leadId" TEXT,
    "contactId" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "data" JSONB,
    "threadId" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "inApp" BOOLEAN NOT NULL DEFAULT true,
    "push" BOOLEAN NOT NULL DEFAULT true,
    "email" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("userId","type")
);

-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_calendars" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "weeklyHours" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_calendars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holidays" (
    "id" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_policies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "departmentId" TEXT,
    "priority" "Priority",
    "calendarId" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sla_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_steps" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "afterBusinessMinutes" INTEGER NOT NULL,
    "action" "SlaAction" NOT NULL,
    "marksOverdue" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "sla_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_events" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "cycleStart" TIMESTAMP(3) NOT NULL,
    "firedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sla_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_rules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "trigger" "AutomationTrigger" NOT NULL,
    "schedule" TEXT,
    "conditions" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_runs" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "threadId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL,
    "error" TEXT,
    "output" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_summaries" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "kind" "AiInsightKind" NOT NULL,
    "model" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "upToMessageId" TEXT NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_suggestions" (
    "id" TEXT NOT NULL,
    "threadId" TEXT,
    "requestedById" TEXT NOT NULL,
    "kind" "AiSuggestionKind" NOT NULL,
    "model" TEXT NOT NULL,
    "input" JSONB,
    "content" TEXT NOT NULL,
    "status" "AiSuggestionStatus" NOT NULL DEFAULT 'PROPOSED',
    "draftId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_logs" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "kind" "SyncKind" NOT NULL,
    "status" "SyncStatus" NOT NULL,
    "messagesAdded" INTEGER NOT NULL DEFAULT 0,
    "messagesUpdated" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "details" JSONB,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "sync_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "actorType" "ActorType" NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "before" JSONB,
    "after" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_roleId_idx" ON "users"("roleId");

-- CreateIndex
CREATE INDEX "users_departmentId_idx" ON "users"("departmentId");

-- CreateIndex
CREATE INDEX "users_managerId_idx" ON "users"("managerId");

-- CreateIndex
CREATE UNIQUE INDEX "user_action_tokens_tokenHash_key" ON "user_action_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "user_action_tokens_userId_idx" ON "user_action_tokens"("userId");

-- CreateIndex
CREATE INDEX "user_identities_userId_idx" ON "user_identities"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "user_identities_provider_providerSubject_key" ON "user_identities"("provider", "providerSubject");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "roles_key_key" ON "roles"("key");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions"("key");

-- CreateIndex
CREATE UNIQUE INDEX "departments_slug_key" ON "departments"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "teams_departmentId_name_key" ON "teams"("departmentId", "name");

-- CreateIndex
CREATE INDEX "team_members_userId_idx" ON "team_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "email_accounts_emailAddress_key" ON "email_accounts"("emailAddress");

-- CreateIndex
CREATE INDEX "email_accounts_status_idx" ON "email_accounts"("status");

-- CreateIndex
CREATE INDEX "email_accounts_departmentId_idx" ON "email_accounts"("departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "email_credentials_emailAccountId_key" ON "email_credentials"("emailAccountId");

-- CreateIndex
CREATE INDEX "email_account_access_userId_idx" ON "email_account_access"("userId");

-- CreateIndex
CREATE INDEX "email_account_access_teamId_idx" ON "email_account_access"("teamId");

-- CreateIndex
CREATE INDEX "email_account_access_departmentId_idx" ON "email_account_access"("departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "email_account_access_emailAccountId_userId_key" ON "email_account_access"("emailAccountId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "email_account_access_emailAccountId_teamId_key" ON "email_account_access"("emailAccountId", "teamId");

-- CreateIndex
CREATE UNIQUE INDEX "email_account_access_emailAccountId_departmentId_key" ON "email_account_access"("emailAccountId", "departmentId");

-- CreateIndex
CREATE INDEX "email_webhook_subscriptions_expiresAt_status_idx" ON "email_webhook_subscriptions"("expiresAt", "status");

-- CreateIndex
CREATE INDEX "email_webhook_subscriptions_emailAccountId_idx" ON "email_webhook_subscriptions"("emailAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "email_webhook_subscriptions_provider_externalId_key" ON "email_webhook_subscriptions"("provider", "externalId");

-- CreateIndex
CREATE INDEX "webhook_events_receivedAt_idx" ON "webhook_events"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_provider_externalEventId_key" ON "webhook_events"("provider", "externalEventId");

-- CreateIndex
CREATE INDEX "email_folders_emailAccountId_type_idx" ON "email_folders"("emailAccountId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "email_folders_emailAccountId_providerFolderId_key" ON "email_folders"("emailAccountId", "providerFolderId");

-- CreateIndex
CREATE INDEX "email_threads_emailAccountId_lastMessageAt_idx" ON "email_threads"("emailAccountId", "lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "email_threads_assigneeId_status_lastMessageAt_idx" ON "email_threads"("assigneeId", "status", "lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "email_threads_departmentId_status_idx" ON "email_threads"("departmentId", "status");

-- CreateIndex
CREATE INDEX "email_threads_teamId_status_idx" ON "email_threads"("teamId", "status");

-- CreateIndex
CREATE INDEX "email_threads_status_slaDueAt_idx" ON "email_threads"("status", "slaDueAt");

-- CreateIndex
CREATE INDEX "email_threads_contactId_idx" ON "email_threads"("contactId");

-- CreateIndex
CREATE INDEX "email_threads_snoozedUntil_idx" ON "email_threads"("snoozedUntil");

-- CreateIndex
CREATE INDEX "email_threads_emailAccountId_normalizedSubject_idx" ON "email_threads"("emailAccountId", "normalizedSubject");

-- CreateIndex
CREATE UNIQUE INDEX "email_threads_emailAccountId_providerThreadId_key" ON "email_threads"("emailAccountId", "providerThreadId");

-- CreateIndex
CREATE INDEX "email_messages_threadId_receivedAt_idx" ON "email_messages"("threadId", "receivedAt");

-- CreateIndex
CREATE INDEX "email_messages_emailAccountId_internetMessageId_idx" ON "email_messages"("emailAccountId", "internetMessageId");

-- CreateIndex
CREATE INDEX "email_messages_fromAddress_idx" ON "email_messages"("fromAddress");

-- CreateIndex
CREATE INDEX "email_messages_emailAccountId_receivedAt_idx" ON "email_messages"("emailAccountId", "receivedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "email_messages_emailAccountId_providerMessageId_key" ON "email_messages"("emailAccountId", "providerMessageId");

-- CreateIndex
CREATE INDEX "message_folders_folderId_imapUid_idx" ON "message_folders"("folderId", "imapUid");

-- CreateIndex
CREATE INDEX "attachments_messageId_idx" ON "attachments"("messageId");

-- CreateIndex
CREATE INDEX "attachments_draftId_idx" ON "attachments"("draftId");

-- CreateIndex
CREATE INDEX "attachments_sha256_idx" ON "attachments"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "drafts_idempotencyKey_key" ON "drafts"("idempotencyKey");

-- CreateIndex
CREATE INDEX "drafts_authorId_status_idx" ON "drafts"("authorId", "status");

-- CreateIndex
CREATE INDEX "drafts_threadId_idx" ON "drafts"("threadId");

-- CreateIndex
CREATE INDEX "signatures_userId_idx" ON "signatures"("userId");

-- CreateIndex
CREATE INDEX "templates_ownerId_idx" ON "templates"("ownerId");

-- CreateIndex
CREATE INDEX "templates_departmentId_idx" ON "templates"("departmentId");

-- CreateIndex
CREATE INDEX "assignments_threadId_createdAt_idx" ON "assignments"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "assignments_assigneeId_createdAt_idx" ON "assignments"("assigneeId", "createdAt");

-- CreateIndex
CREATE INDEX "assignment_rules_isEnabled_position_idx" ON "assignment_rules"("isEnabled", "position");

-- CreateIndex
CREATE INDEX "status_history_threadId_createdAt_idx" ON "status_history"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "internal_notes_threadId_createdAt_idx" ON "internal_notes"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "note_mentions_userId_idx" ON "note_mentions"("userId");

-- CreateIndex
CREATE INDEX "thread_shares_userId_idx" ON "thread_shares"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "tags_name_key" ON "tags"("name");

-- CreateIndex
CREATE INDEX "thread_tags_tagId_idx" ON "thread_tags"("tagId");

-- CreateIndex
CREATE UNIQUE INDEX "companies_domain_key" ON "companies"("domain");

-- CreateIndex
CREATE INDEX "companies_name_idx" ON "companies"("name");

-- CreateIndex
CREATE INDEX "contacts_companyId_idx" ON "contacts"("companyId");

-- CreateIndex
CREATE INDEX "contacts_ownerId_idx" ON "contacts"("ownerId");

-- CreateIndex
CREATE INDEX "contacts_mergedIntoId_idx" ON "contacts"("mergedIntoId");

-- CreateIndex
CREATE UNIQUE INDEX "contact_emails_email_key" ON "contact_emails"("email");

-- CreateIndex
CREATE INDEX "contact_emails_contactId_idx" ON "contact_emails"("contactId");

-- CreateIndex
CREATE INDEX "leads_ownerId_status_idx" ON "leads"("ownerId", "status");

-- CreateIndex
CREATE INDEX "leads_status_createdAt_idx" ON "leads"("status", "createdAt");

-- CreateIndex
CREATE INDEX "leads_contactId_idx" ON "leads"("contactId");

-- CreateIndex
CREATE INDEX "lead_status_history_leadId_createdAt_idx" ON "lead_status_history"("leadId", "createdAt");

-- CreateIndex
CREATE INDEX "tasks_assigneeId_status_dueAt_idx" ON "tasks"("assigneeId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_createdAt_idx" ON "notifications"("userId", "readAt", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "push_subscriptions_userId_idx" ON "push_subscriptions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "holidays_calendarId_date_key" ON "holidays"("calendarId", "date");

-- CreateIndex
CREATE INDEX "sla_policies_departmentId_priority_idx" ON "sla_policies"("departmentId", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "sla_steps_policyId_afterBusinessMinutes_action_key" ON "sla_steps"("policyId", "afterBusinessMinutes", "action");

-- CreateIndex
CREATE UNIQUE INDEX "sla_events_threadId_stepId_cycleStart_key" ON "sla_events"("threadId", "stepId", "cycleStart");

-- CreateIndex
CREATE INDEX "automation_rules_trigger_isEnabled_position_idx" ON "automation_rules"("trigger", "isEnabled", "position");

-- CreateIndex
CREATE UNIQUE INDEX "automation_runs_idempotencyKey_key" ON "automation_runs"("idempotencyKey");

-- CreateIndex
CREATE INDEX "automation_runs_ruleId_startedAt_idx" ON "automation_runs"("ruleId", "startedAt");

-- CreateIndex
CREATE INDEX "ai_summaries_threadId_kind_createdAt_idx" ON "ai_summaries"("threadId", "kind", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ai_summaries_threadId_kind_upToMessageId_key" ON "ai_summaries"("threadId", "kind", "upToMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_suggestions_draftId_key" ON "ai_suggestions"("draftId");

-- CreateIndex
CREATE INDEX "ai_suggestions_threadId_idx" ON "ai_suggestions"("threadId");

-- CreateIndex
CREATE INDEX "sync_logs_emailAccountId_startedAt_idx" ON "sync_logs"("emailAccountId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "sync_logs_status_startedAt_idx" ON "sync_logs"("status", "startedAt");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_createdAt_idx" ON "audit_logs"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_actorId_createdAt_idx" ON "audit_logs"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_action_createdAt_idx" ON "audit_logs"("action", "createdAt");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_action_tokens" ADD CONSTRAINT "user_action_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "user_permission_overrides_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "user_permission_overrides_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "business_calendars"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_accounts" ADD CONSTRAINT "email_accounts_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_accounts" ADD CONSTRAINT "email_accounts_connectedById_fkey" FOREIGN KEY ("connectedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_credentials" ADD CONSTRAINT "email_credentials_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "email_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_account_access" ADD CONSTRAINT "email_account_access_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "email_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_account_access" ADD CONSTRAINT "email_account_access_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_account_access" ADD CONSTRAINT "email_account_access_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_account_access" ADD CONSTRAINT "email_account_access_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_webhook_subscriptions" ADD CONSTRAINT "email_webhook_subscriptions_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "email_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_folders" ADD CONSTRAINT "email_folders_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "email_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "email_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_slaPolicyId_fkey" FOREIGN KEY ("slaPolicyId") REFERENCES "sla_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "email_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "email_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_sentByUserId_fkey" FOREIGN KEY ("sentByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_folders" ADD CONSTRAINT "message_folders_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "email_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_folders" ADD CONSTRAINT "message_folders_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "email_folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "email_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "email_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "email_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "email_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "email_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "assignment_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_rules" ADD CONSTRAINT "assignment_rules_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_rules" ADD CONSTRAINT "assignment_rules_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "round_robin_cursors" ADD CONSTRAINT "round_robin_cursors_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "status_history" ADD CONSTRAINT "status_history_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "email_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "status_history" ADD CONSTRAINT "status_history_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_notes" ADD CONSTRAINT "internal_notes_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "email_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_notes" ADD CONSTRAINT "internal_notes_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_mentions" ADD CONSTRAINT "note_mentions_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "internal_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_mentions" ADD CONSTRAINT "note_mentions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thread_shares" ADD CONSTRAINT "thread_shares_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "email_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thread_shares" ADD CONSTRAINT "thread_shares_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thread_shares" ADD CONSTRAINT "thread_shares_sharedById_fkey" FOREIGN KEY ("sharedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thread_tags" ADD CONSTRAINT "thread_tags_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "email_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thread_tags" ADD CONSTRAINT "thread_tags_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_emails" ADD CONSTRAINT "contact_emails_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_sourceThreadId_fkey" FOREIGN KEY ("sourceThreadId") REFERENCES "email_threads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_status_history" ADD CONSTRAINT "lead_status_history_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "email_threads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "email_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "business_calendars"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "business_calendars"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_steps" ADD CONSTRAINT "sla_steps_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "sla_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_events" ADD CONSTRAINT "sla_events_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "email_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_events" ADD CONSTRAINT "sla_events_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "sla_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "automation_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_summaries" ADD CONSTRAINT "ai_summaries_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "email_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "email_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "drafts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_logs" ADD CONSTRAINT "sync_logs_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "email_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
