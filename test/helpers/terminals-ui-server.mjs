// Apple terminals screens (docs/architecture/modules/apple/terminals.md): artificial registry, check results and member PATCH rules.
// No SSH, keys or real terminals. Prints {"url"} on start; /test/reset, /test/mode?terminals=ok|unsupported|unavailable&members=new|old,
// /test/proof, /test/fingerprint?id=.
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../../ios/BellBot/BellBot/Core/PreviewFixtures.swift', import.meta.url), 'utf8')
const fixture = JSON.parse(source.match(/let source = """\n([\s\S]*?)\n\s*"""/u)[1])
export const fingerprint = id => `SHA256:${createHash('sha256').update(id).digest('base64').replace(/=+$/u, '')}`
const trust = id => ({ provider: 'aiterm.known-hosts.v1', revision: `sha256:${createHash('sha256').update(`trust-${id}`).digest('hex')}` })
const TERMINAL_ID = /^[a-z0-9][a-z0-9-]{0,62}$/u
const MEMBER_TERMINAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

let state
function reset() {
  state = {
    mode: { terminals: 'ok', members: 'new' },
    bots: structuredClone(fixture.bots).map((bot, index) => ({ ...bot, terminalId: index === 0 ? 'owner-macbook' : '', projectRoot: index === 0 ? '/Users/kite/work/app' : '' })),
    terminals: [
      { terminalId: 'owner-macbook', host: '192.168.1.12', user: 'kite', port: 22, os: 'macos', accountOwner: 'owner', sshKeyConfigured: true, sudoKeyConfigured: false, hostTrust: trust('owner-macbook'), revision: 4, maintenance: { terminalId: 'owner-macbook', observedAt: '2026-11-09T07:40:00Z', before: '2.1.30', after: '2.1.32', outcome: 'updated' } },
      { terminalId: 'sleeping-mini', host: '192.168.1.20', user: 'kite', port: 22, os: 'macos', accountOwner: 'owner', sshKeyConfigured: true, sudoKeyConfigured: false, hostTrust: trust('sleeping-mini'), revision: 1, maintenance: null },
      { terminalId: 'studio-mac', host: '192.168.1.30', user: 'hana', port: 2222, os: 'macos', accountOwner: 'terminal-owner', sshKeyConfigured: true, sudoKeyConfigured: true, revision: 2, maintenance: null },
      { terminalId: 'office-imac', host: 'office-imac.local', user: 'kite', port: 22, os: 'macos', accountOwner: 'owner', sshKeyConfigured: true, sudoKeyConfigured: false, hostTrust: trust('office-imac'), revision: 3, maintenance: { terminalId: 'office-imac', observedAt: '2026-11-08T22:10:00Z', before: '2.1.29', after: '2.1.29', outcome: 'failed' } },
    ],
    proof: { terminalReads: 0, puts: [], deletes: [], checks: [], botSaves: [], rejectedBotSaves: [] },
  }
}
reset()

const projection = record => {
  const { hostTrust, ...rest } = record
  return hostTrust ? { ...rest, hostTrust } : rest
}

function check(record) {
  const observedAt = new Date().toISOString()
  const base = { terminalId: record.terminalId, observedAt, reachable: false, reason: null }
  if (!record.sshKeyConfigured) return { ...base, reason: 'SSH_KEY_UNSET', action: `bind the SSH key of terminal ${record.terminalId} (bind_terminal_key)` }
  if (!record.hostTrust) return { ...base, reason: 'HOST_TRUST_MISSING', action: `confirm the host key of ${record.host}` }
  if (record.terminalId === 'sleeping-mini') return { ...base, reason: 'UNREACHABLE' }
  if (record.terminalId === 'office-imac' && record.revision < 4) return { ...base, reason: 'HOST_KEY_MISMATCH', action: `confirm the new host key ${fingerprint('office-imac')} on ${record.host}` }
  return { ...base, reachable: true }
}

function validRoot(path) {
  return typeof path === 'string' && path.startsWith('/') && !path.includes('\0') && Buffer.byteLength(path) <= 4096
    && (path === '/' || !path.slice(1).split('/').some(part => !part || part === '.' || part === '..'))
}

