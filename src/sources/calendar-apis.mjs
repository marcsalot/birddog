// Calendar back ends besides iCal links: Google Calendar API, Microsoft Graph, and
// CalDAV (iCloud and friends). Each turns events into the same plain
// "occurrence" shape the Calendar source ranks:
//   { uid, summary, location, description, url, joinUrl, organizer, declined,
//     start, end, allDay, recurring }   (start/end in epoch ms)
// Read-only: GET for the APIs; PROPFIND/REPORT (CalDAV's read methods) for CalDAV.

import { HttpError } from './http.mjs';

const TIMEOUT_MS = 15_000;

async function getJsonAuth(fetchImpl, url, token, label, extraHeaders = {}) {
  let res;
  try { res = await fetchImpl(url, { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...extraHeaders }, signal: AbortSignal.timeout(TIMEOUT_MS) }); } catch {
    throw new HttpError(`${label} is not reachable (are you offline?)`, { status: 0 });
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) throw new HttpError(`${label} rejected the sign-in. Sign in again in setup.`, { status: 401 });
  if (!res.ok) throw new HttpError(`${label} returned HTTP ${res.status}${body?.error?.message ? `: ${body.error.message}` : ''}`, { status: res.status });
  return body;
}

/** "2026-11-04" → local midnight. */
const localDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };

// ---------------------------------------------------------------------------
// Google Calendar API

export async function googleOccurrences({ fetchImpl, token, from, to }) {
  const q = new URLSearchParams({ timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '250' });
  const body = await getJsonAuth(fetchImpl, `https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`, token, 'Google Calendar');
  return (body.items ?? []).filter((e) => e.status !== 'cancelled' && e.start).map((e) => {
    const allDay = !!e.start.date;
    const video = e.hangoutLink || e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri || null;
    return {
      uid: e.id,
      summary: e.summary ?? '(no title)',
      location: e.location ?? null,
      description: e.description ?? null,
      url: e.htmlLink ?? null,
      joinUrl: video,
      organizer: e.organizer?.displayName ?? e.organizer?.email ?? null,
      declined: (e.attendees ?? []).some((a) => a.self && a.responseStatus === 'declined'),
      start: allDay ? localDate(e.start.date) : Date.parse(e.start.dateTime),
      end: allDay ? localDate(e.end?.date ?? e.start.date) : Date.parse(e.end?.dateTime ?? e.start.dateTime),
      allDay,
      recurring: !!e.recurringEventId,
    };
  });
}

/** Who is signed in (the primary calendar's id is the account's email). */
export async function googleAccount({ fetchImpl, token }) {
  const b = await getJsonAuth(fetchImpl, 'https://www.googleapis.com/calendar/v3/users/me/calendarList/primary', token, 'Google Calendar');
  return { account: b.id ?? null };
}

// ---------------------------------------------------------------------------
// Microsoft Graph (Outlook / Microsoft 365)

export async function graphOccurrences({ fetchImpl, token, from, to }) {
  const q = new URLSearchParams({
    startDateTime: new Date(from).toISOString(), endDateTime: new Date(to).toISOString(), $top: '100',
    $select: 'id,subject,start,end,isAllDay,isCancelled,location,onlineMeeting,onlineMeetingUrl,webLink,organizer,responseStatus,type,bodyPreview',
  });
  let url = `https://graph.microsoft.com/v1.0/me/calendarView?${q}`;
  const out = [];
  for (let page = 0; url && page < 3; page++) {
    const body = await getJsonAuth(fetchImpl, url, token, 'Microsoft Graph', { prefer: 'outlook.timezone="UTC"' });
    for (const e of body.value ?? []) {
      if (e.isCancelled) continue;
      const utc = (x) => Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(x) ? x : `${x}Z`);
      out.push({
        uid: e.id,
        summary: e.subject || '(no title)',
        location: e.location?.displayName || null,
        description: e.bodyPreview ?? null,
        url: e.webLink ?? null,
        joinUrl: e.onlineMeeting?.joinUrl ?? e.onlineMeetingUrl ?? null,
        organizer: e.organizer?.emailAddress?.name ?? e.organizer?.emailAddress?.address ?? null,
        declined: e.responseStatus?.response === 'declined',
        start: e.isAllDay ? localDate(e.start.dateTime.slice(0, 10)) : utc(e.start.dateTime),
        end: e.isAllDay ? localDate(e.end.dateTime.slice(0, 10)) : utc(e.end.dateTime),
        allDay: !!e.isAllDay,
        recurring: e.type === 'occurrence' || e.type === 'exception',
      });
    }
    url = body['@odata.nextLink'] ?? null;
  }
  return out;
}

