// Source registry. To add a source, write a module with the plugin interface
// (see README "Writing a source") and add it to SOURCES.

import * as git from './git.mjs';

export const SOURCES = [git];

/** Sources that appear in setup but are not built yet. */
export const COMING_SOON = [
  { id: 'github', name: 'GitHub', description: 'Review requests, your PRs with failing checks, mentions and assigned issues.' },
  { id: 'jira', name: 'Jira Cloud', description: 'Tickets assigned to you, blocked work and sprint deadlines.' },
  { id: 'cal', name: 'Calendar', description: 'Upcoming meetings from any iCal link, so nothing sneaks up on you.' },
];

export function validateSource(mod) {
  for (const key of ['id', 'name']) {
    if (typeof mod[key] !== 'string' || !mod[key]) throw new Error(`source is missing "${key}"`);
  }
  for (const fn of ['test', 'collect']) {
    if (typeof mod[fn] !== 'function') throw new Error(`source "${mod.id}" must export a ${fn}() function`);
  }
  return mod;
}
