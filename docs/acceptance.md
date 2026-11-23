# Acceptance criteria (spec §21): status

The spec says the application is production-ready only when all 18 are met, and that no integration counts as complete until it has been tested with a real, authorised email account. Below:
- what is built;
- what is proven by automated tests (against real PostgreSQL and local stand-ins for the mail providers);
- what still needs a real account.

**Sign-off** is SEO Discovery's, after the real-account check.

| # | Criterion | Built and tested | Still needed | Sign-off |
|---|---|---|---|---|
| 1 | Multiple Gmail accounts can be connected | ✅ Phase 2 (OAuth, sync, push, reconnect) | ⏳ ≥2 real Google Workspace / Gmail mailboxes (06 §6 checklist). Google OAuth verification / CASA for consumer Gmail | ☐ |
| 2 | Multiple Microsoft 365 accounts can be connected | ✅ Phase 2 (Graph, subscriptions, reconnect) | ⏳ ≥2 real Microsoft 365 mailboxes; Entra app consent | ☐ |
| 3 | Custom domain email accounts can be connected | ✅ Phase 4 (IMAP/SMTP with presets) | ⏳ ≥2 real custom-domain mailboxes (e.g. Zoho, the website host) | ☐ |
| 4 | IMAP-supported email providers can be connected | ✅ Phase 4 (connection test, IDLE, APPEND to Sent) | ⏳ Same real-host check as #3 | ☐ |
| 5 | All authorised emails appear in one unified inbox | ✅ Phase 3 (views, filters, search, live updates) | ⏳ Visual check by employees | ☐ |
| 6 | Users can reply from the correct original account | ✅ Phase 3/4: send through the conversation's own mailbox; collision check | ⏳ Reply in each real mailbox type | ☐ |
| 7 | Conversations remain correctly threaded | ✅ Provider thread ids, then In-Reply-To/References, then subject + participants | ⏳ Check at the recipient (Gmail, Outlook) | ☐ |
| 8 | Attachments can be viewed and downloaded | ✅ Phase 3. **Phase 10:** virus scanning and encrypted storage | ⏳ Real PDFs/images/zips; ClamAV running in production | ☐ |
| 9 | Emails can be assigned and reassigned | ✅ Phase 5 (manual, bulk, rules, round-robin, least-loaded, history) | ⏳ The real routing rules | ☐ |
| 10 | Role-based permissions work correctly | ✅ Phase 1 role × endpoint matrix. **Phase 10:** also enforced in PostgreSQL (RLS) | — | ☐ |
| 11 | Pending and overdue conversations are tracked | ✅ Phase 6 (working-hours SLA, steps, escalation) | ⏳ Working hours, holidays and SLA targets | ☐ |
| 12 | Notifications reach assigned employees | ✅ Phase 6 (bell, browser push) | ⏳ VAPID keys; check on real devices | ☐ |
| 13 | CRM contacts and leads are created correctly | ✅ Phase 7 (matching, duplicates and merge with undo, lead pipeline) | ⏳ Lead stages and the sales roster | ☐ |
| 14 | AI suggestions require human approval | ✅ Phase 8 (drafts only; a test proves no code path sends) | ⏳ OpenAI key and DPA; the accuracy set of ~200 emails | ☐ |
| 15 | Management reports show accurate information | ✅ Phase 9 (numbers reconcile with direct SQL on a fixed dataset) | ⏳ Definitions signed off | ☐ |
| 16 | Synchronisation works reliably after reconnecting | ✅ Phases 2/4 (cursors, idempotent ingest, no duplicates after reconnect) | ⏳ The real-mailbox revoke/reconnect test (06 §6 item 7) | ☐ |
| 17 | No unauthorised employee can access restricted emails | ✅ Guard + query layer + **PostgreSQL RLS (Phase 10)**. Tested with the app filter removed on purpose | ⏳ External penetration test | ☐ |
| 18 | All important actions are recorded in audit logs | ✅ Append-only audit log (sign-ins, sends, assignments, status, merges, exports, AI use, permissions, blocked files) | ⏳ Decide whether viewing a conversation or downloading a file must be logged (not logged today) | ☐ |
