#!/usr/bin/env node
// Try Birddog's login without registering an app anywhere:
//
//   npm run dev:login
//
// Starts a mock sign-in provider on :4900 and a Birddog with login turned on at
// http://127.0.0.1:4748, using its own config folder (.birddog-dev/, git-ignored),
// so your real ~/.config/birddog is not touched. Edit .birddog-dev/auth.json to
// change who is allowed in; delete it to turn login off again.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSecretStore } from '../src/secrets.mjs';
import { createBirddog } from '../src/server.mjs';
import { startMockIdp } from './mock-idp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = path.join(ROOT, '.birddog-dev');
const IDP_PORT = 4900;
const PORT = 4748;

async function writeIfMissing(file, data) {
  try { await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' }); return true; } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}

await fs.mkdir(HOME, { recursive: true });
await writeIfMissing(path.join(HOME, 'config.json'), { port: PORT, sources: { git: { roots: [path.dirname(ROOT)] } } });
await writeIfMissing(path.join(HOME, 'auth.json'), {
  enabled: true,
  issuer: `http://127.0.0.1:${IDP_PORT}`,
  clientId: 'birddog-dev',
  allowedEmails: ['you@example.com'],
});

const auth = JSON.parse(await fs.readFile(path.join(HOME, 'auth.json'), 'utf8'));
const idp = auth.enabled && auth.issuer === `http://127.0.0.1:${IDP_PORT}`
  ? await startMockIdp({ port: IDP_PORT, clientId: auth.clientId, accounts: auth.allowedEmails?.length ? auth.allowedEmails : ['you@example.com'] })
  : null;

// Keep dev secrets out of your real keychain.
const secrets = await createSecretStore({ dir: HOME, backend: 'file' });
const app = await createBirddog({ dir: HOME, cwd: ROOT, secrets });
await app.start(PORT);
const url = `http://127.0.0.1:${PORT}`;

console.log(`
  🔐 Birddog login test

     dashboard  ${url}   (login ${app.authEnabled ? 'on' : 'off'})
     provider   ${idp ? `${idp.issuer}  (mock, development only)` : auth.issuer ?? 'none'}
     settings   ${path.relative(process.cwd(), path.join(HOME, 'auth.json')) || '.birddog-dev/auth.json'}

  Pick an allowed account to get in, or "stranger@example.org" to see a refusal.
  Press Ctrl+C to stop.
`);

if (process.argv.includes('--open')) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  execFile(cmd, args, () => {});
}

const stop = async () => { await app.close(); await idp?.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
