# Phase 6 — Status, SLA and notifications

**Status:** built and tested locally, 2026-11-18. SEO Discovery's working hours, holidays and reply targets per department still need to be entered (Admin → SLA & working hours). The milestone also asks for a push notification received on a real desktop and a real Android phone; that needs the VAPID keys set on Render (see below).

## What works

| Area | Delivered |
|---|---|
| Status | Statuses: New, Assigned, In progress, Waiting for client, Pending reply, Follow-up, Reply not needed, Closed. New and Assigned follow the assignment; employees choose the others (with `conversation.status` in their scope). **Reopen** returns a conversation to New or Assigned. Every change is kept in the status history (who, when, why) and audited |
| Re-assessment on new mail | A client's new message reopens a *waiting / follow-up / closed / reply-not-needed* conversation to **Pending reply** (or New if nobody has it) and tells the assignee ("New reply"). Our reply turns an open conversation into **Waiting for client**. Mail imported when a mailbox is connected is never re-assessed |
| Follow-up dates | "Follow up on …": the conversation waits for the client and becomes **Follow-up** at that time, with a notification. A client reply before then cancels it |
| Priority | Low / Normal / High / Urgent, changeable in the conversation; it can select a different SLA policy |
| Working hours | **Admin → SLA & working hours.** Calendars with a time zone, opening hours per weekday (split hours for a lunch break are allowed) and holidays |
| SLA policies | Per department and/or priority, plus one default. The most specific wins: department + priority, then department, then priority, then default. Each policy has up to 10 steps, counted in **working minutes** from the client's unanswered email: *tell the assignee → remind → alert the team leader or department manager → escalate to the MD*. One step marks the conversation **overdue** |
| SLA clock | Runs only while a reply is owed: it starts with the client's unanswered email, stops when we reply or the status is Waiting for client / Reply not needed / Closed, and starts a new cycle with the client's next email. Each step fires **once per cycle**, even with several workers or a restart. Steps that were already due when a policy or calendar was changed are recorded without alerting anyone. Imported history never starts a clock |
| Overdue | **Overdue** view and count in the inbox; red edge and "Overdue 2 h" badge in the list; "Reply due in 40 min" before that; the conversation shows the deadline and each step's time |
| Who gets SLA alerts | Assignee steps: the assignee, or the team leader / department manager for a conversation still in a queue. Manager step: the team leader of the conversation's team, otherwise the department manager. Escalation: everyone with the MD or Super Admin role |
| Notifications | **Bell** in the header with unread count, live updates, mark read / mark all read; clicking opens the conversation. Kinds sent today: assigned, reassigned, client replied, mentioned in a note, follow-up due, reply reminders, overdue (managers), escalations, mailbox needs reconnecting |
| Preferences | **Notifications** (under *You*): per kind, on/off for the bell and for devices |
| Browser push | Turn on per device (Chrome, Edge, Firefox on desktop and Android; Safari on macOS; iPhone after "Add to Home Screen"). Payloads are end-to-end encrypted (Web Push, VAPID). The server only sends to the browser vendors' push services, and forgets devices the push service reports as gone. Pushes are sent by the worker |

## How it was verified

- **182 automated tests, all passing**: 146 before this phase plus 36 new ones. Of the new tests, 15 are unit tests:
  - working-hours clock: weekends, holidays, lunch break, mail before opening time, hours until midnight, a calendar without hours;
  - time zones: India, a New York calendar across the daylight-saving change, the same instant in London vs India;
  - policy matching.

  The other 21 are end-to-end tests with fixed dates. They cover:
  - an email on Friday 17:30 IST being due Tuesday 10:30 IST over a weekend and a Monday holiday;
  - each step firing once at its working time, and no duplicates when the sweep runs twice;
  - the overdue view respecting access;
  - our reply stopping the clock and the client's answer starting a new cycle;
  - queue conversations alerting the team leader;
  - calendar changes not alerting retroactively;
  - status changes with history and audit;
  - follow-up dates;
  - priority switching policies;
  - admin permissions for department managers;
  - notifications only ever visible to their owner;
  - live bell updates only on the owner's stream;
  - preferences;
  - push encrypted with a VAPID signature, foreign endpoints refused, and removed devices forgotten.
- **Live run of the production builds** through the web proxy (12/12):
  - a calendar and a policy were saved;
  - a new email was synced by the worker, assigned, and given its deadline;
  - **the worker's sweep** sent the first reminder;
  - the bell updated live through the proxy;
  - status changed with history;
  - the SLA steps showed;
  - the push config was available and a foreign endpoint was refused;
  - the `/admin/sla`, `/settings/notifications` and `/inbox` pages loaded, and the service worker was served.
- **Not yet verified:** a push shown on a real desktop and on a real Android phone. That needs the keys below on Render and someone to press "Turn on for this device".

## Needed from SEO Discovery

1. **Working hours** per office (days, hours, lunch break if the clock should stop) and the **holiday list** for 2026–27.
2. **Reply targets** per department, e.g. Sales: remind after 30 min, overdue at 2 working hours, escalate after 1 working day; HR: overdue after 1 working day.
3. To switch on browser push, run `npx web-push generate-vapid-keys` once and put the result on the **crm-api** service on Render. The worker copies them automatically.
   - `VAPID_PUBLIC_KEY`
   - `VAPID_PRIVATE_KEY`
   - `VAPID_SUBJECT`, e.g. `mailto:it@seodiscovery.com`

## Known gaps

- **Email notifications.** The database has an "email" preference, but nothing sends notification emails yet, so the option is not shown.
- **Time remaining.** The "Reply due in …" badge counts clock time. The deadline itself is computed in working time.
- **Snoozing** does not pause the SLA clock.
- **Department calendars.** A department's calendar field is not used; each policy names its own calendar.
- **Automatic reassignment.** Reassigning when someone is away, and the rules engine that acts on SLA steps, come in Phase 8.
- **Unrelated security alerts.** `npm audit` reports advisories in existing dependencies (nodemailer, zod, postcss and others). They are unrelated to this phase and are left for the Phase 10 hardening pass.
