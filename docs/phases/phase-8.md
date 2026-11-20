# Phase 8 — AI assistant and automation

**Status:** built and tested locally, 2026-11-20, against a local stand-in for the OpenAI API.

Two things are still open:
- **Switching AI on.** Until `OPENAI_API_KEY` is set on Render, the AI features stay hidden and automation works without them.
- **Accuracy evaluation.** The exit criterion asks for an accuracy check on about 200 real, consented emails. That needs the key and the email set.

## What works

### AI assistant

**Where it runs**
- **Uses OpenAI**, through the API with structured JSON answers. The model is set in configuration; the default is gpt-4o-mini.
- **Server switch:** with no API key on the server, nothing AI-related is shown or sent.
- **Per-mailbox switch:** **Allow the AI assistant for this mailbox** (Admin → Mailboxes → a mailbox). When it is off, no email from that mailbox is ever sent to OpenAI; use it for HR or finance mail.
- **Who can use it:** permission `ai.use`, with the same reach as conversation access (an employee: the conversations assigned to them).

**What is sent to OpenAI, and what never is**
- Only the emails themselves: the latest 8 messages, without quoted history, and at most about 16,000 characters.
- **Never sent:** internal notes, tags, CRM fields and other data.
- The AI is told the email text is untrusted and that it must never follow instructions inside it.

**AI panel beside each conversation**
- A short **summary**.
- **Category:** sales enquiry, existing client, support, billing, partnership, job application, vendor, newsletter, spam, other.
- **Sentiment**, and **urgency** with the reason.
- **"Looks like a new sales lead"**, with confidence and service interest.
- A **suggested next step**.
- New mail is analysed automatically (`AI_AUTO_ANALYZE`). Results are cached and marked when newer mail has arrived. **Refresh** re-analyses.

**Suggest a reply**
- Choose a tone (professional, friendly, short, formal, apologetic) and add optional instructions such as "offer a call on Monday".
- The AI writes a reply. It is told not to invent prices, dates or promises; unknown details appear in [brackets] to fill in.
- **Use as draft** puts it into a normal reply draft, above the signature and the quoted mail.
- The employee edits it and **presses Send themselves**. Nothing AI-written is ever sent without that.

**Improve writing** (in the email editor)
- **Fix grammar and spelling**, or make the text professional, friendly, shorter, formal or apologetic.
- Only the employee's own text is sent; the signature and the quoted mail stay out.
- The result is shown first, with **Replace** or **Keep mine**.

### Automation (Admin → Automation)

**Rules**
- Each rule has a **trigger**, optional **conditions** and ordered **actions**.
- **Triggers:**
  - **New email arrives:** after routing and after the AI has read it, so AI fields can be used.
  - **AI detects a sales lead:** 70% confidence or more.
  - **Employee marked absent.**
- **Conditions:** mailbox, sender, sender domain, recipients, subject, text, priority, status, AI category, AI urgency, AI sentiment, has an assignee, assignee is away.
- **Actions:**
  - assign (person, team or department; round-robin or least loaded);
  - set priority; set status; add a tag;
  - notify (assignee, team leader, department manager or chosen people);
  - create a task; open a sales lead;
  - **write an AI reply draft for the assignee**: it is saved as their draft, they are notified, and it is **never sent automatically**;
  - **reassign an absent person's open conversations** to their team (round-robin, skipping people who are away) or to a chosen person.
- **There is no "send email" action.** The system refuses one if it is attempted.

**Using rules**
- **Test** shows what a rule would do for a real conversation without changing anything.
- **Run log** lists each run and what every action did.
- **Each rule runs at most once per event**, even if the worker restarts.
- **Department managers** can create rules only for their own department, acting only within it. Administrators can create company-wide rules.

**Absence reassignment**
- When someone is marked away (by themselves or their manager), an "Employee marked absent" rule hands their open conversations to colleagues.
- The handover is recorded in the assignment history as an absence reassignment.

