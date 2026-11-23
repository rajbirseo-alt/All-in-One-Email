# Runbook: load test

```bash
npm run db:local        # in another terminal
npm run build
node --env-file=.env tools/loadtest/run.mts
```

## What it does

1. **Builds the dataset** in the database `crm_load` (once, then reused): the target volume of the spec, **50 mailboxes × 2,000 emails a day**, for 2 days. That is 100,000 conversations and 200,000 messages. It also creates 100 employees in 10 departments and teams (2 admins, 10 managers, 10 team leaders, 78 staff) with mailbox grants.
2. **Starts the production builds** of the API (row-level security on) and the worker as separate processes, as on Render.
3. **Simulates 100 signed-in employees using the inbox at the same time** for 60 s (`LOAD_SECONDS`), after a 15 s warm-up that is not counted:
   - list a view (inbox, mine, pending, unassigned);
   - sidebar counts;
   - open a conversation;
   - sometimes search.
   Each employee pauses 2–8 s between actions (`LOAD_THINK_MS`).
4. **Delivers new mail** to an IMAP mailbox every 10 s, and times until it shows in the inbox through the API (IDLE → worker → database → API).

Diagnosis options:
- `LOAD_VUS`: number of employees.
- `LOAD_ONLY=list|counts|me`.
- `LOAD_NO_RLS=1`: the same load without the RLS context.
- `LOAD_DIAG=1`: per view and role, plus the slowest SQL.
- `LOAD_CPU_PROF=<dir>`: CPU profile of the API.

## SLOs (docs/07, Phase 10)

- Inbox list p95 < 300 ms.
- New mail visible < 60 s.

## Results, 2026-11-23

Developer laptop: Windows 11, 16 cores, PostgreSQL 17 embedded. The load generator, API, worker and database all ran on the same machine.

| Request | p50 | p95 | p99 |
|---|---|---|---|
| Inbox list | 120–125 ms | **302–322 ms** | 430–500 ms |
| Sidebar counts | 200–215 ms | 390–430 ms | 520–650 ms |
| Open conversation | 85–90 ms | 280–320 ms | 460–535 ms |
| Search | 1.0–1.1 s | 1.9 s | 2.2–2.7 s |

- About 18 requests a second, no errors.
- **New mail visible after 1.8–3.9 s.** The first mail after connecting a mailbox took 13 s, until the mailbox got its IDLE connection.
- The API process used about 0.7 of one CPU core.

**Verdict:**
- **New mail (< 60 s): met.**
- **Inbox list p95 (< 300 ms): at the limit.** It was 302–322 ms on this laptop, with everything sharing one machine.
- It must be confirmed on Render with the production plans: `crm-api` Standard, and the database plan chosen for production. If the target is missed there, run 2 API instances.

## What the load test found and fixed

1. **Row-level security policy:** checked per row with a function (mentions). 37 s → 30 ms per list; the per-caller values are now computed once per statement.
2. **Search under RLS:** could not use its indexes (`@@` and `LIKE` are not "leakproof"). 25 s → 1 s; the candidate lookup runs without the row filter, and the list query that uses it applies both filters.
3. **Search by part of a sender address:** an unindexed `EXISTS … LIKE`. It now uses a trigram index.
4. **Report rollup:** the reply-time query used a self-join (10+ min for 200k messages) and rebuilt empty weeks. **23 s** now. The "last two days" re-run moved from hourly to nightly, because it slowed the inbox every hour.
5. **IMAP IDLE:** one unreachable mail host held up the others. Newly connected mailboxes waited up to 60 s for IDLE, and mail in that gap waited for the 5-minute poll. Mailboxes now connect in parallel, are picked up within 15 s, and are caught up when IDLE starts.
6. **Per-request permission lookups:** now cached for 30 s, and dropped at once when a role or override changes.
7. **Rate limit per IP:** 300/min would have blocked a whole office behind one IP. It is now 3,000 per IP and 600 per employee.
