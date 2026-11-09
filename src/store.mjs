// SQLite-backed store with JSON file parity.
//
// Reads:  SQLite is primary. If the JSON file is newer than the SQLite row
//         (manual edit, test-seeded data, or first run), the file wins and
//         SQLite is updated to match.
// Writes: SQLite + JSON file kept in sync.
// Broken JSON files are renamed to .broken-* (original behaviour preserved).
// Requires node:sqlite (Node ≥ 22.5.0; stable / no flag in Node ≥ 22.13.0).

import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dbs = new Map(); // dir → DatabaseSync

function dbFor(dir) {
  if (dbs.has(dir)) return dbs.get(dir);
  const db = new DatabaseSync(path.join(dir, 'birddog.db'));
  db.exec(`CREATE TABLE IF NOT EXISTS kv (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL,
    ts     INTEGER NOT NULL,
    src    TEXT NOT NULL DEFAULT 'file'
  )`);
  // Add src column to databases created before this version.
  try { db.exec(`ALTER TABLE kv ADD COLUMN src TEXT NOT NULL DEFAULT 'file'`); } catch {}
  dbs.set(dir, db);
  return db;
}

export async function readJson(file, fallback) {
  const dir = path.dirname(file);
  try {
    await fs.mkdir(dir, { recursive: true });
    const db = dbFor(dir);
    const key = path.basename(file, '.json');
    const row = db.prepare('SELECT value, ts, src FROM kv WHERE key = ?').get(key);

    const stat = await fs.stat(file).catch(() => null);

    if (!stat) {
      // File is gone. Only use SQLite when the data was written by us ('write');
      // a file-cached row ('file' src) should clear when the file is deleted.
      if (row?.src === 'write') return JSON.parse(row.value);
      return fallback;
    }

    // File exists and is newer than SQLite (manual edit, test seed, first-run).
    if (!row || stat.mtimeMs > row.ts) {
      try {
        const text = await fs.readFile(file, 'utf8');
        const data = JSON.parse(text);
        db.prepare('INSERT OR REPLACE INTO kv (key, value, ts, src) VALUES (?, ?, ?, ?)').run(key, JSON.stringify(data), stat.mtimeMs, 'file');
        return data;
      } catch (err) {
        if (err instanceof SyntaxError) {
          const backup = `${file}.broken-${Date.now()}`;
          await fs.rename(file, backup).catch(() => {});
          console.warn(`birddog: ${path.basename(file)} was not valid JSON; moved it to ${backup}`);
          return fallback;
        }
        // File disappeared between stat and read; fall through to SQLite row.
      }
    }

    // File exists and SQLite is current — return SQLite (fastest path in production).
    if (row) return JSON.parse(row.value);
    return fallback;
  } catch (err) {
    console.warn(`birddog: readJson ${path.basename(file)}: ${err.message}`);
    return fallback;
  }
}

const queues = new Map(); // file → Promise (serialises concurrent writes to same key)

/** Write JSON to the JSON file (atomic) then SQLite (primary). Concurrent writes serialised. */
export function writeJson(file, data) {
  const dir = path.dirname(file);
  const prev = queues.get(file) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    await fs.mkdir(dir, { recursive: true });
    // JSON file first (atomic write-then-rename, same as original)
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(tmp, file);
    // SQLite after the rename, using the file's ACTUAL mtime as ts.
    // This ensures readJson sees mtime === ts and trusts SQLite instead of
    // re-reading the file (which would flip src back to 'file').
    const { mtimeMs } = await fs.stat(file);
    const db = dbFor(dir);
    db.prepare('INSERT OR REPLACE INTO kv (key, value, ts, src) VALUES (?, ?, ?, ?)').run(path.basename(file, '.json'), JSON.stringify(data), mtimeMs, 'write');
  });
  queues.set(file, next);
  next.finally(() => { if (queues.get(file) === next) queues.delete(file); }).catch(() => {});
  return next;
}
