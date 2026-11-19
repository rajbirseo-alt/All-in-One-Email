# Phase 7 — Contacts and leads

**Status:** built and tested locally, 2026-11-19.

Two things are still open:
- **Real enquiry.** The exit criterion asks for a lead flow end to end from a real enquiry. That needs a connected sales mailbox and a routing rule with "Also create a sales lead".
- **Company inputs.** SEO Discovery's lead stages and sales team roster are still to be confirmed (see below).

## What works

**Automatic contacts**
- Every conversation is linked to the person outside the company it is with, and their **Last email** date is kept up to date.
- A new address creates a contact, with the name taken from the email header.
- The sender's domain creates a **company** (e.g. `acme-labs.co.uk` → "Acme Labs"); colleagues from the same domain join it.
- **Website enquiry forms** that send from our own domain or a robot address use the **Reply-To** address, so the contact is the client.
- **Never turned into contacts:**
  - our own mailboxes, employees and company domains;
  - robot addresses (`noreply@`, `mailer-daemon@`, …).
- Free-mail domains (gmail.com, yahoo, outlook.com, rediffmail, …) never form a company.

**Contacts**
- **Contacts** under the new *CRM* menu: search by name, email, company or phone, and filter by type.
- Each contact card shows:
  - several email addresses (one is the main one);
  - phone, company, website, country, type (client, prospect, vendor, partner, candidate, other), owner and department;
  - tags and internal notes;
  - the timeline: conversations, leads and tasks.
- New contacts can also be added by hand.
- An address belongs to one contact only. Adding one another contact has is refused, with a suggestion to merge.

**Companies**
- List and page per company, with its people and leads.
- Create and edit.
- The domain is cleaned up (`https://www.x.com/about` → `x.com`).
- Free-mail domains and domains already taken are refused.

**Who sees contacts**
- **Employees:** contacts they own, plus the contact of any conversation they can read.
- **Department managers and roles with department scope** (Sales, Finance): their department's contacts.
- **Super Admin and MD:** everyone.
- Anything outside a person's scope behaves as if it did not exist.

**Duplicates and merging**
- **Find duplicates** (needs `contact.merge`) lists likely pairs with the reasons:
  - same phone number;
  - similar name at the same company;
  - same full name;
  - same mailbox name at another domain.
- **Not the same person** hides a pair.
- **Merge** shows a preview first:
  - what moves (addresses, conversations, leads, tasks, tags);
  - which empty fields are filled in;
  - which differing values are kept.
- **Undo merge** on the contact page puts everything back. Nothing is ever deleted, and both actions are in the audit log.

**Leads**
- **Leads** page:
  - a board by stage: New, Contacted, Follow-up, Interested, Proposal sent, Negotiation, Won, Lost;
  - search and an owner filter;
  - totals for open, won, lost and conversion rate, plus the won value;
  - a per-owner table.
- **A lead's window** shows:
  - its contact, company and source email;
  - value, currency, service interest and owner;
  - a stage change with a note (**Lost** needs a reason);
  - full stage history and tasks.
- **Won** turns the contact into a *Client*.

**Creating leads**
- **Create lead** beside a conversation in the inbox, or from a contact's page.
- The creator owns it, unless a manager chooses someone else.
- A conversation can have only one open lead.
- Opening a lead:
  - marks the contact as a *Prospect*;
  - tells the owner, unless they created it themselves;
  - gives them a **follow-up task** due in 24 hours.

**Lead routing**
- Routing rules have a new option, **Also create a sales lead** (with an optional service interest).
- When a new email matches the rule, a lead is opened for the salesperson the rule picked (directly, round-robin or least-loaded), with a notification and a follow-up task.
- No second lead is opened while the sender already has an open one.
- Our first reply on the lead's email moves it from New to **Contacted** automatically.

**Who sees leads**
- **Sales members:** their own leads.
- **Team leaders:** their team's leads.
- **Department managers:** their department's leads.
- **Super Admin and MD:** all leads.
- **Employees:** no leads (as in the permission matrix).

**Tasks**
- **Tasks** page:
  - views: *My tasks*, *Given by me*, and *Everything I can see* (for leaders and managers);
  - filters: open, done or all;
  - add tasks, and tick them off or reopen them.
- Tasks can be linked to a conversation, a lead or a contact. A link only shows to people who may open it.
- Giving a task to someone else tells them. People with own-scope task permission can only give tasks to themselves.
- When a task falls due, the worker sends one **Task due** reminder; changing the due time sets up a new reminder.

