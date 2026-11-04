# 🐾 Birddog

**What needs me next?** Birddog is a local-first dashboard for developers. A bird dog finds what matters and points at it: Birddog sniffs through your work, ranks it with plain rules, and tells you *why* each thing is in your list.

<!-- Screenshot placeholder: add docs/screenshot.png and replace this comment with
     ![Birddog inbox](docs/screenshot.png). A demo GIF comes in v0.4. -->
> 📸 *Screenshot coming soon.*

- **Local-first.** Runs on your machine, binds to `127.0.0.1`, stores everything in a JSON file you can read. No account, no cloud, no telemetry.
- **Explains itself.** Every item has a "why" line and names the rule that put it there. No mystery scores.
- **Keyboard-first.** `j`/`k` to move, `x` done, `s` snooze, `z` undo, `⌘K` for everything else.
- **Zero runtime dependencies.** Node 22+ and `git`. That's it.
- **Read-only.** Birddog looks at git, GitHub and Jira. It never pushes, comments, transitions or marks anything as read.
- **Optional SSO.** Put Birddog behind your Google, Okta or Entra login when you run it somewhere shared.

> **Status: v0.2, milestone 2.** Local git, GitHub and Jira Cloud sources are live. A Calendar source is on the way (it shows as "coming soon" in setup).

## Quick start

```bash
npx bird-dog --open
```

Or from a clone:

```bash
git clone <this repo> birddog && cd birddog
node bin/birddog.mjs --open
```

On first run Birddog looks for your code in the usual places (`~/code`, `~/src`, `~/projects`, `~/Developer`, …) and falls back to the folder you ran it from. Change the folders any time in **Connect a source** (or press `⌘K` → "Connect a source").

```
birddog                 start on http://127.0.0.1:4747
birddog --open          start and open your browser
birddog --port 5000     use another port
birddog --host 0.0.0.0  listen beyond localhost (only with login turned on)
birddog secret set oidc-client-secret   store a secret in your keychain (reads stdin)
birddog --help
```

If the port is busy, Birddog tries the next one. If Birddog is already running, `birddog --open` just opens the existing one.

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

## How ranking works

Rules live in [`src/rules.mjs`](src/rules.mjs). They are checked top to bottom and the first match wins. Order also breaks ties inside a group: people waiting on you come first, then deadlines, then local git hygiene.

| Source | Rule | Urgency |
|---|---|---|
| GitHub | Review requested of you over a day ago | **Now** |
| GitHub | Assigned issue in a milestone that is past due | **Now** |
| Jira | Ticket past its due date | **Now** |
| Jira | Sprint ends within a day and the ticket is not done | **Now** |
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

Tokens and keys go to the **macOS Keychain**, or **Secret Service** on Linux (via `secret-tool`), under the service name `birddog`. Elsewhere they fall back to `secrets.json` in the config folder with mode 600. The startup banner says which one is in use. Force one with `BIRDDOG_SECRETS=keychain|secret-service|file`.

## Configuration

`~/.config/birddog/config.json` (or `$XDG_CONFIG_HOME/birddog`, or `$BIRDDOG_HOME`):

```json
{
  "port": 4747,
  "refreshMinutes": 5,
  "sources": {
    "git": { "enabled": true, "roots": ["~/code"], "maxDepth": 3, "staleDays": 30 },
    "github": { "clientId": "Ov23li…" },
    "jira": { "enabled": true, "site": "https://acme.atlassian.net", "email": "you@acme.com" }
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
- `enabledByDefault = false`: keep the source off until the user saves its settings (Jira does this).

The rules of the road:

- **Throw when you can't collect.** Birddog keeps your last good items, marks them stale with a timestamp, and shows the error with a "Fix in setup" link. One broken source never empties the inbox.
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
src/sources/http.mjs   GET-only JSON helper shared by the web sources
public/                the UI: plain HTML, CSS and ES modules, no build step
test/                  node:test suites
```

## Roadmap

1. ✅ Skeleton, local git source, real UI, optional SSO, GitHub sign-in, OS keychain secrets
2. ✅ GitHub and Jira Cloud sources
3. Setup wizard for the remaining sources, calendar (iCal) source
4. Read-only MCP server so your AI tools can ask "what needs me?", demo GIF, npm release

## License

[MIT](LICENSE) © Marcus Ferrell