async function body(request) {
  let text = ''
  for await (const chunk of request) text += chunk
  return text ? JSON.parse(text) : {}
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost')
  const path = url.pathname
  const send = (status, value) => { response.statusCode = status; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)) }
  const fail = (status, code, message = code) => send(status, { error: code, message })
  if (path === '/test/reset') { reset(); return send(200, { ok: true }) }
  if (path === '/test/proof') return send(200, state.proof)
  // What the Owner would read on the terminal itself (the test plays the Owner).
  if (path === '/test/fingerprint') return send(200, { fingerprint: fingerprint(url.searchParams.get('id') ?? '') })
  if (path === '/test/mode') {
    for (const key of ['terminals', 'members']) if (url.searchParams.has(key)) state.mode[key] = url.searchParams.get(key)
    return send(200, state.mode)
  }
  const bots = () => state.bots.map(bot => {
    if (state.mode.members === 'new') return bot
    const { terminalId, projectRoot, ...old } = bot
    return old
  })
  if (path === '/api/bots' && request.method === 'GET') return send(200, { bots: bots() })
  const botMatch = /^\/api\/bots\/([a-z0-9-]+)$/u.exec(path)
  if (botMatch && request.method === 'GET') {
    const bot = bots().find(item => item.id === botMatch[1])
    return bot ? send(200, { bot }) : fail(404, 'BOT_NOT_FOUND')
  }
  if (botMatch && request.method === 'PATCH') {
    const input = await body(request)
    const bot = state.bots.find(item => item.id === botMatch[1])
    if (!bot) return fail(404, 'BOT_NOT_FOUND')
    // Same rules as bot-registry normalizeRemoteBinding; a body without the fields keeps the stored binding.
    const terminalId = input.terminalId ?? bot.terminalId, projectRoot = input.projectRoot ?? bot.projectRoot
    let code = null
    if (terminalId && !MEMBER_TERMINAL_ID.test(terminalId)) code = 'BOT_TERMINAL_ID_INVALID'
    else if (projectRoot && !validRoot(projectRoot)) code = 'BOT_PROJECT_ROOT_INVALID'
    else if (Boolean(terminalId) !== Boolean(projectRoot)) code = 'BOT_REMOTE_BINDING_INVALID'
    if (code) { state.proof.rejectedBotSaves.push({ body: input, code }); return fail(400, code) }
    state.proof.botSaves.push({ body: input })
    Object.assign(bot, input)
    return send(200, { ok: true })
  }
  if (path === '/api/rooms') return send(200, { rooms: fixture.rooms })
  if (path === '/api/owner') return send(200, { owner: fixture.owner })
  if (path === '/api/models') return send(200, { models: { claude: { efforts: ['high'], models: [{ id: 'opus', efforts: ['high'], fast: true }] }, codex: { efforts: [], models: [] }, grok: { efforts: [], models: [] } } })
  if (path === '/api/queue' || path.endsWith('/queue')) return send(200, { items: [] })
  if (path.endsWith('/messages') || path.endsWith('/timeline')) return send(200, { messages: [], items: [], hasMore: false })

  const terminalsMatch = /^\/api\/terminals(?:\/([a-z0-9][a-z0-9-]{0,63})(\/check)?)?$/u.exec(path)
  if (terminalsMatch) {
    if (state.mode.terminals === 'unsupported') return fail(404, 'NOT_FOUND')
    if (state.mode.terminals === 'unavailable') return fail(503, 'TERMINALS_UNAVAILABLE')
    const [, id, isCheck] = terminalsMatch
    const index = id ? state.terminals.findIndex(item => item.terminalId === id) : -1
    if (!id && request.method === 'GET') { state.proof.terminalReads++; return send(200, { terminals: state.terminals.map(projection) }) }
    if (id && isCheck && request.method === 'POST') {
      const result = index < 0 ? { terminalId: id, observedAt: new Date().toISOString(), reachable: false, reason: 'TERMINAL_NOT_FOUND' } : check(state.terminals[index])
      state.proof.checks.push({ terminalId: id, reachable: result.reachable, reason: result.reason })
      return send(200, result)
    }
    if (id && request.method === 'GET') return index < 0 ? fail(404, 'TERMINAL_NOT_FOUND') : send(200, projection(state.terminals[index]))
    if (id && request.method === 'PUT') {
      const input = await body(request)
      state.proof.puts.push({ terminalId: id, body: input })
      const { confirmHostKey, ...fields } = input
      const unknown = Object.keys(fields).filter(key => !['host', 'user', 'port', 'os', 'accountOwner', 'sshKeyRef', 'sudoKeyRef'].includes(key))
      if (unknown.length) return fail(400, 'INVALID_TERMINAL', `Unknown terminal fields: ${unknown.join(', ')}`)
      if (confirmHostKey !== undefined) {
        if (index < 0) return fail(404, 'TERMINAL_NOT_FOUND', 'Terminal not found; list_terminals shows the registered terminalIds')
        if (confirmHostKey !== fingerprint(id)) return fail(409, 'HOST_KEY_FINGERPRINT_MISMATCH', 'Host key did not match the confirmed fingerprint')
        state.terminals[index] = { ...state.terminals[index], ...fields, hostTrust: trust(`${id}-confirmed`), revision: state.terminals[index].revision + 1 }
        return send(200, projection(state.terminals[index]))
      }
      if (fields.host !== undefined && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/iu.test(fields.host)) return fail(400, 'INVALID_TERMINAL', "host must be the terminal's IP address or DNS name only")
      if (index >= 0) {
        state.terminals[index] = { ...state.terminals[index], ...fields, revision: state.terminals[index].revision + 1 }
        return send(200, projection(state.terminals[index]))
      }
      if (!TERMINAL_ID.test(id)) return fail(400, 'INVALID_TERMINAL', 'terminalId must be a lowercase slug')
      const record = { terminalId: id, port: 22, ...fields, sshKeyConfigured: false, sudoKeyConfigured: false, revision: 1, maintenance: null }
      state.terminals.push(record)
      return send(200, projection(record))
    }
    if (id && request.method === 'DELETE') {
      state.proof.deletes.push(id)
      if (index < 0) return send(200, null)
      const [removed] = state.terminals.splice(index, 1)
      return send(200, projection(removed))
    }
    return fail(405, 'METHOD_NOT_ALLOWED')
  }
  return fail(404, 'NOT_FOUND')
})
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` })))
