import { z } from 'zod';
import { PERMISSION_KEYS, SCOPES, type PermissionKey } from './permissions';

const id = z.string().min(1).max(64);
const email = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(254);
const name = z.string().trim().min(1).max(120);
const permissionKey = z.enum(PERMISSION_KEYS as [PermissionKey, ...PermissionKey[]]);
const scope = z.enum(SCOPES);

/** IANA zone check using the runtime's own tz database. */
export const timezone = z
  .string()
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Unknown time zone');

/** 12+ chars; length matters more than composition rules (NIST 800-63B). */
export const password = z.string().min(12, 'Use at least 12 characters').max(256);

export const loginSchema = z.object({ email, password: z.string().min(1).max(256) });
export const mfaVerifySchema = z.object({
  mfaToken: z.string().min(1).max(2048),
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});
export const mfaEnrollStartSchema = z.object({ mfaToken: z.string().min(1).max(2048) });
export const setPasswordSchema = z.object({ token: z.string().min(20).max(200), password });

export const createUserSchema = z.object({
  email,
  name,
  roleId: id,
  departmentId: id.nullable().optional(),
  managerId: id.nullable().optional(),
  timezone: timezone.optional(),
});
export const updateUserSchema = z
  .object({
    name: name.optional(),
    roleId: id.optional(),
    departmentId: id.nullable().optional(),
    managerId: id.nullable().optional(),
    timezone: timezone.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export const updateSelfSchema = z
  .object({ name: name.optional(), timezone: timezone.optional() })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export const absenceSchema = z
  .object({ isAbsent: z.boolean(), absentUntil: z.coerce.date().nullable().optional() })
  .refine((v) => !v.absentUntil || v.absentUntil > new Date(), {
    message: 'absentUntil must be in the future',
    path: ['absentUntil'],
  });
export const permissionOverridesSchema = z.object({
  overrides: z
    .array(
      z.object({
        permissionKey,
        effect: z.enum(['GRANT', 'DENY']),
        scope: scope.nullable().optional(),
        reason: z.string().max(500).optional(),
        expiresAt: z.coerce.date().nullable().optional(),
      }),
    )
    .max(PERMISSION_KEYS.length),
});
export const listUsersQuery = z.object({
  q: z.string().max(120).optional(),
  status: z.enum(['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED']).optional(),
  departmentId: id.optional(),
  roleId: id.optional(),
  cursor: id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const createRoleSchema = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'Use UPPER_SNAKE_CASE'),
  name,
  description: z.string().max(500).optional(),
});
export const updateRoleSchema = z
  .object({ name: name.optional(), description: z.string().max(500).nullable().optional() })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export const rolePermissionsSchema = z.object({
  permissions: z
    .array(z.object({ permissionKey, scope }))
    .max(PERMISSION_KEYS.length)
    .refine((a) => new Set(a.map((p) => p.permissionKey)).size === a.length, 'Duplicate permission'),
});

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and dashes')
  .max(60);
export const createDepartmentSchema = z.object({ name, slug, managerId: id.nullable().optional() });
export const updateDepartmentSchema = z
  .object({ name: name.optional(), slug: slug.optional(), managerId: id.nullable().optional() })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export const createTeamSchema = z.object({ name, departmentId: id, leaderId: id.nullable().optional() });
export const updateTeamSchema = z
  .object({ name: name.optional(), leaderId: id.nullable().optional() })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export const teamMemberSchema = z.object({ userId: id, inRotation: z.boolean().default(true) });

export const auditQuery = z.object({
  entityType: z.string().max(60).optional(),
  entityId: id.optional(),
  actorId: id.optional(),
  action: z.string().max(80).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// ── Mailboxes (Phase 2) ──
export const MAIL_PROVIDERS = ['GMAIL', 'MICROSOFT'] as const;
export const MAILBOX_ACCESS_LEVELS = ['READ', 'REPLY', 'MANAGE'] as const;

export const connectMailboxSchema = z.object({
  departmentId: id.nullable().optional(),
  /** How many days of existing mail the first sync imports. */
  syncDays: z.coerce.number().int().min(1).max(3650).optional(),
});
export const updateMailboxSchema = z
  .object({ displayName: z.string().trim().max(120).nullable().optional(), departmentId: id.nullable().optional(), aiEnabled: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export const mailboxFoldersSchema = z.object({
  folders: z.array(z.object({ folderId: id, syncEnabled: z.boolean() })).min(1).max(500),
});
export const mailboxAccessSchema = z.object({
  grants: z
    .array(
      z
        .object({
          userId: id.optional(),
          teamId: id.optional(),
          departmentId: id.optional(),
          level: z.enum(MAILBOX_ACCESS_LEVELS),
        })
        .refine((g) => [g.userId, g.teamId, g.departmentId].filter(Boolean).length === 1, 'Choose exactly one employee, team or department'),
    )
    .max(500),
});
export const mailboxSyncQuery = z.object({ full: z.enum(['true', 'false']).optional() });

export type LoginInput = z.infer<typeof loginSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type PermissionOverridesInput = z.infer<typeof permissionOverridesSchema>;
export type RolePermissionsInput = z.infer<typeof rolePermissionsSchema>;

// ── Conversations (Phase 3) ──
export const THREAD_VIEWS = ['inbox', 'mine', 'unassigned', 'unread', 'pending', 'waiting', 'followup', 'starred', 'snoozed', 'sent', 'archive', 'spam', 'trash', 'closed', 'overdue', 'all'] as const;
export type ThreadView = (typeof THREAD_VIEWS)[number];
export const CONVERSATION_STATUSES = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_FOR_CLIENT', 'PENDING_REPLY', 'FOLLOW_UP_REQUIRED', 'REPLY_NOT_NEEDED', 'CLOSED'] as const;
export const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;

const many = <T extends z.ZodTypeAny>(t: T) => z.preprocess((v) => (v === undefined || Array.isArray(v) ? v : [v]), z.array(t).max(50)).optional();

export const threadListQuery = z.object({
  view: z.enum(THREAD_VIEWS).default('inbox'),
  accountId: many(id),
  status: many(z.enum(CONVERSATION_STATUSES)),
  assigneeId: id.optional(),
  q: z.string().trim().max(200).optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  hasAttachments: z.enum(['true', 'false']).optional(),
  tagId: many(id),
  teamId: id.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const threadDetailQuery = z.object({ images: z.enum(['true', 'false']).optional() });
export const THREAD_ACTIONS = ['read', 'unread', 'star', 'unstar', 'archive', 'unarchive', 'spam', 'not-spam'] as const;
export const snoozeSchema = z.object({ until: z.coerce.date().nullable() });

// ── Compose & send (Phase 3) ──
export const DRAFT_MODES = ['NEW', 'REPLY', 'REPLY_ALL', 'FORWARD'] as const;
export const recipient = z.object({ address: email, name: z.string().trim().max(200).nullable().optional() });
const recipients = z.array(recipient).max(100);

export const createDraftSchema = z
  .object({
    mode: z.enum(DRAFT_MODES),
    threadId: id.optional(),
    /** Message being replied to / forwarded; defaults to the latest one in the thread. */
    messageId: id.optional(),
    /** Required for NEW. */
    emailAccountId: id.optional(),
  })
  .refine((d) => (d.mode === 'NEW' ? !!d.emailAccountId : !!d.threadId), 'NEW needs emailAccountId; replies and forwards need threadId');

export const updateDraftSchema = z
  .object({
    to: recipients.optional(),
    cc: recipients.optional(),
    bcc: recipients.optional(),
    subject: z.string().max(998).optional(),
    bodyHtml: z.string().max(2_000_000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const sendDraftSchema = z.object({
  /** Thread version the author last saw (collision check); omit for NEW mail. */
  baseThreadVersion: z.number().int().min(0).optional(),
  scheduledFor: z.coerce.date().nullable().optional(),
});

export const signatureSchema = z.object({
  name: z.string().trim().min(1).max(80),
  html: z.string().max(20_000),
  emailAccountId: id.nullable().optional(),
  isDefault: z.boolean().default(false),
});
export const templateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  subject: z.string().max(998).nullable().optional(),
  bodyHtml: z.string().max(200_000),
  /** private (only me) · department (my department) · company (everyone; needs conversation.read ALL). */
  sharing: z.enum(['private', 'department', 'company']).default('private'),
});

// ── Assignment & collaboration (Phase 5) ──
export const assignSchema = z
  .object({ assigneeId: id.nullable().optional(), teamId: id.nullable().optional(), departmentId: id.nullable().optional(), reason: z.string().trim().max(500).optional() })
  .refine((v) => !!(v.assigneeId || v.teamId || v.departmentId), 'Choose a person, team or department');

export const RULE_FIELDS = ['mailbox', 'from', 'fromDomain', 'to', 'subject', 'body'] as const;
export const RULE_OPS = ['is', 'contains', 'startsWith', 'endsWith', 'notContains'] as const;
export const ruleConditionsSchema = z.object({
  match: z.enum(['all', 'any']).default('all'),
  conditions: z.array(z.object({ field: z.enum(RULE_FIELDS), op: z.enum(RULE_OPS), value: z.string().trim().min(1).max(500) })).min(1).max(20),
});
export const assignmentRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    isEnabled: z.boolean().default(true),
    conditions: ruleConditionsSchema,
    targetType: z.enum(['USER', 'TEAM', 'DEPARTMENT']),
    targetUserId: id.nullable().optional(),
    teamId: id.nullable().optional(),
    departmentId: id.nullable().optional(),
    strategy: z.enum(['DIRECT', 'ROUND_ROBIN', 'LEAST_LOADED']).default('DIRECT'),
    setPriority: z.enum(PRIORITIES).nullable().optional(),
    /** Also open a sales lead for the conversation (owner = whoever the rule assigns), with a follow-up task. */
    createLead: z.boolean().default(false),
    leadServiceInterest: z.string().trim().max(80).nullable().optional(),
  })
  .refine(
    (r) => (r.targetType === 'USER' ? !!r.targetUserId && r.strategy === 'DIRECT' : r.targetType === 'TEAM' ? !!r.teamId : !!r.departmentId),
    'Choose the target that matches the rule type (a person is always assigned directly)',
  );
export const ruleOrderSchema = z.object({ ids: z.array(id).min(1).max(500) });
export const ruleTestSchema = z
  .object({
    threadId: id.optional(),
    sample: z.object({ accountId: id, from: z.string().max(320), to: z.string().max(2000).default(''), subject: z.string().max(998).default(''), body: z.string().max(20000).default('') }).optional(),
  })
  .refine((v) => !!v.threadId !== !!v.sample, 'Give either a conversation or a sample message');

export const noteSchema = z.object({ body: z.string().trim().min(1).max(10000) });
export const shareSchema = z.object({ canReply: z.boolean().default(false) });
export const tagSchema = z.object({ name: z.string().trim().min(1).max(40), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#64748b') });
export const presenceSchema = z.object({ state: z.enum(['viewing', 'composing', 'left']) });
export const BULK_ACTIONS = ['assign', 'unassign', 'read', 'unread', 'archive', 'spam', 'star', 'tag', 'untag'] as const;
export const bulkSchema = z.object({
  threadIds: z.array(id).min(1).max(500),
  action: z.enum(BULK_ACTIONS),
  assigneeId: id.nullable().optional(),
  teamId: id.nullable().optional(),
  departmentId: id.nullable().optional(),
  tagId: id.optional(),
});

// ── Status, SLA and notifications (Phase 6) ──

/** Statuses an employee can choose. NEW / ASSIGNED follow the assignment; "OPEN" reopens to whichever applies. */
export const MANUAL_STATUSES = ['IN_PROGRESS', 'WAITING_FOR_CLIENT', 'PENDING_REPLY', 'FOLLOW_UP_REQUIRED', 'REPLY_NOT_NEEDED', 'CLOSED', 'OPEN'] as const;
export const statusChangeSchema = z
  .object({
    status: z.enum(MANUAL_STATUSES),
    reason: z.string().trim().max(500).optional(),
    /** Turns the conversation into "Follow-up required" at this time unless the client writes first. */
    followUpAt: z.coerce.date().nullable().optional(),
  })
  .refine((v) => !v.followUpAt || !['CLOSED', 'REPLY_NOT_NEEDED'].includes(v.status), { path: ['followUpAt'], message: 'A closed conversation has no follow-up date' })
  .refine((v) => !v.followUpAt || v.followUpAt.getTime() > Date.now() - 60_000, { path: ['followUpAt'], message: 'The follow-up date must be in the future' });
export const prioritySchema = z.object({ priority: z.enum(PRIORITIES) });

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'HH:MM');
const daySpans = z.array(z.tuple([hhmm, hhmm])).max(6).default([]);
export const weeklyHoursSchema = z.object({ mon: daySpans, tue: daySpans, wed: daySpans, thu: daySpans, fri: daySpans, sat: daySpans, sun: daySpans });
export const calendarSchema = z.object({
  name: z.string().trim().min(1).max(100),
  timezone: z.string().min(1).max(64),
  weeklyHours: weeklyHoursSchema,
});
export const holidaySchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'), name: z.string().trim().min(1).max(100) });

export const SLA_ACTIONS = ['NOTIFY_ASSIGNEE', 'REMIND_ASSIGNEE', 'ALERT_MANAGER', 'ESCALATE'] as const;
export const slaPolicySchema = z.object({
  name: z.string().trim().min(1).max(100),
  departmentId: id.nullable().default(null),
  priority: z.enum(PRIORITIES).nullable().default(null),
  calendarId: id,
  isEnabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  steps: z
    .array(z.object({ afterBusinessMinutes: z.number().int().min(0).max(60 * 24 * 60), action: z.enum(SLA_ACTIONS), marksOverdue: z.boolean().default(false) }))
    .min(1)
    .max(10),
});

export const notificationListQuery = z.object({
  unread: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
  cursor: id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
/** Notification kinds the system sends today (others in the database arrive with later phases). */
export const NOTIFICATION_TYPES = [
  { type: 'ASSIGNED', label: 'Assigned to me', description: 'A conversation is assigned to you' },
  { type: 'REASSIGNED', label: 'Reassigned to me', description: 'A colleague hands a conversation over to you' },
  { type: 'CLIENT_REPLIED', label: 'Client replied', description: 'New mail arrives in a conversation assigned to you' },
  { type: 'NOTE_MENTION', label: 'Mentioned in a note', description: 'Someone @mentions you in an internal note' },
  { type: 'FOLLOW_UP_DUE', label: 'Follow-up due', description: 'A follow-up date you set has come' },
  { type: 'SLA_REMINDER', label: 'Reply reminders', description: 'A conversation of yours is waiting for a reply or about to be overdue' },
  { type: 'SLA_OVERDUE', label: 'Overdue (managers)', description: 'A conversation in your team or department is overdue' },
  { type: 'SLA_ESCALATED', label: 'Escalations', description: 'A conversation was escalated to management' },
  { type: 'ACCOUNT_NEEDS_REAUTH', label: 'Mailbox needs reconnecting', description: 'A mailbox you connected lost access and must be reconnected' },
  { type: 'LEAD_ASSIGNED', label: 'Lead assigned to me', description: 'A sales lead is created for you or handed over to you' },
  { type: 'TASK_ASSIGNED', label: 'Task assigned to me', description: 'A colleague gives you a task' },
  { type: 'TASK_DUE', label: 'Task due', description: 'One of your tasks reaches its due time' },
  { type: 'AUTOMATION', label: 'Automation messages', description: 'An automation rule tells you something, e.g. an AI draft is ready for you to check' },
] as const;
export type ActiveNotificationType = (typeof NOTIFICATION_TYPES)[number]['type'];
const notificationTypeEnum = z.enum(NOTIFICATION_TYPES.map((t) => t.type) as [ActiveNotificationType, ...ActiveNotificationType[]]);

export const notificationPrefsSchema = z.object({
  items: z.array(z.object({ type: notificationTypeEnum, inApp: z.boolean(), push: z.boolean() })).min(1).max(30),
});
export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(4).max(100) }),
});
export const pushUnsubscribeSchema = z.object({ endpoint: z.string().url().max(1000) });

// ───────────── CRM: contacts, companies, leads, tasks (Phase 7) ─────────────

export const CONTACT_TYPES = ['CLIENT', 'PROSPECT', 'VENDOR', 'PARTNER', 'CANDIDATE', 'OTHER'] as const;
export const LEAD_STATUSES = ['NEW', 'CONTACTED', 'FOLLOW_UP', 'INTERESTED', 'PROPOSAL_SENT', 'NEGOTIATION', 'WON', 'LOST'] as const;
export const OPEN_LEAD_STATUSES = ['NEW', 'CONTACTED', 'FOLLOW_UP', 'INTERESTED', 'PROPOSAL_SENT', 'NEGOTIATION'] as const;

/** Empty strings become null, so a cleared field is stored as "no value". */
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable()
    .optional();
const website = z
  .string()
  .trim()
  .max(300)
  .transform((v) => v || null)
  .refine((v) => v === null || /^(https?:\/\/)?[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(v), 'Enter a web address like example.com')
  .nullable()
  .optional();
const phone = z
  .string()
  .trim()
  .max(40)
  .transform((v) => v || null)
  .refine((v) => v === null || /^[+()\d\s.-]{5,40}$/.test(v), 'Use digits, spaces and + ( ) - only')
  .nullable()
  .optional();
const domain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .transform((v) => v.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '') || null)
  .refine((v) => v === null || /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v), 'Enter a domain like example.com')
  .nullable()
  .optional();

export const contactListQuery = z.object({
  q: z.string().trim().max(200).optional(),
  type: z.enum(CONTACT_TYPES).optional(),
  ownerId: id.optional(),
  companyId: id.optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const contactFieldsSchema = z.object({
  name: optText(200),
  phone,
  companyId: id.nullable().optional(),
  website,
  country: optText(80),
  type: z.enum(CONTACT_TYPES).optional(),
  ownerId: id.nullable().optional(),
  departmentId: id.nullable().optional(),
  notes: optText(10_000),
});
export const contactCreateSchema = contactFieldsSchema.extend({
  emails: z.array(email).min(1, 'Add at least one email address').max(20),
});
export const contactEmailSchema = z.object({ email, isPrimary: z.boolean().default(false) });
export const contactTagsSchema = z.object({ tagIds: z.array(id).max(50) });
export const mergeSchema = z.object({
  sourceContactIds: z.array(id).min(1).max(20),
  dryRun: z.boolean().default(false),
});
export const dismissDuplicateSchema = z.object({ aId: id, bId: id }).refine((v) => v.aId !== v.bId, 'Choose two different contacts');

export const companySchema = z.object({
  name: z.string().trim().min(1).max(200),
  domain,
  website,
  country: optText(80),
});
export const companyListQuery = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const money = z.coerce.number().min(0).max(999_999_999_999).nullable().optional();
const currency = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'Use a three-letter currency code, e.g. USD')
  .optional();

export const leadListQuery = z.object({
  status: z.enum(LEAD_STATUSES).optional(),
  ownerId: id.optional(),
  q: z.string().trim().max(200).optional(),
});
export const leadCreateSchema = z
  .object({
    /** From a conversation: the contact is the conversation's contact. */
    threadId: id.optional(),
    contactId: id.optional(),
    title: z.string().trim().min(1).max(300).optional(),
    ownerId: id.nullable().optional(),
    estimatedValue: money,
    currency,
    serviceInterest: optText(80),
  })
  .refine((v) => !!v.threadId || !!v.contactId, 'Choose a conversation or a contact');
export const leadUpdateSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  ownerId: id.nullable().optional(),
  estimatedValue: money,
  currency,
  serviceInterest: optText(80),
});
export const leadStatusSchema = z
  .object({
    status: z.enum(LEAD_STATUSES),
    note: optText(1000),
    lostReason: optText(500),
  })
  .refine((v) => v.status !== 'LOST' || !!v.lostReason, { message: 'Say why the lead was lost', path: ['lostReason'] });
export const leadSummaryQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const TASK_STATUSES = ['OPEN', 'DONE', 'CANCELLED'] as const;
export const taskListQuery = z.object({
  view: z.enum(['mine', 'created', 'all']).default('mine'),
  status: z.enum(TASK_STATUSES).optional(),
  threadId: id.optional(),
  leadId: id.optional(),
  contactId: id.optional(),
});
export const taskCreateSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: optText(5000),
  dueAt: z.coerce.date().nullable().optional(),
  assigneeId: id.optional(),
  threadId: id.nullable().optional(),
  leadId: id.nullable().optional(),
  contactId: id.nullable().optional(),
});
export const taskUpdateSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: optText(5000),
  dueAt: z.coerce.date().nullable().optional(),
  assigneeId: id.optional(),
});

