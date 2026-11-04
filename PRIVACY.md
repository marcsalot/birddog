# Birddog privacy policy

_Last updated: 4 November 2026_

Birddog is an open-source program that runs on your own computer and shows what needs your
attention next: work in your local git repos, pull requests, tickets, incidents, messages and
meetings. This policy explains what it reads and where that data goes.

## The short version

- Birddog runs **on your computer**. There is no Birddog server, no account, no analytics and no
  telemetry.
- It only **reads**. It never posts, edits, deletes, or marks anything read in the services you
  connect.
- What it reads stays on your computer. The one exception is the optional chat (see below).
- Sign-in tokens are kept in your operating system's keychain.

## What Birddog reads

Birddog reads only what you connect, and only to build your own list:

- **Local git repos** in the folders you choose: branch and commit status, and uncommitted changes.
- **GitHub, GitLab, Azure DevOps:** pull or merge requests, reviews, pipeline and check results,
  mentions, assigned issues and security alerts.
- **Jira, Linear:** issues assigned to you.
- **Sentry, PagerDuty:** errors assigned to you, incidents, and on-call shifts.
- **Slack:** messages that mention you, and direct messages waiting for your reply.
- **Calendars** (Google, Microsoft, iCloud, iCal links): your events, read-only.

## Google user data

If you choose **Sign in with Google**, Birddog asks for one scope, `calendar.readonly`. It uses it
only to read your upcoming events and show the next meetings in your list. It doesn't use Google
data for advertising. It doesn't sell it, transfer it to anyone, or use it to train AI models.
People don't read it, and it never leaves your computer.

Birddog's use and transfer of information received from Google APIs adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements.

## Where data is kept

- Copies of your items, and your done and snooze choices, are kept in Birddog's folder on your
  computer (`~/.config/birddog`).
- Sign-in tokens and API tokens go to your OS keychain (macOS Keychain, or Secret Service on
  Linux). They're never written to Birddog's files in plain text.
- Birddog sends data only to the services you connected, to read from them.

## The optional chat ("Ask Fetch")

The chat is off until you add your own Anthropic API key and agree to send inbox content. When you
use it, your question and the items it looks up are sent to Anthropic's API under your key:
titles, "why" lines, fields and links, but never tokens. Anthropic's own policies apply to that
data. Turning the chat off forgets the key.

## Removing access

**Disconnect** on any source card deletes its tokens from your keychain, and revokes them at the
provider where the provider allows it (Google, GitLab, Linear). You can also remove Birddog from
the provider's list of connected apps, for example at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions). To delete everything
else, delete Birddog's folder.

## Contact

Questions or concerns: open an issue at <https://github.com/marcsalot/birddog/issues>.
