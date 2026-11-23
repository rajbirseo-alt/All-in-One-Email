/**
 * Fixed synthetic dataset for the load test and the restore drill: departments, teams, employees
 * of every role, mailboxes with department grants, conversations and messages (ids prefixed lt-).
 * Re-running replaces it. Employees: 1–2 Super Admin, 3–12 department managers, 13–22 team
 * leaders, the rest Sales/Employee; ~70% of conversations assigned, half in a team queue.
 */
export interface SeedOptions {
  domain: string;
  users: number;
  mailboxes: number;
  threads: number;
  days: number;
}

export function seedSql(o: SeedOptions): string {
  return `
    DELETE FROM email_threads WHERE id LIKE 'lt-th-%';
    DELETE FROM email_account_access WHERE id LIKE 'lt-%';
    DELETE FROM sessions WHERE "userId" LIKE 'lt-user-%';
    DELETE FROM team_members WHERE "teamId" LIKE 'lt-team-%';
    DELETE FROM email_accounts WHERE id LIKE 'lt-acc-%';
    UPDATE departments SET "managerId" = NULL WHERE id LIKE 'lt-dept-%';
    DELETE FROM teams WHERE id LIKE 'lt-team-%';
    DELETE FROM users WHERE id LIKE 'lt-user-%';
    DELETE FROM departments WHERE id LIKE 'lt-dept-%';

    INSERT INTO departments (id, name, slug, "createdAt", "updatedAt")
      SELECT 'lt-dept-' || d, 'Load Dept ' || d, 'load-dept-' || d, now(), now() FROM generate_series(1, 10) d;
    INSERT INTO users (id, email, name, "roleId", status, "departmentId", "createdAt", "updatedAt")
      SELECT 'lt-user-' || u, 'load.user' || u || '@${o.domain}', 'Load User ' || u,
             (SELECT id FROM roles WHERE key = CASE WHEN u <= 2 THEN 'SUPER_ADMIN' WHEN u <= 12 THEN 'DEPT_MANAGER' WHEN u <= 22 THEN 'TEAM_LEADER' WHEN u % 2 = 0 THEN 'SALES' ELSE 'EMPLOYEE' END),
             'ACTIVE', CASE WHEN u <= 2 THEN NULL ELSE 'lt-dept-' || (((u - 1) % 10) + 1) END, now(), now()
      FROM generate_series(1, ${o.users}) u;
    UPDATE departments d SET "managerId" = (SELECT u.id FROM users u JOIN roles r ON r.id = u."roleId" WHERE r.key = 'DEPT_MANAGER' AND u."departmentId" = d.id LIMIT 1) WHERE d.id LIKE 'lt-dept-%';
    INSERT INTO teams (id, name, "departmentId", "leaderId", "createdAt")
      SELECT 'lt-team-' || d, 'Load Team ' || d, 'lt-dept-' || d,
             (SELECT u.id FROM users u JOIN roles r ON r.id = u."roleId" WHERE r.key = 'TEAM_LEADER' AND u."departmentId" = 'lt-dept-' || d LIMIT 1), now()
      FROM generate_series(1, 10) d;
    INSERT INTO team_members ("teamId", "userId") SELECT 'lt-team-' || (((u - 1) % 10) + 1), 'lt-user-' || u FROM generate_series(23, ${o.users}) u;
    INSERT INTO email_accounts (id, provider, "emailAddress", "displayName", "departmentId", status, "connectedById", "createdAt", "updatedAt")
      SELECT 'lt-acc-' || a, 'IMAP', 'box' || a || '@load.example', 'Load box ' || a, 'lt-dept-' || (((a - 1) % 10) + 1), 'PAUSED', 'lt-user-1', now() - interval '30 days', now()
      FROM generate_series(1, ${o.mailboxes}) a;
    INSERT INTO email_account_access (id, "emailAccountId", "departmentId", level, "createdAt")
      SELECT 'lt-acc-grant-' || a, 'lt-acc-' || a, 'lt-dept-' || (((a - 1) % 10) + 1), 'REPLY', now() FROM generate_series(1, ${o.mailboxes}) a;

    INSERT INTO email_threads (id, "emailAccountId", subject, "normalizedSubject", snippet, status, priority, "assigneeId", "teamId", "departmentId",
                               "messageCount", "unreadCount", "firstMessageAt", "lastMessageAt", "lastInboundAt", "lastOutboundAt", "awaitingReplySince", "slaDueAt", "createdAt", "updatedAt")
      SELECT 'lt-th-' || i, 'lt-acc-' || a, 'Enquiry about service ' || i, 'enquiry about service ' || i, 'Hello, we would like to know more about ' || i,
             (ARRAY['NEW','ASSIGNED','IN_PROGRESS','WAITING_FOR_CLIENT','PENDING_REPLY','CLOSED','CLOSED','IN_PROGRESS'])[1 + i % 8]::"ConversationStatus",
             (ARRAY['LOW','NORMAL','NORMAL','NORMAL','HIGH','URGENT'])[1 + i % 6]::"Priority",
             CASE WHEN r < 0.7 THEN 'lt-user-' || (d + 10 * (3 + i % 7)) END,
             CASE WHEN r < 0.5 THEN 'lt-team-' || d END,
             'lt-dept-' || d, 2, CASE WHEN i % 3 = 0 THEN 1 ELSE 0 END, t - interval '1 hour', t, t - interval '1 hour', CASE WHEN i % 2 = 0 THEN t END,
             CASE WHEN i % 2 = 1 THEN t - interval '1 hour' END, CASE WHEN i % 2 = 1 THEN t + interval '2 hours' END, t, t
      FROM (SELECT i, ((i - 1) % ${o.mailboxes}) + 1 AS a, (((i - 1) % ${o.mailboxes}) % 10) + 1 AS d, now() - random() * interval '${o.days} days' AS t, random() AS r
            FROM generate_series(1, ${o.threads}) i) x;
    INSERT INTO email_messages (id, "threadId", "emailAccountId", "providerMessageId", "internetMessageId", direction, "fromAddress", "fromName", "toRecipients", subject, snippet, "bodyText", "receivedAt", "createdAt", "updatedAt")
      SELECT 'lt-m1-' || t.id, t.id, t."emailAccountId", 'mid:<' || t.id || '-1@load>', '<' || t.id || '-1@load>', 'INBOUND', 'client' || (length(t.id) % 97) || '@client.example', 'Client',
             '[]'::jsonb, t.subject, t.snippet, repeat('We would like a proposal for search engine optimisation and paid ads. ', 8) || t.id, t."firstMessageAt", now(), now()
      FROM email_threads t WHERE t.id LIKE 'lt-th-%';
    INSERT INTO email_messages (id, "threadId", "emailAccountId", "providerMessageId", "internetMessageId", direction, "fromAddress", "fromName", "toRecipients", subject, snippet, "bodyText", "receivedAt", "createdAt", "updatedAt")
      SELECT 'lt-m2-' || t.id, t.id, t."emailAccountId", 'mid:<' || t.id || '-2@load>', '<' || t.id || '-2@load>',
             CASE WHEN t."lastOutboundAt" IS NOT NULL THEN 'OUTBOUND' ELSE 'INBOUND' END::"MessageDirection", 'reply@load.example', 'Agency',
             '[]'::jsonb, 'Re: ' || t.subject, 'Thanks for your message', repeat('Thank you for reaching out, here is our proposal. ', 8), t."lastMessageAt", now(), now()
      FROM email_threads t WHERE t.id LIKE 'lt-th-%';
    ANALYZE;`;
}
