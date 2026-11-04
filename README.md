# 🐾 Birddog

[![npm](https://img.shields.io/npm/v/@marcusferrell/birddog?color=f5b700)](https://www.npmjs.com/package/@marcusferrell/birddog)
[![Node 22+](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![CI](https://github.com/marcsalot/birddog/actions/workflows/ci.yml/badge.svg)](https://github.com/marcsalot/birddog/actions/workflows/ci.yml)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)

**What needs me next?** Birddog is a local-first inbox for developers. It looks through your local git repos, GitHub, Jira and calendar, ranks what it finds with plain rules, and tells you *why* each thing is there.

![Birddog demo: the inbox, opening an item, marking one done, snoozing another, and switching themes](https://raw.githubusercontent.com/marcsalot/birddog/main/docs/demo.gif)

```bash
npx @marcusferrell/birddog --demo --open  # look around with made-up data (http://127.0.0.1:4848)
npx @marcusferrell/birddog --open         # the real thing (http://127.0.0.1:4747)
```

You need Node 22 or newer. There's no account and no cloud, and the package has no dependencies. See [Install](#install) for `npm i -g`, Docker and running from source.

## Why

Work-in-progress hides in too many places: a branch you forgot to push, a review someone is waiting on, a Jira ticket due tomorrow, a meeting in ten minutes. Each tool has its own inbox and its own idea of "important". Birddog puts them in one list and is upfront about its reasoning:

> **@ana-lopez** requested your review **2 days** ago · they are waiting on you
> *Rule: Review requested of you over a day ago → Now*

- **Explains itself.** Every item has a "why" line and names the rule that put it there. There are no scores and no machine learning, just a list of rules you can read in [`src/rules.mjs`](src/rules.mjs).
- **Local-first.** It runs on your machine, listens only on `127.0.0.1`, and keeps its state in JSON files you can read. There's no telemetry.
- **Read-only.** It never pushes, comments, moves tickets, RSVPs, or marks notifications as read. Done and snooze only change Birddog's own list.
- **Keyboard-first.** `j`/`k` to move, `x` done, `s` snooze, `z` undo, `⌘K` for everything else.
- **Zero runtime dependencies.** It's plain Node and browser JavaScript. Even the iCalendar parser and the MCP server are hand-written.
- **Talks to your AI tools.** `birddog mcp` lets Claude Code, Claude Desktop or any MCP client ask "what needs me?" and triage items.

## Install

**1. With npm** (recommended; needs [Node.js](https://nodejs.org) 22 or newer):

```bash
npx @marcusferrell/birddog --open       # run it straight away, nothing installed
```

```bash
npm install -g @marcusferrell/birddog    # or install it for good …
birddog --open                            # … then run it as birddog
```

The npm package is `@marcusferrell/birddog` (the plain name `birddog` is taken); the command is `birddog` either way. Upgrade with `npm install -g @marcusferrell/birddog@latest`.

**2. With Docker**: no Node needed. See [Run it in Docker](#run-it-in-docker).

**3. From source** (no `npm install` step, because there are no dependencies):

```bash
git clone https://github.com/marcsalot/birddog && cd birddog
node bin/birddog.mjs --open
```

### First run

On first run a **setup wizard** walks you through each source: your code folders (Birddog guesses `~/code`, `~/src`, `~/projects`, `~/Developer`, …, or the folder you ran it from), then GitHub, Jira and your calendar. Each step runs that source's test as soon as you reach it, so you see straight away whether it works. Skip whatever you don't use; skipping GitHub switches it off so it doesn't sit there as "stale". You can change anything later in **Connect a source**, or run the wizard again with `⌘K` → "Run the setup wizard".

```
birddog                 start on http://127.0.0.1:4747
birddog --open          start and open your browser
birddog --demo          made-up data in a temporary folder on :4848; your real setup is never touched
birddog mcp             MCP server on stdio (add --demo for made-up data)
birddog --port 5000     use another port
birddog --host 0.0.0.0  listen beyond localhost (only with login turned on; also BIRDDOG_HOST)
birddog secret set jira-token   store a secret in your keychain (reads stdin; also cal-url, oidc-client-secret)
birddog --version
birddog --help
```

If the port is busy, Birddog tries the next one. If Birddog is already running, `birddog --open` just opens the existing one.

### Demo mode

`birddog --demo` starts Birddog with an imaginary company's repos, PRs, tickets and meetings. It uses a fresh temporary folder, an in-memory secret store and a fake network layer. Your repos, tokens and calendar are never read, nothing goes over the network, and everything is deleted when you stop it. The real GitHub, Jira and Calendar sources run against fake APIs, so the ranking and "why" lines are exactly what real data would produce. The GIF above was recorded this way.

## Run it in Docker

If you'd rather not install Node, or you want Birddog running all the time on a home server, use the image. It's built from this repo on `node:22-alpine` with `git` added, runs as a non-root user, and contains only what the npm package ships.

```bash
git clone https://github.com/marcsalot/birddog && cd birddog
docker build -t birddog:local .
docker run --rm -p 127.0.0.1:4848:4747 birddog:local --demo --port 4747   # made-up data: open http://127.0.0.1:4848
```

The real thing, with your config and triage state on a volume and your code mounted **read-only**:

```bash
docker run -d --name birddog --restart unless-stopped \
  -p 127.0.0.1:4747:4747 \
  -v birddog-data:/data \
  -v ~/code:/repos:ro \
  -e TZ=Europe/Berlin \
  -e GITHUB_TOKEN \
  birddog:local
```

Or with Compose, which does the same and also has a demo service:

```bash
GITHUB_TOKEN=$(gh auth token) docker compose up -d     # http://127.0.0.1:4747
docker compose --profile demo up birddog-demo          # http://127.0.0.1:4848, no mounts, no tokens
```

> ⚠️ **Publish the port on `127.0.0.1` only**, as every example here does. Inside the container Birddog listens on `0.0.0.0`, because that's the only way Docker can forward to it, and it trusts Docker to keep the port on your loopback. `-p 4747:4747` or `-p 0.0.0.0:4747:4747` would let anyone on your network read your work inbox: PR titles, ticket names, meetings. To reach it from other machines, put it behind [login](#login-for-the-dashboard-sso) and a reverse proxy with HTTPS.

**How the container differs from running it directly**

| | Directly | In Docker |
|---|---|---|
| Listens on | `127.0.0.1` (change with `--host` or `BIRDDOG_HOST`) | `0.0.0.0` inside, published to host loopback |
| Config and state | `~/.config/birddog` | the `/data` volume (`birddog-data`): survives restarts and rebuilds |
| Your repos | any folder | whatever you mount, read-only; scan `/repos` (the default on first run) |
| Secrets | OS keychain | **environment variables or Docker secret files only**: never written to `/data` |
| GitHub sign-in | `gh` CLI or device flow | `GITHUB_TOKEN` |
| Time zone | your machine's | set `TZ`, or meeting times show in UTC |

`BIRDDOG_CONTAINER=1` (set in the image) switches all of this on. Birddog never guesses whether it runs in Docker.

**Tokens in a container.** A container has no keychain, so Birddog reads secrets from the environment and refuses to keep them in a plain-text file on the volume. Setup shows where each one comes from (never its value) and what to set if it's missing:

| Secret | Variable | Or a file (Docker secret) |
|---|---|---|
| GitHub token | `GITHUB_TOKEN` (or `GH_TOKEN`) | `GITHUB_TOKEN_FILE=/run/secrets/github` |
| Jira API token | `BIRDDOG_JIRA_TOKEN` | `BIRDDOG_JIRA_TOKEN_FILE` |
| Calendar iCal link | `BIRDDOG_CAL_URL` | `BIRDDOG_CAL_URL_FILE` |
| OIDC client secret (login) | `BIRDDOG_OIDC_CLIENT_SECRET` | `BIRDDOG_OIDC_CLIENT_SECRET_FILE` |
| Session signing key (login) | `BIRDDOG_SESSION_KEY` | `BIRDDOG_SESSION_KEY_FILE` |

The Jira site and email, the repo folders and everything else are set in setup as usual and saved on the volume. Pass tokens with `-e NAME` (the value comes from your shell, not the command line), with an `--env-file` you keep out of git, or as files under `/run/secrets`; `docker-compose.yml` shows the secrets version. To try the env-variable mode outside Docker, set `BIRDDOG_SECRETS=env`.

**MCP through Docker.** Stdio works through `docker run -i`. Share the dashboard's volume so both see the same items and triage:

```bash
claude mcp add birddog -- docker run -i --rm -v birddog-data:/data -v ~/code:/repos:ro birddog:local mcp
```

```json
{
  "mcpServers": {
    "birddog": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-v", "birddog-data:/data", "-v", "/Users/you/code:/repos:ro", "birddog:local", "mcp"]
    }
  }
}
```

Leave out `-p`; the MCP server doesn't listen on a port. It reads what the dashboard container last collected. If that's older than two refresh intervals, it refreshes itself, and then it needs the same tokens (add `-e GITHUB_TOKEN`, or `-v ~/.secrets/github:/run/secrets/github:ro -e GITHUB_TOKEN_FILE=/run/secrets/github`). Claude Desktop needs the full path to `docker` if it isn't on its `PATH`.

## Sources

| Source | What it finds | How it connects |
|---|---|---|
| **Local git** | Unpushed commits, uncommitted work, merged and stale branches | Scans folders you pick; runs read-only `git` commands |
| **GitHub** | Review requests, your PRs with failing checks, change requests or conflicts, unread @mentions, assigned issues | Your existing `gh` login, or "Sign in with GitHub" (device flow) |
| **Jira Cloud** | Your tickets: overdue, sprint ending, blocked, high priority | Site + email + API token |
| **Calendar** | Meetings starting soon or later today, all-day events | Any iCal link (Google, Outlook, iCloud) or `.ics` file |

When a source fails, its last good items stay in the list, marked stale, with a **Retry** button. One broken token never empties your inbox. Details for each source are [further down](#what-it-finds-local-git).

## Privacy and secrets

- Everything stays on your machine: config, cache and triage state live in `~/.config/birddog/` as plain JSON.
- Tokens and private calendar links go to your **OS keychain** (macOS Keychain, or Secret Service on Linux), never into config files, never into API responses, and never to the browser. If no keychain is available, Birddog says so clearly before falling back to a file only you can read. See [Secrets](#secrets).
- Birddog only talks to the services you connect, with `GET` requests, and to nothing else.
- For a shared machine, you can put the dashboard behind your own OpenID Connect login (Google, Okta, Entra, …). See [Login](#login-for-the-dashboard-sso).
- In [Docker](#run-it-in-docker), tokens come only from environment variables or Docker secrets and are never written to the volume. Your repos are mounted read-only, and the port is published to `127.0.0.1` only.

## Use it from Claude (MCP)

`birddog mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io) server over stdio. It reads the same data as the dashboard, so both can run at once, and decisions made in one show up in the other.

**Claude Code:**

```bash
claude mcp add birddog -- npx -y @marcusferrell/birddog mcp
```

**Claude Desktop:** add this to `claude_desktop_config.json` (Settings → Developer → Edit Config), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "birddog": {
      "command": "npx",
      "args": ["-y", "@marcusferrell/birddog", "mcp"]
    }
  }
}
```

Claude Desktop starts servers with a short `PATH`. If it can't find `npx`, use the full path (`which npx`). If you use the GitHub CLI login, add `"env": { "PATH": "/opt/homebrew/bin:/usr/bin:/bin" }` so Birddog can find `gh`.

Want to try it first? Use `["-y", "@marcusferrell/birddog", "mcp", "--demo"]` and it runs on made-up data.

| Tool | What it does |
|---|---|
| `list_items` | What needs you, most urgent first, each with its "why". Filter by `urgency`, `source`, `status`; `limit`. |
| `get_item` | One item in full: rule, fields, link, suggested next step. |
| `list_sources` | Which sources are connected, item counts, and which are stale (with the error). |
| `mark_done` | Done in Birddog until the item changes. |
| `snooze` | Hide until `1h`, `3h`, `2d`, `tomorrow`, `next-week`, `change`, or a date. |
| `restore` | Undo a done or snooze. |

The tools return titles, "why" lines, links and fields, never tokens, secrets or settings. Triage tools only change Birddog's own list. If the dashboard hasn't refreshed recently, the MCP server refreshes the sources itself.

## How it works

```
 sources (git, GitHub, Jira, iCal)        each returns Items: title, why, urgency, url, fields
        │   plain rules rank them          src/rules.mjs: first match wins, the rule is shown
        ▼
 collector ── cache.json                  keeps the last good result per source; stale + backoff on failure
        │
 triage ──── state.json                   done / snooze, comes back when the item changes
        │
        ├── HTTP server + UI               127.0.0.1 only, strict CSP, no build step (public/)
        └── MCP server (stdio)             birddog mcp
 secrets ─── OS keychain                  tokens and private links, never in files or responses
```

Each source is one small ES module with `test()` and `collect()`. Adding one is about a page of code; see [Writing a source](#writing-a-source). The whole thing is about 5,700 lines of JavaScript with 164 `node:test` tests, and none of the tests touch the network. CI runs them on Node 22 and 24 and inside the Docker image.

## What it finds (local git)

Birddog scans the folders you choose (3 levels deep, skipping `node_modules`, `vendor`, `dist` and friends) and reports:

| Item | Example "why" | Suggested next step (copy with `c`) |
|---|---|---|
| Unpushed commits | **3 commits** only on this machine for **5 days** · push to back them up | `git -C ~/code/api push -u origin feat/x` |
| Uncommitted changes | Edits sitting uncommitted for **4 days** · commit or stash before they get lost | `git -C ~/code/api status` |
| Merged branches | Already merged into **main** · safe to delete | `git -C ~/code/api branch -d old-a old-b` |
| Stale branches | No commits in **3 months** · finish, rebase or delete | `git -C ~/code/api branch -vv` |

It is read-only: it never fetches, commits, pushes or deletes. It only runs `git status`, `for-each-ref`, `log`, `branch --merged`, `symbolic-ref` and `remote`, each with a timeout and with `GIT_OPTIONAL_LOCKS=0` so it never fights your editor for the index lock.

## What it finds (GitHub)

Sign in once in **Connect a source** (see [Sign in with GitHub](#sign-in-with-github)) and Birddog shows:

| Item | Example "why" | Suggested next step |
|---|---|---|
| Review requests | **@ana** requested your review **2 days** ago · they are waiting on you | `gh pr checkout 12 -R acme/api` |
| Your PRs with changes requested | **@ben** requested changes **1 day** ago · address the feedback | `gh pr view 20 -R acme/api --comments` |
| Your PRs with failing checks | **2 checks failing**: test, lint · fix before reviewers look | `gh pr checks 20 -R acme/api` |
| Your PRs with merge conflicts | **Merge conflicts** with **main** · merge or rebase to unblock it | |
| Unread @mentions (last 14 days) | **@dee** mentioned you **5 hours** ago | `gh issue view 30 -R acme/api --comments` |
| Issues assigned to you | Milestone **v2.1** is due **tomorrow** · assigned to you | `gh issue view 40 -R acme/api` |

How it decides:

- **Review requests** come from the search `is:open is:pr review-requested:@me`. The PR's events say who asked and when. Requests made of a team you are on, and drafts, rank lower than requests made of you.
- **Your PRs** come from `is:open is:pr author:@me`. A PR shows up only when something needs you: a reviewer whose latest verdict is "changes requested", a failing check run or commit status, or merge conflicts. Clean PRs stay out of your way.
- **Mentions** come from your unread GitHub notifications with reason `mention` or `team_mention`. If the latest comment on the thread is yours, you already answered, so it is skipped. Birddog never marks notifications as read.
- **Assigned issues** rank higher when their milestone is due within 3 days (or overdue), or when they carry a label like `P0`, `P1`, `urgent`, `critical`, `blocker` or `priority: high`.
- If one PR or issue shows up for two reasons (say, assigned *and* mentioned), you see it once, under the more urgent one.
- Each search shows the 50 most recently updated results. A refresh costs 3 searches, one notifications call and a few calls per PR, well inside GitHub's rate limits.

Not signed in? The GitHub source shows as stale with a "Sign in to GitHub in setup" link. GitHub Enterprise works too: set `webUrl` and `apiUrl` under `sources.github`.

## What it finds (Jira Cloud)

The open tickets assigned to you (`assignee = currentUser() AND statusCategory != Done`), ranked:

| Example "why" | Urgency |
|---|---|
| **Overdue** · was due **2 days ago** and is still In Progress | Now |
| Sprint **Sprint 42** ends **today** · still In Progress | Now |
| **Blocked** by PAY-12 · chase it or pick up something else | Today |
| Due **in 2 days** · In Review | Today |
| **Highest** priority · To Do | Today |
| **In Progress** · last updated **10 days** ago | Later |

"Blocked" means an *is blocked by* link to a ticket that is not done, the **Flagged** field, or a status named like *Blocked* or *On hold*. Sprint deadlines come from the active sprint on the ticket. Want a different set of tickets? Put your own JQL in config.json as `sources.jira.jql`.

### Connect Jira

1. Create an API token at [id.atlassian.com → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens) (**Create API token**, the plain kind without scopes).
2. In Birddog, open **Connect a source** → **Jira Cloud**, enter your site (`acme` or `acme.atlassian.net`), your Atlassian email and the token, then **Test & connect**.

Birddog tests the settings before it saves anything. The token goes to your OS keychain (see [Secrets](#secrets)); config.json only gets the site and email. **Disconnect** deletes the token and switches the source off. Jira is off until you connect it, so people without Jira never see it complain.

Why an API token and not Atlassian OAuth? OAuth would mean registering your own app in the Atlassian developer console and keeping a client secret, which is a lot more setup than one token for a tool that runs on your machine.

## What it finds (Calendar)

Your meetings from any iCalendar feed or `.ics` file:

| Example "why" | Urgency |
|---|---|
| Starts **in 10 minutes** · Google Meet | Now |
| **Happening now** · started 5 minutes ago, ends at 10:30 | Now |
| Starts at **14:00** (in 3 hours) · Room 4 | Today |
| **All day** today | Later |
| Tomorrow at **09:30** · Zoom | Later |

Open the item (`o`) to join: Birddog picks the Zoom, Meet, Teams or Webex link out of the event. Finished meetings disappear; cancelled ones never show up. Add your email in setup and meetings you declined are hidden too.

### Connect a calendar

Paste the private iCal address of your calendar into **Connect a source** → **Calendar**, then **Test & connect**:

- **Google Calendar:** Settings → your calendar → Integrate calendar → *Secret address in iCal format*.
- **Outlook / Microsoft 365:** Settings → Calendar → Shared calendars → Publish a calendar → the *ICS* link.
- **iCloud:** share a calendar as a *Public Calendar* and copy the link (`webcal://` links are fine).

That link works like a password (anyone who has it can read your calendar), so Birddog keeps it in your OS keychain as `cal-url`, never in config.json, and never shows it in the UI, the API or error messages (only its host name). You can also point at a local `.ics` file instead, or as well.

The reader is built in (no dependencies) and handles what real feeds contain: folded lines and escapes, UTC, `TZID` and floating times, Windows zone names from Outlook, all-day and multi-day events, `DURATION`, recurring events (`RRULE` with `DAILY`/`WEEKLY`/`MONTHLY`/`YEARLY`, `INTERVAL`, `COUNT`, `UNTIL`, `BYDAY` such as `2TU` or `-1FR`, `BYMONTHDAY`, `BYMONTH`), `EXDATE`, `RDATE`, and single instances that were moved or cancelled (`RECURRENCE-ID`). Recurring events keep their wall-clock time across daylight saving changes. A zone it doesn't know falls back to the zone's standard offset, with a warning in setup. Not supported: `BYSETPOS`, `HOURLY`/`MINUTELY` rules and `BYWEEKNO` (such events show their first occurrence only).

## When a source breaks

Birddog never empties your inbox because one source failed. If GitHub is down, your token expired or a calendar link moved:

- The source's last good items stay in the list, each marked **⚠ stale since 10:48**.
- A bar above the list names the source, says how old its data is, shows the error, and has **Retry** (try now) and **Fix** (open setup).
- The sidebar marks the source **! stale**; hover it for the next automatic try.
- Automatic refreshes back off for a source that keeps failing: 2, 4, 8, 16, 32 minutes, then hourly. Refreshing by hand (`r`) or pressing **Retry** always tries right away. The other sources keep refreshing on schedule.
- The last good data is kept in `cache.json`, so it survives a restart.

## How ranking works

Rules live in [`src/rules.mjs`](src/rules.mjs). They are checked top to bottom and the first match wins. Order also breaks ties inside a group: people waiting on you come first, then deadlines, then local git hygiene.

| Source | Rule | Urgency |
|---|---|---|
| Calendar | Meeting in progress or starting within 15 minutes | **Now** |
| GitHub | Review requested of you over a day ago | **Now** |
| GitHub | Assigned issue in a milestone that is past due | **Now** |
| Jira | Ticket past its due date | **Now** |
| Jira | Sprint ends within a day and the ticket is not done | **Now** |
| Calendar | Meeting later today | Today |
| GitHub | Fresh review request for you | Today |
| GitHub | Your PR has changes requested | Today |
| GitHub | Your PR has failing checks | Today |
| GitHub | Your PR has merge conflicts | Today |
| GitHub | Assigned issue in a milestone due within 3 days | Today |
| GitHub | Assigned issue labeled urgent, critical, P0 or P1 | Today |
| GitHub | Unread @mention from the last 3 days | Today |
| Jira | Ticket is blocked or flagged | Today |
| Jira | Ticket due within 3 days | Today |
| Jira | Sprint ends within 3 days and the ticket is not done | Today |
| Jira | High, Highest, Critical or Blocker priority | Today |
| Calendar | All-day event today | Later |
| Calendar | Meeting tomorrow | Later |
| GitHub | Review requested of your team, or on a draft | Later |
| GitHub | Your draft PR has failing checks, conflicts or change requests | Later |
| GitHub | Older unread @mention | Later |
| GitHub | Other open issues assigned to you | Later |
| Jira | Other open tickets assigned to you | Later |
| git | Unpushed commits older than 3 days | **Now** |
| git | Unpushed commits older than 1 day | Today |
| git | Fresh unpushed commits | Later |
| git | Uncommitted edits older than 3 days | Today |
| git | Recent uncommitted edits | Later |
| git | Only untracked files | Later |
| git | Local branches already merged | Later |
| git | Unmerged branches with no commits for 30 days (or remote branch deleted) | Later |

Inside a group, items sort by rule order, then oldest first (the work that has waited longest is most at risk). A branch counts as either stale *or* unpushed, never both, and repos with no remote are never nagged about pushing.

## Triage

- **Done** (`x`) hides an item until it changes. New commits on that branch, or new files in that repo, bring it back.
- **Snooze** (`s`, then `1`–`4`): 1 hour, tomorrow 9:00, next Monday 9:00, or *until it changes*.
- **Undo** (`z`) after either. **Restore** (`u`) from the Done or Snoozed view.
- Decisions about items you have not seen for 30 days are forgotten.

All of it lives in `~/.config/birddog/state.json`, along with your theme.

## Keyboard

| Key | Action | Key | Action |
|---|---|---|---|
| `j` / `k` | move down / up | `↵` | open details |
| `x` | done | `s` | snooze |
| `z` | undo | `u` | restore |
| `c` | copy suggested command | `o` | open link |
| `r` | refresh | `/` or `⌘K` | command palette |
| `1`–`6` | All / Now / Today / Later / Snoozed / Done | `?` | shortcuts |
| `t` | light / dark | `p` | next theme |

## Themes

Three palettes, each in light, dark or system mode: **Retriever gold** (default), **Electric violet** and **Sunset**. Pick one from **Appearance**, or press `p` to cycle.

## Sign in with GitHub

Connect from **Connect a source** → **GitHub**. You never paste a token:

- **Use my gh CLI login.** If you already ran `gh auth login`, Birddog asks `gh` for a token whenever it needs one and keeps no copy.
- **Sign in with GitHub** (device flow). Birddog shows a short code; you approve it on github.com. This needs a GitHub OAuth App client ID, because each install should use its own app:
  1. GitHub → Settings → Developer settings → OAuth Apps → **New OAuth App** (any homepage and callback URL, e.g. `http://127.0.0.1:4747`).
  2. Tick **Enable Device Flow**, save, and copy the **Client ID** (no secret needed).
  3. Add it to config.json: `"sources": { "github": { "clientId": "Ov23li…" } }` and restart.

  The token goes into your OS keychain. For GitHub Enterprise, also set `webUrl` and `apiUrl` there.

Mentions come from GitHub notifications, which fine-grained personal access tokens cannot read; with the gh CLI or device flow they just work. **Disconnect** forgets the token (or, for gh, just stops asking `gh`).

## Login for the dashboard (SSO)

Off by default: on `127.0.0.1` only you can reach Birddog. Turn it on when you run Birddog somewhere shared, such as a home server or a VM behind a reverse proxy. It works with any OpenID Connect provider: Google, Okta, Microsoft Entra ID, Auth0, Keycloak, Authentik, …

**Try it first without a provider:**

```bash
npm run dev:login
```

This starts a mock sign-in provider and a Birddog with login on at `http://127.0.0.1:4748`, using its own `.birddog-dev/` folder (your real config is untouched). Pick `you@example.com` to get in, `stranger@example.org` to see a refusal, or Cancel. Edit `.birddog-dev/auth.json` to change who is allowed.

**For real:**

1. Register a **web application** with your provider. Redirect URI: `http://127.0.0.1:4747/auth/callback` (or `https://your-host/auth/callback` when you set `publicUrl`).
2. Put your login settings in `auth.json` next to config.json (or in an `auth` block inside config.json; `auth.json` wins if both exist, and deleting it turns login off):

   ```json
   {
     "enabled": true,
     "issuer": "https://accounts.google.com",
     "clientId": "1234-abc.apps.googleusercontent.com",
     "allowedEmails": ["you@example.com"],
     "allowedDomains": ["yourteam.dev"],
     "publicUrl": "https://birddog.example.com"
   }
   ```

3. If your provider gives you a client secret, keep it out of config.json:

   ```bash
   pbpaste | birddog secret set oidc-client-secret
   ```

   (or set `BIRDDOG_OIDC_CLIENT_SECRET`). Then restart Birddog. With login on you may also listen beyond localhost, e.g. `birddog --host 0.0.0.0`.

How it behaves:

- Pages redirect to your provider, and API calls without a session get `401`. After sign-in you land back where you were.
- Authorization code flow with **PKCE**, `state` and `nonce`. The ID token's signature (RS256/PS256/ES256 families, from the provider's published keys), issuer, audience and expiry are all checked.
- **Allow list required.** Birddog refuses to start with login on unless `allowedEmails` or `allowedDomains` says who may sign in; otherwise anyone with a Google account could. Unverified emails are refused. Removing someone from the list locks them out on their next request.
- Sessions are signed, `HttpOnly`, `SameSite=Lax` cookies (`__Host-` and `Secure` over https), 7 days by default (`sessionDays`). The signing key lives in your OS keychain.
- `publicUrl` is also the only extra `Host` Birddog will answer to.

## Secrets

Every secret Birddog holds (the GitHub token from device sign-in, the Jira API token, your calendar's iCal link, the login session key and the OIDC client secret) goes to the **macOS Keychain**, or **Secret Service** on Linux (via `secret-tool`), under the service name `birddog`:

- **Never in config files.** Setup sends secrets straight to the keychain. If you type one into config.json by hand (say `sources.jira.token`), Birddog moves it into the keychain on the next start and removes it from the file.
- **Never in API responses.** `/api/setup` only says *whether* a secret is saved. Settings whose names look like credentials (`token`, `secret`, `password`, `apiKey`, …) are never sent to the browser.
- **Any value works.** Values go to the `security` tool over stdin, hex-encoded, so they never appear in `ps` and no character can break the command.
- **No keychain?** On other systems, or Linux without `secret-tool` (install `libsecret-tools` and a keyring such as GNOME Keyring), Birddog falls back to `secrets.json` in the config folder, readable only by you (mode 600) but **not encrypted**. The startup banner and the setup screen say so in plain words.

Force a backend with `BIRDDOG_SECRETS=keychain|secret-service|file|env`. `env` is read-only: it takes secrets from environment variables and `*_FILE` files, as in [Docker](#run-it-in-docker). Store or remove one by hand with `birddog secret set|delete <name>` (`jira-token`, `cal-url`, `oidc-client-secret`), piping the value in.

## Configuration

`~/.config/birddog/config.json` (or `$XDG_CONFIG_HOME/birddog`, or `$BIRDDOG_HOME`):

```json
{
  "port": 4747,
  "refreshMinutes": 5,
  "sources": {
    "git": { "enabled": true, "roots": ["~/code"], "maxDepth": 3, "staleDays": 30 },
    "github": { "clientId": "Ov23li…" },
    "jira": { "enabled": true, "site": "https://acme.atlassian.net", "email": "you@acme.com" },
    "cal": { "enabled": true, "file": "", "email": "you@acme.com" }
  }
}
```

Every source key is optional. Next to it: `state.json` (done/snooze/preferences), `cache.json` (last good data from each source) and `connections.json` (who you are signed in as; never tokens). Tokens live in the keychain. Changes to `auth` take effect on restart.

## Writing a source

A source is an ES module in `src/sources/` that exports four things, then gets added to `SOURCES` in [`src/sources/index.mjs`](src/sources/index.mjs):

```js
export const id = 'weather';           // unique, used in item ids and config
export const name = 'Weather';         // shown in the UI

// Can this source work with this config? Shown in setup.
export async function test(config, ctx) {
  return { ok: true, message: 'Connected as @you' };
}

// Return what needs attention right now.
export async function collect(config, ctx) {
  // ctx.now           timestamp of this run
  // ctx.warn(s)       report a non-fatal problem
  // ctx.summary(s)    one line for setup, e.g. "12 repos scanned"
  // ctx.fetch         fetch() to use (tests swap in a fake)
  // ctx.secret(name)  read a secret from the OS keychain
  // ctx.github        the GitHub sign-in: await ctx.github.token()
  return [{
    id: 'weather:umbrella',
    source: 'weather',
    kind: 'umbrella',
    title: 'Take an umbrella',
    url: 'https://example.com/forecast',  // http(s) or null
    why: 'Rain from **3 PM** · you have a walk at 4',
    urgency: 'today',                      // 'now' | 'today' | 'later'
    updatedAt: new Date().toISOString(),
    meta: {
      fields: { Chance: '80%' },          // shown in the details drawer
      command: 'open https://example.com',// optional "next step" with a copy button
      fingerprint: 'rain-3pm',            // when this changes, done/snoozed items come back
    },
  }];
}
```

Optionally export:

- `description`: a sentence for setup.
- `normalizeSettings(input)`: validates what the setup screen may change and returns the config patch (throw to reject).
- `secretFields`: setup fields that are secrets, e.g. `{ token: 'weather-token' }`. Birddog stores them in the keychain under that name, strips them before `normalizeSettings` sees the form, and never writes them to config.json. `test()` gets the unsaved draft through `ctx.secret()`, so "Test" works before "Save". A blank field keeps the saved secret.
- `validateSecrets(values)`: check or clean secret values (keyed by secret name) before they are tested or stored; throw to reject. Calendar uses it to turn `webcal://` into `https://`.
- `enabledByDefault = false`: keep the source off until the user saves its settings (Jira and Calendar do this).

The rules of the road:

- **Throw when you can't collect.** Birddog keeps your last good items, marks them stale with a timestamp, shows the error with **Retry** and **Fix** buttons, and backs off (see [When a source breaks](#when-a-source-breaks)). One broken source never empties the inbox.
- **Items are validated.** A bad urgency or a non-http URL fails the run instead of rendering junk.
- **Keep `why` short and specific.** It is the most important line in the app. `**bold**` is the only markup.
- **Rank with rules** from `src/rules.mjs`, so the drawer can say which rule fired.
- Each run has a 60 second timeout.
- **Stay read-only.** Sources only send `GET` requests (see [`src/sources/http.mjs`](src/sources/http.mjs)).

## API

The UI talks to a small JSON API on the same port. It answers only on `localhost`/`127.0.0.1` (plus `auth.publicUrl` when login is on), rejects foreign `Host` and `Origin` headers, and only accepts JSON writes, so other websites cannot read or change your data.

| Method | Path | |
|---|---|---|
| `GET` | `/api/items` | items (with `status`: open/done/snoozed) and per-source status |
| `POST` | `/api/refresh` | re-run all sources |
| `POST` | `/api/items/:id/done` | mark done |
| `POST` | `/api/items/:id/snooze` | `{ "until": "<ISO date>" \| "change" }` |
| `POST` | `/api/items/:id/restore` | undo done/snooze |
| `GET`/`PUT` | `/api/prefs` | theme, mode, hidden sources |
| `GET` | `/api/setup` | sources and their settings |
| `POST` | `/api/sources/:id/test` | try settings without saving |
| `PUT` | `/api/sources/:id` | save settings (secrets go to the keychain), switch on and rescan |
| `DELETE` | `/api/sources/:id` | disconnect: delete its secrets and switch it off |
| `POST` | `/api/sources/:id/retry` | refresh just this source, now |
| `PUT` | `/api/sources/:id/enabled` | `{ "enabled": true \| false }`: switch a source on or off, keeping its settings |
| `GET` | `/api/me` | whether login is on, and who is signed in |
| `GET` / `DELETE` | `/api/connections/github` | GitHub sign-in status / disconnect |
| `POST` | `/api/connections/github/device` | start "Sign in with GitHub" |
| `POST` | `/api/connections/github/gh-cli` | connect using the gh CLI login |
| `GET` | `/auth/login`, `/auth/callback` | SSO sign-in (when login is on) |
| `POST` | `/auth/logout` | sign out |

## Development

```bash
npm test          # node:test, no dependencies, no network; builds throwaway git repos and fakes GitHub and Jira
npm run dev       # start and open the browser
npm run dev:watch # live reload: restarts on src/ changes, reloads open pages on src/ or public/ changes
```

`dev:watch` uses Node's built-in `--watch`, so it needs nothing extra. It doesn't open a browser, because it would open a new tab on every restart; open `http://127.0.0.1:4747` yourself once.

Layout:

```
bin/birddog.mjs        CLI
src/items.mjs          the Item model and sort order
src/rules.mjs          ranking rules and "why" text
src/collector.mjs      runs sources, keeps last good data, marks stale
src/triage.mjs         done / snooze / prefs (state.json)
src/server.mjs         HTTP server, API and login gate
src/secrets.mjs        OS keychain / Secret Service / file secret store
src/auth/oidc.mjs      OpenID Connect sign-in (PKCE, ID token checks)
src/auth/session.mjs   signed session cookies
src/auth/github.mjs    GitHub device flow and gh CLI sign-in
src/sources/git.mjs    local git source
src/sources/github.mjs GitHub source (review requests, your PRs, mentions, issues)
src/sources/jira.mjs   Jira Cloud source (assigned tickets, blocked work, deadlines)
src/sources/cal.mjs    Calendar source (meetings from an iCal link or .ics file)
src/sources/ical.mjs   iCalendar reader: parsing, time zones, recurring events
src/sources/http.mjs   GET-only helpers shared by the web sources
Dockerfile             multi-stage image: test → package (npm pack) → runtime
docker-compose.yml     the dashboard on a volume, plus a demo profile
.github/workflows/     CI: tests on Node 22 and 24, and inside the image
src/mcp.mjs            MCP server (JSON-RPC over stdio)
src/demo.mjs           demo mode: canned git items and fake GitHub / Jira / calendar APIs
docs/                  demo GIF, screenshot, launch post
test/fixtures/         sample Google- and Outlook-style .ics files
public/                the UI: plain HTML, CSS and ES modules, no build step
test/                  node:test suites
```

## Roadmap

1. ✅ Skeleton, local git source, real UI, optional SSO, GitHub sign-in, OS keychain secrets
2. ✅ GitHub and Jira Cloud sources
3. ✅ Setup wizard, calendar (iCal) source, hardened keychain secrets, stale-source retry and backoff
4. ✅ MCP server, demo mode, `npx @marcusferrell/birddog` release
5. ✅ Docker image, Compose file, CI that runs the tests in the image

Ideas for later: GitLab and Linear sources, a "focus" view that hides Later, desktop notifications for Now.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE) © Marcus Ferrell
