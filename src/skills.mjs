// `birddog skill install <name>`: copy a Claude Code skill that ships with Birddog into
// ~/.claude/skills/<name> (or ./.claude/skills/<name> with --project). It never overwrites
// a skill folder it didn't install (one without a .birddog-skill marker) unless --force.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const MARKER = '.birddog-skill';

export async function listSkills() {
  const entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

/** Copy one skill. Returns the folder it went to. */
export async function installSkill(name, { project = false, force = false, home = os.homedir(), cwd = process.cwd() } = {}) {
  if (!(await listSkills()).includes(name)) throw new Error(`No skill called "${name}". Birddog ships: ${(await listSkills()).join(', ')}`);
  const dest = path.join(project ? cwd : home, '.claude', 'skills', name);
  const exists = await fs.stat(dest).then(() => true, () => false);
  const ours = await fs.stat(path.join(dest, MARKER)).then(() => true, () => false);
  if (exists && !ours && !force) throw new Error(`${dest} already exists and wasn't installed by Birddog. Move it away, or add --force to replace it.`);
  await fs.rm(dest, { recursive: true, force: true });
  await fs.cp(path.join(SKILLS_DIR, name), dest, { recursive: true });
  await fs.writeFile(path.join(dest, MARKER), 'Installed by "birddog skill install". Reinstalling replaces this folder.\n');
  return dest;
}

export async function skillCommand(argv, { out = console.log, err = console.error, home, cwd } = {}) {
  const [cmd, name, ...flags] = argv;
  if (cmd === 'list' || !cmd) { out((await listSkills()).map((s) => `  ${s}`).join('\n')); return 0; }
  if (cmd !== 'install' || !name) { err('Usage: birddog skill install <name> [--project] [--force]   (birddog skill list)'); return 2; }
  try {
    const dest = await installSkill(name, { project: flags.includes('--project'), force: flags.includes('--force'), home, cwd });
    out(`Installed the ${name} skill in ${dest}. In Claude Code, say "launch the site for <ticket>" or run /${name}.`);
    return 0;
  } catch (e) { err(e.message); return 1; }
}
