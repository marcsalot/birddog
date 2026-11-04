#!/usr/bin/env node
// birddog: a local-first "what needs me next?" dashboard for developers.

import { execFile } from 'node:child_process';
import { parseArgs } from 'node:util';
import { configDir, DEFAULT_PORT, tildify } from '../src/config.mjs';
import { createBirddog, VERSION } from '../src/server.mjs';

const HELP = `
  birddog ${VERSION}: finds what needs you next and points at it.

  Usage
    birddog                 start the dashboard on http://127.0.0.1:${DEFAULT_PORT}
    birddog --open          start it and open your browser
    birddog --port 5000     use another port

  Options
    -o, --open              open the dashboard in your browser
    -p, --port <number>     port to listen on (default ${DEFAULT_PORT}, or "port" in config.json)
    -v, --version           print the version
    -h, --help              show this help

  Files live in ${tildify(configDir())} (set BIRDDOG_HOME to change it).
`;

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

async function main() {
  let args;
  try {
    ({ values: args } = parseArgs({
      options: {
        open: { type: 'boolean', short: 'o' },
        port: { type: 'string', short: 'p' },
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

  let explicitPort = null;
  if (args.port !== undefined) {
    explicitPort = Number(args.port);
    if (!Number.isInteger(explicitPort) || explicitPort < 0 || explicitPort > 65535) {
      console.error(`birddog: --port must be a number between 0 and 65535 (got "${args.port}")`);
      process.exit(2);
    }
  }

  const dir = configDir();
  const app = await createBirddog({ dir, cwd: process.cwd() });
  const wanted = explicitPort ?? Number(app.config.port ?? DEFAULT_PORT);

  let port;
  for (let attempt = 0; attempt < 10; attempt++) {
    const tryPort = wanted === 0 ? 0 : wanted + attempt;
    try {
      port = await app.start(tryPort);
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      if (await isBirddog(tryPort)) {
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

  const url = `http://127.0.0.1:${port}`;
  const roots = app.config.sources?.git?.roots ?? [];
  console.log(`
  🐾 Birddog ${VERSION} is pointing at ${url}

     config   ${tildify(app.configFile)}${app.firstRun ? '  (created just now)' : ''}
     scanning ${roots.join(', ') || 'nothing yet'}

  Press Ctrl+C to stop.
`);
  if (args.open) openBrowser(url);

  const stop = async () => {
    console.log('\n  Birddog is going to sleep. Bye!');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error(`birddog: ${err.stack ?? err.message}`);
  process.exit(1);
});
