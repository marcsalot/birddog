#!/usr/bin/env node
// birddog: a local-first "what needs me next?" dashboard for developers.

import { execFile } from 'node:child_process';
import { parseArgs } from 'node:util';
import { configDir, DEFAULT_PORT, tildify } from '../src/config.mjs';
import { createDemo } from '../src/demo.mjs';
import { createMcpHandler, serveStdio } from '../src/mcp.mjs';
import { showSystemNotification } from '../src/notify.mjs';
import { createSecretStore } from '../src/secrets.mjs';
import { createBirddog, VERSION } from '../src/server.mjs';

const HELP = `
  birddog ${VERSION}: finds what needs you next and points at it.

  Usage
    birddog                 start the dashboard on http://127.0.0.1:${DEFAULT_PORT}
    birddog --open          start it and open your browser
    birddog --port 5000     use another port

    birddog --demo          try it with made-up data (never touches your repos, tokens or calendar)
    birddog mcp             run as an MCP server on stdio, for Claude Code, Claude Desktop and friends
    birddog notify          no dashboard, just desktop notifications (runs until you stop it)
    birddog notify --on     …and switch notifications on first
    birddog notify --test   show one test notification and exit

    birddog slot status     dev slots: run a copy of your app per worktree (see "birddog slot help")
    birddog skill install launch-site   add the launch-site skill to Claude Code (~/.claude/skills)

    birddog secret set <name>      store a secret in your OS keychain (asks for it, hidden; or pipe it in)
    birddog secret delete <name>   remove it

  Options
    -o, --open              open the dashboard in your browser
    -p, --port <number>     port to listen on (default ${DEFAULT_PORT}, or "port" in config.json)
        --host <address>    address to listen on (default 127.0.0.1, or BIRDDOG_HOST; anything else needs
                            login turned on, except in the Docker image, which publishes to loopback)
        --demo              use made-up demo data in a temporary folder (also works with "mcp")
        --dev               reload open pages when the UI changes (used by npm run dev:watch)
    -v, --version           print the version
    -h, --help              show this help

  Files live in ${tildify(configDir())} (set BIRDDOG_HOME to change it).
`;

const SECRET_NAMES = new Set(['oidc-client-secret', 'jira-token', 'cal-url', 'anthropic-api-key', 'caldav-password', 'google-client-secret', 'atlassian-client-secret', 'apple-private-key', 'gitlab-token', 'linear-token', 'azure-devops-token', 'sentry-token', 'pagerduty-token', 'slack-token', 'discord-token', 'todoist-token', 'gitlab-client-secret', 'linear-client-secret', 'pagerduty-client-secret']);

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  execFile(cmd, args, { windowsHide: true }, (err) => {
    if (err) console.log(`  Could not open a browser automatically. Visit ${url}`);
  });
}

async function isBirddog(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return (await res.json()).app === 'birddog';
  } catch { return false; }
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').trim();
}

/**
 * Read a secret at a terminal prompt without echoing it. The value never touches argv, so it
 * can't land in shell history or show up in `ps`.
 */