// ───────────── IMAP / SMTP mailboxes (Phase 4) ─────────────

const host = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9.-]+$/, 'Enter a server name like imap.example.com');
const serverSchema = z.object({
  host,
  port: z.coerce.number().int().min(1).max(65535),
  security: z.enum(['TLS', 'STARTTLS']),
});
export const imapAccountSchema = z.object({
  email,
  displayName: z.string().trim().max(120).nullable().optional(),
  /** Usually the email address. */
  username: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(1000),
  imap: serverSchema,
  smtp: serverSchema,
});
export const imapConnectSchema = imapAccountSchema.extend({
  departmentId: id.nullable().optional(),
  syncDays: z.coerce.number().int().min(1).max(3650).optional(),
});

// ───────────── AI assistant (Phase 8) ─────────────

export const AI_TONES = ['professional', 'friendly', 'concise', 'formal', 'apologetic'] as const;
export const AI_CATEGORIES = ['SALES_ENQUIRY', 'EXISTING_CLIENT', 'SUPPORT', 'BILLING', 'PARTNERSHIP', 'JOB_APPLICATION', 'VENDOR', 'NEWSLETTER', 'SPAM', 'OTHER'] as const;
export const AI_SENTIMENTS = ['POSITIVE', 'NEUTRAL', 'NEGATIVE'] as const;
export const AI_URGENCIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;