**In the inbox**
- A **Contact, leads and tasks** panel beside the conversation: the contact card, its leads with their stage, **Create lead**, and the conversation's tasks with **Add task**.

**Notifications**
- New kinds, each with its own setting under *Notifications*: **Lead assigned to me**, **Task assigned to me**, **Task due**.
- Clicking one opens the lead or the task.

## How it was verified

**Automated tests: 201, all passing.** That is 182 before this phase plus 19 new ones.

- **3 unit tests:**
  - company names from domains;
  - free-mail and robot addresses;
  - phone matching.
- **16 end-to-end tests** against a real PostgreSQL and the fake Gmail server:
  - **Contacts:** created and reused across conversations; colleagues joining the same company; no company for gmail.com; no contacts for robots or colleagues; website forms using Reply-To.
  - **Access:** an employee sees only the contacts of conversations assigned to them; a department sees its contacts.
  - **Editing:** contacts with several addresses; refusing an address another contact has; main address and removal rules; tags; field validation.
  - **Companies:** free-mail and duplicate domains refused.
  - **Duplicates:** same phone, same name and same mailbox name detected; dismissing a pair.
  - **Merging:** the preview changes nothing; the merge moves conversations, addresses and tasks; the merged id opens the survivor; new mail to the old address lands on the survivor; **undo restores everything**; undoing twice is refused; both are audited.
  - **Lead routing:**
    - round-robin owner;
    - the notification links to the lead;
    - the follow-up task is due in 24 hours;
    - the contact becomes a Prospect;
    - no second lead for the same sender;
    - non-matching mail creates no lead.
  - **Lead access:** only the owner and the department manager see the lead; another salesperson gets 404.
  - **Pipeline:** our reply moves the lead to Contacted; stage history; Lost needs a reason; Won makes a client; the summary shows the won value.
  - **Manual leads:** creating a lead from a conversation; a second one is refused; own-scope users cannot hand a lead over; managers can, and the new owner is told.
  - **Tasks:** own-scope limits; the assignee is told; **exactly one due reminder**, and a new one after the due time changes; completing and reopening; conversation links hidden from people who cannot read them.
- **Live run of the production builds** through the web proxy, with the background worker: **17/17 checks passed.**
  1. A rule with "create a lead" was saved.
  2. A website-form email was synced by the worker. It produced a contact from Reply-To and a company by domain.
  3. The worker opened a lead for the rep the rule picked, with a task.
  4. The rep's bell showed it.
  5. The conversation panel showed the contact, lead and task.
  6. Our reply moved the lead to Contacted.
  7. The lead moved through the stages to Won.
  8. A duplicate was found, merged and undone.
  9. A task reminder was sent by the worker's sweep.
  10. All eight new pages loaded.
- **Database:** the migration matches the schema (drift check clean). The web production build passed type checks.
- **Not checked by eye:** the screens were tested through the API and page loads, not looked at in a browser.

## Needed from SEO Discovery

1. **Lead stages.** The built stages are the eight from the brief: New, Contacted, Follow-up, Interested, Proposal sent, Negotiation, Won, Lost. Tell us if sales uses different names or extra stages.
2. **Sales team roster.** Who is in the sales team and who takes part in the round-robin rotation (Admin → Departments & teams). Their role should be **Sales Member**.
3. **Which enquiries become leads.** For example, everything to sales@, or website-form emails with "quote" in the subject. These become routing rules with "Also create a sales lead".
4. **A real enquiry** to that mailbox once it is connected, to close the exit criterion.

## Known gaps

- **Lead detection is rule-based.** AI-based detection of business enquiries comes in Phase 8.
- **Lead stages are fixed.** Changing their names or adding stages means a code change.
- **No contact deletion.** Merging is the supported way to remove a duplicate. Deleting or anonymising a contact on request (e.g. GDPR) is planned for the Phase 10 hardening pass.
- **Changing a conversation's contact.** A conversation keeps the contact it was matched to. To fix a wrong match, merge the contacts.
- **Duplicate search is not paged.** It looks at all contacts in one query and shows the best 100 pairs. That is fine at the current scale; it will need revisiting at around 100,000 contacts.
- **The follow-up task is due 24 clock hours** after the lead is created, not 24 working hours.
- **Reports.** A full lead conversion report with date ranges and CSV export is part of Phase 9 analytics. The leads page already shows totals and conversion per owner.
