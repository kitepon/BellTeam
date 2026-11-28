import assert from 'node:assert/strict'
import { createServer, connect as netConnect } from 'node:net'
import test from 'node:test'
import { createAuthCore } from '../src/auth-mediation/core.mjs'
import { createItemCache } from '../src/auth-mediation/items.mjs'
import { openImap, sortMessage } from '../src/auth-mediation/imap.mjs'
import { emptyPolicy } from '../src/auth-mediation/policy.mjs'
import { validateAuthMediationRequest } from '../src/auth-mediation-protocol.mjs'
import { relayAnswer } from '../src/auth-mediation-relay.mjs'

const KW = '$Phantom_Handoff,$Phantom_Action,$Phantom_Junk,$Phantom_Dismissed'
const ITEM = { mail_host: 'imap.example.com', mail_user: 'me@example.com', mail_password: 'pa55-word-secret', mail_sort_keywords: KW }

// A fake IMAP server that records every command and can lack features (no MOVE, no Archive folder, custom flags not permanent, other uidvalidity).
async function fakeImap(opts = {}) {
  const { move = true, archive = true, permanent = '\\Seen \\Deleted \\*', uidvalidity = 777 } = opts, seen = []
  const server = createServer(socket => {
    let buf = ''; socket.setEncoding('latin1'); socket.on('error', () => {}); socket.write('* OK ready\r\n')
    socket.on('data', d => { buf += d
      for (;;) {
        const eol = buf.indexOf('\r\n'); if (eol < 0) return
        const line = buf.slice(0, eol); buf = buf.slice(eol + 2); seen.push(line)
        const [tag, cmd, ...rest] = line.split(' ')
        if (cmd === 'LOGIN') socket.write(tag + ' OK ok\r\n')
        else if (cmd === 'LIST') socket.write('* LIST () "/" "INBOX"\r\n' + (archive ? '* LIST (\\Archive) "/" "Archive"\r\n' : '') + tag + ' OK\r\n')
        else if (cmd === 'CAPABILITY') socket.write(`* CAPABILITY IMAP4rev1 ${move ? 'MOVE ' : ''}UIDPLUS\r\n${tag} OK\r\n`)
        else if (cmd === 'SELECT') socket.write(`* 1 EXISTS\r\n* OK [UIDVALIDITY ${uidvalidity}] ok\r\n* OK [PERMANENTFLAGS (${permanent})] ok\r\n${tag} OK [READ-WRITE] done\r\n`)
        else if (cmd === 'UID' && rest[0] === 'FETCH') socket.write(rest[1] === '9' ? `* 1 FETCH (UID 9)\r\n${tag} OK\r\n` : tag + ' OK\r\n')
        else if (cmd === 'UID' && (rest[0] === 'STORE' || rest[0] === 'MOVE')) socket.write(tag + ' OK done\r\n')
        else if (cmd === 'LOGOUT') socket.end(tag + ' OK bye\r\n')
        else socket.write(tag + ' BAD unknown\r\n')
      } })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port
  return { seen, connect: () => netConnect(port, '127.0.0.1'), close: () => server.close() }
}
const sort = async (args, opts, fields = ITEM) => { const s = await fakeImap(opts); try { const c = await openImap(fields, { connect: s.connect }); try { return { s, result: await sortMessage(c, { folder: 'INBOX', uid: 9, uidvalidity: 777, allowed: KW.split(','), ...args }).then(r => r, e => e) } } finally { c.close() } } finally { s.close() } }
const writes = s => s.seen.filter(l => /UID (STORE|MOVE)/u.test(l))

test('sort: keywords are added with +FLAGS and the message moves to the Archive folder; only those two commands ever write', async () => {
  const { s, result } = await sort({ add: ['$Phantom_Action', '$Phantom_Handoff'], archive: true })
  assert.deepEqual(result, { flagged: ['$Phantom_Action', '$Phantom_Handoff'], moved: true })
  assert.deepEqual(writes(s).map(l => l.split(' ').slice(1).join(' ')), ['UID STORE 9 +FLAGS.SILENT ($Phantom_Action $Phantom_Handoff)', 'UID MOVE 9 "Archive"'])
  assert.ok(!s.seen.some(l => /EXPUNGE|DELETE|COPY|APPEND|-FLAGS|\\Seen|\\Deleted/u.test(l.replace(/^\S+ SELECT.*/u, ''))))
  const flagOnly = await sort({ add: ['$Phantom_Junk'] }); assert.deepEqual(flagOnly.result, { flagged: ['$Phantom_Junk'], moved: false }); assert.equal(writes(flagOnly.s).length, 1)
  const moveOnly = await sort({ archive: true }); assert.deepEqual(moveOnly.result, { flagged: [], moved: true })
})

test('sort: a keyword outside the item\'s list, a system flag, a malformed word, too many or nothing to do is refused before anything is written', async () => {
  for (const add of [['$Phantom_BooksReceived'], ['\\Seen'], ['\\Deleted'], ['$Phantom_Action', '\\Seen'], ['a b'], ['x\r\nA9 DELETE Archive'], ['$Phantom_Action\n'], Array(9).fill('$Phantom_Junk'), [1]]) {
    const { s, result } = await sort({ add }); assert.equal(result.code, 'MAIL_REJECTED', JSON.stringify(add)); assert.equal(writes(s).length, 0)
  }
  assert.equal((await sort({})).result.code, 'MAIL_REJECTED'); assert.equal((await sort({ add: ['$Phantom_Action'], allowed: [] })).result.code, 'MAIL_REJECTED')
  for (const bad of [{ uid: 0 }, { uid: 1.5 }, { uidvalidity: 'x' }]) assert.equal((await sort({ add: ['$Phantom_Action'], ...bad })).result.code, 'MAIL_REJECTED')
})

test('sort: the module checks the server first and changes nothing when a check fails: other uidvalidity, no Archive folder, no MOVE, custom keywords not permanent, no such message', async () => {
  for (const [opts, args] of [[{ uidvalidity: 5 }, { add: ['$Phantom_Action'] }], [{ archive: false }, { archive: true }], [{ move: false }, { archive: true }], [{ permanent: '\\Seen' }, { add: ['$Phantom_Action'] }], [{}, { add: ['$Phantom_Action'], uid: 10 }]]) {
    const { s, result } = await sort(args, opts); assert.equal(result.code, 'MAIL_REJECTED', JSON.stringify(opts) + JSON.stringify(args)); assert.equal(writes(s).length, 0)
  }
  assert.equal((await sort({ archive: true }, { permanent: '\\Seen' })).result.moved, true) // MOVE needs no custom keywords
})

function core(server, grants = ['mail box sort', 'mail box check']) {
  const lines = [], UNIT = '/home/kite/phantom'
  const store = { policy: { ...emptyPolicy(), vault: 'v', units: { [UNIT]: { grants: grants.map(command => ({ command })) } } }, read: async () => structuredClone(store.policy) }
  const items = createItemCache({ runOp: async args => { if (args[2] !== 'mail box') throw new Error('x'); return JSON.stringify({ fields: Object.entries(ITEM).map(([label, value]) => ({ label, value })) }) } })
  return { UNIT, lines, core: createAuthCore({ store, items, audit: l => lines.push(l), roots: () => ({}), imapConnect: server.connect }) }
}

test('sort and check via the core: separate grants (read does not allow sort); the keyword list comes from the item; imap993 login check answers ok; the audit has counts, no keywords or subjects', async () => {
  const s = await fakeImap(); const t = core(s)
  try {
    const call = extra => t.core.mail({ name: 'box', via: 'host-socket', cwd: t.UNIT, unit: t.UNIT, ...extra })
    assert.equal((await call({ action: 'sort', uid: 9, uidvalidity: 777, add: ['$Phantom_Action'], archive: true })).outcome, 'granted')
    assert.equal((await call({ action: 'sort', uid: 9, uidvalidity: 777, add: ['$Other'] })).error, 'MAIL_REJECTED')
    assert.deepEqual(await call({ action: 'check', protocol: 'imap993' }), { outcome: 'granted', tls_verified: false }) // a stand-in connection is not a verified one
    assert.equal((await call({ action: 'check', protocol: 'ftp' })).error, 'MAIL_REJECTED')
    const noSort = core(s, ['mail box read']); assert.equal((await noSort.core.mail({ action: 'sort', name: 'box', uid: 9, uidvalidity: 777, add: ['$Phantom_Action'], via: 'host-socket', cwd: noSort.UNIT, unit: noSort.UNIT })).outcome, 'denied')
    await new Promise(r => setImmediate(r)); const log = JSON.stringify(t.lines)
    assert.ok(!log.includes('Phantom') && !log.includes('pa55-word-secret'))
    assert.deepEqual(t.lines.slice(0, 1).map(l => [l.item, l.outcome, l.flagged, l.moved]), [['mail box sort', 'granted', 1, true]])
  } finally { s.close() }
})

test('relay and protocol: sort and check carry exactly their fields; the caller cannot name the mailbox', async () => {
  const seen = []; const facade = { mail: async p => (seen.push(p), { outcome: 'granted' }) }
  await relayAnswer({ via: 'host-socket', peer: null, request: { op: 'mail-sort', name: 'box', cwd: '/c', uid: 9, uidvalidity: 777, add: ['$A'], archive: true, mailbox: 'Trash' } }, facade)
  await relayAnswer({ via: 'host-socket', peer: null, request: { op: 'mail-check', name: 'box', cwd: '/c', protocol: 'smtp465', junk: 1 } }, facade)
  assert.deepEqual(seen[0], { action: 'sort', name: 'box', uid: 9, uidvalidity: 777, add: ['$A'], archive: true, via: 'host-socket', cwd: '/c', unit: '/c' })
  assert.deepEqual(seen[1], { action: 'check', name: 'box', protocol: 'smtp465', via: 'host-socket', cwd: '/c', unit: '/c' })
  const ctx = { generation: 'g1' }, base = { name: 'box', via: 'host-socket', cwd: '/c' }
  assert.doesNotThrow(() => validateAuthMediationRequest('mail', { ...base, action: 'sort', uid: 9, uidvalidity: 777, add: ['$A'], archive: true }, ctx))
  assert.doesNotThrow(() => validateAuthMediationRequest('mail', { ...base, action: 'check', protocol: 'smtp587-starttls' }, ctx))
  for (const bad of [{ ...base, action: 'sort', uid: 9, uidvalidity: 777, mailbox: 'Trash' }, { ...base, action: 'sort', uid: 9 }, { ...base, action: 'sort', uid: 9, uidvalidity: 7, add: ['a b'] }, { ...base, action: 'sort', uid: 9, uidvalidity: 7, add: ['x\r\nA2 DELETE'] },
    { ...base, action: 'check', protocol: 'imap143' }, { ...base, action: 'check', protocol: 'imap993', mailbox: 'x' }, { ...base, action: 'read', archive: true }])
    assert.throws(() => validateAuthMediationRequest('mail', bad, ctx), /AUTH_MEDIATION_INVALID/u)
})