export const suggestReplySchema = z.object({
  threadId: id,
  tone: z.enum(AI_TONES).default('professional'),
  instructions: z.string().trim().max(500).optional(),
});
export const rewriteSchema = z.object({
  /** The draft being edited: decides whether its mailbox allows AI. */
  draftId: id,
  text: z.string().trim().min(1).max(20_000),
  kind: z.enum(['grammar', 'tone']),
  tone: z.enum(AI_TONES).default('professional'),
});

// ───────────── Automation (Phase 8) ─────────────

/** Triggers with a working backend. No trigger or action sends email. */
export const AUTOMATION_TRIGGERS = ['MESSAGE_RECEIVED', 'LEAD_DETECTED', 'USER_ABSENT'] as const;
export const AUTOMATION_FIELDS = ['mailbox', 'from', 'fromDomain', 'to', 'subject', 'body', 'priority', 'status', 'category', 'urgency', 'sentiment', 'assigned', 'assigneeAbsent'] as const;
export const AUTOMATION_OPS = ['is', 'contains', 'notContains', 'startsWith', 'endsWith'] as const;
export const AUTOMATION_ACTIONS = ['assign', 'set_priority', 'set_status', 'add_tag', 'notify', 'create_task', 'create_lead', 'request_ai_draft', 'reassign_absent'] as const;
export const AUTOMATION_STATUSES = ['IN_PROGRESS', 'WAITING_FOR_CLIENT', 'PENDING_REPLY', 'FOLLOW_UP_REQUIRED', 'REPLY_NOT_NEEDED', 'CLOSED'] as const;

