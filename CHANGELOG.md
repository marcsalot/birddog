# Changelog

All notable changes to Birddog. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

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
- `npx bird-dog`: package metadata, and both `birddog` and `bird-dog` commands.

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

[1.1.0]: https://github.com/marcsalot/birddog/compare/8453eb7...main
[1.0.0]: https://github.com/marcsalot/birddog/compare/f19aa7a...8453eb7
[0.3.0]: https://github.com/marcsalot/birddog/compare/87709b1...f19aa7a
[0.2.0]: https://github.com/marcsalot/birddog/compare/1137fab...87709b1
[0.1.0]: https://github.com/marcsalot/birddog/commit/1137fab
