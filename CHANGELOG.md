# Changelog

All notable changes to Birddog. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.20.0] - 2026-11-06

### Added
- **Email triage**: Thunderbird, Gmail and Outlook mail sort each message into *needs you*, *FYI* or *noise* (`src/mailsense.mjs`), and say why. They use bulk mail headers, robot senders, notifications from tools Birddog already shows, To versus CC, people you've replied to, "action required" wording, Gmail's Important marker and tabs, Outlook's Focused Inbox, and per-source *Always important* and *Always noise* lists. Noise is counted, not listed, unless you ask.
- **Gmail** (Sign in with Gmail, `gmail.metadata`: headers and labels only) and **Outlook mail** (Sign in with Outlook mail, `Mail.ReadBasic`): unread and starred / flagged mail. Neither reads message bodies or changes anything.
- **Dynatrace**: open problems in a management zone or entity selection; availability and error problems are **Now**.
- **Grafana**: firing alerts (not silenced) through the Alertmanager API, with label filters; critical severity is **Now**. Grafana Cloud or a private Grafana.
- **Jenkins**: jobs in a view or folder whose last build failed or is unstable, with multibranch pipelines one item per branch, and an option for only builds you started or broke.
- **GitHub Projects**: items assigned to you on the boards you list, not done, ranked like tickets (iteration end, due date, priority, blocked). Birddog's GitHub sign-in now asks for `read:project`.
- **Confluence**: @mentions in pages and comments (last 7 days), and inline tasks assigned to you.
- **Private servers**: `http://` is accepted for hosts on your own network only; clearer errors when you're off the VPN or a server uses a company CA (`NODE_EXTRA_CA_CERTS`).
- New `alert` kind and rules; the demo has all of the above.

## [1.19.0] - 2026-11-06

### Added
- **Task lists, two-way**: Microsoft To Do (Sign in with Microsoft To Do), Google Tasks (Sign in with Google Tasks) and Todoist (API token). They list open tasks that are overdue, due within a week, or important / P1, ranked by new task rules. **Sync done**, off by default and switched per source, makes Done in Birddog (UI, keyboard, MCP `mark_done`) complete the task in its app and Undo / Restore reopen it. If the app refuses, nothing changes in Birddog. Write scopes are asked for only after you switch it on. `PUT /api/sources/:id/sync`.
- **One unified calendar**: the Calendar source reads every calendar that's connected at once (Google, Outlook, iCloud, iCal links and files, and now **Thunderbird's calendars**). The same meeting in two calendars shows once, and one broken calendar is a warning instead of an empty list. The card lists each calendar with **Remove** (`DELETE /api/sources/cal/calendars/:kind`) and **Add a calendar**.
- **Thunderbird calendars**: read from a copy of `calendar-data/local.sqlite` with Node's built-in `node:sqlite` (Node 22.13+), turned into iCalendar so repeats, moved occurrences, all-day and floating times go through the existing parser.
- The demo has To Do and Todoist with Sync done on, and a Thunderbird calendar.

### Changed
- Signing out of Google or Microsoft in the Calendar card removes just that calendar; the Calendar source stays on while it has others.
- Home (the default profile) also shows Google Tasks and Todoist.

## [1.18.0] - 2026-11-06

### Added
- **Profiles**: Work and Home by default, and up to 12 of your own. A profile picks which sources show, can follow a schedule (Auto: Work on weekdays 08:00–18:00, Home otherwise; overnight windows work), and can keep quiet. It filters the inbox, notifications (items outside it are noted silently, so switching never causes a burst) and MCP `list_items` (new `profile` argument). Top-bar switcher, <kbd>⇧P</kbd>, palette commands, an editor, and `GET/PUT/DELETE /api/profiles`; `GET /api/items?profile=`.
- **Discord**: @mentions of you, or a role you have, that you haven't answered in that channel since. It reads through a bot you invite (bot token plus your user ID), GET only, and never sees DMs.
- **Thunderbird**: unread mail from the last week, and starred mail you haven't replied to, read straight from Thunderbird's local Inbox files (mbox, read-only). It decodes encoded and raw UTF-8 headers and skips deleted messages. No token.
- Setup cards for sources that need no token ("reading files on this computer", **Turn off**).
- The demo and the live site have a Discord server, a Thunderbird inbox, and Work and Home profiles.
- **Website and live demo** at https://marcsalot.github.io/birddog/: a landing page, and the real UI running in the browser on recorded `--demo` data (`scripts/build-pages.mjs`, `site/`), with times shifted to now, triage, replies, slot claims and recorded Ask Fetch answers working in the tab. Deployed to GitHub Pages on every push to `main`.

