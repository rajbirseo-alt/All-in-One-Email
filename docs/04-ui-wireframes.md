# 04 — UI Wireframes

Design language: neutral greys, one accent colour, Inter (or the system font) at 14px base, 8px spacing grid, light and dark themes. The layout is dense but readable, because employees here process high volumes of mail. Everything is keyboard-first: `j/k` next and previous, `e` archive, `r` reply, `a` reply-all, `f` forward, `c` compose, `/` search, `n` add note, `s` star, `⇧A` assign, `⇧S` set status.

Status colours: New = blue, Assigned = indigo, In Progress = amber, Waiting for Client = slate, Pending Reply = orange, Follow-up = violet, Reply Not Needed = grey, Closed = green. Overdue gets a red left border and a clock icon. Colour is never the only signal; there is always a text label as well.

## A. Unified inbox (three columns)

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ ◧ SEO Discovery CRM   [ 🔍 Search all mail… (/)                     ]   🔔3   ◐   (RS ▾)      │
├───────────────────┬──────────────────────────────┬───────────────────────────────────────────┤
│ ✉ Compose         │ Pending Reply · 42      ⚙ ⇅  │ Re: SEO audit for acme.co      ★  ⋯       │
│                   │ [Account ▾][Dept ▾][Assignee▾]│ sales@seodiscovery · #seo #audit          │
│ VIEWS             │ [Status ▾][Priority ▾][Tags ▾]│ ┌───────────────────────────────────────┐ │
│  All Inboxes  128 │ [Date ▾]  [+ filter]  Clear   │ │Status [Pending Reply ▾] Prio [High ▾] │ │
│  My Inbox      12 │──────────────────────────────│ │Assignee [Aman K ▾]  SLA: 1h 12m left  │ │
│  Assigned to Me 9 │☐ ● John Carter       10:42   │ │Follow-up [—]   [Reply not needed]     │ │
│  Unassigned    17 │  SEO audit for acme.co  🔴    │ └───────────────────────────────────────┘ │
│  Unread        31 │  Hi team, following up on…    │ ▸ Summary (AI): Client wants audit by Fri…│
│  Pending Reply 42 │  sales@ · Aman K · HIGH  📎   │                                           │
│  Waiting Client 8 │──────────────────────────────│ John Carter <john@acme.co>   Mon 10:42    │
│  Follow-up      5 │☐   Priya S           09:15   │ to sales@seodiscovery.com                 │
│  Closed           │  Invoice #2231                │ Hi team, following up on the proposal…    │
│  Sent             │  accounts@ · Unassigned       │ [📎 brief.pdf 240KB ⬇]                     │
│  Drafts         2 │──────────────────────────────│ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─   │
│  Archive          │☐   Meera (HR)        Yest    │ 🟨 Internal note · Rohit (Manager) 11:02  │
│  Spam             │  Interview schedule           │   @Aman please send the revised quote     │
│  ⏰ Overdue      3 │  hr@ · Meera · Waiting        │ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─   │
│                   │                               │ ⚠ Neha is replying to this conversation   │
│ ACCOUNTS          │ (virtualised list; infinite   │ ┌───────────────────────────────────────┐ │
│  ● sales@      ok │  scroll; bulk bar appears on  │ │[Reply][Note]  From: sales@seodiscovery│ │
│  ● accounts@   ok │  selection: Assign · Status · │ │To: john@acme.co  [Cc][Bcc]            │ │
│  ▲ info@  reauth  │  Tag · Archive · Mark read)   │ │ B I U • 1. 🔗 📎 {Template▾} ✨AI ▾   │ │
│  ● hr@         ok │                               │ │                                       │ │
│ TEAM INBOXES      │                               │ │ -- Signature: Aman K, Sales ▾          │ │
│  Sales Team    14 │                               │ │ [Send ▾] (Send & close / Send & wait) │ │
│  Finance        3 │                               │ └───────────────────────────────────────┘ │
│ TAGS              │                               │ History ▸ assigned by Rule "sales@" 10:42 │
└───────────────────┴──────────────────────────────┴───────────────────────────────────────────┘
```

Notes:
- The **"From:" field is fixed to the thread's mailbox** on reply. It can only be chosen for a new compose, and the dropdown lists only mailboxes where the user has `REPLY` access.
- The **Note** tab uses a yellow editor so it can't be confused with a reply. Notes always render in yellow and are never placed inside the reply editor.
- The **AI ✨** menu offers Suggest reply, Improve grammar, Make more formal/friendly and Summarise. The output goes into the editor as editable text with an "AI draft — review before sending" banner.
- The collision banner comes from presence data. If the send still collides, a modal shows the new message(s) with the choices **Send anyway / Edit reply / Discard**.
- Below 1024px the layout collapses to two columns (list | thread). On mobile it is a single column with a back button, and the sidebar becomes a drawer.

## B. Connect email account

```
┌ Connect a mailbox ───────────────────────────────────────────────┐
│  [ G  Google Workspace / Gmail ]   [ ⊞ Microsoft 365 / Outlook ] │
│  [ ✉  Other provider (IMAP/SMTP) ]                               │
└──────────────────────────────────────────────────────────────────┘
IMAP form:
  Email [            ]  Username [            ]  Password [••••••]
  Incoming  host [imap.domain.com] port [993] security [TLS ▾]
  Outgoing  host [smtp.domain.com] port [465] security [TLS ▾]
  Presets: [Zoho] [GoDaddy] [Hostinger] [cPanel] [Yahoo] [iCloud]
  [Test connection]
     ✓ DNS resolved  ✓ TLS ok  ✓ IMAP login  ✓ 14 folders  ✗ SMTP auth failed: 535 …
  Department [Sales ▾]   Sync mail from [Last 90 days ▾]   [Save & start sync]
