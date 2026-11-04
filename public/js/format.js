// Escaping and time formatting. Everything from a source goes through esc().

const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ENT[c]);

/** The why line allows **bold**; everything else is escaped. */
export const whyHTML = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
export const plain = (s) => String(s ?? '').replace(/\*\*/g, '');

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

export function shortAge(iso, now = Date.now()) {
  const ms = now - Date.parse(iso);
  if (!(ms >= MIN)) return 'now';
  if (ms < HOUR) return `${Math.floor(ms / MIN)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  const d = ms / DAY;
  if (d < 7) return `${Math.floor(d)}d`;
  if (d < 60) return `${Math.floor(d / 7)}w`;
  if (d < 365) return `${Math.floor(d / 30)}mo`;
  return `${Math.floor(d / 365)}y`;
}

export function relTime(iso, now = Date.now()) {
  const ms = now - (typeof iso === 'number' ? iso : Date.parse(iso));
  if (!(ms >= 45_000)) return 'just now';
  if (ms < HOUR) return `${Math.round(ms / MIN)} min ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h ago`;
  if (ms < 2 * DAY) return 'yesterday';
  return `${Math.floor(ms / DAY)} days ago`;
}

export const clock = (d) => new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

const dayStart = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };

/** "3:15 PM", "tomorrow 9:00 AM", "Mon 9:00 AM", "Dec 4". */
export function whenLabel(d, now = Date.now()) {
  const t = new Date(d);
  const days = Math.round((dayStart(t) - dayStart(now)) / DAY);
  if (days === 0) return clock(t);
  if (days === 1) return `tomorrow ${clock(t)}`;
  if (days > 1 && days < 7) return `${t.toLocaleDateString([], { weekday: 'short' })} ${clock(t)}`;
  return t.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** Snooze choices, computed at the moment the menu opens. */
export function snoozeChoices(now = new Date()) {
  const hour = new Date(now.getTime() + HOUR);
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
  const monday = new Date(now); monday.setDate(now.getDate() + (((8 - now.getDay()) % 7) || 7)); monday.setHours(9, 0, 0, 0);
  return [
    { label: '1 hour', until: hour.toISOString(), hint: clock(hour) },
    { label: 'Tomorrow', until: tomorrow.toISOString(), hint: clock(tomorrow) },
    { label: 'Next week', until: monday.toISOString(), hint: `Mon ${clock(monday)}` },
    { label: 'Until it changes', until: 'change', hint: '' },
  ];
}