function readHidden(prompt) {
  return new Promise((resolve) => {
    const { stdin } = process;
    let value = '';
    const finish = (result) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
      resolve(result);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish(value.trim());
        if (ch === '\u0003') return finish(null); // Ctrl+C
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    process.stderr.write(prompt);
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function secretCommand([action, name, ...extra]) {
  if (extra.length) {
    console.error(`birddog: don't put the secret on the command line, where it lands in your shell history. Run "birddog secret set ${name}" and paste it at the prompt, or pipe it in.`);
    process.exit(2);
  }
  if (!['set', 'delete'].includes(action) || !SECRET_NAMES.has(name)) {
    console.error(`birddog: usage: birddog secret set|delete ${[...SECRET_NAMES].join('|')}`);
    process.exit(2);
  }
  const store = await createSecretStore({ dir: configDir() });
  if (action === 'delete') {
    await store.delete(name);
    console.log(`  Removed ${name} from ${store.kind}.`);
    return;
  }
  // From a hidden prompt at a terminal, or from stdin when piped; never from argv.
  const value = process.stdin.isTTY ? await readHidden(`  Paste ${name} (it won't be shown), then press Enter: `) : await readStdin();
  if (value === null) { console.error('  Cancelled.'); process.exit(130); }
  if (!value) { console.error(`birddog: no value given${process.stdin.isTTY ? '' : ' on stdin'}`); process.exit(2); }
  await store.set(name, value);
  console.log(`  Saved ${name} to ${store.kind}.`);
}

/** `birddog mcp`: stdio MCP server. stdout carries protocol messages only; everything else goes to stderr. */
async function mcpCommand(args) {
  const stderr = { log: (...a) => console.error(...a), warn: (...a) => console.error(...a), error: (...a) => console.error(...a) };
  const demo = args.demo ? await createDemo() : null;
  let app;
  try {
    app = await createBirddog({ dir: demo?.options.dir ?? configDir(), cwd: process.cwd(), autoRefresh: false, log: stderr, ...(demo?.options ?? {}) });
  } catch (err) {
    console.error(`birddog mcp: ${err.message}`);
    process.exit(1);
  }
  console.error(`birddog mcp ${VERSION}: ready on stdio${demo ? ' (demo data)' : ` · ${tildify(app.configFile)}`}`);
  await serveStdio(createMcpHandler({ app, version: VERSION }));
  await app.close();
  await demo?.cleanup();
}

/** `birddog notify`: refresh on a timer and show system notifications, without the web UI. */
async function notifyCommand(args) {
  if (args.test) {
    try {
      await showSystemNotification('Birddog test notification', 'If you can read this, desktop notifications work.');
      console.log('  Sent a test notification. Nothing showed up? Allow notifications for your terminal (or Script Editor) in System Settings → Notifications.');
    } catch (err) { console.error(`birddog notify: ${err.message}`); process.exit(1); }
    return;
  }
  const demo = args.demo ? await createDemo() : null;
  const dir = demo?.options.dir ?? configDir();
  let app;
  try {
    app = await createBirddog({ dir, cwd: process.cwd(), autoRefresh: false, notifyChannel: 'system', ...(demo?.options ?? {}) });
  } catch (err) {
    console.error(`birddog notify: ${err.message}`);
    process.exit(1);
  }
  const port = Number(app.config.port ?? DEFAULT_PORT);
  if (!demo && await isBirddog(port)) {
    console.log(`\n  Birddog is already running at http://127.0.0.1:${port} and sends notifications itself:\n  in the browser while a tab is open, from the system when none is. Nothing to do here.\n`);
    await app.close();
    return;
  }
  if (args.on) await app.triage.setPrefs({ notifications: { enabled: true } });
  const every = Math.max(1, Number(app.config.refreshMinutes) || 5) * 60_000;
  const tick = async () => {
    await app.refresh({ scheduled: true }).catch((e) => console.error(`birddog notify: ${e.message}`));
    await app.notifier.flush().catch(() => {});
  };
  await tick();
  const on = app.triage.prefs.notifications.enabled;
  console.log(`\n  🐾 Birddog ${VERSION} is watching for things that need you now${demo ? ' (demo data)' : ''}.\n  ${on ? `Checking every ${every / 60_000} min.` : 'Notifications are switched off: run "birddog notify --on", or turn them on under 🔔 in the dashboard.'} Press Ctrl+C to stop.\n`);
  const refreshTimer = setInterval(tick, every);
  const flushTimer = setInterval(() => app.notifier.flush().catch(() => {}), 5_000);
  const stop = async () => {
    clearInterval(refreshTimer);
    clearInterval(flushTimer);
    await app.close();
    await demo?.cleanup();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function main() {
  // Subcommands with their own flags, before the dashboard's option parser sees them.
  if (process.argv[2] === 'slot') {
    const { slotCommand } = await import('../src/launch.mjs');
    process.exitCode = await slotCommand(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === 'skill') {
    const { skillCommand } = await import('../src/skills.mjs');
    process.exitCode = await skillCommand(process.argv.slice(3));
    return;
  }
  let args;
  let positionals;
  try {
    ({ values: args, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        open: { type: 'boolean', short: 'o' },
        port: { type: 'string', short: 'p' },
        host: { type: 'string' },
        dev: { type: 'boolean' },
        demo: { type: 'boolean' },
        on: { type: 'boolean' },
        test: { type: 'boolean' },
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (err) {
    console.error(`birddog: ${err.message}\n${HELP}`);
    process.exit(2);
  }
  if (args.help) { console.log(HELP); return; }
  if (args.version) { console.log(VERSION); return; }
  if (positionals[0] === 'secret') return secretCommand(positionals.slice(1));
  if (positionals[0] === 'mcp') return mcpCommand(args);
  if (positionals[0] === 'notify') return notifyCommand(args);
  if (positionals.length) {
    console.error(`birddog: unknown command "${positionals[0]}"\n${HELP}`);
    process.exit(2);
  }

  let explicitPort = null;
  if (args.port !== undefined) {
    explicitPort = Number(args.port);
    if (!Number.isInteger(explicitPort) || explicitPort < 0 || explicitPort > 65535) {
      console.error(`birddog: --port must be a number between 0 and 65535 (got "${args.port}")`);
      process.exit(2);
    }
  }
  // BIRDDOG_HOST is how the Docker image listens on 0.0.0.0; outside a container the default stays 127.0.0.1.
  const host = args.host ?? process.env.BIRDDOG_HOST ?? '127.0.0.1';
  const container = process.env.BIRDDOG_CONTAINER === '1';

  const demo = args.demo ? await createDemo() : null;
  const dir = demo?.options.dir ?? configDir();
  let app;
  try {
    app = await createBirddog({ dir, cwd: process.cwd(), ...(demo?.options ?? {}), ...(args.dev ? { liveReload: true } : {}), allowRemote: container });
  } catch (err) {
    console.error(`birddog: ${err.message}`);
    process.exit(1);
  }
  const wanted = explicitPort ?? Number(app.config.port ?? DEFAULT_PORT);

  let port;
  for (let attempt = 0; attempt < 10; attempt++) {
    const tryPort = wanted === 0 ? 0 : wanted + attempt;
    try {
      port = await app.start(tryPort, host);
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') { console.error(`birddog: ${err.message}`); process.exit(1); }
      if (!demo && await isBirddog(tryPort)) {
        const url = `http://127.0.0.1:${tryPort}`;
        console.log(`\n  Birddog is already running at ${url}\n`);
        if (args.open) openBrowser(url);
        return;
      }
      if (explicitPort !== null) {
        console.error(`birddog: port ${tryPort} is in use. Try --port ${tryPort + 1}.`);
        process.exit(1);
      }
    }
  }
  if (port === undefined) {
    console.error(`birddog: ports ${wanted}–${wanted + 9} are all in use. Pick one with --port.`);
    process.exit(1);
  }

  const auth = app.config.auth ?? {};
  const url = auth.enabled && auth.publicUrl ? auth.publicUrl.replace(/\/+$/, '') : `http://127.0.0.1:${port}`;
  const roots = app.config.sources?.git?.roots ?? [];
  const who = [...(auth.allowedEmails ?? []), ...(auth.allowedDomains ?? []).map((d) => `@${d.replace(/^@/, '')}`)].join(', ');
  if (demo) {
    console.log(`
  🐾 Birddog ${VERSION} demo is pointing at ${url}

     Made-up data for an imaginary company. Your repos, tokens and calendar are not touched,
     and nothing goes over the network. Changes vanish when you stop it.

  Press Ctrl+C to stop.
`);
  } else console.log(`
  🐾 Birddog ${VERSION} is pointing at ${url}${host !== '127.0.0.1' ? `  (listening on ${host}:${port})` : ''}

     config   ${tildify(app.configFile)}${app.firstRun ? '  (created just now)' : ''}
     scanning ${roots.join(', ') || 'nothing yet'}
     login    ${app.authEnabled ? `on · ${new URL(auth.issuer).host} · allowed: ${who}${app.authFile ? ' (from auth.json)' : ''}` : container ? 'off (anyone who can reach the published port can read your inbox, so publish it on 127.0.0.1 only)' : 'off (only this machine can reach Birddog)'}
     ${container ? `docker   publish with -p 127.0.0.1:4747:4747 (loopback only); repos go in /repos, tokens in env vars\n     ` : ''}secrets  ${app.secrets.kind}${app.secrets.warning ? `\n              ⚠ ${app.secrets.warning}` : ''}

  Press Ctrl+C to stop.
`);
  if (args.open) openBrowser(url);

  const stop = async () => {
    console.log('\n  Birddog is going to sleep. Bye!');
    await app.close();
    await demo?.cleanup();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error(`birddog: ${err.stack ?? err.message}`);
  process.exit(1);
});