const automationCondition = z.object({
  field: z.enum(AUTOMATION_FIELDS),
  op: z.enum(AUTOMATION_OPS),
  value: z.string().trim().max(500),
});
export const automationActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('assign'),
    targetType: z.enum(['USER', 'TEAM', 'DEPARTMENT']),
    targetUserId: id.nullable().optional(),
    teamId: id.nullable().optional(),
    departmentId: id.nullable().optional(),
    strategy: z.enum(['DIRECT', 'ROUND_ROBIN', 'LEAST_LOADED']).default('ROUND_ROBIN'),
  }),
  z.object({ type: z.literal('set_priority'), priority: z.enum(PRIORITIES) }),
  z.object({ type: z.literal('set_status'), status: z.enum(AUTOMATION_STATUSES) }),
  z.object({ type: z.literal('add_tag'), tagId: id }),
  z.object({
    type: z.literal('notify'),
    to: z.enum(['assignee', 'team_leader', 'department_manager', 'users']),
    userIds: z.array(id).max(20).default([]),
    message: z.string().trim().min(1).max(300),
  }),
  z.object({
    type: z.literal('create_task'),
    title: z.string().trim().min(1).max(300),
    dueInHours: z.coerce.number().min(0).max(24 * 90).default(24),
    assignTo: z.enum(['assignee', 'user']).default('assignee'),
    userId: id.nullable().optional(),
  }),
  z.object({ type: z.literal('create_lead'), serviceInterest: z.string().trim().max(80).nullable().optional() }),
  z.object({ type: z.literal('request_ai_draft'), tone: z.enum(AI_TONES).default('professional'), instructions: z.string().trim().max(500).optional() }),
  z.object({ type: z.literal('reassign_absent'), to: z.enum(['pool', 'user']).default('pool'), userId: id.nullable().optional() }),
]);
export const automationRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).nullable().optional(),
    trigger: z.enum(AUTOMATION_TRIGGERS),
    /** Set: the rule only applies to this department's conversations / people. */
    departmentId: id.nullable().optional(),
    isEnabled: z.boolean().default(false),
    conditions: z.object({ match: z.enum(['all', 'any']).default('all'), conditions: z.array(automationCondition).max(20).default([]) }),
    actions: z.array(automationActionSchema).min(1, 'Add at least one action').max(10),
  })
  .superRefine((r, ctx) => {
    r.actions.forEach((a, i) => {
      const bad = (message: string) => ctx.addIssue({ code: 'custom', path: ['actions', i], message });
      if (a.type === 'reassign_absent' && r.trigger !== 'USER_ABSENT') bad('Reassigning an absent person’s conversations only works with the “Employee marked absent” trigger');
      if (a.type !== 'reassign_absent' && a.type !== 'notify' && r.trigger === 'USER_ABSENT') bad('With “Employee marked absent”, only reassign and notify actions are possible');
      if (a.type === 'assign' && (a.targetType === 'USER' ? !a.targetUserId : a.targetType === 'TEAM' ? !a.teamId : !a.departmentId)) bad('Choose who to assign to');
      if (a.type === 'notify' && a.to === 'users' && !a.userIds.length) bad('Choose who to notify');
      if (a.type === 'create_task' && a.assignTo === 'user' && !a.userId) bad('Choose who gets the task');
      if (a.type === 'reassign_absent' && a.to === 'user' && !a.userId) bad('Choose who takes over');
    });
    if (r.trigger === 'USER_ABSENT' && r.conditions.conditions.length) ctx.addIssue({ code: 'custom', path: ['conditions'], message: 'The absence trigger has no conditions; limit it with a department instead' });
  });
