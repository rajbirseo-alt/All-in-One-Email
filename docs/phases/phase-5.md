# Phase 5 — Assignment and team collaboration

**Status:** built and tested locally, 2026-11-18. The real routing rules (who should get sales@, accounts@, hr@ … mail) still need to come from SEO Discovery, and the live check with real mailboxes waits on the Phase 2 setup.

## What works

| Area | Delivered |
|---|---|
| Manual assignment | Assign a conversation to a person, a team queue or a department queue, or unassign it; with an optional reason. The conversation row is locked while assigning, so 10 simultaneous assignments leave exactly one current assignee and a complete history. `NEW` becomes `ASSIGNED` (and back on unassign), with status history. The assignee gets a notification row (shown in Phase 6) |
| Who may assign to whom | By `conversation.assign` scope: company-wide (anyone), department (own department's people, teams and queue) or team (own teams and their members). Employees cannot assign |
| Routing rules | **Admin → Routing rules.** Rules are checked top to bottom; the first match wins. Conditions: mailbox, sender address, sender domain, recipient, subject, body (is / contains / does not contain / starts with / ends with; all or any). Targets: a person; or a team or department, either into the queue, **round-robin** or **least busy**. Round-robin and least busy skip people marked away and team members taken out of rotation; concurrent arrivals are serialised so the rotation stays fair. A rule can also set the priority |
| What gets routed | Only **new** incoming conversations: never the history imported when a mailbox is connected, never a conversation that was already assigned once, never sent-only threads. A client's reply stays with whoever has the conversation |
| Rule management | Admins manage and order all rules. Department managers see and edit only rules that route into their own department and cannot reorder the whole list. **Test the rules**: enter a sample email and see which rule matches and who would get it; nothing is assigned and the rotation does not move |
| Internal notes | Per conversation, visible only to colleagues and never part of an outgoing email (tested). `@mention` notifies the person and gives them access to that conversation, as the spec requires. Only the author can edit or delete a note |
| Sharing | Share a conversation with a colleague (read, optionally reply) and withdraw it |
| Tags | Coloured tags, managed by rule managers, applied by anyone who can see the conversation; the list can be filtered by tag |
| Bulk actions | Select conversations in the list: assign, mark read, archive (plus unassign, unread, spam, star, tag by API). Each conversation is permission-checked on its own; the result says how many were refused |
| Presence | "Priya is replying… / Rahul is viewing" on an open conversation, live over the existing event stream |
| Audit | Assignments (with method and rule), notes (ids only), shares, rule and tag changes |

## How it was verified

- **146 automated tests, all passing**, including **15 new end-to-end tests** with three mailboxes sales@, accounts@ and hr@, a Sales team (one person away, one out of rotation), Finance and HR:
  - imported history not routed;
  - sales@ round-robin across the two eligible people with priority set;
  - accounts@ invoices to the least-busy Finance person, other mail left in the queue;
  - hr@ to the HR person;
  - rule order deciding the winner (VIP rule moved first);
  - dry run not assigning or rotating;
  - department-manager limits;
  - **10 simultaneous assignments** consistent (exit criterion);
  - 6 simultaneous arrivals split 3/3 by round-robin;
  - team-leader assignment limits and history;
  - notes, mentions, access and the guarantee that notes never appear in sent mail;
  - shares, tags, bulk with partial refusal, presence.
- **Live run of the production builds** through the web proxy (8/8):
  1. a rule is created;
  2. new mail is routed **by the worker process** round-robin to both team members;
  3. it appears in their "Assigned to me";
  4. a manual reassignment;
  5. a note with a mention;
  6. "is replying" reaches a colleague's live stream;
  7. `/admin/rules` loads;
  8. `/inbox` loads.

## Needed from SEO Discovery

The exit criterion in [07](../07-milestones.md) is a live test with **the real routing rules**. Please send, per mailbox, who should receive new mail. For example:
- sales@ → Sales team, round-robin;
- accounts@ invoices → Finance;
- hr@ → HR manager;
- anything from a key client → their account manager.

Also tell me who is in which team and who should be out of rotation.

## Known gaps

- Notifications are stored but have no bell or email yet (Phase 6).
- Automatic reassignment when someone is away is Phase 8. Today, away people are skipped for *new* routing, but their existing conversations stay with them.
- An @mention gives the mentioned person access to that one conversation. That is the specified behaviour, but it means anyone who can see a conversation can widen who sees it by mentioning someone. If you want mentions limited (e.g. only people who can already see the mailbox), say so.
- Round-robin uses the assignment history under a lock instead of the separate `round_robin_cursors` table, which stays unused.
