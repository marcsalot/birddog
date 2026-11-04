# Changelog

All notable changes to Birddog. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

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

[1.6.0]: https://github.com/marcsalot/birddog/compare/0b78f3b...main
[1.5.0]: https://github.com/marcsalot/birddog/compare/35cffb9...0b78f3b
[1.4.0]: https://github.com/marcsalot/birddog/compare/f1288c5...35cffb9
[1.3.0]: https://github.com/marcsalot/birddog/compare/c5a5fad...f1288c5
[1.2.0]: https://github.com/marcsalot/birddog/compare/74c3238...c5a5fad
[1.1.0]: https://github.com/marcsalot/birddog/compare/8453eb7...74c3238
[1.0.0]: https://github.com/marcsalot/birddog/compare/f19aa7a...8453eb7
[0.3.0]: https://github.com/marcsalot/birddog/compare/87709b1...f19aa7a
[0.2.0]: https://github.com/marcsalot/birddog/compare/1137fab...87709b1
[0.1.0]: https://github.com/marcsalot/birddog/commit/1137fab
