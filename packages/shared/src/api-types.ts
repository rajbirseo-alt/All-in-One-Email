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
  /** False: no content of this mailbox is sent to the AI provider. */
  aiEnabled: boolean;
  folders: MailboxFolderInfo[];
  subscriptions: { id: string; provider: string; resource: string; status: string; expiresAt: string; lastNotifiedAt: string | null }[];
  access: MailboxAccessGrant[];
  syncLogs: SyncLogEntry[];
}

export interface MailboxProvidersResponse {
  gmail: boolean;
  microsoft: boolean;
  /** IMAP/SMTP needs no server-side setup: always available. */
  imap: boolean;
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
  createLead: boolean;
  leadServiceInterest: string | null;
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
  /** Where clicking the notification goes. */
  url: string;
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

// ───────────── CRM (Phase 7) ─────────────

export interface PersonRef {
  id: string;
  name: string;
}

export interface CompanyRef {
  id: string;
  name: string;
  domain: string | null;
}

export interface ContactListItem {
  id: string;
  name: string | null;
  primaryEmail: string | null;
  emailCount: number;
  company: CompanyRef | null;
  type: string;
  owner: PersonRef | null;
  phone: string | null;
  lastContactedAt: string | null;
  tags: TagView[];
}

export interface ContactMergeView {
  id: string;
  source: { id: string; name: string | null; emails: string[] };
  mergedBy: PersonRef | null;
  createdAt: string;
  undoneAt: string | null;
  moved: { emails: number; threads: number; leads: number; tasks: number; tags: number };
}

export interface ContactDetail extends ContactListItem {
  emails: { id: string; email: string; isPrimary: boolean }[];
  website: string | null;
  country: string | null;
  department: PersonRef | null;
  notes: string | null;
  createdAt: string;
  canEdit: boolean;
  canMerge: boolean;
  /** Merges into this contact (newest first); only for holders of contact.merge. */
  merges: ContactMergeView[];
}

export interface TimelineThread {
  id: string;
  subject: string;
  mailbox: string;
  status: string;
  messageCount: number;
  lastMessageAt: string;
  assignee: PersonRef | null;
}

export interface ContactTimeline {
  threads: TimelineThread[];
  leads: LeadListItem[];
  tasks: TaskView[];
}

export interface DuplicatePair {
  a: ContactListItem;
  b: ContactListItem;
  score: number;
  reasons: string[];
}

export interface MergePreview {
  target: ContactListItem;
  sources: ContactListItem[];
  moves: { emails: number; threads: number; leads: number; tasks: number; tags: number };
  /** Target fields that are empty and will be filled from a source. */
  fills: { field: string; value: string }[];
  /** Both have a value and they differ: the target's value is kept. */
  conflicts: { field: string; kept: string; dropped: string }[];
  /** Set when the merge was committed. */
  mergeIds?: string[];
}

export interface CompanyView extends CompanyRef {
  website: string | null;
  country: string | null;
  contactCount: number;
  openLeadCount: number;
}

export interface LeadListItem {
  id: string;
  title: string;
  status: string;
  source: string;
  contact: { id: string; name: string | null; email: string | null };
  company: CompanyRef | null;
  owner: PersonRef | null;
  department: PersonRef | null;
  estimatedValue: string | null;
  currency: string | null;
  serviceInterest: string | null;
  sourceThreadId: string | null;
  openTasks: number;
  createdAt: string;
  updatedAt: string;
}

export interface LeadHistoryEntry {
  id: string;
  from: string | null;
  to: string;
  changedBy: PersonRef | null;
  note: string | null;
  createdAt: string;
}

export interface LeadDetail extends LeadListItem {
  lostReason: string | null;
  wonAt: string | null;
  lostAt: string | null;
  /** The source conversation, when the caller can read it. */
  sourceThread: { id: string; subject: string } | null;
  history: LeadHistoryEntry[];
  tasks: TaskView[];
  canEdit: boolean;
}

export interface LeadSummary {
  byStatus: { status: string; count: number }[];
  open: number;
  won: number;
  lost: number;
  /** won / (won + lost); null while nothing is decided. */
  conversionRate: number | null;
  wonValue: { currency: string; value: string }[];
  byOwner: { owner: PersonRef | null; open: number; won: number; lost: number }[];
}

export interface TaskView {
  id: string;
  title: string;
  description: string | null;
  dueAt: string | null;
  status: string;
  assignee: PersonRef;
  createdBy: PersonRef | null;
  /** Links appear only when the caller may open them. */
  thread: { id: string; subject: string } | null;
  lead: { id: string; title: string } | null;
  contact: { id: string; name: string | null } | null;
  completedAt: string | null;
  createdAt: string;
  canEdit: boolean;
}

export interface ThreadCrm {
  contact: (ContactListItem & { canEdit: boolean }) | null;
  leads: LeadListItem[];
  tasks: TaskView[];
  canCreateLead: boolean;
  canCreateTask: boolean;
}

// ───────────── IMAP / SMTP (Phase 4) ─────────────

export interface ImapTestResult {
  ok: boolean;
  steps: { step: 'dns' | 'imap' | 'folders' | 'smtp'; ok: boolean; message: string }[];
  folders: { name: string; type: string }[];
}

/** Saved server settings of an IMAP mailbox (never the password). */
export interface ImapSettingsView {
  username: string;
  imap: { host: string; port: number; security: 'TLS' | 'STARTTLS' };
  smtp: { host: string; port: number; security: 'TLS' | 'STARTTLS' };
}

// ───────────── AI assistant (Phase 8) ─────────────

export interface ThreadInsights {
  /** AI is configured on the server and allowed for this conversation's mailbox. */
  available: boolean;
  /** Why not, when unavailable. */
  reason: string | null;
  /** A newer message arrived after the analysis. */
  stale: boolean;
  analyzedAt: string | null;
  model: string | null;
  summary: string | null;
  category: string | null;
  sentiment: string | null;
  urgency: { level: string; reason: string } | null;
  lead: { isLead: boolean; confidence: number; serviceInterest: string | null; companyName: string | null; reason: string } | null;
  followUp: { needed: boolean; inDays: number | null; action: string | null } | null;
}

export interface AiSuggestionView {
  id: string;
  threadId: string | null;
  kind: string;
  status: string;
  content: string;
  tone: string | null;
  model: string;
  draftId: string | null;
  createdAt: string;
}

export interface AiStatus {
  enabled: boolean;
  model: string | null;
  autoAnalyze: boolean;
}

// ───────────── Automation (Phase 8) ─────────────

export interface AutomationRuleView {
  id: string;
  name: string;
  description: string | null;
  trigger: string;
  department: { id: string; name: string } | null;
  isEnabled: boolean;
  position: number;
  conditions: { match: 'all' | 'any'; conditions: { field: string; op: string; value: string }[] };
  actions: ({ type: string } & Record<string, unknown>)[];
  lastRun: { status: string; startedAt: string } | null;
  runCount: number;
  canEdit: boolean;
}

export interface AutomationRunView {
  id: string;
  status: string;
  error: string | null;
  thread: { id: string; subject: string } | null;
  output: { type: string; ok: boolean; detail: string }[];
  startedAt: string;
  finishedAt: string | null;
}

export interface AutomationTestResult {
  matched: boolean;
  /** Why not, when it does not apply (other department, condition not met, …). */
  reason: string | null;
  facts: Record<string, string>;
  /** What each action would do; nothing is written. */
  actions: { type: string; detail: string }[];
}

// ───────────── Analytics (Phase 9) ─────────────
export interface AnalyticsRange {
  range: string;
  /** Local dates (report time zone), both inclusive. */
  from: string;
  to: string;
  timezone: string;
  /** When the figures were last brought up to date (null: not built yet). */
  asOf: string | null;
}
/** Minutes; null when there were no replies (or no business calendar for business minutes). */
export interface ResponseAverages {
  replies: number;
  avgMinutes: number | null;
  avgBusinessMinutes: number | null;
  firstReplies: number;
  avgFirstMinutes: number | null;
  avgFirstBusinessMinutes: number | null;
}
export interface AnalyticsOverview extends AnalyticsRange {
  /** Range figures. */
  incoming: number;
  outgoing: number;
  newThreads: number;
  closed: number;
  slaBreaches: number;
  response: ResponseAverages;
  /** Right now. */
  accounts: number;
  unread: number;
  unassigned: number;
  pending: number;
  overdue: number;
  /** Only for company-wide scope. */
  ai: { analyses: number; inputTokens: number; outputTokens: number } | null;
}
export interface ResponseTimeRow extends ResponseAverages {
  key: string | null;
  name: string;
  incoming: number;
  outgoing: number;
  closed: number;
  slaBreaches: number;
}
export interface WorkloadRow {
  key: string | null;
  name: string;
  open: number;
  pending: number;
  overdue: number;
}
export interface TrendPoint {
  /** Local date of the bucket start. */
  bucket: string;
  values: Record<string, number | null>;
}
export interface TrendsResult {
  interval: 'day' | 'week' | 'month';
  timezone: string;
  asOf: string | null;
  points: TrendPoint[];
}
export interface LeadFunnel extends AnalyticsRange {
  total: number;
  /** Current status of the leads created in the range. */
  byStatus: { status: string; count: number }[];
  /** How many of them ever reached each stage (New → Won). */
  reached: { status: string; count: number }[];
  won: number;
  lost: number;
  wonValue: { currency: string; amount: number }[];
  conversionRate: number | null;
}
export interface AccountHealthRow {
  id: string;
  emailAddress: string;
  displayName: string | null;
  provider: string;
  status: string;
  lastSuccessAt: string | null;
  lastError: string | null;
  failures24h: number;
  incoming: number;
}
export interface MdDashboard extends AnalyticsRange {
  incoming: number;
  pending: number;
  unassigned: number;
  overdue: number;
  newLeads: number;
  wonLeads: number;
  response: ResponseAverages;
  departments: (ResponseTimeRow & { open: number; pending: number; overdue: number })[];
  monthly: TrendPoint[];
}
export interface MyDashboard extends AnalyticsRange {
  assigned: number;
  newAssigned: number;
  pending: number;
  overdue: number;
  followUpsDue: number;
  tasksDue: number;
  closed: number;
  replies: number;
  myAvgMinutes: number | null;
  myAvgBusinessMinutes: number | null;
  /** Median of the average reply times of the people in the caller's teams (null: no team data). */
  teamMedianMinutes: number | null;
  teamMedianBusinessMinutes: number | null;
  nextUp: { id: string; subject: string; priority: string; status: string; awaitingReplySince: string | null; slaDueAt: string | null; overdue: boolean }[];
}
