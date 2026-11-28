import assert from 'node:assert/strict'
import { createServer, connect as netConnect } from 'node:net'
import test from 'node:test'
import { createAuthCore } from '../src/auth-mediation/core.mjs'
import { createItemCache } from '../src/auth-mediation/items.mjs'
import { listFolders, openImap, readFolder, searchCriteria, LIMITS } from '../src/auth-mediation/imap.mjs'
import { emptyPolicy } from '../src/auth-mediation/policy.mjs'
import { validateAuthMediationRequest } from '../src/auth-mediation-protocol.mjs'
import { relayAnswer } from '../src/auth-mediation-relay.mjs'

const ITEM = { mail_host: 'imap.example.com', mail_user: 'me@example.com', mail_password: 'pa55-word-secret' }
const RAW = 'From: a@b.cd\r\nTo: me@example.com\r\nSubject: Receipt 領収書\r\nMessage-ID: <1@b.cd>\r\n\r\nHello body 本文\r\n'
const FOLDERS = { INBOX: { uidvalidity: 777, messages: [{ uid: 5, flags: '\\Seen', date: '20-Nov-2026 10:00:00 +0000' }, { uid: 9, flags: '$Phantom_Action', date: '27-Nov-2026 09:00:00 +0000' }, { uid: 12, flags: '', date: '28-Nov-2026 08:00:00 +0000' }] },
  Archive: { uidvalidity: 5, messages: [{ uid: 1, flags: '\\Seen \\Flagged', date: '25-Nov-2026 07:00:00 +0000' }] } }

