import { randomUUID } from 'node:crypto'
import { realpath as fsRealpath } from 'node:fs/promises'
import { posix } from 'node:path'
import { authorize, importV1 } from './policy.mjs'
import { envReturn, runEnv } from './env.mjs'
import { botForCwd, callerKey } from './identity.mjs'
import { useKey, signData, signDigest } from './keyuse.mjs'
import { callHttp, forgetTokens } from './http.mjs'
import { callGmail } from './gmail.mjs'
import { planRun, startRun, stopRuns } from './run.mjs'
import { sshIdentity, sshSign } from './sshkey.mjs'
import { sendMail } from './mail.mjs'
import { LIMITS, listFolders, openImap, readFolder, sortMessage } from './imap.mjs'

const NOT_REGISTERED = 'This command is not registered.'
// A reason the caller may see (a server's status code or one of our fixed words): never a value from the item or the request.
const SAFE_DETAIL = /^(?:smtp [2-5]\d\d|imap (?:NO|BAD|BYE)|token \d{3}|token request|no AUTH PLAIN|no archive folder|no MOVE|no such message|keywords do not persist|uidvalidity|connect|timeout|connection|io|item|request|keywords|nothing|date|control|q|id|labels|max_results|page_token|format|action)$/u
const ENTRY_ONLY = ['grant', 'revoke', 'import'], DECISION_KEYS = ['id', 'role', 'record', 'need', 'reason']
const REFUSALS = { stopped: 'This command is stopped by the operator.', denied: 'This command is not permitted.' }

