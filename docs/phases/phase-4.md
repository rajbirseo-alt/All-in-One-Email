# Phase 4 — IMAP / SMTP mailboxes

**Status:** built and tested locally, 2026-11-20, against local IMAP and SMTP test servers. The exit criterion (the real-account checklist in 06 §6 on at least two real custom-domain hosts, such as the company's Zoho or cPanel mail) waits for test mailboxes.

## What works

**Connecting**
- **Mailboxes → Connect other (IMAP)** connects mailboxes that are not Gmail or Microsoft 365: Zoho, Hostinger, GoDaddy, cPanel hosting, Yahoo, iCloud and any other IMAP/SMTP provider.
- **Presets** fill in the servers. The form says when the provider needs an **app password** (Zoho with two-step sign-in, Yahoo, iCloud).
- **Test connection** shows four checks:
  - server names found;
  - signed in to read mail (IMAP);
  - folders found (an inbox must exist);
  - signed in to send mail (SMTP).
- **Connect** runs the same test again, so a wrong password is never saved.
- **Reconnecting:** when a password changes, the mailbox shows **Reconnect needed**. **Reconnect**, or **Change password or server**, opens the form with the saved servers filled in. Nothing is imported twice.

**Security**
- The password is stored **encrypted**, the same way as Google and Microsoft tokens, and is never shown again.
- Only encrypted connections are used: TLS 1.2 or newer, with a valid certificate.
- A typed-in server that points to a private or internal network address is refused.
- Only people with the mailbox-connect permission can test or connect.

**Reading mail**
- The first sync imports the chosen number of days from Inbox, Sent, Archive, Junk and the custom folders.
- After that, new mail arrives **within seconds** through IMAP IDLE (the worker keeps one connection per mailbox). Every mailbox is also checked every 5 minutes.
- Changes made in the provider's own webmail are picked up: read, starred, moved to another folder, deleted.
- **One email is one message**, even when it moves between folders or sits in both Inbox and Sent.
- If the server renumbers a folder, it is read again without duplicates.
- **Replies join their conversation** by their headers. When a client's mail program drops those headers, a reply with the same subject from the same people within 30 days joins it too.
- Contacts, leads, routing rules, SLA and notifications work exactly as for Gmail and Microsoft mailboxes.

**Sending and actions**
- Replies, reply-all, forwards and new mail go out over the mailbox's own SMTP server.
  - **Bcc** recipients are never visible to the others.
  - A copy is saved in the mailbox's **Sent** folder, unless the server already saved one.
  - If sending fails for a moment, it is retried. Once the server has accepted an email it is **never sent twice**, even when something fails afterwards.
- Read, unread, star, archive and spam in the CRM are applied on the mail server too.
- **Attachments** download from the server when opened, intact.

## How it was verified

**Automated tests: 15 new end-to-end tests** against a real PostgreSQL, a local IMAP server (hoodiecrow, with IDLE, MOVE, UIDPLUS and SPECIAL-USE) and a local SMTP server:
- **Connection test:** each step reported; a wrong password and an unknown server refused; a refused connect saves nothing. Under production rules, private addresses and non-TLS connections are refused. Only mailbox admins may connect.
- **Connect:** the password is encrypted at rest (not readable in the stored bytes) and decrypts correctly; settings are visible without the password; the connect is audited. An address already connected through Google is refused.
- **First sync:** the window is imported, older mail is left out; our reply in Sent joins the client's thread as outbound; contacts are matched; a second run imports nothing twice.
- **Changes:** new mail; replies by header and by subject; mail without a Message-ID; read and starred in webmail; moved to Archive in webmail (one message, now in Archive); deleted in webmail; a renumbered folder without duplicates.
- **Sending:**
  - SMTP envelope includes Bcc while the message has no Bcc header;
  - In-Reply-To is set and the Sent copy is saved once;
  - after the next sync there is still one message, in the same thread;
  - a retry after SMTP accepted sends nothing again;
  - a temporary SMTP failure is retried and sent once.
- **CRM actions on the server:** unread, star, archive (moved to Archive at the server); the attachment downloaded matches byte for byte.
- **IDLE:** new mail on the server queued a sync within seconds.
- **Failures:** a changed password → Reconnect needed; reconnecting resumes without loss or duplicates; disconnecting deletes the stored password.

**Also:**
- **3 unit tests:** folder types, UID sets and flags, message parsing (encoded subjects, Reply-To, references, messages without a Message-ID).
- The existing Gmail and Microsoft tests still pass.

**Not checked by eye:** the screens were tested through the API, not looked at in a browser.

## Needed from SEO Discovery

1. **Two real custom-domain mailboxes** to run the real-account checklist (06 §6), e.g. one on Zoho and one on the website host. For each: the address, the provider, and an app password if two-step sign-in is on.
2. **IMAP access switched on** for those mailboxes. In Zoho: Settings → Mail Accounts → IMAP access.

## Known gaps

- **No CONDSTORE/QRESYNC.** Flags are re-checked for the whole import window on each sync. That is fine for normal mailboxes; very large windows (tens of thousands of messages) will make syncs slower.
- **IDLE watches the inbox only.** Other folders update with the 5-minute check.
- **Plain passwords only.** XOAUTH2 sign-in over IMAP (offered by some providers) is not built.
- **Archive and spam need the folders to exist.** If a mailbox has no Archive or Junk folder, the action is applied in the CRM but fails at the server (shown in the sync log).
- **Unrelated security alerts.** `npm audit` reports advisories in existing dependencies; the Phase 10 hardening pass handles them.
