import { randomUUID } from 'node:crypto'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

// SMTP send inside the module (README F17): the module logs in to the item's own server and sends; the password never leaves.
// Failure classes the caller can act on: MAIL_NOT_SUBMITTED (retry is safe), MAIL_REJECTED (do not retry), MAIL_UNKNOWN (the connection ended after the message was sent: never retry).
export const MAIL_NOT_SUBMITTED = 'MAIL_NOT_SUBMITTED', MAIL_REJECTED = 'MAIL_REJECTED', MAIL_UNKNOWN = 'MAIL_UNKNOWN'
const fail = (code, why) => Object.assign(new Error(code), { code, why })
const ADDRESS = /^[^\s<>()@",;:\\\0]+@[^\s<>()@",;:\\\0]+\.[^\s<>()@",;:\\\0]+$/u
const clean = (value, max) => typeof value === 'string' && value.length <= max && !/[\r\n\0]/u.test(value)
const STEP_MS = 20000, TOTAL_MS = 40000

// Pure: the message as CRLF text, base64 bodies (any characters survive), non-ASCII header text as RFC 2047 words.
export function buildMessage({ fromAddress, fromName, to, replyTo, subject, text, html, messageId, date = new Date() }) {
  const words = value => /^[\x20-\x7e]*$/u.test(value) ? value : [...value].reduce((parts, ch) => { const last = parts.at(-1); if (last && Buffer.byteLength(last + ch) <= 42) parts[parts.length - 1] = last + ch; else parts.push(ch); return parts }, []).map(part => `=?UTF-8?B?${Buffer.from(part).toString('base64')}?=`).join(' ')
  const b64 = body => Buffer.from(body, 'utf8').toString('base64').replace(/(.{76})/gu, '$1\r\n').replace(/\r\n$/u, '')
  const head = [`From: ${fromName ? `${/^[\x20-\x7e]*$/u.test(fromName) ? `"${fromName.replace(/(["\\])/gu, '\\$1')}"` : words(fromName)} ` : ''}<${fromAddress}>`, `To: ${to.map(a => `<${a}>`).join(', ')}`,
    ...(replyTo ? [`Reply-To: <${replyTo}>`] : []), `Subject: ${words(subject)}`, `Date: ${date.toUTCString()}`, `Message-ID: ${messageId}`, 'MIME-Version: 1.0']
  const part = (type, body) => [`Content-Type: ${type}; charset=utf-8`, 'Content-Transfer-Encoding: base64', '', b64(body)].join('\r\n')
  if (!html) return [...head, part('text/plain', text)].join('\r\n') + '\r\n'
  const boundary = '=_' + randomUUID()
  return [...head, `Content-Type: multipart/alternative; boundary="${boundary}"`, '', `--${boundary}`, part('text/plain', text), `--${boundary}`, part('text/html', html), `--${boundary}--`].join('\r\n') + '\r\n'
}

// One SMTP conversation. connect(options) returns a socket; production uses TLS with normal certificate and hostname checks (tests inject a plain socket).
export async function sendMail(fields, request, { connect = defaultConnect, now = () => new Date(), checkOnly = false } = {}) {
  const host = fields?.mail_host, user = fields?.mail_user, password = fields?.mail_password, fromAddress = fields?.mail_from ?? user
  const mode = fields?.mail_tls ?? 'implicit', port = Number(fields?.mail_port ?? (mode === 'starttls' ? 587 : 465))
  if (!host || !password || !ADDRESS.test(user ?? '') || !ADDRESS.test(fromAddress) || !['implicit', 'starttls'].includes(mode) || !Number.isInteger(port)) throw fail(MAIL_REJECTED, 'item')
  const { to, subject, text, html, from_name: fromName, reply_to: replyTo } = request
  if (!checkOnly && (!Array.isArray(to) || to.length < 1 || to.length > 10 || !to.every(a => clean(a, 254) && ADDRESS.test(a)) || !clean(subject, 256) || typeof text !== 'string' || Buffer.byteLength(text) > 32768
    || (html !== undefined && (typeof html !== 'string' || Buffer.byteLength(html) > 32768)) || (fromName !== undefined && !clean(fromName, 100)) || (replyTo !== undefined && !(clean(replyTo, 254) && ADDRESS.test(replyTo))))) throw fail(MAIL_REJECTED, 'request')
  const messageId = `<${randomUUID()}@${fromAddress.split('@')[1]}>`
  const body = checkOnly ? '' : buildMessage({ fromAddress, fromName, to, replyTo, subject, text, html, messageId, date: now() })
  let socket, buffer = '', waiter = null, ended = false, sent = false
  const deadline = Date.now() + TOTAL_MS
  const wake = () => { const w = waiter; waiter = null; w?.() }
  const attach = s => { if (s === socket) return; socket = s; s.setEncoding('utf8'); s.on('data', d => { buffer += d; wake() }); s.on('end', () => { ended = true; wake() }); s.on('error', () => { ended = true; wake() }); s.on('close', () => { ended = true; wake() }) }
  const lost = () => fail(sent ? MAIL_UNKNOWN : MAIL_NOT_SUBMITTED, 'connection')
  async function reply() {
    for (;;) {
      const lines = buffer.split('\r\n'), last = lines.findIndex(l => /^\d{3} /u.test(l))
      if (last >= 0 && lines.slice(0, last).every(l => /^\d{3}-/u.test(l))) { buffer = lines.slice(last + 1).join('\r\n'); return { code: Number(lines[last].slice(0, 3)), lines: lines.slice(0, last + 1) } }
      const left = deadline - Date.now(), before = buffer.length
      if (ended || left <= 0) throw lost()
      await new Promise(resolve => { const t = setTimeout(resolve, Math.min(STEP_MS, left)); waiter = () => { clearTimeout(t); resolve() } })
      if (buffer.length === before && !ended) throw lost() // a silent server: the step timer ran out
    }
  }
  const expect = async (ok, command) => {
    if (command !== undefined) socket.write(command + '\r\n')
    const r = await reply()
    if (r.code === ok || (Array.isArray(ok) && ok.includes(r.code))) return r
    throw fail(r.code >= 500 ? MAIL_REJECTED : MAIL_NOT_SUBMITTED, `smtp ${r.code}`)
  }
  try {
    try { attach(await connect({ host, port, mode })) } catch { throw fail(MAIL_NOT_SUBMITTED, 'connect') }
    await expect(220)
    let hello = await expect(250, 'EHLO auth-mediation')
    if (mode === 'starttls') {
      await expect(220, 'STARTTLS')
      attach(await connect({ host, port, mode, upgrade: socket })); buffer = ''
      hello = await expect(250, 'EHLO auth-mediation')
    }
    if (!hello.lines.some(l => /AUTH[ =].*PLAIN/iu.test(l))) throw fail(MAIL_REJECTED, 'no AUTH PLAIN')
    await expect(235, 'AUTH PLAIN ' + Buffer.from(`\0${user}\0${password}`).toString('base64'))
    if (checkOnly) { await expect(221, 'QUIT').catch(() => {}); return { tls_verified: true } } // login only: nothing is sent; the farewell is awaited so the server sees it
    await expect(250, `MAIL FROM:<${fromAddress}>`)
    for (const a of to) await expect([250, 251], `RCPT TO:<${a}>`)
    await expect(354, 'DATA')
    socket.write(body.replace(/^\./gmu, '..') + '.\r\n'); sent = true
    await expect(250)
    try { socket.write('QUIT\r\n') } catch { /* the message is accepted; the farewell is not needed */ }
    return { message_id: messageId }
  } catch (error) {
    if (error?.code?.startsWith?.('MAIL_')) throw error
    throw fail(sent ? MAIL_UNKNOWN : MAIL_NOT_SUBMITTED, 'io')
  } finally { try { socket?.destroy() } catch { /* already closed */ } }
}

function defaultConnect({ host, port, mode, upgrade }) {
  return new Promise((resolve, reject) => {
    const s = upgrade ? tlsConnect({ socket: upgrade, servername: host }) : mode === 'implicit' ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port })
    const ok = upgrade || mode === 'implicit' ? 'secureConnect' : 'connect'
    s.once(ok, () => resolve(s)); s.once('error', reject); s.setTimeout(STEP_MS * 2, () => s.destroy(new Error('timeout')))
  })
}