## [1.17.0] - 2026-11-05

### Added
- **Launch slots, complete**: `require` (files that must exist) and `guards` (patterns that must not appear in a local file) are checked before anything is claimed; `overlays` write per-slot files into the worktree, backing up and restoring yours, refusing tracked files and staying out of `git status`; `after` steps run once a slot is live (failures are reported, the slot stays up); `--open` opens the browser.
- **Who owns a port**: a port answered by a process the launch didn't start fails as `FOREIGN_LISTENER` instead of passing for ready, and teardown stops listeners our processes started but never anyone else's. Per service, `"ownerCheck": "port"` accepts any listener (a Docker-published port). Uses lsof and ps on macOS and Linux, netstat and PowerShell on Windows.
- **Pid start stamps** in locks (`starts=`): a pid the OS has reused for another process is never treated as ours or killed.
- `birddog slot cleanup --ports` also stops orphan listeners on slot ports (only when asked); cleanup reverts overlays left by launches that lost their lock.
- CI runs the launch-slot tests on Windows.

## [1.16.0] - 2026-11-05

### Added
- **Launch slots** (`birddog slot start | stop | restart | status | cleanup`): run several copies of your app at once, one per git worktree, each in its own set of ports with a lock file. Settings in `launch-site.json`. Claims are exclusive (O_EXCL), a slot is free only with no lock and quiet ports, services start and are polled together (one that exits early fails at once, with its log), failures release or tear down, and stop kills only the recorded process trees, then verifies the ports before releasing the lock. Stale locks are cleared on the next start. Works on macOS, Linux and Windows.
- **The launch-site skill for Claude Code**, shipped in `skills/launch-site` and installed with `birddog skill install launch-site` (`--project` for this repo only). It drives `birddog slot`, explains failures from the logs, never kills processes itself, and offers to draft a `launch-site.json`.
- **Worktrees & slots reads launch slots**: with a `launch-site.json` in a repo (or `workspace.launchSite`), the dev slots are its slots, with Starting / Running / Stale lock from the locks, Stop and Restart commands, and **Start in a slot** on each idle worktree. Locks that keep the worktree's name in `worktree` and its folder in `worktree_path` are understood.

## [1.15.0] - 2026-11-05

### Added
- **Ticket board** (`b`): your Jira tickets in swimlanes, In Progress → In Code Review → Code Review Pass → Ready for Deployment. Cards show time in status (from the changelog, ⏳ after 3 days), type, priority, fix version, and the ticket's worktree, dev slot and QA slot; tickets without a worktree get a copyable `git worktree add` command. **Lanes & filter** edits lane names, the Jira statuses in each (several per lane), their order, and whose tickets (mine, projects, or a JQL filter). Read-only, one search a minute at most.
- **Worktrees & slots** (`w`): every git worktree with its ticket and board lane, changes, unpushed commits, ahead/behind main and last commit, with flags for what needs a look; local **dev slots** (running when their ports answer or their lock file names a live process; claim one by hand); numbered **QA slots** (12, or however many) that Birddog asks which branch and build they run, with claims for who has which. Commands are copied, never run.
- `config.json → board` and `→ workspace`, `slots.json` for claims, and `GET /api/board`, `GET /api/workspace` with their settings and slot routes.
- The demo has a full board, five worktrees, three dev slots and twelve QA slots (one down, one claimed).

## [1.14.0] - 2026-11-04

