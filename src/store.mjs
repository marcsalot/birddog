// Tiny JSON file helpers. Writes are atomic (write temp file, then rename)
// so a crash mid-write never leaves a half-written config or state file.

import fs from 'node:fs/promises';
import path from 'node:path';

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    if (err instanceof SyntaxError) {
      // Keep the broken file for the user to inspect instead of silently losing it.
      const backup = `${file}.broken-${Date.now()}`;
      await fs.rename(file, backup).catch(() => {});
      console.warn(`birddog: ${path.basename(file)} was not valid JSON; moved it to ${backup}`);
      return fallback;
    }
    throw err;
  }
}

const queues = new Map();

/** Write JSON atomically. Concurrent writes to the same file are serialized. */
export function writeJson(file, data) {
  const prev = queues.get(file) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(tmp, file);
  });
  queues.set(file, next);
  next.finally(() => { if (queues.get(file) === next) queues.delete(file); }).catch(() => {});
  return next;
}