## How it was verified

**Automated tests: 15 new end-to-end tests**, against a real PostgreSQL, the fake Gmail server and a local OpenAI stand-in that records every request.

- **Insights:**
  - New mail is analysed automatically; the API key is sent, and the system prompt marks the email as untrusted.
  - The cache is used, so reading costs nothing.
  - People outside the conversation get 404.
  - **An internal note's text never appears in any request to the AI.**
  - Newer mail marks the result stale, and re-analysis updates it.
  - **A mailbox with AI switched off sends nothing to the AI** (checked against every recorded request); refresh and suggest are refused for it.
  - An AI outage is reported as such.
- **Replies stay drafts:**
  - A suggestion uses the tone and instructions.
  - Another employee cannot use it.
  - "Use" creates an AI draft addressed to the client, in EDITING status, with **nothing queued to send**. Using it twice is refused, and the use is audited.
  - Rewrite returns corrected text without changing the draft, and only the draft's owner may use it.
- **Automation:**
  - Permissions: department managers are limited to their department and to people in it, and a "send email" action is refused.
  - **A full rule on new mail:** round-robin assignment, high priority, tag, task, AI draft for the assignee (not sent), notifications to the assignee and the manager, a run log with every action, and audited changes.
  - The same event again does nothing; mail that does not match runs nothing.
  - A dry run writes nothing.
  - A detected lead opens a lead.
  - A rule for another department does not run.
  - **Absence:** both open conversations moved to the colleague, recorded as absence reassignment, and the manager was told.
- **"No code path sends AI or automation output without a human" (the exit criterion):**
  1. A scan of the API source: only the human **Send** on a draft queues mail, and only the send worker talks to SMTP, Gmail send or Graph send. The AI and automation code does not reference any of them.
  2. The action list contains nothing that sends, and unknown actions are refused.
  3. Every AI draft made during the tests is unsent and unapproved, and no send job exists for them.
  4. The send worker refuses a draft nobody approved.
- **Also:** all earlier tests still pass. 234 tests in total.

**Live run of the production builds** through the web proxy, with the real background worker, together with Phase 4: **13/13 checks passed.**
1. An IMAP mailbox was connected.
2. New mail reached the CRM through IDLE in about 3 seconds.
3. The worker analysed it with AI.
4. The automation rule assigned it, raised the priority and wrote an AI draft for the salesperson, with **nothing sent**.
5. The salesperson pressed Send: one SMTP delivery, and a copy filed in Sent.
6. Rewrite worked, and the pages loaded.

**Not checked by eye:** the screens were tested through the API and page loads, not looked at in a browser.

## Needed from SEO Discovery

1. **An OpenAI API key** from the company's OpenAI organisation. Put it as `OPENAI_API_KEY` on the **crm-api** service on Render; the worker copies it. Optionally set `OPENAI_MODEL` (default gpt-4o-mini).
2. **Agreement on what mail may go to OpenAI.** The data processing agreement (DPA) with OpenAI must be in place. Then switch AI off for any mailbox whose mail must not go there (HR, finance…).
3. **About 200 real emails, with consent**, labelled with the right category (sales enquiry, support, billing…), to measure how often the AI is right.
4. **The automation rules you want.** For example: sales enquiries → sales team, high priority, AI draft; absent employees → their team.

## Known gaps

- **Fixed triggers.** Automation runs on new mail, detected leads and absences. Triggers for SLA steps, status changes and schedules are not built yet, so they are not offered.
- **Reply only.** AI drafts are always replies to the latest message, not new emails or forwards.
- **Plain text from rewrite.** Rewrite returns plain paragraphs, so formatting in the employee's text (bold, lists) is lost when they accept it.
- **No AI cost tracking.** There is no monthly AI budget or cost report. Token counts are stored per analysis for a later report (Phase 9).
- **The accuracy of categories and lead detection is unmeasured** until the evaluation set exists.
