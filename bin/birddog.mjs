#!/usr/bin/env node
// birddog: a local-first "what needs me next?" dashboard for developers.

import { execFile } from 'node:child_process';
import { parseArgs } from 'node:util';
import { configDir, DEFAULT_PORT, tildify } from '../src/config.mjs';
import { createDemo } from '../src/demo.mjs';
import { createMcpHandler, serveStdio } from '../src/mcp.mjs';
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

    birddog secret set <name>      store a secret in your OS keychain (value read from stdin)
    birddog secret delete <name>   remove it

  Options
    -o, --open              open the dashboard in your browser
    -p, --port <number>     port to listen on (default ${DEFAULT_PORT}, or "port" in config.json)
        --host <address>    address to listen on (default 127.0.0.1; anything else needs login turned on)
        --demo              use made-up demo data in a temporary folder (also works with "mcp")
        --dev               reload open pages when the UI changes (used by npm run dev:watch)
    -v, --version           print the version
    -h, --help              show this help

  Files live in ${tildify(configDir())} (set BIRDDOG_HOME to change it).
`;

const SECRET_NAMES = new Set(['oidc-client-secret', 'jira-token', 'cal-url']);

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

async function secretCommand([action, name]) {
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
  if (process.stdin.isTTY) {
    console.error(`  Pipe the value in so it never lands in your shell history, e.g.\n\n    pbpaste | birddog secret set ${name}\n`);
    process.exit(2);
  }
  const value = await readStdin();
  if (!value) { console.error('birddog: no value on stdin'); process.exit(2); }
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

async function main() {
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
  const host = args.host ?? '127.0.0.1';

  const demo = args.demo ? await createDemo() : null;
  const dir = demo?.options.dir ?? configDir();
  let app;
  try {
    app = await createBirddog({ dir, cwd: process.cwd(), ...(demo?.options ?? {}), ...(args.dev ? { liveReload: true } : {}) });
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
     login    ${app.authEnabled ? `on · ${new URL(auth.issuer).host} · allowed: ${who}${app.authFile ? ' (from auth.json)' : ''}` : 'off (only this machine can reach Birddog)'}
     secrets  ${app.secrets.kind}${app.secrets.warning ? `\n              ⚠ ${app.secrets.warning}` : ''}

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