```

## C. Account health (Settings → Mailboxes)

```
 Mailbox              Provider   Status        Last sync   Lag    Errors(24h)  Actions
 sales@seod…          Gmail      ● Active      10:44:02    4s     0            Folders · Access · ⋯
 info@seod…           Microsoft  ▲ Reauth      Yesterday   —      12           [Reconnect]
 support@client.in    IMAP       ● Syncing 63% 10:40:10    —      0            Pause
```

## D. Dashboards

```
CMO / Super Admin  [Today|Yesterday|Week|Month|Custom ▾]   Dept [All ▾]
┌Accounts 9┐┌Incoming 1,240┐┌Unread 311┐┌Unassigned 17┐┌Pending 42┐┌Overdue 3┐┌Avg 1st reply 38m┐
┌ Response time by department (bar) ┐┌ Incoming vs replied (line, 30d) ┐
┌ Employee productivity table: name · assigned · replied · avg response · overdue · closed ┐
┌ Leads funnel New→Won ┐┌ Account health list ┐

MD — the same range picker, fewer tiles: Total · Pending · Unassigned · Overdue · Leads,
     department table, workload bars, monthly trend. No configuration controls.

Employee — My assigned · New today · Pending replies · Follow-ups due · Overdue · Closed ·
     My avg response time vs team median; "Next up" list sorted by SLA due.
```

## E. Admin screens (all fully functional, each built in its own phase)
- Users & roles: user table, invite, role select, a permission matrix (permission × scope) per role, and overrides per user.
- Assignment rules: an ordered list with drag reorder, a rule builder (IF field op value [AND/OR] THEN assign to user/team/dept via direct/round-robin/least-loaded), and a "Test rule" panel.
- SLA: policies per department and priority, step timeline editor (0m notify → 30m remind → 2h manager → 24h escalate), working-hours calendar and holiday list.
- Automation: trigger → conditions → actions builder, an enable toggle and the run log.
- Audit log: a filterable table with a before/after JSON diff drawer.

Rule from the spec: **a control only appears in the UI once its backend exists.** Screens are released phase by phase, and the navigation hides modules that are not yet built. Nothing is shown disabled as a placeholder.
