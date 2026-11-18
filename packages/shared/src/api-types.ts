import type { EffectivePermissions } from './permissions';

/** Response shapes shared by the API and the web app. */

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface MeResponse {
  user: {
    id: string;
    email: string;
    name: string;
    avatarUrl: string | null;
    timezone: string;
    isAbsent: boolean;
    absentUntil: string | null;
    mfaEnabled: boolean;
    role: { id: string; key: string; name: string };
    department: { id: string; name: string } | null;
  };
  permissions: EffectivePermissions;
  session: { id: string; authMethod: string; expiresAt: string };
}

export interface AuthProvidersResponse {
  google: boolean;
  microsoft: boolean;
  password: boolean;
}

export type LoginResponse =
  | { status: 'ok' }
  | { status: 'mfa_required'; mfaToken: string }
  | { status: 'mfa_enrollment_required'; mfaToken: string };

export interface UserSummary {
  id: string;
  email: string;
  name: string;
  status: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
  timezone: string;
  isAbsent: boolean;
  lastLoginAt: string | null;
  mfaEnabled: boolean;
  hasPassword: boolean;
  role: { id: string; key: string; name: string };
  department: { id: string; name: string } | null;
  manager: { id: string; name: string } | null;
  createdAt: string;
}

export interface RoleDetail {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  userCount: number;
  permissions: { permissionKey: string; scope: string }[];
}

export interface DepartmentDetail {
  id: string;
  name: string;
  slug: string;
  manager: { id: string; name: string } | null;
  memberCount: number;
  teams: TeamDetail[];
}

export interface TeamDetail {
  id: string;
  name: string;
  departmentId: string;
  leader: { id: string; name: string } | null;
  members: { userId: string; name: string; email: string; inRotation: boolean }[];
}

export interface AuditEntry {
  id: string;
  actor: { id: string; name: string } | null;
  actorType: string;
  action: string;
  entityType: string;
  entityId: string | null;
  ip: string | null;
  before: unknown;
  after: unknown;
  metadata: unknown;
  createdAt: string;
}

export interface SessionInfo {
  id: string;
  ip: string | null;
  userAgent: string | null;
  authMethod: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
}

// ── Mailboxes (Phase 2) ──
export type MailProviderKey = 'GMAIL' | 'MICROSOFT' | 'IMAP';
export type MailboxStatus = 'CONNECTING' | 'INITIAL_SYNC' | 'ACTIVE' | 'NEEDS_REAUTH' | 'ERROR' | 'PAUSED' | 'DISCONNECTED';

export interface MailboxSummary {
  id: string;
  provider: MailProviderKey;
  emailAddress: string;
  displayName: string | null;
  department: { id: string; name: string } | null;
  status: MailboxStatus;
  lastSyncedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  messageCount: number;
  threadCount: number;
  /** Newest stored message; "lag" on the health screen is now minus this. */
  newestMessageAt: string | null;
  pushActive: boolean;
  disconnectedAt: string | null;
  purgeAfter: string | null;
  purgedAt: string | null;
  connectedBy: { id: string; name: string };
  createdAt: string;
}

export interface MailboxFolderInfo {
  id: string;
  name: string;
  type: string;
  syncEnabled: boolean;
  messageCount: number;
  lastSyncedAt: string | null;
}

export interface MailboxAccessGrant {
  id: string;
  level: 'READ' | 'REPLY' | 'MANAGE';
  user: { id: string; name: string; email: string } | null;
  team: { id: string; name: string } | null;
  department: { id: string; name: string } | null;
}