export const automationTestSchema = z.object({ threadId: id });

// ───────────── Analytics (Phase 9) ─────────────
export const ANALYTICS_RANGES = ['today', 'yesterday', 'week', 'month', 'custom'] as const;
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');
export const analyticsRangeQuery = z
  .object({
    range: z.enum(ANALYTICS_RANGES).default('week'),
    /** custom: local dates in the report time zone, both inclusive. */
    from: localDate.optional(),
    to: localDate.optional(),
    /** Narrows the figures to one department (always within the caller's own scope). */
    departmentId: id.optional(),
  })
  .superRefine((q, ctx) => {
    if (q.range !== 'custom') return;
    if (!q.from || !q.to) return ctx.addIssue({ code: 'custom', path: ['from'], message: 'A custom range needs from and to' });
    if (q.from > q.to) ctx.addIssue({ code: 'custom', path: ['to'], message: 'The end date is before the start date' });
    const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000;
    if (days > 366) ctx.addIssue({ code: 'custom', path: ['to'], message: 'At most one year at a time' });
  });
export const ANALYTICS_GROUPS = ['user', 'department', 'account'] as const;
export const analyticsGroupQuery = analyticsRangeQuery.and(z.object({ groupBy: z.enum(ANALYTICS_GROUPS).default('user') }));
export const workloadQuery = z.object({ groupBy: z.enum(['user', 'department']).default('user'), departmentId: id.optional() });
export const TREND_METRICS = ['incoming', 'outgoing', 'newThreads', 'replies', 'avgResponse', 'avgBusinessResponse', 'closed', 'slaBreaches'] as const;
export const trendsQuery = z.object({
  metric: z
    .string()
    .default('incoming,replies')
    .transform((s) => s.split(',').map((m) => m.trim()).filter(Boolean))
    .pipe(z.array(z.enum(TREND_METRICS)).min(1).max(4)),
  interval: z.enum(['day', 'week', 'month']).default('day'),
  /** How many intervals back from today (default 30 days, 12 weeks or 12 months). */
  periods: z.coerce.number().int().min(1).max(366).optional(),
  departmentId: id.optional(),
});
export const EXPORT_REPORTS = ['productivity', 'departments', 'accounts', 'daily', 'leads', 'workload'] as const;
export const exportQuery = analyticsRangeQuery.and(z.object({ report: z.enum(EXPORT_REPORTS) }));
