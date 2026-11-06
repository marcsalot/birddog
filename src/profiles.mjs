// Profiles: which sources you see, and when. Birddog starts with two, Work and Home,
// and you can add more (On call, Side project, Weekend…).
//
// A profile is a list of source ids (or every source), an optional schedule (days and a
// time window), and whether it may send notifications. Profiles live in config.json
// ("profiles"), so you can edit them by hand. Which one is showing is a UI preference
// (state.json "profile"): a profile id, "all", or "auto".
//
// "auto" picks the first profile whose schedule covers right now. If none does, it picks
// the first profile without a schedule. So by default you see Work on weekdays from
// 8:00 to 18:00 and Home the rest of the time.
//
// Every source still refreshes in the background, so switching profiles is instant.
// A profile only filters what you see and what may notify you.

export const MAX_PROFILES = 12;
const ID = /^[a-z0-9][a-z0-9-]{0,23}$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const CHOICES = Object.freeze(['auto', 'all']);

export function defaultProfiles() {
  return [
    { id: 'work', name: 'Work', sources: null, schedule: { days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' }, notify: true },
    { id: 'home', name: 'Home', sources: ['git', 'github', 'cal', 'discord', 'thunderbird', 'gtasks', 'todoist'], schedule: null, notify: true },
  ];
}

/** "Side project!" → "side-project". */
export function slugify(name) {
  return String(name ?? '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 24).replace(/^-+|-+$/g, '');
}

function normalizeSchedule(s, label) {
  if (s === null || s === undefined || s === false) return null;
  if (typeof s !== 'object' || Array.isArray(s)) throw new TypeError(`${label}: the schedule must be {"days": [1,2,3,4,5], "from": "08:00", "to": "18:00"} or null`);
  const days = [...new Set((Array.isArray(s.days) ? s.days : []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
  if (!days.length) throw new TypeError(`${label}: pick at least one day for the schedule (0 = Sunday … 6 = Saturday)`);
  const from = String(s.from ?? '');
  const to = String(s.to ?? '');
  if (!TIME.test(from) || !TIME.test(to)) throw new TypeError(`${label}: schedule times look like 08:00 and 18:00`);
  if (from === to) throw new TypeError(`${label}: the schedule starts and ends at the same time`);
  return { days, from, to };
}

/**
 * Check and clean a list of profiles (from config.json or the UI).
 * @param {unknown} input
 * @param {string[]} [knownSources]  source ids; unknown ones are dropped
 */
export function normalizeProfiles(input, knownSources) {
  if (input === undefined || input === null) return defaultProfiles();
  if (!Array.isArray(input)) throw new TypeError('"profiles" must be a list');
  if (!input.length) throw new TypeError('Keep at least one profile');
  if (input.length > MAX_PROFILES) throw new TypeError(`At most ${MAX_PROFILES} profiles`);
  const seen = new Set();
  return input.map((p, n) => {
    if (!p || typeof p !== 'object') throw new TypeError(`Profile ${n + 1} must be an object`);
    const name = String(p.name ?? '').trim().slice(0, 40);
    if (!name) throw new TypeError(`Profile ${n + 1} needs a name`);
    const id = String(p.id ?? '').trim() || slugify(name);
    if (!ID.test(id)) throw new TypeError(`"${name}": the id must be lowercase letters, digits and dashes`);
    if (CHOICES.includes(id)) throw new TypeError(`"${id}" is reserved; pick another name`);
    if (seen.has(id)) throw new TypeError(`Two profiles are called "${id}"`);
    seen.add(id);
    let sources = null;
    if (p.sources !== null && p.sources !== undefined && p.sources !== '*') {
      if (!Array.isArray(p.sources)) throw new TypeError(`"${name}": sources must be a list of source ids, or null for all of them`);
      sources = [...new Set(p.sources.map(String))].filter((s) => /^[a-z0-9-]{1,40}$/.test(s) && (!knownSources || knownSources.includes(s)));
    }
    return { id, name, sources, schedule: normalizeSchedule(p.schedule, `"${name}"`), notify: p.notify !== false };
  });
}

const minutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

/** Does this schedule cover time t (local time)? A window like 22:00–06:00 runs past midnight. */
export function inSchedule(schedule, t) {
  if (!schedule) return false;
  const d = new Date(t);
  const now = d.getHours() * 60 + d.getMinutes();
  const from = minutes(schedule.from);
  const to = minutes(schedule.to);
  if (from < to) return schedule.days.includes(d.getDay()) && now >= from && now < to;
  // Overnight: the part before midnight belongs to today, the part after to yesterday.
  if (now >= from) return schedule.days.includes(d.getDay());
  return now < to && schedule.days.includes((d.getDay() + 6) % 7);
}

/**
 * Which profile is showing.
 * @returns {{ choice: string, profile: object|null, auto: boolean }}  profile null = every source
 */
export function resolveProfile(profiles, choice = 'auto', t = Date.now()) {
  const list = profiles?.length ? profiles : defaultProfiles();
  if (choice === 'all') return { choice, profile: null, auto: false };
  const named = list.find((p) => p.id === choice);
  if (named) return { choice, profile: named, auto: false };
  const scheduled = list.find((p) => inSchedule(p.schedule, t));
  return { choice: 'auto', profile: scheduled ?? list.find((p) => !p.schedule) ?? list[0], auto: true };
}

/** Is a source shown in this profile? (profile null = all) */
export const showsSource = (profile, sourceId) => !profile || !profile.sources || profile.sources.includes(sourceId);

/** What the UI and API say about profiles. */
export function profileSummary(profiles, choice, t) {
  const r = resolveProfile(profiles, choice, t);
  return {
    choice: r.choice,
    active: r.profile?.id ?? 'all',
    name: r.profile?.name ?? 'All sources',
    auto: r.auto,
    notify: r.profile ? r.profile.notify : true,
    list: profiles,
  };
}

/** Accept a profile choice from the UI: "auto", "all" or a profile id. */
export const isChoice = (v) => typeof v === 'string' && (CHOICES.includes(v) || ID.test(v));