// store: {read, write}; items: createItemCache; audit: line => Promise; roots: () => {botId: absoluteRoot}.
export function createAuthCore({ store, items: itemCache, tokenState = null, runner = startRun, audit, roots, now = () => new Date(), realpath = fsRealpath, fetchImpl = fetch, mailConnect, imapConnect }) {
  // A flush (stop, revoke, flush, a new token) also drops the OAuth tokens the http op keeps in memory: the key is a hash of the item, so all of them go (cost: one new token).
  const items = { ...itemCache, get: (...a) => itemCache.get(...a), flush: name => { itemCache.flush(name); forgetTokens(); stopRuns(name) } }
  // An audit failure never refuses a request (the diagnostic is the caller's); it is swallowed here by design.
  const record = (rec, outcome, extra = {}) => { void Promise.resolve(audit({ ...rec, outcome, ...extra })).catch(() => {}) }

  const insideProject = async (cwd, root, real) => {
    if (!root || cwd !== posix.normalize(cwd) || (cwd.length > 1 && cwd.endsWith('/'))) return false
    try { const [c, r] = await Promise.all([real(cwd), real(root)]); return c === r || c.startsWith(r + '/') } catch { return false }
  }

  // The caller: the Bot the transport named, the unit (host folder or caller socket), or the registered Bot root that contains the peer's cwd.
  const identify = async request => request.botId ? { kind: 'bot', id: request.botId }
    : request.unit ? { kind: 'unit', folder: request.unit }
      : (id => id && { kind: 'bot', id })(botForCwd(await roots(), request.cwd))

  // request: {command: string[], cwd, via: 'mcp'|'container-socket'|'host-socket', botId?, unit?}
  async function resolve(request) {
    const at = now()
    const policy = await store.read()
    const name = request.command.join(' ')
    const caller = await identify(request)
    const rec = { time: at.toISOString(), request_id: randomUUID(), caller: caller ? callerKey(caller) : null, item: name, via: request.via, cwd: request.cwd }
    if (!caller || request.command.length === 0) { record(rec, 'unknown-caller'); return { outcome: 'unknown-caller', error: 'The caller is not registered.' } }
    // The run path starts a process in cwd, so cwd must be a clean path inside the Bot's own project (symlinks resolved).
    if (request.via === 'mcp' && !(await insideProject(request.cwd, (await roots())[request.botId], realpath))) {
      record(rec, 'denied'); return { outcome: 'denied', error: 'The working folder is outside your project.' }
    }
    const verdict = authorize(policy, caller, name, request.cwd, at.getTime())
    if (verdict !== 'granted') {
      if (verdict === 'stopped') items.flush(name)
      record(rec, verdict); return { outcome: verdict, error: REFUSALS[verdict] }
    }
    const found = await items.get(name, policy.vault, policy.cache_seconds)
    const env = found && (request.via === 'mcp' ? runEnv : envReturn)(found.fields, request.command[0])
    if (!env || Object.keys(env).length === 0) { record(rec, found ? 'error' : 'not-registered'); return { outcome: found ? 'error' : 'not-registered', error: NOT_REGISTERED } }
    record(rec, 'granted', { cache: found.hit ? 'hit' : 'miss' })
    return { outcome: 'granted', env, cache: found.hit ? 'hit' : 'miss' }
  }

  // Admin verbs run only for a Bot listed in policy.admins; the change is audited and the item cache is dropped.
  // Once an entry program is registered (entry.set), grant, revoke and import also need the peer program to be exactly that program, and carry the decision record.
  // program: {path, sha256, sealed} read by the relay from the peer process. The module judges nothing about the decision; it only requires and keeps it.
  async function admin(botId, verb, args = {}, program = null) {
    const policy = await store.read()
    const base = () => ({ time: now().toISOString(), request_id: randomUUID(), caller: `bot:${botId}`, item: args.command ?? null, via: 'admin' })
    if (!policy.admins.includes(botId)) { record(base(), 'denied'); return { outcome: 'denied', error: 'Not an administrator.' } }
    const decision = args.decision && typeof args.decision === 'object' ? Object.fromEntries(DECISION_KEYS.filter(k => typeof args.decision[k] === 'string').map(k => [k, args.decision[k].slice(0, 500)])) : undefined
    if (policy.entry && ENTRY_ONLY.includes(verb)) {
      const fromEntry = program?.sealed && program.path === policy.entry.path && program.sha256 === policy.entry.sha256
      if (!fromEntry || (verb !== 'import' && !(decision?.id && decision.reason))) {
        record(base(), 'denied', { refused: fromEntry ? 'no-decision' : 'not-entry', target: args.bot ?? args.unit, decision })
        return { outcome: 'denied', error: fromEntry ? 'A grant or revoke needs its decision record (id and reason).' : 'Grants change only through the registered grant entry program.' }
      }
    }
    const entry = args.unit ? (policy.units[args.unit] ??= { grants: [] }) : args.bot ? (policy.bots[args.bot] ??= { grants: [] }) : null
    let result = {}
    if (verb === 'grant') entry.grants.push({ command: args.command, ...(args.cwd ? { cwd: args.cwd } : {}), ...(args.expires ? { expires: args.expires } : {}) })
    else if (verb === 'revoke') entry.grants = entry.grants.filter(g => g.command !== args.command || (args.cwd && g.cwd !== args.cwd))
    else if (verb === 'stop') { if (!policy.stopped.includes(args.command)) policy.stopped.push(args.command) }
    else if (verb === 'resume') policy.stopped = policy.stopped.filter(c => c !== args.command)
    else if (verb === 'entry.set') { if (!/^\/[^\0]{1,4095}$/u.test(args.path) || !/^[a-f0-9]{64}$/u.test(args.sha256)) return { outcome: 'error', error: 'entry.set needs an absolute path and a sha256.' }; policy.entry = { path: args.path, sha256: args.sha256 } }
    else if (verb === 'flush') { items.flush(args.command); return { outcome: 'ok' } }
    else if (verb === 'show') return { outcome: 'ok', policy }
    else if (verb === 'import') { const out = importV1(policy, args.policy, args.host); Object.assign(policy, out.policy); result = { count: out.count } }
    else return { outcome: 'error', error: 'Unknown verb.' }
    await store.write(policy)
    if (args.command) items.flush(args.command)
    record(base(), verb, { target: args.bot ?? args.unit, expires: args.expires, grant_cwd: args.cwd, decision, entry: verb === 'entry.set' ? policy.entry : undefined })
    return { outcome: 'ok', ...result }
  }
  // Key use: the module uses the key inside itself and returns only the result (wrap or unwrap). Caller = the unit of the caller socket the relay named.
  // Same authorize and audit as resolve; the grant command is "wrapkey <name> wrap" or "wrapkey <name> unwrap"; the item is "wrapkey <name>" (field wrap_key).
  async function keyuse(request) {
    const at = now(), policy = await store.read()
    // wrap / unwrap use the item "wrapkey <name>", sign the item "signkey <name>"; the grant command adds the action. The caller is named by the transport (caller socket unit, host folder, container peer folder).
    const caller = await identify(request), key = `${{ sign: 'signkey', 'sign-digest': 'signkey', 'ssh-identity': 'sshkey', 'ssh-sign': 'sshkey' }[request.action] ?? 'wrapkey'} ${request.name}`, name = `${key} ${request.action.startsWith('ssh-') || request.action === 'sign-digest' ? 'sign' : request.action}`
    const where = request.cwd ?? request.unit
    const rec = { time: at.toISOString(), request_id: randomUUID(), caller: caller ? callerKey(caller) : null, item: name, action: request.action, via: request.via ?? 'caller-socket', cwd: where, aad: request.aad }
    if (!caller) { record(rec, 'unknown-caller'); return { outcome: 'unknown-caller', error: 'The caller is not registered.' } }
    const verdict = authorize(policy, caller, name, where, at.getTime())
    if (verdict !== 'granted') { if (verdict === 'stopped') items.flush(key); record(rec, verdict); return { outcome: verdict, error: REFUSALS[verdict] } }
    const found = await items.get(key, policy.vault, policy.cache_seconds)
    if (!found) { record(rec, 'not-registered'); return { outcome: 'not-registered', error: NOT_REGISTERED } }
    const cache = found.hit ? 'hit' : 'miss'
    try { const data = request.action === 'sign' ? signData(found.fields, request.data) : request.action === 'sign-digest' ? signDigest(found.fields, request.data) : request.action === 'ssh-identity' ? sshIdentity(found.fields) : request.action === 'ssh-sign' ? sshSign(found.fields, request.data, request.flags) : useKey(request.action, found.fields, request.data, request.aad ?? ''); record(rec, 'granted', { cache }); return { outcome: 'granted', data } }
    catch { record(rec, 'error', { cache }); return { outcome: 'error', error: `Cannot ${request.action}.` } }
  }
  // Http (F14): the module makes the request with the credential added and returns the response. Grant command "http <name>"; item "http <name>".
  async function http(request) {
    const at = now(), policy = await store.read(), caller = await identify(request), item = `http ${request.name}`
    const rec = { time: at.toISOString(), request_id: randomUUID(), caller: caller ? callerKey(caller) : null, item, via: request.via, cwd: request.cwd ?? request.unit, method: request.method, path: request.path.split('?')[0] }
    if (!caller) { record(rec, 'unknown-caller'); return { outcome: 'unknown-caller', error: 'The caller is not registered.' } }
    const verdict = authorize(policy, caller, item, request.cwd ?? request.unit, at.getTime())
    if (verdict !== 'granted') { if (verdict === 'stopped') items.flush(item); record(rec, verdict); return { outcome: verdict, error: REFUSALS[verdict] } }
    const found = await items.get(item, policy.vault, policy.cache_seconds)
    if (!found) { record(rec, 'not-registered'); return { outcome: 'not-registered', error: NOT_REGISTERED } }
    try {
      const result = await callHttp(found.fields, request, fetchImpl, tokenState && { state: tokenState, item, audit: extra => record({ ...rec, request_id: randomUUID(), method: undefined, path: undefined }, extra.rotated ? 'rotated' : 'rotation-failed') })
      record(rec, 'granted', { cache: found.hit ? 'hit' : 'miss', status: result.status })
      return { outcome: 'granted', ...result }
    } catch (error) { record(rec, 'error', { cache: found.hit ? 'hit' : 'miss' }); return { outcome: 'error', error: error?.code?.startsWith?.('HTTP_') ? error.message : 'The request failed.' } }
  }
  // Run (F22): the item fixes the command and holds the secrets; the relay named a per-run stream socket, the caller's bytes go in and the output comes back on it.
  async function run(request) {
    const at = now(), policy = await store.read(), caller = await identify(request), item = `run ${request.name}`
    const rec = { time: at.toISOString(), request_id: randomUUID(), caller: caller ? callerKey(caller) : null, item, via: request.via, cwd: request.cwd ?? request.unit }
    if (!caller) { record(rec, 'unknown-caller'); return { outcome: 'unknown-caller', error: 'The caller is not registered.' } }
    const verdict = authorize(policy, caller, item, request.cwd ?? request.unit, at.getTime())
    if (verdict !== 'granted') { if (verdict === 'stopped') items.flush(item); record(rec, verdict); return { outcome: verdict, error: REFUSALS[verdict] } }
    const found = await items.get(item, policy.vault, policy.cache_seconds)
    if (!found) { record(rec, 'not-registered'); return { outcome: 'not-registered', error: NOT_REGISTERED } }
    try {
      await runner(planRun(found.fields), { item, stream: request.stream, onEnd: end => record({ ...rec, request_id: randomUUID() }, 'run-ended', end) })
      record(rec, 'granted', { cache: found.hit ? 'hit' : 'miss' })
      return { outcome: 'granted' }
    } catch (error) { record(rec, 'error', { cache: found.hit ? 'hit' : 'miss' }); return { outcome: 'error', error: error?.code === 'RUN_REFUSED' ? error.message : 'The run failed.' } }
  }
  // Mail read (F17): the module logs in to the item's IMAP server, opens mailboxes read-only (EXAMINE, BODY.PEEK: nothing is ever marked seen) and answers with folders or messages.
  async function readMail(fields, request) {
    const client = await openImap(fields, imapConnect ? { connect: imapConnect } : {})
    try {
      const folders = await listFolders(client)
      if (request.folders) return { folders }
      const which = request.mailbox === '*' ? folders.map(f => f.name) : [request.mailbox ?? 'INBOX'], budget = { left: LIMITS.total }, limit = Math.min(request.limit ?? 20, LIMITS.messages), messages = []
      for (const folder of which) {
        if (budget.left <= 0) break
        messages.push(...await readFolder(client, folder, { search: request.search, order: request.order, limit, fetch: request.fetch ?? 'none', uid: request.uid, budget }))
      }
      const by = (a, b) => (Date.parse(b.internaldate) || 0) - (Date.parse(a.internaldate) || 0)
      if (which.length > 1) messages.sort(request.order === 'oldest' ? (a, b) => by(b, a) : by)
      return { messages: messages.slice(0, limit), ...(budget.left <= 0 ? { truncated: true } : {}) }
    } finally { client.close() }
  }

  // Mail sort (F19): keywords from the item's list and a move to the Archive folder, one message, the item's mailbox only.
  async function sortMail(fields, request) {
    const client = await openImap(fields, imapConnect ? { connect: imapConnect } : {})
    try {
      return await sortMessage(client, { folder: fields.mail_sort_mailbox ?? 'INBOX', uid: request.uid, uidvalidity: request.uidvalidity, add: request.add, archive: request.archive === true,
        allowed: (fields.mail_sort_keywords ?? '').split(',').map(k => k.trim()).filter(Boolean) })
    } finally { client.close() }
  }

  // Mail login check (F20): log in on one public port with normal verification and stop; nothing is sent or read.
  async function checkMail(fields, request) {
    if (request.protocol === 'imap993') { (await openImap({ ...fields, mail_imap_port: 993 }, imapConnect ? { connect: imapConnect } : {})).close(); return { tls_verified: !imapConnect } }
    const mode = { smtp465: { mail_port: 465, mail_tls: 'implicit' }, 'smtp587-starttls': { mail_port: 587, mail_tls: 'starttls' } }[request.protocol]
    if (!mode) throw Object.assign(new Error('MAIL_REJECTED'), { code: 'MAIL_REJECTED' })
    const r = await sendMail({ ...fields, ...mode }, {}, { checkOnly: true, ...(mailConnect ? { connect: mailConnect } : {}) })
    return { tls_verified: !mailConnect && r.tls_verified }
  }

  // Mail send (F17): the module logs in to the item's SMTP server and sends. Grant command "mail <name> send"; item "mail <name>". The audit keeps counts and the message id, never addresses or text.
  async function mail(request) {
    const at = now(), policy = await store.read(), caller = await identify(request), item = `mail ${request.name}`, name = `${item} ${request.action}`
    const rec = { time: at.toISOString(), request_id: randomUUID(), caller: caller ? callerKey(caller) : null, item: name, action: request.action, via: request.via, cwd: request.cwd ?? request.unit, recipients: request.to?.length }
    if (!caller) { record(rec, 'unknown-caller'); return { outcome: 'unknown-caller', error: 'The caller is not registered.' } }
    const verdict = authorize(policy, caller, name, request.cwd ?? request.unit, at.getTime())
    if (verdict !== 'granted') { if (verdict === 'stopped') items.flush(item); record(rec, verdict); return { outcome: verdict, error: REFUSALS[verdict] } }
    const found = await items.get(item, policy.vault, policy.cache_seconds)
    if (!found) { record(rec, 'not-registered'); return { outcome: 'not-registered', error: NOT_REGISTERED } }
    try {
      const result = request.action === 'read' ? await readMail(found.fields, request) : request.action === 'sort' ? await sortMail(found.fields, request) : request.action === 'check' ? await checkMail(found.fields, request) : await sendMail(found.fields, request, { now, ...(mailConnect ? { connect: mailConnect } : {}) })
      record(rec, 'granted', { cache: found.hit ? 'hit' : 'miss', message_id: result.message_id, folders: result.folders?.length, messages: result.messages?.length, flagged: result.flagged?.length, moved: result.moved, protocol: request.protocol })
      return { outcome: 'granted', ...result }
    } catch (error) { const code = error?.code?.startsWith?.('MAIL_') ? error.code : 'MAIL_NOT_SUBMITTED'; record(rec, 'error', { cache: found.hit ? 'hit' : 'miss', class: code, why: error?.why }); return { outcome: 'error', error: code, ...(SAFE_DETAIL.test(error?.why ?? '') ? { detail: error.why } : {}) } }
  }
  // Gmail (F21): fixed Gmail API calls with the item's OAuth secrets. Grants "gmail <name> read" (list, get) and "gmail <name> sort" (modify). The audit has the action and the status only.
  const gmailTokens = new Map()
  async function gmail(request) {
    const at = now(), policy = await store.read(), caller = await identify(request), item = `gmail ${request.name}`, name = `${item} ${request.action === 'modify' ? 'sort' : 'read'}`
    const rec = { time: at.toISOString(), request_id: randomUUID(), caller: caller ? callerKey(caller) : null, item: name, action: request.action, via: request.via, cwd: request.cwd ?? request.unit }
    if (!caller) { record(rec, 'unknown-caller'); return { outcome: 'unknown-caller', error: 'The caller is not registered.' } }
    const verdict = authorize(policy, caller, name, request.cwd ?? request.unit, at.getTime())
    if (verdict !== 'granted') { if (verdict === 'stopped') { items.flush(item); gmailTokens.delete(request.name) } record(rec, verdict); return { outcome: verdict, error: REFUSALS[verdict] } }
    const found = await items.get(item, policy.vault, policy.cache_seconds)
    if (!found) { record(rec, 'not-registered'); return { outcome: 'not-registered', error: NOT_REGISTERED } }
    try {
      const result = await callGmail(found.fields, request, { tokens: gmailTokens, name: request.name, fetchImpl, now: () => now().getTime() })
      record(rec, 'granted', { cache: found.hit ? 'hit' : 'miss', status: result.status })
      return { outcome: 'granted', ...result }
    } catch (error) { const code = error?.code?.startsWith?.('GMAIL_') ? error.code : 'GMAIL_FAILED'; record(rec, 'error', { cache: found.hit ? 'hit' : 'miss', class: code, why: error?.why }); return { outcome: 'error', error: code, ...(SAFE_DETAIL.test(error?.why ?? '') ? { detail: error.why } : {}) } }
  }
  return { resolve, admin, keyuse, http, mail, gmail, run }
}
