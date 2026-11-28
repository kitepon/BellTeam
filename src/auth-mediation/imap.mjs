import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

// IMAP read inside the module (README F17): the module logs in to the item's IMAP server and answers with folders and messages; the password never leaves.
// Read-only by construction: mailboxes are opened with EXAMINE (nothing can be changed, \Seen included) and bodies are fetched with BODY.PEEK.
export const MAIL_NOT_SUBMITTED = 'MAIL_NOT_SUBMITTED', MAIL_REJECTED = 'MAIL_REJECTED'
const fail = (code, why) => Object.assign(new Error(code), { code, why })
const STEP_MS = 20000, TOTAL_MS = 60000
export const LIMITS = { messages: 50, headers: 65536, text: 262144, raw: 262144, one: 1048576, total: 2097152 }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const quote = value => '"' + String(value).replace(/([\\"])/gu, '\\$1') + '"'
const printable = (value, max) => typeof value === 'string' && value.length >= 1 && value.length <= max && /^[\x20-\x7e]*$/u.test(value)
const imapDate = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(iso ?? ''); if (!m || +m[2] < 1 || +m[2] > 12) throw fail(MAIL_REJECTED, 'date'); return `${+m[3]}-${MONTHS[+m[2] - 1]}-${m[1]}` }

// The search a caller may ask for: fixed words and validated values only, never a raw IMAP string.
export function searchCriteria(search = {}) {
  const parts = []
  if (search.unseen) parts.push('UNSEEN')
  if (search.since) parts.push('SINCE', imapDate(search.since))
  if (search.before) parts.push('BEFORE', imapDate(search.before))
  for (const key of ['from', 'subject']) if (search[key] !== undefined) { if (!printable(search[key], 100)) throw fail(MAIL_REJECTED, key); parts.push(key.toUpperCase(), quote(search[key])) }
  return parts.length ? parts.join(' ') : 'ALL'
}

// A connection that speaks tagged commands. Responses are read as latin1 text so literal sizes (bytes) match string lengths.
export async function openImap(fields, { connect = defaultConnect } = {}) {
  const host = fields?.mail_host, user = fields?.mail_user, password = fields?.mail_password, port = Number(fields?.mail_imap_port ?? 993)
  if (!host || !user || !password || !Number.isInteger(port) || /[\r\n\0]/u.test(user + password)) throw fail(MAIL_REJECTED, 'item')
  let socket, buffer = '', ended = false, waiter = null, tag = 0
  const deadline = Date.now() + TOTAL_MS
  const wake = () => { const w = waiter; waiter = null; w?.() }
  try { socket = await connect({ host, port }) } catch { throw fail(MAIL_NOT_SUBMITTED, 'connect') }
  socket.setEncoding('latin1'); socket.on('data', d => { buffer += d; wake() }); for (const e of ['end', 'error', 'close']) socket.on(e, () => { ended = true; wake() })
  const more = async () => {
    const left = deadline - Date.now(), before = buffer.length
    if (ended || left <= 0) throw fail(MAIL_NOT_SUBMITTED, 'connection')
    await new Promise(resolve => { const t = setTimeout(resolve, Math.min(STEP_MS, left)); waiter = () => { clearTimeout(t); resolve() } })
    if (buffer.length === before && !ended) throw fail(MAIL_NOT_SUBMITTED, 'timeout')
  }
  // One response: a line, where "{n}" at its end announces n bytes of literal, after which the line goes on. Returns {text (literals replaced by \0L<i>\0), literals}.
  async function response() {
    let text = '', literals = [], at = 0
    for (;;) {
      const eol = buffer.indexOf('\r\n', at)
      if (eol < 0) { await more(); continue }
      const line = buffer.slice(at, eol), m = /\{(\d+)\}$/u.exec(line)
      if (!m) { text += line; buffer = buffer.slice(eol + 2); return { text, literals } }
      const n = Number(m[1]), start = eol + 2
      while (buffer.length < start + n) await more()
      text += line.slice(0, m.index) + `\0L${literals.length}\0`; literals.push(buffer.slice(start, start + n)); buffer = buffer.slice(start + n); at = 0
    }
  }
  const client = {
    async command(text) {
      const id = 'A' + ++tag; socket.write(`${id} ${text}\r\n`)
      const untagged = []
      for (;;) {
        const r = await response()
        if (r.text.startsWith(id + ' ')) { const status = r.text.slice(id.length + 1).split(' ')[0]; if (status === 'OK') return { untagged, text: r.text }; throw fail(status === 'NO' ? MAIL_REJECTED : MAIL_REJECTED, 'imap ' + status) }
        untagged.push(r)
      }
    },
    close() { try { socket.write('A99 LOGOUT\r\n') } catch { /* gone */ } try { socket.destroy() } catch { /* gone */ } },
  }
  try {
    await response() // greeting
    await client.command(`LOGIN ${quote(user)} ${quote(password)}`)
    return client
  } catch (error) { client.close(); throw error?.code?.startsWith?.('MAIL_') ? error : fail(MAIL_NOT_SUBMITTED, 'io') }
}

export async function listFolders(client) {
  const { untagged } = await client.command('LIST "" "*"')
  return untagged.flatMap(r => { const m = /^\* LIST \(([^)]*)\) (?:"[^"]*"|NIL) (?:"((?:[^"\\]|\\.)*)"|(\S+))$/u.exec(r.text); if (!m) return []
    const attrs = m[1].split(' ').filter(Boolean); if (attrs.includes('\\Noselect') || attrs.includes('\\NonExistent')) return []
    const role = ['\\Archive', '\\Drafts', '\\Sent', '\\Trash', '\\Junk', '\\All', '\\Flagged'].find(a => attrs.includes(a))
    return [{ name: (m[2] ?? m[3]).replace(/\\(.)/gu, '$1'), ...(role ? { role: role.slice(1).toLowerCase() } : {}) }] })
}

const decode = literal => Buffer.from(literal, 'latin1')
// Reads one folder (EXAMINE: read-only). search -> uids; fetch summaries (and bodies by kind) for the newest/oldest N.
export async function readFolder(client, folder, { search, order = 'newest', limit = 20, fetch = 'none', uid, budget }) {
  const sel = await client.command(`EXAMINE ${quote(folder)}`)
  const uidvalidity = Number(sel.untagged.map(r => /\[UIDVALIDITY (\d+)\]/u.exec(r.text)?.[1]).find(Boolean))
  let uids
  if (uid !== undefined) uids = [uid]
  else {
    const found = (await client.command(`UID SEARCH ${searchCriteria(search)}`)).untagged.find(r => r.text.startsWith('* SEARCH'))
    uids = (found?.text.slice(8).trim().split(' ').filter(Boolean).map(Number) ?? []).sort((a, b) => a - b)
    uids = order === 'oldest' ? uids.slice(0, limit) : uids.slice(-limit).reverse()
  }
  if (!uids.length) return []
  const body = { none: '', headers: ' BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID AUTHENTICATION-RESULTS)]', text: ' BODY.PEEK[TEXT]', raw: ' BODY.PEEK[]' }[fetch]
  const out = await client.command(`UID FETCH ${uids.join(',')} (UID FLAGS INTERNALDATE RFC822.SIZE${body})`)
  const cap = uid !== undefined ? LIMITS.one : LIMITS[fetch] ?? 0
  const messages = out.untagged.flatMap(r => {
    const t = r.text; if (!/^\* \d+ FETCH /u.test(t)) return []
    const m = { folder, uid: Number(/UID (\d+)/u.exec(t)?.[1]), uidvalidity, flags: (/FLAGS \(([^)]*)\)/u.exec(t)?.[1] ?? '').split(' ').filter(Boolean),
      internaldate: /INTERNALDATE "([^"]+)"/u.exec(t)?.[1], size: Number(/RFC822\.SIZE (\d+)/u.exec(t)?.[1]) }
    const part = /BODY\[[^\]]*\] (?:\0L(\d+)\0|"((?:[^"\\]|\\.)*)"|NIL)/u.exec(t)
    if (part && fetch !== 'none') {
      let bytes = part[1] !== undefined ? decode(r.literals[Number(part[1])]) : Buffer.from(part[2] ?? '', 'latin1')
      if (bytes.length > cap) { bytes = bytes.subarray(0, cap); m.truncated = true }
      if (budget.left < bytes.length) { bytes = bytes.subarray(0, Math.max(0, budget.left)); m.truncated = true }
      budget.left -= bytes.length
      if (fetch === 'raw') m.raw = bytes.toString('base64'); else m[fetch] = bytes.toString('utf8')
    }
    return [m]
  })
  return order === 'oldest' ? messages.sort((a, b) => a.uid - b.uid) : messages.sort((a, b) => b.uid - a.uid)
}

function defaultConnect({ host, port }) {
  return new Promise((resolve, reject) => { const s = tlsConnect({ host, port, servername: host }); s.once('secureConnect', () => resolve(s)); s.once('error', reject); s.setTimeout(STEP_MS * 2, () => s.destroy(new Error('timeout'))) })
}
void netConnect