### Added
- **Microsoft Teams source.** 1:1 chats whose last message is someone else's (waiting for your reply), and @mentions of you in group and meeting chats that you haven't answered since. **Sign in with Microsoft Teams** uses the Microsoft app (same client ID and tenant settings as the Outlook calendar) but its own sign-in and tokens, so the calendar never asks for chat access. Reads with `Chat.Read`; work or school accounts only. Channel posts aren't read (that needs `ChannelMessage.Read.All`, which only an admin can grant).
- **Teams replies**, opt-in like Slack: the same reply box, 5-second undo, Fetch confirmation and MCP gate. Turning on **Allow replies** adds `ChatMessage.Send` to the next sign-in; until it's granted, the reply box says so with a **Sign in again** button. Replies are plain text with no @mentions, so they ping nobody extra. 429s are retried briefly, then explained.
- `grantedScopes(provider)` in the sign-in module, from the token response, so a source can tell what the user allowed.
- The demo has a fake Teams (a waiting chat with Lena, an @mention in "Launch crew").

### Added
- **Boundary tests** (`test/boundaries.test.mjs`, 38 tests): a scripted model tries to cross each of Fetch's boundaries (read tokens or settings, change or reply without Confirm, reply where replies are off, call the web or a tool Birddog doesn't have, obey instructions inside an item, store a secret, loop forever), and each test checks that Birddog holds the line.

## [1.13.0] - 2026-11-04

### Added
- **Fetch remembers.** "Remember that …" saves a short note that later conversations start with. The new **Memory** tab lists the notes, with **Forget** and **Forget everything**. Notes that look like a password, key or token are refused.
- **Conversations are saved** (`chat-history.json`, kept a week), so a reload or restart picks up where you left off. **＋** still starts a new one.
- **Boundaries, visible and enforced.** A **Boundaries** tab lists what Fetch can read (your connected sources), can do, does only after you confirm, and never does, with **Try it** questions that show the limits in action. When Fetch tries to cross one (a reply where "Allow replies" is off, a secret in memory), Birddog refuses the call and the chat shows **🛡 Boundary held**. The system prompt also tells Fetch to treat item content as data, never as instructions.
- **Every source.** Fetch's prompt names every connected source, `list_items` describes all of them, and it gains a `query` filter (words in the title, "why" line or fields), also in MCP.

