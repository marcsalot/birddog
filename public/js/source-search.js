// The search box in Sources & settings: match a source by its name, id,
// description, or the kind of thing it is ("calendar", "tickets", "ci"…).

export const KEYWORDS = {
  git: 'code repos repositories commits branches uncommitted local folders',
  github: 'code pull requests prs reviews ci actions builds checks dependabot security alerts mentions issues',
  jira: 'tickets issues atlassian sprints boards',
  cal: 'calendar meetings events google microsoft outlook office 365 icloud apple ical ics caldav',
  gitlab: 'code merge requests mrs reviews ci pipelines issues',
  linear: 'tickets issues cycles projects',
  azure: 'microsoft devops boards work items tickets repos code pull requests prs reviews ci',
  sentry: 'errors exceptions crashes monitoring alerts',
  pagerduty: 'incidents on call oncall alerts pages ops',
  slack: 'chat messages mentions dms direct',
  teams: 'microsoft teams chat messages mentions office 365 m365 work',
  discord: 'chat messages mentions servers guilds community gaming home',
  todo: 'tasks to do todo lists reminders microsoft outlook office 365 two-way sync',
  gtasks: 'tasks to do todo lists gmail google two-way sync',
  todoist: 'tasks to do todo lists projects two-way sync',
  dynatrace: 'incidents problems alerts monitoring apm observability ops',
  grafana: 'alerts alerting monitoring dashboards prometheus observability ops self-hosted private',
  jenkins: 'ci builds pipelines failing jobs self-hosted private',
  ghprojects: 'github projects boards tickets issues iterations kanban',
  confluence: 'wiki pages docs mentions comments tasks atlassian',
  gmail: 'email mail inbox google important noise newsletters',
  outlook: 'email mail inbox microsoft office 365 focused noise newsletters',
  thunderbird: 'email mail inbox unread starred mozilla imap pop local home',
};

/**
 * True when every word of the query starts a word in the source's name, id,
 * description or keywords ("ci" finds "CI", not "inCIdents"; "cal" finds "Calendar").
 */
export function sourceMatches(src, q = '') {
  const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = ` ${src.name} ${src.id} ${src.description ?? ''} ${KEYWORDS[src.id] ?? ''}`.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
  return words.every((w) => hay.includes(` ${w.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()}`));
}
