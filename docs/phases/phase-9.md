# Phase 9 — Dashboards and reports

**Status:** built and tested locally, 2026-11-23.

One thing is still open: **the definitions need sign-off** (below), for example whether reply time is counted in working hours or clock hours. The dashboards show both, so either choice works without rebuilding anything.

## What works

### Dashboard (menu: Dashboard)

**Who sees what**
- **Overview** and **Management summary**: for people with company, department or team report access.
- **My work**: for everyone with report access.
- The figures follow the `report.read` scope:
  - Super Admin, CMO and MD: the whole company.
  - Department manager: their departments.
  - Team leader: their teams and the people in teams they lead.
  - Employee: their own work.
- This is enforced on the server. Choosing another department in the filter cannot widen it.

**Filters** (one row above the charts)
- Period: Today, Yesterday, Last 7 days, Last 30 days, or custom dates (up to a year).
- Department.
- **Reply times in working hours or clock hours.**
- **Export CSV**, with permission `report.export`.

**Overview**
- **Tiles:** mailboxes, incoming, unread, unassigned, waiting for reply, overdue, average first reply.
- **Average reply time by department** (bar chart).
- **Incoming vs replied** over the last 30 days. The line chart shows each day's values on hover, and has a table view.
- **Employee productivity:** for each person, open, waiting and overdue (now), and incoming, replies, average reply, average first reply and closed (in the period).
- **Lead funnel** for leads created in the period: how many reached each stage, won, lost, value won and conversion.
- **Mailbox health:** status, last sync and failed syncs in the last 24 hours.
- **AI usage** (company-wide only): analyses and tokens in the period.

**Management summary**
- Tiles: incoming, waiting, unassigned, overdue, new leads, leads won.
- A department table.
- Open conversations by department.
- The last 12 months, month by month.
- There are no configuration controls on this view.

**My work**
- Assigned to me, newly assigned, waiting for my reply, follow-ups and tasks due, overdue, closed.
- My average reply time against the team median.
- **Next up:** the conversations waiting for my reply, soonest SLA deadline first, each linking to the inbox.

**"Right now" figures** (waiting, overdue, unassigned, unread) use exactly the same conditions as the inbox views, so the two always agree.

### How the figures are built

- **Every reply is recorded** from the first unanswered client message to the reply: in clock minutes, and in working minutes of the department's SLA calendar (else the default policy's).
- **Hourly totals** are kept per mailbox, department, team and person, in the report time zone (`REPORT_TIMEZONE`, default Asia/Kolkata). Days start at midnight India time, not UTC.
- **Update schedule** (worker):
  - every 10 minutes for the last 3 hours;
  - every night (02:15 India time) for the last 2 days, which catches later changes such as a conversation reassigned or marked spam.
  - The very first run builds the past 400 days.
- **Repeatable:** each run replaces its hours completely, so it can be repeated at any time. Two runs never overlap, across worker instances too.
- **Kept after purge:** when a disconnected mailbox's mail is deleted after 120 days, its figures stay.
- **Rebuild:** `npm run cli:analytics-rebuild -w @crm/api -- --days 400`. Needed after changing `REPORT_TIMEZONE`, or a calendar that should apply to past figures.
- **"Updated … ago"** on each dashboard shows when the last update finished.

**CSV export**
- Reports: employee productivity, departments, mailboxes, day by day, lead funnel, open workload.
- Same scope as the dashboard.
- UTF-8, so Excel shows names correctly.
- Cells that a spreadsheet would run as a formula are made safe.
- Every export is recorded in the audit log.

## Definitions to sign off

| Figure | Current definition |
|---|---|
| Reply time | From the first unanswered client message in a conversation to our next outgoing message. Several client messages before a reply count once, from the first. |
| Working-hours reply time | The same, counting only the open hours of the department's SLA calendar (holidays excluded) |
| First reply | The first reply in a conversation |
| Who gets credit | Incoming mail, new conversations and SLA breaches: the conversation's assignee. Outgoing mail and replies: whoever sent it in the CRM, else the assignee (for example, replied from Gmail directly). Closed: whoever closed it. |
| Department | The conversation's department, else its mailbox's |
| Last 7 / 30 days | Including today |
| Not counted | Spam and trash |

## How it was verified

**Automated tests: 14 new end-to-end tests**, against a real PostgreSQL with a fixed week of data written straight into the tables (Mon 3 – Sun 9 Feb 2025, India time).

1. **The exit criterion: numbers reconcile with direct SQL.**
   - Incoming, outgoing, new conversations, closed and SLA breaches from the dashboard equal counts taken directly on the mail, status and SLA tables.
   - Reply times equal times worked out independently from the stored messages:
     - 60, 1,020 and 2,040 minutes;
     - average 1,040 clock minutes and 60 working minutes.
   - The live counts match the inbox definitions.
2. **Time zone:** a message at 00:10 India time on Monday (still Sunday in UTC) counts on Monday.
3. **Per person, per department and per mailbox** totals and averages.
   - A reply sent outside the CRM is credited to the assignee.
   - Unassigned mail appears as "Nobody assigned".
4. **Workload** (open / waiting / overdue) per person and per department.
5. **Lead funnel:** stages reached, won and lost, value won, conversion.
6. **CSV:**
   - one row per local day, adding up to the dashboard;
   - correct file name;
   - audited;
   - a name like `=HYPERLINK(…)` is neutralised;
   - refused without `report.export`.
7. **Scope:**
   - a department manager sees only their department, even when asking for another;
   - a team leader sees their team and their people;
   - an employee sees only their own figures.
8. **Rollup:**
   - running it again gives the same numbers;
   - a purged mailbox keeps its figures;
   - the scheduled run covers the current hours and records when it finished.
9. **My work:** own average against the team median, and the next conversation to answer.
10. **Bad periods are refused:** end before start, more than a year, or a custom period without dates.

All earlier tests still pass: **248 tests in total**.

**Not checked by eye:** the dashboard compiles and its data is tested, but it has not been looked at in a browser yet.

## Needed from SEO Discovery

1. **Sign-off of the definitions** above, especially:
   - working hours or clock hours as the headline reply time;
   - who gets credit for a reply sent outside the CRM.
2. **Confirm the report time zone** (Asia/Kolkata unless some teams work in another zone).

## Known gaps

- **Up to 10 minutes behind.** Figures for today can lag by up to 10 minutes. Each dashboard shows when they were last updated.
- **Credit can freeze.** Attribution follows the conversation's assignee at the time of each update. A conversation reassigned more than two days later keeps its old credit unless the figures are rebuilt.
- **Fixed trend window.** The Overview trend always shows the last 30 days, whatever period is chosen above it.
- **No scheduled emailing of reports.** Reports can be exported, but they are not sent automatically.