### Changed
- **Fetch runs on Claude Haiku 5.5** (`claude-haiku-5-5`) by default: fast and the cheapest current model. `chat.model` / `BIRDDOG_CHAT_MODEL` still pick another. The server-side refusal fallback is only requested on models that have it (Haiku doesn't), and output is capped at 16k tokens.
- **Each conversation is append-only.** The system prompt and tool list are fixed when it starts (the current time now travels with each question), and `reply` is always declared and refused where replies are off. Newer models reject a replayed thinking block when anything before it changed.

### Fixed
- **Ask Fetch setup ignored the pasted API key** and said "Paste an Anthropic API key." The form was redrawn (to show it was busy) before the key was read, which emptied the field, so an empty key was sent.

### Changed
- The menu's collapse button is now a round tab on the rail's right edge, halfway down the screen, instead of beside the logo. It follows the edge when the menu collapses.

## [1.12.0] - 2026-11-04

### Added
- **Reply from Birddog** (Slack first). Answer a DM in the DM, or a channel mention in its thread (optional "Also send to #channel"), from the item's details: `⇧R` to jump to the box, `⌘↵` / `Ctrl+↵` to send. The box says who and where ("Reply to @priya in DM", "Reply in thread in #payments"). Each reply waits **5 seconds with Undo send** before it goes out; then you get a link to it and the item clears.
- **Opt-in writing.** Nothing posts until you tick **Allow replies** on the Slack card, which says plainly that Birddog will post as you. Needs the `chat:write` user scope; without it the reply box says so (with the fix) before you type.
- **A generic reply capability** for sources: `capabilities: ['reply']` with `replyTarget()`, `reply()` and an optional `replyCheck()` (`src/replies.mjs`). Other chats (Teams, Discord, Google Chat) plug in the same way; PR and ticket comments could later.
- **Fetch drafts replies**: it shows the full text and where it goes, and sends only on **Confirm and send**. It's offered the `reply` tool only once a source has replies on.
- **MCP `reply` tool**, hidden and refused unless config has `"mcp": { "allowReplies": true }` (and the source's own switch is on). It posts exactly the text in the call.
- Plain text only, up to 4000 characters: `&`, `<`, `>` escaped; `@channel` / `@here` only when you typed them in the dashboard, never from Fetch or MCP. Slack 429s wait out a short `Retry-After` (≤ 20 s, twice) or say when to try again.
- Demo mode has a fake Slack (one DM, one mention) that takes replies and sends nothing anywhere.
- The guide is **resizable**: drag its left edge to any width (or focus the edge and use ←/→, Shift for bigger steps; double-click resets). ⇤ in its header, or `Shift+G`, jumps between the normal rail and a wide reading view. The width is remembered (`guideWidth` pref). **Expand all / Collapse all** opens or closes every section at once.
- Built-in Google app: client ID `787425286434-if73gibnotktjm2rrthk4fk3ujre313j.apps.googleusercontent.com` (project "Birddog", Desktop app client), status `'testing'`. Its desktop secret is **not shipped** (not in code, config defaults or docs). Until it's stored locally, the Calendar card shows one friendly step instead of a button that would fail: get the secret from whoever runs the Birddog Google project, then `birddog secret set google-client-secret`, or `BIRDDOG_GOOGLE_CLIENT_SECRET` / `BIRDDOG_GOOGLE_CLIENT_SECRET_FILE`.
- `birddog secret set <name>` asks for the value at a hidden prompt when run at a terminal (still reads stdin when piped), and refuses a value given as an argument, so secrets stay out of shell history.
- Built-in GitHub app: **Sign in with GitHub** (device flow) now works on github.com with no setup. The client ID is `Ov23liwWb176mY399VPJ` (OAuth App "Birddog"); `BIRDDOG_GITHUB_CLIENT_ID` and `sources.github.clientId` still override it.

### Changed
- Bigger icons in the main menu, especially when it's collapsed to icons (the collapsed menu is a little wider to fit them).
- The Google notice follows `BUILT_IN.google.status` (`'testing'` | `'unverified'` | `'verified'`; the older `verified: true|false` still works). In testing it says sign-in is invite-only (test users only), suggests the iCal link, and warns that Google ends test sign-ins after 7 days. Google's `access_denied` and "has not completed verification" errors, and a refused weekly refresh, now explain the same thing instead of a bare error.

## [1.11.0] - 2026-11-04

### Added
- **Built-in sign-in apps** (`src/auth/clients.mjs`): when Birddog ships its own public OAuth client ID for a provider, "Sign in with X" works with no app registration. Precedence: `BIRDDOG_<PROVIDER>_CLIENT_ID`, then config.json, then built-in. Only public-client flows: GitHub device flow; PKCE with no secret for GitLab (gitlab.com), Microsoft (tenant `common`), Linear and PagerDuty (Classic User OAuth); Google's desktop client with PKCE and its non-confidential desktop secret. The registry ships empty until the maintainer registers the apps.
- **Sign in with Linear** and **Sign in with PagerDuty**, as alternatives to their tokens.
- **Google "unverified app" notice** next to "Sign in with Google": how to continue (Advanced → Go to Birddog (unsafe)), what Birddog reads, the 100-account cap, and the iCal-link alternative. It's driven by `BUILT_IN.google.verified` and also appears in the guide and README.
- **Sign in again**: a source whose sign-in can't be renewed turns stale with a one-click "Sign in again" (the API tags such sources with `signIn`).
- `docs/register-apps.md` (the maintainer's checklist for each provider) and `PRIVACY.md`.

### Changed
- One "Sign in" row per source card: the button plus a line saying what Birddog will read, or, without an app for that provider, the token / bring-your-own-app path worded as a fallback. Signed in, the row shows the account and Disconnect.
- Atlassian and Slack get no built-in app, because both need a confidential secret. Their tokens stay the main way in.

## [1.10.0] - 2026-11-04

### Changed
- **Sources A–Z, with search.** Every list of sources is sorted by name (Sources & settings, the left rail, the setup wizard, ⌘K). Sources & settings has a search box that matches names and kinds of thing (*calendar*, *tickets*, *ci*), with an "N of M" count; Esc clears it.
- **Top-right menu.** The Guide (book icon, `g`) and an account avatar now sit at the right of the top bar. The avatar's menu shows who you're signed in as, Sources & settings, Appearance, keyboard shortcuts, and Sign out when login is on. Both left the left rail.
- **Ask Birddog is now "Ask Fetch"**, Birddog's assistant (the dog that fetches answers). It opens from a ✦ sparkle button in the bottom-right corner (or `a`) as a floating panel; on phones it's a full-screen sheet. The button steps aside for a docked guide and hides while the guide or the item drawer covers that corner. The shortcut bar and toasts keep clear of it. The API, consent flow, Confirm/Cancel and streaming are unchanged, and the demo's scripted replies speak as Fetch.

## [1.9.0] - 2026-11-04

### Changed
- **One-step first run.** A new install asks only where your code is, with the folders that hold repos already ticked (and a repo count for each). One click, about half a second from start to the first items, no account. The multi-step wizard is still there under `⌘K` → "Run the setup wizard".
- A new config starts with local git only: GitHub stays off until you connect it, so a fresh inbox has no "not signed in" warning. Connecting switches it on.
- One suggested next step after the first run, **Connect GitHub**, above the inbox and the Overview, with a GitHub-only setup dialog. "Not now" hides it (`hideNextStep` pref).

### Added
- `GET /api/firstrun`: the folders the first-run screen offers. The demo uses made-up folders and never looks at your disk.
- A first-run screenshot in the guide (`npm run screenshots`).

## [1.8.0] - 2026-11-04

### Added
- **GitLab** (gitlab.com or self-managed): MRs to review, your MRs with failed pipelines or conflicts, assigned issues. Sign in with GitLab (OAuth + PKCE, `read_api`) or a token.
- **Linear**: assigned issues, ranked like tickets (overdue, cycle end, blocked, priority). Read-only GraphQL.
- **Azure DevOps**: PRs you haven't voted on, and work items assigned to you (WIQL). Built from Microsoft's public REST docs.
- **Sentry**: new and regressed errors assigned to you.
- **PagerDuty**: incidents paged to you (triggered → Now), and your on-call shifts.
- **Slack**: mentions, and DMs waiting for your reply (user token, read-only scopes).
- **GitHub Actions** failures on branches you pushed this week, and **Dependabot** alerts on those repos.
- One setup card for every token source, built from each source's own metadata. Docker env vars for every new token. A guide section.

### Changed
- Jira's `jira-issue` kind is now `ticket`, shared by Jira, Linear and Azure Boards; rule texts no longer say "Jira".
- Notification settings list kinds once, not per source.

## [1.7.0] - 2026-11-04

### Added
- **Sign in with Google** and **Sign in with Microsoft** for the Calendar: Google Calendar API and Microsoft Graph, read-only.
- **Sign in with Atlassian** for Jira Cloud: OAuth 2.0 (3LO) through `api.atlassian.com`.
- All three use the authorization code flow with PKCE and a loopback redirect. Tokens and refresh tokens are kept in the keychain and renewed automatically (rotated refresh tokens are kept). Disconnect forgets them, revokes at Google, and switches off the source that used them.
- Each provider uses your own app registration, read from config or env. There's a "register your app" guide for each.
- **iCloud calendars** over CalDAV with an app-specific password. Discovery follows only iCloud's own redirects, and the password never goes anywhere else.
- **Sign in with Apple** as an optional dashboard login: an ES256 client-secret JWT signed per sign-in, and a `form_post` callback accepted only from appleid.apple.com.
- The GitHub device flow now has step-by-step instructions, a countdown, and a new-code button.
- A guide section on sign-ins.

## [1.6.0] - 2026-11-04

### Added
- **Collapsible main menu**: Overview, the inbox views, sources, Ask Birddog, the guide, and Sources & settings, all in the left rail.
  - It collapses to icons with count badges (« or `m`), and every icon keeps its label as a tooltip and accessible name.
  - It remembers its state.
  - On phones it's a drawer behind ☰.
  - It works alongside the guide rail: the guide docks next to a collapsed menu from 1060px wide.

### Changed
- Ask Birddog and the guide moved from the top bar into the menu.
- The chat panel shows "Loading…" instead of briefly flashing its setup screen.

## [1.5.0] - 2026-11-04

### Added
- **User guide**: a searchable, collapsible rail on the right (📖 or `g`). It covers getting started, sources, triage, shortcuts, notifications, chat, Docker and MCP. It docks on wide screens, floats on narrow ones, and remembers if it was open. `⌘K` jumps to its sections.
- `npm run screenshots`: a Playwright script that captures the guide's screenshots in light and dark, from `--demo` data only. Playwright is a devDependency; there are still no runtime dependencies.

### Changed
- The top bar no longer wraps on narrow windows.

## [1.4.0] - 2026-11-04

### Added
- **Overview**, the new front page (`0`):
  - a load dial (Calm / Busy / Swamped, with icon and word)
  - open items against a week ago, and done today
  - the longest-waiting PR
  - meetings left today, with booked time and what's next
  - a 14-day chart of open and Now items, with crosshair tooltips
  - breakdowns by source and by kind
  - source health with Retry
- The charts are hand-rolled SVG with a colorblind-checked palette. Every chart has a text alternative and a "Show the numbers" table.
- `history.json` and `/api/history`: one row per day for the chart, kept for 60 days. `--demo` comes with two weeks of made-up history.

### Changed
- Birddog opens on the Overview; the inbox is one click, or `1`, away.

## [1.3.0] - 2026-11-04

### Added
- **Ask Birddog**: a chat panel (`a`) that answers questions about your inbox. The local server calls the Claude Messages API (`claude-sonnet-5-5` by default) with plain `fetch` and streams the answer. The model uses Birddog's own MCP tools, with inputs checked against their schemas.
- Changes the model proposes (`mark_done`, `snooze`, `restore`) wait for **Confirm / Cancel** in the panel.
- It's opt-in: it needs your Anthropic API key (keychain, or `ANTHROPIC_API_KEY` in Docker) and your explicit consent to send inbox content to Anthropic.
- A scripted stand-in assistant in `--demo`, so chat works without a key.

## [1.2.0] - 2026-11-04

### Added
- **Notifications**: when an item becomes Now, or a source stops refreshing, Birddog tells you, in the browser (Notification API) while a tab is open and from the system otherwise (macOS `osascript`, Linux `notify-send`, Windows toast). Each item is announced at most once, even across restarts.
- Per-source and per-kind switches, quiet hours (overnight ranges work), snooze all, and a test notification, all under 🔔.
- `birddog notify`: notifications without the dashboard (`--on`, `--test`).
- `/api/notifications/claim`, `/api/notifications/test` and `/api/notifications/kinds`.

## [1.1.0] - 2026-11-04

### Added
- **Docker image**: a multi-stage `Dockerfile` on `node:22-alpine` with git, which runs as a non-root user and has a healthcheck. Config and state live on a `/data` volume; repos are mounted read-only at `/repos`.
- `docker-compose.yml` with the dashboard and a `demo` profile that needs no mounts or tokens.
- **Environment secrets** (`BIRDDOG_SECRETS=env`, the default in Docker): `GITHUB_TOKEN`, `BIRDDOG_JIRA_TOKEN`, `BIRDDOG_CAL_URL` and more, each with a `*_FILE` variant for Docker secrets. These are read-only and never written to disk.
- `BIRDDOG_HOST` as an alternative to `--host`.
- GitHub Actions CI: tests on Node 22 and 24, tests inside the image, and a smoke test of the demo and the MCP server.

### Changed
- In a container, setup and the wizard explain where each token comes from, and the plain-text secret file fallback is refused.

## [1.0.0] - 2026-11-04

### Added
- **MCP server**: `birddog mcp`, over stdio, with `list_items`, `get_item`, `list_sources`, `mark_done`, `snooze` and `restore`. It shares state with the dashboard and never returns secrets.
- **Demo mode**: `birddog --demo` (and `birddog mcp --demo`) runs on made-up data in a temporary folder and makes no network requests.
- Demo GIF and screenshot; README rewritten for the public repo.
- npx release: package metadata and a `birddog` command. Published as `@marcusferrell/birddog`, since npm rejects `bird-dog` as too close to an existing `birddog` package.

### Changed
- Done and snooze state is re-read when another process changes it, so the dashboard and the MCP server can run side by side.
- `npm run dev:watch` also restarts when `package.json` changes.

## [0.3.0] - 2026-11-03

### Added
- **Calendar source**: any iCal link or `.ics` file. The parser is built in and handles time zones (including Outlook's Windows names), all-day events, recurring events (`RRULE`, `EXDATE`, `RDATE`) and moved or cancelled instances.
- **First-run setup wizard** that tests each source as you reach it.
- Stale sources show a "stale since" bar with **Retry**, and scheduled refreshes back off: 2, 4, 8, 16, 32 minutes, then hourly.
- `POST /api/sources/:id/retry` and `PUT /api/sources/:id/enabled`.
- `npm run dev:watch` with live reload.

### Changed
- Keychain writes accept any character. Secrets typed into `config.json` move to the keychain on start, and the API never returns credential-looking settings.
- A clear warning when only the unencrypted file fallback for secrets is available.

## [0.2.0] - 2026-11-03

### Added
- **GitHub source**: review requests, your PRs with failing checks, change requests or conflicts, unread @mentions, and assigned issues.
- **Jira Cloud source**: assigned tickets ranked by overdue, sprint end, blocked and priority. The API token is kept in the keychain.
- Setup cards for GitHub and Jira, with **Test & connect** and **Disconnect**.

## [0.1.0] - 2026-11-03

### Added
- Local git source: unpushed commits, uncommitted work, merged and stale branches.
- Ranked, keyboard-first inbox where every item explains why it's there; done, snooze and undo; three themes in light and dark.
- Optional OpenID Connect login for the dashboard, GitHub sign-in (gh CLI or device flow), and OS keychain secrets.

[1.11.0]: https://github.com/marcsalot/birddog/compare/d2ef6df...main
[1.10.0]: https://github.com/marcsalot/birddog/compare/7a6d029...d2ef6df
[1.9.0]: https://github.com/marcsalot/birddog/compare/619b986...7a6d029
[1.8.0]: https://github.com/marcsalot/birddog/compare/ac18fb3...619b986
[1.7.0]: https://github.com/marcsalot/birddog/compare/45bcfde...ac18fb3
[1.6.0]: https://github.com/marcsalot/birddog/compare/0b78f3b...45bcfde
[1.5.0]: https://github.com/marcsalot/birddog/compare/35cffb9...0b78f3b
[1.4.0]: https://github.com/marcsalot/birddog/compare/f1288c5...35cffb9
[1.3.0]: https://github.com/marcsalot/birddog/compare/c5a5fad...f1288c5
[1.2.0]: https://github.com/marcsalot/birddog/compare/74c3238...c5a5fad
[1.1.0]: https://github.com/marcsalot/birddog/compare/8453eb7...74c3238
[1.0.0]: https://github.com/marcsalot/birddog/compare/f19aa7a...8453eb7
[0.3.0]: https://github.com/marcsalot/birddog/compare/87709b1...f19aa7a
[0.2.0]: https://github.com/marcsalot/birddog/compare/1137fab...87709b1
[0.1.0]: https://github.com/marcsalot/birddog/commit/1137fab
