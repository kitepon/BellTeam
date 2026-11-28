import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { TLSSocket } from 'node:tls'
import { defaultConnect, sendMail, MAIL_NOT_SUBMITTED } from '../src/auth-mediation/mail.mjs'

// A real STARTTLS conversation: a plain SMTP greeting, then the server upgrades the SAME connection to TLS with a real certificate and the client must continue inside TLS.
const dir = mkdtempSync(join(tmpdir(), 'starttls-'))
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=smtp.test', '-addext', 'subjectAltName=DNS:smtp.test'], { stdio: 'ignore' })
const key = readFileSync(join(dir, 'k.pem')), cert = readFileSync(join(dir, 'c.pem'))
test.after(() => rmSync(dir, { recursive: true, force: true }))
const ITEM = { mail_host: 'smtp.test', mail_port: '587', mail_tls: 'starttls', mail_user: 'bot@smtp.test', mail_password: 'pa55-word-secret' }
const REQUEST = { to: ['a@b.cd'], subject: 'hi', text: 'body' }

async function server({ wrongName = false } = {}) {
  const seen = { plainAuth: false, tlsCommands: [], plainAfterUpgrade: false }
  const srv = createServer(raw => {
    raw.on('error', () => {}); raw.setEncoding('utf8'); raw.write('220 smtp.test ESMTP\r\n')
    let buf = '', secure = null
    const handle = (socket, tls) => { socket.on('data', d => { buf += d
      for (;;) { const eol = buf.indexOf('\r\n'); if (eol < 0) return; const line = buf.slice(0, eol); buf = buf.slice(eol + 2)
        if (!tls && line.startsWith('AUTH')) seen.plainAuth = true
        if (tls) seen.tlsCommands.push(line.split(' ')[0])
        if (line.startsWith('EHLO')) socket.write('250-smtp.test\r\n250-STARTTLS\r\n250 AUTH PLAIN\r\n')
        else if (line.startsWith('STARTTLS')) { socket.write('220 ready\r\n'); raw.removeAllListeners('data'); secure = new TLSSocket(raw, { isServer: true, key, cert }); secure.on('error', () => {}); handle(secure, true) }
        else if (line.startsWith('AUTH')) socket.write('235 ok\r\n')
        else if (line.startsWith('DATA')) { socket.write('354 go\r\n'); buf = buf; socket.once('data', () => {}) }
        else if (line.startsWith('QUIT')) socket.end('221 bye\r\n')
        else if (line === '.') socket.write('250 queued\r\n')
        else socket.write('250 ok\r\n') } }) }
    handle(raw, false)
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  // the production connect, pointed at the test server, trusting only the test certificate
  const connect = o => defaultConnect({ ...o, host: wrongName ? 'other.test' : 'smtp.test', dial: { host: '127.0.0.1', port }, tls: { ca: cert } })
  return { seen, connect, close: () => srv.close() }
}

test('starttls: the real upgrade works: AUTH and the message travel only inside TLS, the password never in clear', async () => {
  const s = await server()
  try {
    const r = await sendMail(ITEM, REQUEST, { connect: s.connect })
    assert.match(r.message_id, /^<[0-9a-f-]+@smtp\.test>$/u); assert.equal(s.seen.plainAuth, false)
    assert.ok(['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA'].every(c => s.seen.tlsCommands.includes(c)), s.seen.tlsCommands.join())
  } finally { s.close() }
})

test('starttls: a certificate for another name is refused and nothing sensitive is sent', async () => {
  const s = await server({ wrongName: true })
  try {
    const e = await sendMail(ITEM, REQUEST, { connect: s.connect }).catch(x => x)
    assert.equal(e.code, MAIL_NOT_SUBMITTED); assert.equal(s.seen.plainAuth, false); assert.ok(!s.seen.tlsCommands.includes('AUTH'))
  } finally { s.close() }
})
