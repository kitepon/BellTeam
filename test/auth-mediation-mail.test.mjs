import assert from 'node:assert/strict'
import { createServer, connect as netConnect } from 'node:net'
import test from 'node:test'
import { createAuthCore } from '../src/auth-mediation/core.mjs'
import { createItemCache } from '../src/auth-mediation/items.mjs'
import { buildMessage, sendMail, MAIL_NOT_SUBMITTED, MAIL_REJECTED, MAIL_UNKNOWN } from '../src/auth-mediation/mail.mjs'
import { emptyPolicy } from '../src/auth-mediation/policy.mjs'
import { validateAuthMediationRequest, validateAuthMediationResult } from '../src/auth-mediation-protocol.mjs'
import { relayAnswer } from '../src/auth-mediation-relay.mjs'

const ITEM = { mail_host: 'smtp.example.com', mail_port: '465', mail_tls: 'implicit', mail_user: 'bot@example.com', mail_password: 'pa55-word-secret' }
const REQUEST = { to: ['visitor@example.org'], subject: 'こんにちは Hello', text: 'Line one\n.dot line\nSecret-free body 日本語', from_name: 'AuctionBOT Contact', reply_to: 'inquirer@example.net' }

// A tiny SMTP server. script maps a command prefix to the reply it gives instead of the normal one; 'drop' closes the connection.
async function fakeSmtp(script = {}) {
  const seen = { commands: [], data: '' }
  const server = createServer(socket => {
    let buf = '', inData = false
    socket.setEncoding('utf8'); socket.write('220 fake ESMTP\r\n')
    socket.on('error', () => {})
    socket.on('data', d => {
      buf += d
      for (;;) {
        if (inData) { const end = buf.indexOf('\r\n.\r\n'); if (end < 0) return; seen.data = buf.slice(0, end + 2); buf = buf.slice(end + 5); inData = false
          const r = script.DATAEND ?? '250 queued as 1'; if (r === 'drop') return socket.destroy(); socket.write(r + '\r\n'); continue }
        const eol = buf.indexOf('\r\n'); if (eol < 0) return
        const line = buf.slice(0, eol); buf = buf.slice(eol + 2); seen.commands.push(line)
        const key = Object.keys(script).find(k => line.startsWith(k)); const r = key ? script[key] : null
        if (r === 'drop') return socket.destroy()
        if (r) { socket.write(r + '\r\n'); continue }
        if (line.startsWith('EHLO')) socket.write('250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n')
        else if (line.startsWith('STARTTLS')) socket.write('220 go ahead\r\n')
        else if (line.startsWith('AUTH')) socket.write('235 ok\r\n')
        else if (line.startsWith('DATA')) { socket.write('354 go\r\n'); inData = true }
        else if (line.startsWith('QUIT')) socket.end('221 bye\r\n')
        else socket.write('250 ok\r\n')
      }
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  return { seen, port, connect: ({ upgrade }) => upgrade ?? netConnect(port, '127.0.0.1'), close: () => server.close() }
}
const send = async (script, fields = ITEM, request = REQUEST) => { const s = await fakeSmtp(script); try { return { s, result: await sendMail(fields, request, { connect: s.connect }).then(r => r, e => e) } } finally { s.close() } }

test('mail: a message is sent with the item\'s own address, the caller\'s display name and reply-to, an encoded subject and a base64 body', async () => {
  const { s, result } = await send()
  assert.match(result.message_id, /^<[0-9a-f-]+@example\.com>$/u)
  const cmds = s.seen.commands
  assert.deepEqual(cmds.slice(0, 2), ['EHLO auth-mediation', 'AUTH PLAIN ' + Buffer.from('\0bot@example.com\0pa55-word-secret').toString('base64')])
  assert.deepEqual(cmds.slice(2, 5), ['MAIL FROM:<bot@example.com>', 'RCPT TO:<visitor@example.org>', 'DATA'])
  const [head, body] = s.seen.data.split('\r\n\r\n')
  assert.match(head, /^From: "AuctionBOT Contact" <bot@example\.com>$/mu); assert.match(head, /^Reply-To: <inquirer@example\.net>$/mu); assert.match(head, /^To: <visitor@example\.org>$/mu)
  assert.match(head, /^Subject: =\?UTF-8\?B\?/mu); assert.match(head, new RegExp('^Message-ID: ' + result.message_id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') + '$', 'mu'))
  assert.equal(Buffer.from(body.replace(/\r\n/gu, ''), 'base64').toString(), REQUEST.text)
  assert.ok(!s.seen.data.includes('pa55-word-secret'))
})

test('mail: the failure class says what the caller may do: not submitted (retry), rejected (do not retry), unknown after submit (never retry)', async () => {
  const cls = async script => (await send(script)).result.code
  assert.equal(await cls({ EHLO: '421 try later' }), MAIL_NOT_SUBMITTED); assert.equal((await send({ MAIL: '451 busy' })).result.code, MAIL_NOT_SUBMITTED)
  assert.equal(await cls({ RCPT: '452 mailbox full' }), MAIL_NOT_SUBMITTED); assert.equal(await cls({ RCPT: '550 no such user' }), MAIL_REJECTED)
  assert.equal(await cls({ AUTH: '535 bad credentials' }), MAIL_REJECTED); assert.equal(await cls({ MAIL: '553 sender refused' }), MAIL_REJECTED)
  assert.equal(await cls({ DATAEND: '451 try later' }), MAIL_NOT_SUBMITTED); assert.equal(await cls({ DATAEND: '554 spam' }), MAIL_REJECTED)
  assert.equal(await cls({ DATAEND: 'drop' }), MAIL_UNKNOWN) // the message was sent, the answer never came: never retry
  assert.equal(await cls({ RCPT: 'drop' }), MAIL_NOT_SUBMITTED)
  const refused = await sendMail(ITEM, REQUEST, { connect: () => Promise.reject(new Error('ECONNREFUSED')) }).catch(e => e); assert.equal(refused.code, MAIL_NOT_SUBMITTED)
})

test('mail: STARTTLS mode upgrades before AUTH; an item or a request that could inject headers or is malformed is rejected before any connection', async () => {
  const { s, result } = await send({}, { ...ITEM, mail_port: '587', mail_tls: 'starttls' })
  assert.ok(result.message_id); assert.deepEqual(s.seen.commands.slice(0, 4).map(c => c.split(' ')[0]), ['EHLO', 'STARTTLS', 'EHLO', 'AUTH'])
  let connects = 0; const connect = () => { connects++; return Promise.reject(new Error('no')) }
  for (const request of [{ ...REQUEST, subject: 'a\r\nBcc: x@y.z' }, { ...REQUEST, from_name: 'x\nBcc: a@b.c' }, { ...REQUEST, to: ['not-an-address'] }, { ...REQUEST, to: [] }, { ...REQUEST, to: Array(11).fill('a@b.cd') },
    { ...REQUEST, reply_to: 'a@b.c, d@e.fg' }, { ...REQUEST, text: 'x'.repeat(40000) }, { ...REQUEST, to: ['a@b.cd>\r\nRCPT TO:<x@y.zz'] }])
    assert.equal((await sendMail(ITEM, request, { connect }).catch(e => e)).code, MAIL_REJECTED)
  for (const fields of [{ ...ITEM, mail_password: undefined }, { ...ITEM, mail_user: 'nope' }, { ...ITEM, mail_tls: 'none' }, { ...ITEM, mail_host: undefined }]) assert.equal((await sendMail(fields, REQUEST, { connect }).catch(e => e)).code, MAIL_REJECTED)
  assert.equal(connects, 0)
})

test('mail check: a login-only probe on 465 or 587 stops after AUTH: no MAIL FROM, no DATA, nothing sent; a wrong password is MAIL_REJECTED', async () => {
  const s = await fakeSmtp(); const ok = await sendMail(ITEM, {}, { connect: s.connect, checkOnly: true }); s.close()
  assert.deepEqual(ok, { tls_verified: true }); assert.deepEqual(s.seen.commands.map(c => c.split(' ')[0]), ['EHLO', 'AUTH', 'QUIT'])
  const bad = await send({ AUTH: '535 bad credentials' }, ITEM, {}); assert.equal(bad.result.code, MAIL_REJECTED)
})

test('mail: a failed answer carries a reason the caller may see (the server status or a fixed word), never a value from the item or the request', async () => {
  const s = await fakeSmtp({ AUTH: '535 5.7.8 Username and Password not accepted for pa55-word-secret' }); const t = core(ITEM, undefined, s)
  try {
    const r = await t.core.mail({ action: 'send', name: 'contact', ...REQUEST, via: 'caller-socket', unit: t.UNIT })
    assert.deepEqual(r, { outcome: 'error', error: MAIL_REJECTED, detail: 'smtp 535' }); assert.ok(!JSON.stringify(r).includes('pa55'))
    const bad = await t.core.mail({ action: 'send', name: 'contact', ...REQUEST, to: ['not-an-address'], via: 'caller-socket', unit: t.UNIT }); assert.equal(bad.error, MAIL_REJECTED); assert.equal(bad.detail, 'request')
    assert.doesNotThrow(() => validateAuthMediationResult('mail', r)); assert.throws(() => validateAuthMediationResult('mail', { ...r, detail: 'x'.repeat(65) }))
  } finally { s.close() }
})

test('mail: buildMessage keeps html as an alternative and dot-stuffs nothing it does not need', () => {
  const m = buildMessage({ fromAddress: 'a@b.cd', to: ['c@d.ef'], subject: 'plain', text: 't', html: '<b>h</b>', messageId: '<1@b.cd>', date: new Date(0) })
  assert.match(m, /multipart\/alternative/u); assert.match(m, /^Date: Thu, 01 Jan 1970 00:00:00 GMT$/mu); assert.match(m, /text\/html; charset=utf-8/u); assert.ok(m.endsWith('\r\n'))
})

function core(item = ITEM, grants = ['mail contact send'], server) {
  const lines = [], UNIT = '/srv/x/callers/auctionbot/auctionbot.sock'
  const store = { policy: { ...emptyPolicy(), vault: 'v', units: { [UNIT]: { grants: grants.map(command => ({ command })) } } }, read: async () => structuredClone(store.policy) }
  const items = createItemCache({ runOp: async args => { if (args[2] !== 'mail contact') throw new Error('x'); return JSON.stringify({ fields: Object.entries(item).filter(([, v]) => v !== undefined).map(([label, value]) => ({ label, value })) }) } })
  return { UNIT, lines, core: createAuthCore({ store, items, audit: l => lines.push(l), roots: () => ({}), mailConnect: server?.connect }) }
}

test('mail via the core: same grants ("mail <name> send"); the answer is the message id or the failure class; the audit holds counts, never addresses, subject, text or password', async () => {
  const s = await fakeSmtp(); const t = core(ITEM, undefined, s)
  try {
    const call = (extra = {}) => t.core.mail({ action: 'send', name: 'contact', ...REQUEST, via: 'caller-socket', unit: t.UNIT, ...extra })
    const ok = await call(); assert.equal(ok.outcome, 'granted'); assert.ok(ok.message_id)
    assert.equal((await t.core.mail({ action: 'send', name: 'other', ...REQUEST, via: 'caller-socket', unit: t.UNIT })).outcome, 'denied')
    assert.equal((await t.core.mail({ action: 'send', name: 'contact', ...REQUEST, via: 'caller-socket', unit: '/else.sock' })).outcome, 'denied')
    assert.equal((await call({ to: ['not-an-address'] })).error, MAIL_REJECTED)
    await new Promise(r => setImmediate(r)); const log = JSON.stringify(t.lines)
    for (const secret of ['visitor@example.org', 'inquirer@example.net', 'pa55-word-secret', 'Line one', 'Hello']) assert.ok(!log.includes(secret), secret)
    assert.deepEqual(t.lines.slice(0, 2).map(l => [l.item, l.outcome, l.recipients]), [['mail contact send', 'granted', 1], ['mail other send', 'denied', 1]])
  } finally { s.close() }
})

test('mail relay and protocol: mail-send reaches the facade with the caller named by the transport; the request keeps its exact fields', async () => {
  const seen = []; const facade = { mail: async p => (seen.push(p), { outcome: 'granted', message_id: '<1@x>' }) }
  const line = { op: 'mail-send', name: 'contact', ...REQUEST, cwd: '/claimed', unit: '/claimed' }
  await relayAnswer({ via: 'container-socket', peer: { uid: 1000, cwd: '/srv/bellteam/bots/bot-a' }, request: line }, facade)
  await relayAnswer({ via: 'caller-socket', unit: '/x/callers/a/a.sock', peer: null, request: line }, facade)
  assert.deepEqual(seen.map(p => [p.via, p.cwd, p.unit]), [['container-socket', '/srv/bellteam/bots/bot-a', undefined], ['caller-socket', undefined, '/x/callers/a/a.sock']]); assert.equal(seen[0].from_name, 'AuctionBOT Contact'); assert.ok(!('op' in seen[0]))
  const ctx = { generation: 'g1' }, ok = { action: 'send', name: 'contact', to: ['a@b.cd'], subject: 's', text: 't', via: 'caller-socket', unit: '/x/a.sock' }
  assert.doesNotThrow(() => validateAuthMediationRequest('mail', { ...ok, html: 'h', from_name: 'n', reply_to: 'r@s.tu' }, ctx))
  for (const bad of [{ ...ok, action: 'read' }, { ...ok, to: [] }, { ...ok, unit: undefined }, { ...ok, extra: 1 }, { ...ok, text: undefined }]) assert.throws(() => validateAuthMediationRequest('mail', bad, ctx), /AUTH_MEDIATION_INVALID/u)
})