async function fakeImap({ password = ITEM.mail_password, big } = {}) {
  const seen = []
  const server = createServer(socket => {
    let buf = '', folder = null
    socket.setEncoding('latin1'); socket.on('error', () => {}); put(socket, '* OK ready\r\n') // the fake writes latin1 strings that hold UTF-8 bytes: the module reads bytes
    socket.on('data', d => { buf += d
      for (;;) {
        const eol = buf.indexOf('\r\n'); if (eol < 0) return
        const line = buf.slice(0, eol); buf = buf.slice(eol + 2); seen.push(line)
        const [tag, cmd, ...rest] = line.split(' '), arg = rest.join(' ')
        if (cmd === 'LOGIN') put(socket, arg.includes('"' + password + '"') ? tag + ' OK logged in\r\n' : tag + ' NO [AUTHENTICATIONFAILED] bad\r\n')
        else if (cmd === 'LIST') put(socket, '* LIST (\\HasNoChildren) "/" "INBOX"\r\n* LIST (\\HasNoChildren \\Archive) "/" "Archive"\r\n* LIST (\\Noselect \\HasChildren) "/" "Shared"\r\n' + tag + ' OK done\r\n')
        else if (cmd === 'EXAMINE') { folder = arg.replace(/"/gu, ''); const f = FOLDERS[folder]; put(socket, f ? `* 3 EXISTS\r\n* OK [UIDVALIDITY ${f.uidvalidity}] ok\r\n${tag} OK [READ-ONLY] done\r\n` : tag + ' NO no such mailbox\r\n') }
        else if (cmd === 'UID' && rest[0] === 'SEARCH') put(socket, `* SEARCH ${FOLDERS[folder].messages.map(m => m.uid).join(' ')}\r\n${tag} OK done\r\n`)
        else if (cmd === 'UID' && rest[0] === 'FETCH') {
          const uids = rest[1].split(',').map(Number), wants = /BODY\.PEEK\[([^\]]*)\]/u.exec(line)
          for (const u of uids) { const m = FOLDERS[folder].messages.find(x => x.uid === u); if (!m) continue
            let part = ''; if (wants) { const body = wants[1] === '' ? (big ?? RAW) : wants[1] === 'TEXT' ? 'Hello body 本文\r\n' : RAW.split('\r\n\r\n')[0] + '\r\n\r\n'; const bytes = Buffer.from(body, 'utf8').toString('latin1'); part = ` BODY[${wants[1]}] {${bytes.length}}\r\n${bytes}` }
            put(socket, `* ${u} FETCH (UID ${u} FLAGS (${m.flags}) INTERNALDATE "${m.date}" RFC822.SIZE ${RAW.length}${part})\r\n`) }
          put(socket, tag + ' OK done\r\n') }
        else if (cmd === 'LOGOUT') socket.end(Buffer.from(tag + ' OK bye\r\n'))
        else put(socket, tag + ' BAD unknown\r\n')
      } })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port
  return { seen, connect: () => netConnect(port, '127.0.0.1'), close: () => server.close() }
}
const put = (socket, text) => socket.write(Buffer.from(text, 'latin1'))
const withClient = async (fn, opts) => { const s = await fakeImap(opts); const c = await openImap(ITEM, { connect: s.connect }); try { return await fn(c, s) } finally { c.close(); s.close() } }

test('imap: folders come with their special-use role; unselectable ones are skipped', () => withClient(async c => {
  assert.deepEqual(await listFolders(c), [{ name: 'INBOX' }, { name: 'Archive', role: 'archive' }])
}))

test('imap: newest first with a limit; each message carries uid, uidvalidity, flags with keywords, internaldate and size', () => withClient(async c => {
  const list = await readFolder(c, 'INBOX', { order: 'newest', limit: 2, budget: { left: 1e9 } })
  assert.deepEqual(list.map(m => m.uid), [12, 9]); assert.equal(list[0].uidvalidity, 777); assert.deepEqual(list[1].flags, ['$Phantom_Action']); assert.equal(list[1].internaldate, '27-Nov-2026 09:00:00 +0000'); assert.equal(list[1].size, RAW.length)
  assert.deepEqual((await readFolder(c, 'INBOX', { order: 'oldest', limit: 2, budget: { left: 1e9 } })).map(m => m.uid), [5, 9])
}))

test('imap: fetch headers, text and raw (base64) come back intact; one message by uid; nothing is ever changed: EXAMINE and BODY.PEEK only', async () => {
  await withClient(async (c, s) => {
    const budget = { left: 1e9 }
    const h = await readFolder(c, 'INBOX', { limit: 1, fetch: 'headers', budget }); assert.match(h[0].headers, /Subject: Receipt 領収書/u); assert.ok(!h[0].headers.includes('Hello body'))
    const t = await readFolder(c, 'INBOX', { limit: 1, fetch: 'text', budget }); assert.equal(t[0].text, 'Hello body 本文\r\n')
    const r = await readFolder(c, 'INBOX', { uid: 9, fetch: 'raw', budget }); assert.equal(Buffer.from(r[0].raw, 'base64').toString(), RAW); assert.equal(r[0].uid, 9)
    const sent = s.seen.join('\n')
    assert.ok(/EXAMINE/u.test(sent) && !/SELECT|STORE|MOVE|COPY|EXPUNGE|APPEND|DELETE/u.test(sent)); assert.ok(!/BODY\[/u.test(sent.replace(/BODY\.PEEK\[/gu, '')))
  })
})

test('imap: a part is cut at its limit and the total at the budget; truncated says so', async () => {
  const big = 'X'.repeat(300000)
  await withClient(async c => {
    const r = await readFolder(c, 'INBOX', { limit: 1, fetch: 'raw', budget: { left: 1e9 } }); assert.equal(Buffer.from(r[0].raw, 'base64').length, LIMITS.raw); assert.equal(r[0].truncated, true)
    const one = await readFolder(c, 'INBOX', { uid: 12, fetch: 'raw', budget: { left: 1e9 } }); assert.equal(Buffer.from(one[0].raw, 'base64').length, 300000)
    const small = await readFolder(c, 'INBOX', { limit: 3, fetch: 'raw', budget: { left: 1000 } }); assert.ok(small.every(m => Buffer.from(m.raw ?? '', 'base64').length <= 1000)); assert.ok(small.some(m => m.truncated))
  }, { big })
})

test('imap: the search is built from fixed words and checked values; anything that could carry a command is refused', () => {
  assert.equal(searchCriteria(), 'ALL'); assert.equal(searchCriteria({ unseen: true, since: '2026-11-01', before: '2026-11-28', from: 'a@b.cd', subject: 'Re: "x"' }), 'UNSEEN SINCE 1-Nov-2026 BEFORE 28-Nov-2026 FROM "a@b.cd" SUBJECT "Re: \\"x\\""')
  for (const search of [{ from: 'a"\r\nA2 DELETE' }, { subject: 'ü' }, { since: '28/11/2026' }, { since: '2026-13-01' }, { from: '' }]) assert.throws(() => searchCriteria(search), e => e.code === 'MAIL_REJECTED')
})

test('imap: a wrong password is MAIL_REJECTED, a refused connection MAIL_NOT_SUBMITTED, an unknown folder an error', async () => {
  const s = await fakeImap({ password: 'other' })
  try { assert.equal((await openImap(ITEM, { connect: s.connect }).catch(e => e)).code, 'MAIL_REJECTED') } finally { s.close() }
  assert.equal((await openImap(ITEM, { connect: () => Promise.reject(new Error('x')) }).catch(e => e)).code, 'MAIL_NOT_SUBMITTED')
  await withClient(async c => assert.equal((await readFolder(c, 'Nope', { budget: { left: 1 } }).catch(e => e)).code, 'MAIL_REJECTED'))
})

function core(server, grants = ['mail box read']) {
  const lines = [], UNIT = '/home/kite/gretel'
  const store = { policy: { ...emptyPolicy(), vault: 'v', units: { [UNIT]: { grants: grants.map(command => ({ command })) } } }, read: async () => structuredClone(store.policy) }
  const items = createItemCache({ runOp: async args => { if (args[2] !== 'mail box') throw new Error('x'); return JSON.stringify({ fields: Object.entries(ITEM).map(([label, value]) => ({ label, value })) }) } })
  return { UNIT, lines, core: createAuthCore({ store, items, audit: l => lines.push(l), roots: () => ({}), imapConnect: server.connect }) }
}

test('mail read via the core: grant "mail <name> read"; every folder with "*"; the audit has counts only', async () => {
  const s = await fakeImap(); const t = core(s)
  try {
    const call = extra => t.core.mail({ action: 'read', name: 'box', via: 'host-socket', cwd: t.UNIT, unit: t.UNIT, ...extra })
    assert.deepEqual((await call({ folders: true })).folders, [{ name: 'INBOX' }, { name: 'Archive', role: 'archive' }])
    const all = await call({ mailbox: '*', order: 'newest', limit: 3, fetch: 'headers' }); assert.deepEqual(all.messages.map(m => [m.folder, m.uid]), [['INBOX', 12], ['INBOX', 9], ['Archive', 1]])
    assert.equal((await call({ name: 'other' })).outcome, 'denied'); assert.equal((await t.core.mail({ action: 'send', name: 'box', to: ['a@b.cd'], subject: 's', text: 't', via: 'host-socket', cwd: t.UNIT, unit: t.UNIT })).outcome, 'denied')
    await new Promise(r => setImmediate(r)); const log = JSON.stringify(t.lines)
    for (const secret of ['Receipt', '領収書', 'a@b.cd', 'pa55-word-secret', 'Hello body']) assert.ok(!log.includes(secret), secret)
    assert.deepEqual(t.lines.slice(0, 2).map(l => [l.item, l.outcome, l.folders ?? l.messages]), [['mail box read', 'granted', 2], ['mail box read', 'granted', 3]])
  } finally { s.close() }
})

test('mail read relay and protocol: mail-read reaches the facade with the caller named by the transport; the request keeps its exact fields', async () => {
  const seen = []; const facade = { mail: async p => (seen.push(p), { outcome: 'granted', messages: [] }) }
  await relayAnswer({ via: 'host-socket', peer: null, request: { op: 'mail-read', name: 'box', cwd: '/c', mailbox: '*', search: { unseen: true }, limit: 5, fetch: 'headers', uid: 3, folders: false, junk: 1 } }, facade)
  assert.deepEqual(seen[0], { action: 'read', name: 'box', mailbox: '*', search: { unseen: true }, limit: 5, fetch: 'headers', uid: 3, folders: false, via: 'host-socket', cwd: '/c', unit: '/c' })
  const ctx = { generation: 'g1' }, ok = { action: 'read', name: 'box', via: 'host-socket', cwd: '/c' }
  assert.doesNotThrow(() => validateAuthMediationRequest('mail', { ...ok, mailbox: '*', search: { since: '2026-11-01' }, order: 'oldest', limit: 50, fetch: 'raw', uid: 4 }, ctx))
  for (const bad of [{ ...ok, limit: 51 }, { ...ok, fetch: 'all' }, { ...ok, search: { x: 1 } }, { ...ok, to: ['a@b.cd'] }, { ...ok, order: 'random' }, { ...ok, uid: 0 }])
    assert.throws(() => validateAuthMediationRequest('mail', bad, ctx), /AUTH_MEDIATION_INVALID/u)
})
