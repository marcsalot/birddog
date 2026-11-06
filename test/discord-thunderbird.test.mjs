// Discord (through your own bot) and Thunderbird (local mail files).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import * as discord from '../src/sources/discord.mjs';
import * as tb from '../src/sources/thunderbird.mjs';
import { demoThunderbird } from '../src/demo.mjs';
import { fakeFetch, tmpDir } from './helpers.mjs';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-06T15:00:00Z');
const ME = '1100000000000000042';
const sf = (t) => String((BigInt(t) - 1420070400000n) << 22n);

describe('Discord', () => {
  it('checks the settings', () => {
    assert.deepEqual(discord.normalizeSettings({ userId: ` ${ME} `, guilds: '1200000000000000001, 1200000000000000002' }), { userId: ME, guilds: '1200000000000000001, 1200000000000000002' });
    assert.throws(() => discord.normalizeSettings({ userId: 'kai#1234' }), /user ID/);
    assert.throws(() => discord.normalizeSettings({ userId: ME, guilds: 'general' }), /server ID/);
    assert.equal(discord.snowflakeTime(sf(NOW)), NOW);
  });

  it('knows a mention: you, a reply to you, or a role you have; never your own message', () => {
    assert.equal(discord.mentionsYou({ author: { id: '1' }, mentions: [{ id: ME }] }, ME), true);
    assert.equal(discord.mentionsYou({ author: { id: '1' }, mention_roles: ['r1'] }, ME, new Set(['r1'])), true);
    assert.equal(discord.mentionsYou({ author: { id: '1' }, mention_roles: ['r2'] }, ME, new Set(['r1'])), false);
    assert.equal(discord.mentionsYou({ author: { id: ME }, mentions: [{ id: ME }] }, ME), false);
  });

  function server({ messages, channels } = {}) {
    const chans = channels ?? [
      { id: 'c1', name: 'general', type: 0, last_message_id: sf(NOW - HOUR) },
      { id: 'c2', name: 'secret', type: 0, last_message_id: sf(NOW - 2 * HOUR) },
      { id: 'c3', name: 'old', type: 0, last_message_id: sf(NOW - 30 * 24 * HOUR) },
      { id: 'c4', name: 'Voice', type: 2, last_message_id: null },
    ];
    const msg = (id, h, author, content, extra = {}) => ({ id, timestamp: new Date(NOW - h * HOUR).toISOString(), author: { id: author, username: `u${author}` }, content, mentions: [], mention_roles: [], ...extra });
    const msgs = messages ?? {
      c1: [
        msg('m4', 1, '7', `<@${ME}> ship it?`, { mentions: [{ id: ME }], member: { nick: 'Kai' } }),
        msg('m3', 3, ME, 'on it'),
        msg('m2', 5, '8', `<@${ME}> answered already`, { mentions: [{ id: ME }] }),
        msg('m1', 200, '8', `<@${ME}> too old`, { mentions: [{ id: ME }] }),
      ],
    };
    return fakeFetch((u, init) => {
      assert.equal(init.headers.authorization, 'Bot tok', 'sent as a bot token');
      assert.equal(init.method ?? 'GET', 'GET', 'read-only');
      const p = u.pathname.replace('/api/v10', '');
      if (p === '/users/@me') return { body: { id: 'bot', username: 'mybot' } };
      if (p === '/users/@me/guilds') return { body: [{ id: 'g1', name: 'Jam' }, { id: 'g2', name: 'Other' }] };
      if (p === '/guilds/g1/channels') return { body: chans };
      if (p === '/guilds/g1/members/' + ME) return { body: { roles: [] } };
      if (p === '/guilds/g1/threads/active') return { body: { threads: [] } };
      if (p === '/channels/c2/messages') return { status: 403, body: { message: 'Missing Access', code: 50001 } };
      const m = /^\/channels\/(\w+)\/messages$/.exec(p);
      if (m) return { body: msgs[m[1]] ?? [] };
      return undefined;
    });
  }

  it('lists mentions you have not answered since, in the servers you picked', async () => {
    const fetch = server();
    const warnings = [];
    const items = await discord.collect({ userId: ME, guilds: 'g1' }, { fetch, now: NOW, secret: async () => 'Bot tok', warn: (w) => warnings.push(w), summary() {} });
    assert.deepEqual(items.map((i) => i.id), ['discord:c1:m4'], 'm2 was answered by m3, m1 is too old');
    const [i] = items;
    assert.equal(i.kind, 'mention');
    assert.equal(i.urgency, 'today');
    assert.equal(i.url, 'https://discord.com/channels/g1/c1/m4');
    assert.match(i.title, /^Jam #general · @… ship it\?/);
    assert.equal(i.meta.fields.From, 'Kai');
    assert.ok(!fetch.calls.some((c) => c.url.pathname.includes('/guilds/g2')), 'only the chosen server');
    assert.ok(!fetch.calls.some((c) => /c3|c4/.test(c.url.pathname)), 'quiet and voice channels are skipped');
    assert.match(warnings.join(' '), /can't read 1 channel/);
  });

  it('says when message text is hidden (no Message Content Intent)', async () => {
    const fetch = server({ messages: { c1: [{ id: 'm9', timestamp: new Date(NOW - HOUR).toISOString(), author: { id: '7', username: 'kai' }, content: '', mentions: [{ id: ME }] }] } });
    const warnings = [];
    const items = await discord.collect({ userId: ME }, { fetch, now: NOW, secret: async () => 'tok', warn: (w) => warnings.push(w) });
    assert.match(items[0].title, /Message Content Intent/);
    assert.match(warnings.join(' '), /Message Content Intent/);
  });

  it('tests the connection and explains a bot with no servers', async () => {
    assert.equal((await discord.test({ userId: ME }, { fetch: server(), secret: async () => 'tok' })).ok, true);
    const lonely = fakeFetch((u) => (u.pathname.endsWith('/guilds') ? { body: [] } : { body: { username: 'mybot' } }));
    assert.match((await discord.test({ userId: ME }, { fetch: lonely, secret: async () => 'tok' })).message, /isn't in any server/);
    assert.match((await discord.test({ userId: ME }, { fetch: lonely, secret: async () => null })).message, /bot token/);
  });
});

const mbox = (msgs) => msgs.map(({ status, date, from = 'A <a@x>', subject = 'Hi', id }) => `From - ${date}\nX-Mozilla-Status: ${status}\nMessage-ID: <${id}>\nDate: ${date}\nFrom: ${from}\nSubject: ${subject}\n\nbody line\nFrom the body, not a separator?\n\n`).join('');

async function profileWith(inbox, { local = false } = {}) {
  const base = await tmpDir();
  const prof = path.join(base, 'Profiles', 'abcd.default-release');
  const box = path.join(prof, local ? 'Mail' : 'ImapMail', local ? 'Local Folders' : 'imap.x.com');
  await fs.mkdir(box, { recursive: true });
  await fs.writeFile(path.join(base, 'profiles.ini'), '[Profile0]\nName=default\nIsRelative=1\nPath=Profiles/old.default\n\n[Install4F96D1932A9F858E]\nDefault=Profiles/abcd.default-release\nLocked=1\n\n[Profile1]\nName=default-release\nIsRelative=1\nPath=Profiles/abcd.default-release\n');
  await fs.writeFile(path.join(prof, 'prefs.js'), local
    ? 'user_pref("mail.server.server2.directory-rel", "[ProfD]Mail/Local Folders");\nuser_pref("mail.server.server2.type", "none");\n'
    : 'user_pref("mail.server.server1.directory-rel", "[ProfD]ImapMail/imap.x.com");\nuser_pref("mail.server.server1.hostname", "imap.x.com");\nuser_pref("mail.server.server1.type", "imap");\nuser_pref("mail.server.server1.userName", "me@x.com");\nuser_pref("mail.server.server3.type", "rss");\nuser_pref("mail.server.server3.directory-rel", "[ProfD]Mail/Feeds");\n');
  await fs.writeFile(path.join(box, local ? 'Inbox' : 'INBOX'), inbox);
  return { base, prof };
}

describe('Thunderbird', () => {
  it('finds the default profile from profiles.ini (the [Install] section first)', () => {
    const ini = '[Profile0]\nPath=Profiles/a.default\nDefault=1\nIsRelative=1\n[Install123]\nDefault=Profiles/b.default-release\n[Profile1]\nPath=Profiles/b.default-release\nIsRelative=1\n';
    assert.equal(tb.defaultProfile(ini, '/base'), path.join('/base', 'Profiles', 'b.default-release'));
    assert.equal(tb.defaultProfile('[Profile0]\nPath=/abs/p\nIsRelative=0\nDefault=1\n', '/base'), '/abs/p');
    assert.equal(tb.defaultProfile('', '/base'), null);
    assert.equal(tb.baseDirs({ platform: 'darwin', home: '/Users/me' })[0], path.join('/Users/me', 'Library', 'Thunderbird'));
    assert.equal(tb.baseDirs({ platform: 'win32', home: 'C:\\Users\\me', env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } })[0], path.join('C:\\Users\\me\\AppData\\Roaming', 'Thunderbird'));
  });

  it('decodes headers: folded lines, encoded words, raw UTF-8, sender names', () => {
    const h = tb.parseHeaders('Subject: =?UTF-8?B?SGVsbG8g?=\n =?UTF-8?Q?w=C3=B6rld?=\nFrom: "Dana (landlord)" <dana@x>\nX-Mozilla-Status: 0005');
    assert.equal(tb.decodeWords(h.subject), 'Hello wörld');
    assert.equal(tb.senderName(h.from), 'Dana (landlord)');
    assert.equal(tb.senderName('<only@addr.example>'), 'only@addr.example');
    assert.equal(tb.decodeWords('=?iso-8859-1?Q?caf=E9?='), 'café');
    assert.equal(tb.parseHeaders(Buffer.from('Subject: 9–11', 'utf8').toString('latin1')).subject, '9–11');
  });

  it('splits an mbox and drops the cut-off first message of a tail', () => {
    const text = mbox([{ status: '0000', date: 'Fri, 06 Nov 2026 10:00:00 +0000', id: 'a' }, { status: '0001', date: 'Fri, 06 Nov 2026 11:00:00 +0000', id: 'b' }]);
    assert.deepEqual(tb.mboxMessages(text).map((m) => [m.headers['message-id'], m.flags]), [['<a>', 0], ['<b>', 1]]);
    assert.equal(tb.mboxMessages(text, { partial: true }).length, 1);
  });

  it('lists unread and starred mail, skips read, deleted, old and replied-to', async () => {
    const d = (h) => new Date(NOW - h * HOUR).toUTCString();
    const { base } = await profileWith(mbox([
      { status: '0000', date: d(2), from: 'Dana <d@x>', subject: 'Boiler visit', id: 'unread-fresh' },
      { status: '0000', date: d(40), subject: 'Library hold', id: 'unread-older' },
      { status: '0000', date: d(24 * 9), subject: 'Too old', id: 'unread-old' },
      { status: '0001', date: d(1), subject: 'Read', id: 'read' },
      { status: '0008', date: d(1), subject: 'Deleted', id: 'deleted' },
      { status: '0005', date: d(72), from: 'Alex <a@x>', subject: 'Camping', id: 'starred' },
      { status: '0007', date: d(72), subject: 'Starred but replied', id: 'starred-replied' },
      { status: '0000', date: d(2), from: 'Dana <d@x>', subject: 'Boiler visit', id: 'unread-fresh' }, // a duplicate copy
    ]));
    const opts = { platform: 'darwin', home: base };
    // Point baseDirs at our temp folder: on macOS it's <home>/Library/Thunderbird.
    await fs.mkdir(path.join(base, 'Library'), { recursive: true });
    await fs.symlink(base, path.join(base, 'Library', 'Thunderbird'));
    let summary = '';
    const items = await tb.collect({ days: 7 }, { now: NOW, thunderbird: opts, summary: (s) => { summary = s; } });
    assert.deepEqual(items.map((i) => [i.title, i.urgency, i.meta.rule.id]).sort(), [
      ['Boiler visit', 'today', 'email-unread-fresh'],
      ['Camping', 'today', 'email-starred'],
      ['Library hold', 'later', 'email-unread'],
    ]);
    const boiler = items.find((i) => i.title === 'Boiler visit');
    assert.equal(boiler.meta.fields.Account, 'me@x.com (imap.x.com)');
    assert.equal(boiler.url, null);
    assert.match(boiler.why, /Unread · from \*\*Dana\*\* \*\*2 hours\*\* ago/);
    assert.match(summary, /1 Inbox · 2 messages waiting · 1 starred/);
    assert.match((await tb.test({}, { thunderbird: opts })).message, /Reading 1 Inbox/);
  });

  it('reads Local Folders (POP) too, and a profile folder given in setup', async () => {
    const { prof } = await profileWith(mbox([{ status: '0000', date: new Date(NOW - HOUR).toUTCString(), id: 'p' }]), { local: true });
    const items = await tb.collect({ profile: prof }, { now: NOW });
    assert.equal(items.length, 1);
    assert.equal(items[0].meta.fields.Account, 'Local Folders');
  });

  it('explains what is missing, and checks the settings', async () => {
    const empty = await tmpDir();
    await assert.rejects(tb.collect({}, { thunderbird: { platform: 'linux', home: empty } }), /isn't set up on this computer/);
    await assert.rejects(tb.collect({ profile: empty }, {}), /No Thunderbird profile/);
    assert.deepEqual(tb.normalizeSettings({}), { profile: '', days: 7 });
    assert.deepEqual(tb.normalizeSettings({ profile: '~/tb', days: '14' }), { profile: '~/tb', days: 14 });
    assert.throws(() => tb.normalizeSettings({ profile: 'relative/path' }), /full path/);
    assert.throws(() => tb.normalizeSettings({ days: '0' }), /1 to 60/);
  });

  it('the demo profile works end to end', async () => {
    const dir = await tmpDir();
    const prof = await demoThunderbird(dir, NOW);
    const items = await tb.collect({ profile: prof }, { now: NOW });
    assert.deepEqual(items.map((i) => i.title).sort(), ['Boiler service visit: Thursday 9–11?', 'Camping weekend: who brings the stove?', 'Your hold is ready – pick up by Saturday']);
  });
});
