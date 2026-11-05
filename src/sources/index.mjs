// Source registry. To add a source, write a module with the plugin interface
// (see README "Writing a source") and add it to SOURCES.

import * as azure from './azure.mjs';
import * as cal from './cal.mjs';
import * as git from './git.mjs';
import * as github from './github.mjs';
import * as gitlab from './gitlab.mjs';
import * as jira from './jira.mjs';
import * as linear from './linear.mjs';
import * as pagerduty from './pagerduty.mjs';
import * as sentry from './sentry.mjs';
import * as slack from './slack.mjs';
import * as teams from './teams.mjs';

// Order is the order in setup: the essentials first, then the rest of a developer's day.
export const SOURCES = [git, github, jira, cal, gitlab, linear, azure, sentry, pagerduty, slack, teams];

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