export interface SyncLogEntry {
  id: string;
  kind: string;
  status: string;
  messagesAdded: number;
  messagesUpdated: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface MailboxDetail extends MailboxSummary {
  syncFromDate: string | null;
  folders: MailboxFolderInfo[];
  subscriptions: { id: string; provider: string; resource: string; status: string; expiresAt: string; lastNotifiedAt: string | null }[];
  access: MailboxAccessGrant[];
  syncLogs: SyncLogEntry[];
}

export interface MailboxProvidersResponse {
  gmail: boolean;
  microsoft: boolean;
  gmailPush: boolean;
  microsoftPush: boolean;
  initialSyncDays: number;
  retentionDays: number;
}

// ── Conversations (Phase 3) ──
export interface Participant {
  address: string;
  name: string | null;
}

export interface ThreadListItem {
  id: string;
  subject: string;
  snippet: string | null;
  status: string;
  priority: string;
  account: { id: string; emailAddress: string; displayName: string | null; provider: MailProviderKey };
  assignee: { id: string; name: string } | null;
  team: { id: string; name: string } | null;
  department: { id: string; name: string } | null;
  tags: TagView[];
  /** Sender of the latest inbound message (or of the latest message). */
  from: Participant | null;
  messageCount: number;
  unreadCount: number;
  hasAttachments: boolean;
  isStarred: boolean;
  isArchived: boolean;
  isSpam: boolean;
  isTrashed: boolean;
  lastMessageAt: string;
  awaitingReplySince: string | null;
  snoozedUntil: string | null;
  followUpAt: string | null;
  /** Reply due (business-hours SLA); null when no clock is running. */
  slaDueAt: string | null;
  slaBreachedAt: string | null;
}

export interface AttachmentInfo {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  isInline: boolean;
}

export interface MessageView {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  from: Participant;
  to: Participant[];
  cc: Participant[];
  /** Only shown on outbound messages. */
  bcc: Participant[];
  replyTo: Participant[];
  subject: string;
  sentAt: string | null;
  receivedAt: string;
  isRead: boolean;
  isStarred: boolean;
  /** Sanitised HTML (render in a sandboxed iframe). */
  html: string;
  blockedImages: number;
  attachments: AttachmentInfo[];
  sentBy: { id: string; name: string } | null;
}

export interface ThreadDetail extends ThreadListItem {
  version: number;
  messages: MessageView[];
  canReply: boolean;
  canAssign: boolean;
  canShare: boolean;
  shares: { user: { id: string; name: string }; canReply: boolean }[];
  presence: PresenceEntry[];
  canChangeStatus: boolean;
  sla: ThreadSla;
}

export type ThreadCounts = Record<string, number>;

// ── Compose & send (Phase 3) ──
export interface DraftView {
  id: string;
  mode: 'NEW' | 'REPLY' | 'REPLY_ALL' | 'FORWARD';
  source: 'USER' | 'AI';
  status: 'EDITING' | 'QUEUED' | 'SENDING' | 'SENT' | 'FAILED';
  emailAccount: { id: string; emailAddress: string; displayName: string | null };
  threadId: string | null;
  to: Participant[];
  cc: Participant[];
  bcc: Participant[];
  subject: string;
  bodyHtml: string;
  baseThreadVersion: number | null;
  attachments: AttachmentInfo[];
  scheduledFor: string | null;
  sendError: string | null;
  updatedAt: string;
}

export interface ThreadChangedDetails {
  currentVersion: number;
  newMessages: { id: string; from: Participant; subject: string; snippet: string | null; receivedAt: string }[];
}

export interface SignatureView {
  id: string;
  name: string;
  html: string;
  emailAccountId: string | null;
  isDefault: boolean;
}

export interface TemplateView {
  id: string;
  name: string;
  subject: string | null;
  bodyHtml: string;
  sharing: 'private' | 'department' | 'company';
  owner: { id: string; name: string };
  canEdit: boolean;
}

// ── Assignment & collaboration (Phase 5) ──
export interface TagView {
  id: string;
  name: string;
  color: string;
}

export interface NoteView {
  id: string;
  author: { id: string; name: string };
  /** Plain text; mentions are written as @[userId] and listed in `mentions`. */
  body: string;
  mentions: { id: string; name: string }[];
  createdAt: string;
  editedAt: string | null;
  canEdit: boolean;
}

export interface AssignmentEntry {
  id: string;
  assignee: { id: string; name: string } | null;
  team: { id: string; name: string } | null;
  department: { id: string; name: string } | null;
  assignedBy: { id: string; name: string } | null;
  method: string;
  rule: { id: string; name: string } | null;
  reason: string | null;
  createdAt: string;
  endedAt: string | null;
}

export interface AssigneeOptions {
  users: { id: string; name: string; email: string; isAbsent: boolean }[];
  teams: { id: string; name: string; departmentId: string }[];
  departments: { id: string; name: string }[];
}

export interface PresenceEntry {
  userId: string;
  name: string;
  state: 'viewing' | 'composing';
}

export interface AssignmentRuleView {
  id: string;
  name: string;
  position: number;
  isEnabled: boolean;
  conditions: { match: 'all' | 'any'; conditions: { field: string; op: string; value: string }[] };
  targetType: 'USER' | 'TEAM' | 'DEPARTMENT';
  targetUser: { id: string; name: string } | null;
  team: { id: string; name: string } | null;
  department: { id: string; name: string } | null;
  strategy: 'DIRECT' | 'ROUND_ROBIN' | 'LEAST_LOADED';
  setPriority: string | null;
  canEdit: boolean;
}

export interface RuleTestResult {
  rule: { id: string; name: string } | null;
  /** Who would receive it now; null for a queue (team/department) or no match. */
  wouldAssignTo: { id: string; name: string } | null;
  queue: { team: { id: string; name: string } | null; department: { id: string; name: string } | null };
  checked: { id: string; name: string; matched: boolean }[];
}

export interface BulkResult {
  done: number;
  failed: { id: string; code: string }[];
}

// ── Status, SLA and notifications (Phase 6) ──
export interface StatusHistoryEntry {
  id: string;
  from: string | null;
  to: string;
  source: 'USER' | 'SYSTEM' | 'INBOUND_MESSAGE' | 'OUTBOUND_MESSAGE' | 'AUTOMATION' | 'SLA';
  changedBy: { id: string; name: string } | null;
  reason: string | null;
  createdAt: string;
}

export interface ThreadSla {
  policy: { id: string; name: string } | null;
  /** When the reply is due (first step that marks the conversation overdue). */
  dueAt: string | null;
  breachedAt: string | null;
  /** The calendar the clock runs on (for showing local due times). */
  timezone: string | null;
  steps: { action: string; afterBusinessMinutes: number; dueAt: string | null; firedAt: string | null; marksOverdue: boolean }[];
}

export interface NotificationView {
  id: string;
  type: string;
  title: string;
  body: string | null;
  threadId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationPrefs {
  pushAvailable: boolean;
  items: { type: string; label: string; description: string; inApp: boolean; push: boolean }[];
}

export interface CalendarView {
  id: string;
  name: string;
  timezone: string;
  weeklyHours: Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', [string, string][]>;
  holidays: { id: string; date: string; name: string }[];
  departments: { id: string; name: string }[];
  usedByPolicies: number;
}

export interface SlaPolicyView {
  id: string;
  name: string;
  department: { id: string; name: string } | null;
  priority: string | null;
  calendar: { id: string; name: string; timezone: string };
  isEnabled: boolean;
  isDefault: boolean;
  steps: { id: string; afterBusinessMinutes: number; action: string; marksOverdue: boolean }[];
  canEdit: boolean;
}
