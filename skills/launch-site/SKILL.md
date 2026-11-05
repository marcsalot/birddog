---
name: launch-site
description: Start, stop, restart or list dev copies of the app, one per git worktree, each in its own port slot so they never collide. Use when the user says "launch the site for PROJ-123", "start another dev instance", "spin up a slot", "restart the API", "stop the site", "what slots are running?", "clean up the dev servers", or wants to set up launch-site.json.
---

# launch-site

Runs several copies of the same app side by side, one per git worktree. Each copy lives in a **slot**: a named set of ports plus a lock file that says which worktree holds it. The work is done by Birddog's `birddog slot` command (or `npx @marcusferrell/birddog slot` when `birddog` isn't on PATH). This skill decides what to run and explains the result.

Birddog's **Worktrees & slots** page shows the same slots live, with the ticket each one is running.

## Which command

| The user wants | Run |
|---|---|
| Launch a ticket or worktree | `birddog slot start --worktree <TICKET or path>` |
| Launch the checkout they're in | `birddog slot start` |
| A particular slot | add `--slot <name>` |
| Skip the build (already built) | add `--skip-build` |
| Open the browser when it's up | add `--open` |
| Restart one service | `birddog slot restart --worktree <X> --service <api\|web\|…>` (`--service all` for every one) |
| Stop | `birddog slot stop --worktree <X>` |
| What's running | `birddog slot status` (`--json` for detail) |
| Stop everything | `birddog slot cleanup` (ask first: it stops other people's and agents' slots too) |
| Also stop orphans on slot ports | `birddog slot cleanup --ports` (ask first: it stops whatever listens there) |

Run commands from inside the repo (any worktree of it): `birddog slot` finds `launch-site.json` there or in the main checkout. `--worktree` takes a folder name under the configured worktree root, or a path.

## Rules

- Never kill processes yourself (no `kill`, `taskkill`, `lsof | xargs kill`). `birddog slot` only stops what its locks record and checks the ports went quiet. If it reports a port still answering, tell the user what is on it rather than killing it.
- Never delete or edit lock files by hand. A slot that looks stuck: run `birddog slot status`. Stale locks (nothing running, or "starting" for longer than `staleStartingSec`) are cleared on the next `start`.
- `OWNER_MISMATCH` means another worktree holds that slot: don't retry with another worktree's name.
- `cleanup` affects every slot, including ones other agents started. Only run it when the user asks.

## What a start does

1. **Checks first, claims nothing:** files in `require` must exist; a `guards` pattern found in its file stops the launch (`GUARD_TRIPPED`, with the reason). Guards only read.
2. **Claims** the first free slot (or `--slot`), clearing stale locks first.
3. **Writes overlays**: per-slot files such as `web/.env.local` with the slot's ports. A file of the user's that was already there is backed up and restored when the slot stops. Git-tracked files are refused.
4. **Builds**, checks every port of the slot is free, **starts all services together** and waits for them.
5. Marks the slot **live**, runs the `after` steps (codegen and the like; a failing one is reported and the slot stays up), and opens the browser with `--open`.

Afterwards, offer a short test plan: what the branch changed (`git log` / `git diff` against the main branch) and where to click to see it in the slot's web URL.

## When a start fails

The error names the failing step and shows the last lines of its log (logs are in `<lockDir>/.launch-site/logs/<slot>-<service>.log`). The claim is already released, or the started services already stopped. Read the log, fix the cause or explain it, then start again. Common causes:

- **Port already in use**: something outside Birddog holds a slot port. Say what (`lsof -i :<port>` on macOS/Linux, `Get-NetTCPConnection -LocalPort <port>` on Windows) and let the user decide.
- **Every slot is busy**: show `birddog slot status`, and offer to stop one of the user's own slots, or to add a slot.
- **Exited before opening its port**: a build or runtime error in that service's log.
- **FOREIGN_LISTENER**: a process this launch didn't start answered on the slot's port. It's left running. Say what it is; if it's a container that publishes the port on purpose, the service needs `"ownerCheck": "port"`.
- **GUARD_TRIPPED** / **MISSING_FILE**: a local file needs fixing first; the message says which. Nothing was claimed.
- **OVERLAY_REFUSED**: an overlay would overwrite a tracked file, or a backup from an earlier launch was never restored. Tell the user which file; don't delete backups yourself.

On success, report the slot, the URLs it printed, and how long it took. Offer to open the web URL.

## No launch-site.json yet

Offer to set one up. Look at the repo first, then show the user a draft and write it only after they agree:

- **Services**: `package.json` scripts (`dev`, `start`) → a Node/Vite/Next service; a `*.csproj` with a web SDK → `dotnet run`; `go.mod` → `go run`. Pass the port through the service's own flag or an environment variable (`PORT`, `ASPNETCORE_URLS`, `--port`).
- **Slots**: 3 to start, ports well clear of each other (e.g. API 5010/5012/5014, web 5173/5174/5175), checked free with `birddog slot status` once written.
- **worktreeRoot**: where the team keeps worktrees (often the folder that holds the main checkout).

```json
{
  "worktreeRoot": "..",
  "slots": [
    { "name": "dev1", "ports": { "api": 5010, "web": 5173 } },
    { "name": "dev2", "ports": { "api": 5012, "web": 5174 } },
    { "name": "dev3", "ports": { "api": 5014, "web": 5175 } }
  ],
  "build": [{ "cwd": ".", "command": "npm ci" }],
  "services": {
    "api": { "cwd": "api", "command": "npm start", "env": { "PORT": "{api}" }, "timeoutSec": 120 },
    "web": { "cwd": "web", "command": "npm run dev -- --port {web} --strictPort", "env": { "API_URL": "http://localhost:{api}" }, "timeoutSec": 60 }
  }
}
```

Optional sections: `require` (files that must exist), `guards` (`{ "file", "pattern", "message" }`: a regular expression that must NOT appear, such as a hard-coded port), `overlays` (`{ "file", "body" }`, placeholders filled in), `after` (commands run once the slot is live), and per service `"ownerCheck": "port"` for a listener outside the service's own processes (say a Docker-published port).

Placeholders: any port name (`{api}`, `{web}`), `{slot}`, `{worktree}`, `{worktree_path}`. Each service waits on the port named by its `port` field (default: the service's own name). Commit `launch-site.json` so every worktree and teammate shares it; lock files and logs go in `lockDir` (default: the worktree root), outside the repo.