export async function graphAccount({ fetchImpl, token }) {
  const b = await getJsonAuth(fetchImpl, 'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', token, 'Microsoft Graph');
  return { account: b.mail ?? b.userPrincipalName ?? null };
}

// ---------------------------------------------------------------------------
// Atlassian: which Jira site the sign-in can reach

export async function atlassianSite({ fetchImpl, token }) {
  const list = await getJsonAuth(fetchImpl, 'https://api.atlassian.com/oauth/token/accessible-resources', token, 'Atlassian');
  const site = (Array.isArray(list) ? list : []).find((r) => (r.scopes ?? []).some((s) => s.includes('jira'))) ?? list?.[0];
  if (!site) throw new HttpError('Atlassian: this sign-in cannot see any Jira site.', { status: 403 });
  return { cloudId: site.id, site: site.url, account: site.name ?? site.url };
}

// ---------------------------------------------------------------------------
// CalDAV (iCloud: https://caldav.icloud.com with an app-specific password)

const unxml = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
const tag = (name) => new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'i');
const tagAll = (name) => new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'gi');

/** The <response> blocks of a multistatus body, each with its href and inner XML. */
export function davResponses(xml) {
  return [...xml.matchAll(tagAll('response'))].map((m) => ({ href: unxml((tag('href').exec(m[1])?.[1] ?? '').trim()), xml: m[1] }));
}

const ALLOWED_HOST = (host, base) => host === base || host.endsWith('.icloud.com') && base.endsWith('icloud.com');

export function caldavClient({ fetchImpl, baseUrl = 'https://caldav.icloud.com/', username, password }) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:') throw new HttpError('The CalDAV address must use https', { status: 0 });
  const auth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const label = base.host;

  async function dav(method, url, body, depth = '0') {
    let target = new URL(url, base);
    for (let hop = 0; hop < 4; hop++) {
      if (!ALLOWED_HOST(target.host, base.host)) throw new HttpError(`${label} redirected to ${target.host}; refusing to send your password there`, { status: 0 });
      let res;
      try {
        res = await fetchImpl(target.toString(), { method, redirect: 'manual', headers: { authorization: auth, depth, 'content-type': 'application/xml; charset=utf-8', accept: 'application/xml' }, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch { throw new HttpError(`${label} is not reachable (are you offline?)`, { status: 0 }); }
      if ([301, 302, 307, 308].includes(res.status) && res.headers.get('location')) { target = new URL(res.headers.get('location'), target); continue; }
      if (res.status === 401) throw new HttpError(`${label} rejected the Apple ID or app-specific password. Make a new app-specific password at appleid.apple.com.`, { status: 401 });
      if (res.status !== 207 && !res.ok) throw new HttpError(`${label} returned HTTP ${res.status}`, { status: res.status });
      return { xml: await res.text(), url: target };
    }
    throw new HttpError(`${label} redirected too many times`, { status: 0 });
  }

  return {
    label,
    /** Every calendar's events overlapping [from, to), as iCalendar texts. */
    async calendars({ from, to }) {
      const p1 = await dav('PROPFIND', base, '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>');
      const principal = unxml(tag('href').exec(tag('current-user-principal').exec(p1.xml)?.[1] ?? '')?.[1] ?? '').trim();
      if (!principal) throw new HttpError(`${label} did not say where your calendars are`, { status: 0 });
      const p2 = await dav('PROPFIND', new URL(principal, p1.url), '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>');
      const home = unxml(tag('href').exec(tag('calendar-home-set').exec(p2.xml)?.[1] ?? '')?.[1] ?? '').trim();
      if (!home) throw new HttpError(`${label} did not list a calendar home`, { status: 0 });
      const homeUrl = new URL(home, p2.url);
      const p3 = await dav('PROPFIND', homeUrl, '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:resourcetype/><d:displayname/><c:supported-calendar-component-set/></d:prop></d:propfind>', '1');
      const cals = davResponses(p3.xml).filter((r) => /<(?:[\w-]+:)?calendar\b/i.test(tag('resourcetype').exec(r.xml)?.[1] ?? '')
        && (!/supported-calendar-component-set/i.test(r.xml) || /name="VEVENT"/i.test(r.xml)));
      const stamp = (t) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
      const out = [];
      for (const c of cals.slice(0, 20)) {
        const name = unxml((tag('displayname').exec(c.xml)?.[1] ?? '').trim()) || 'Calendar';
        const rep = await dav('REPORT', new URL(c.href, p3.url), `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${stamp(from)}" end="${stamp(to)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`, '1');
        for (const r of davResponses(rep.xml)) {
          const data = tag('calendar-data').exec(r.xml)?.[1];
          if (data) out.push({ label: `${label} · ${name}`, text: unxml(data) });
        }
      }
      return out;
    },
  };
}
