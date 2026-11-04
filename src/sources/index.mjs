// Source registry. To add a source, write a module with the plugin interface
// (see README "Writing a source") and add it to SOURCES.

import * as cal from './cal.mjs';
import * as git from './git.mjs';
import * as github from './github.mjs';
import * as jira from './jira.mjs';

export const SOURCES = [git, github, jira, cal];

/** Sources that appear in setup but are not built yet. */
export const COMING_SOON = [];

/** Is this source switched on? Sources are on unless config says otherwise or they opt in (enabledByDefault: false). */
export function isEnabled(src, config) {
  return config.sources?.[src.id]?.enabled ?? (src.enabledByDefault !== false);
}

export function validateSource(mod) {
  for (const key of ['id', 'name']) {
    if (typeof mod[key] !== 'string' || !mod[key]) throw new Error(`source is missing "${key}"`);
  }
  for (const fn of ['test', 'collect']) {
    if (typeof mod[fn] !== 'function') throw new Error(`source "${mod.id}" must export a ${fn}() function`);
  }
  return mod;
}
