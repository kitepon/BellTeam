// Apple terminals screens (docs/architecture/modules/apple/terminals.md): artificial registry, check results and member PATCH rules.
// Keys (terminals #811): POST/DELETE /api/terminals/:id/keys/{ssh|sudo} and the secret card's /api/secret-requests/:id/submit|cancel.
// No SSH, keys or real terminals. Prints {"url"} on start; /test/reset,
// /test/mode?terminals=ok|unsupported|unavailable&members=new|old&keys=ok|old|unavailable&onepassword=1|0
//   &setting=absent|off|connected|zero|rejected|cli&picker=ok|empty|error|missing, /test/proof, /test/fingerprint?id=.
// Host-key attest (terminals #856): POST /api/terminals/:id/trust {fingerprint}; /test/mode?trust=ok|mismatch|unavailable|changed|old
//   (ok accepts any well-formed SHA256: value, changed answers TERMINAL_CHANGED once, old is an older body's 404) and thismac=1
//   adds the terminal `this-mac` (host 127.0.0.1, no trust). /test/proof.trusts keeps each attest body.
// Self-service step 4/5 (terminals #858, members #859): thismac=1 or selfservice=1 adds `locked-mac` (key not on the Mac yet: check answers AUTH_FAILED until authorized)
//   and `closed-mac` (CONNECTION_REFUSED). POST /api/terminals/:id/keys/ssh/authorize -> a terminal.login card; its submit records the outcome after one more
//   GET of the terminal (pending first), chosen by /test/mode?authorize=authorized|already|rejected|disabled|unconfirmed|unavailable.
//   /test/mode?folder=ok|missing|notdir|notwritable|notpermitted|unchecked answers member saves (POST /api/bots, PATCH) with `{error: code}` only (#859);
//   createFolder:true turns `missing` into a saved member. /test/proof.authorizes keeps each authorize call, folderChecks each member folder check.
// Folder picker (terminals README S6, a double of the contract; the server route is not built yet): GET /api/terminals/:id/folders[?path=] and
//   POST /api/terminals/:id/folder {path, create:true}. /test/mode?folders=ok|empty|truncated|offline|error|old: offline answers reason UNREACHABLE, error is a 503,
//   old is an older body's 404. /Users/<user>/Desktop is FOLDER_NOT_PERMITTED, an unknown path FOLDER_MISSING; created folders stay until /test/reset.
//   /test/proof.folderReads keeps each listed path (null = home), folderCreates each create body.
// 1Password (usage #836/#838): GET|PATCH /api/settings (item onePassword: guide, connection, error), GET /api/secret-requests/:id/onepassword-items.
// A token starting ops_good connects; any other ops_ token is rejected. The token itself is never kept, only its shape.
// Screenshots (apple parity batch 1): /test/mode?patchdelay=<ms> holds the 1Password PATCH answer (the "checking" line);
//   updates=waiting serves GET /api/updates with two up_to_date parts and one `incompatible` part (the update screen's waiting heading);
//   GET /api/events is an open SSE stream that only says `ready` (the app then reads /api/updates).
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../../ios/BellBot/BellBot/Core/PreviewFixtures.swift', import.meta.url), 'utf8')
const updateExamples = JSON.parse(await readFile(new URL('../../ios/BellBot/BellBotTests/Fixtures/update-examples.json', import.meta.url), 'utf8'))
const fixture = JSON.parse(source.match(/let source = """\n([\s\S]*?)\n\s*"""/u)[1])
export const fingerprint = id => `SHA256:${createHash('sha256').update(id).digest('base64').replace(/=+$/u, '')}`
const trust = id => ({ provider: 'aiterm.known-hosts.v1', revision: `sha256:${createHash('sha256').update(`trust-${id}`).digest('hex')}` })
const TERMINAL_ID = /^[a-z0-9][a-z0-9-]{0,62}$/u
const MEMBER_TERMINAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

// Subfolders per path (names only; hidden ones are never listed). Home of every fixture user is /Users/<user>.
const FOLDERS = {
  '/': ['Applications', 'Users', 'Volumes'],
  '/Users': ['hana', 'kite'],
  '/Users/kite': ['BellTeam', 'Desktop', 'Documents', 'work'],
  '/Users/kite/BellTeam': [],
  '/Users/kite/Desktop': [],
  '/Users/kite/Documents': ['notes'],
  '/Users/kite/Documents/notes': [],
  '/Users/kite/work': ['app', 'docs', 'tools'],
  '/Users/kite/work/app': ['src', 'tests'],
  '/Users/kite/work/app/src': [],
  '/Users/kite/work/app/tests': [],
  '/Users/kite/work/docs': [],
  '/Users/kite/work/tools': [],
  '/Users/hana': ['projects'],
  '/Users/hana/projects': [],
}
// truncated answers a short list with the flag set (the real route cuts at 500; a long list only slows the UI test)
const MANY = Array.from({ length: 12 }, (_, index) => `folder-${String(index + 1).padStart(3, '0')}`)

let state
function reset() {
  state = {
    mode: { terminals: 'ok', members: 'new', keys: 'ok', onepassword: '1', setting: 'off', picker: 'ok', folders: 'ok', trust: 'ok', thismac: '0', selfservice: '0', authorize: 'authorized', folder: 'ok', patchdelay: '0', updates: 'none' },
    bots: structuredClone(fixture.bots).map((bot, index) => ({ ...bot, terminalId: index === 0 ? 'owner-macbook' : '', projectRoot: index === 0 ? '/Users/kite/work/app' : '' })),
    terminals: [
      { terminalId: 'owner-macbook', host: '192.168.1.12', user: 'kite', port: 22, os: 'macos', accountOwner: 'owner', sshKeyConfigured: true, sudoKeyConfigured: false, keySource: 'terminal-native', hostTrust: trust('owner-macbook'), revision: 4, maintenance: { terminalId: 'owner-macbook', observedAt: '2026-11-09T07:40:00Z', before: '2.1.30', after: '2.1.32', outcome: 'updated' } },
      { terminalId: 'sleeping-mini', host: '192.168.1.20', user: 'kite', port: 22, os: 'macos', accountOwner: 'owner', sshKeyConfigured: true, sudoKeyConfigured: false, keySource: 'terminal-native', hostTrust: trust('sleeping-mini'), revision: 1, maintenance: null },
      { terminalId: 'studio-mac', host: '192.168.1.30', user: 'hana', port: 2222, os: 'macos', accountOwner: 'terminal-owner', sshKeyConfigured: true, sudoKeyConfigured: true, keySource: 'secret', sudoKeySource: 'secret', revision: 2, maintenance: null },
      { terminalId: 'office-imac', host: 'office-imac.local', user: 'kite', port: 22, os: 'macos', accountOwner: 'owner', sshKeyConfigured: true, sudoKeyConfigured: false, keySource: 'terminal-native', hostTrust: trust('office-imac'), revision: 3, maintenance: { terminalId: 'office-imac', observedAt: '2026-11-08T22:10:00Z', before: '2.1.29', after: '2.1.29', outcome: 'failed' } },
    ],
    requests: new Map(),
    createdFolders: new Set(),
    proof: { terminalReads: 0, puts: [], deletes: [], checks: [], botSaves: [], rejectedBotSaves: [], keyRequests: [], keyDeletes: [], secretSubmits: [], settingPatches: [], itemReads: 0, trusts: [], authorizes: [], folderChecks: [], folderReads: [], folderCreates: [] },
    folderTree: new Map(Object.entries(FOLDERS).map(([key, names]) => [key, [...names]])),
  }
}
reset()

const VAULT = 'a'.repeat(26), ITEM = 'b'.repeat(26)
const GUIDE = { steps: [
  'サービスアカウントは、BellTeamが1Passwordの鍵を読むための専用の鍵束です。',
  '1Passwordのウェブで「開発者」→「サービスアカウント」から作ります。',
  '読ませたい保管庫だけを許可します（Personal / Private は共有できません）。',
  '表示されるトークン（ops_で始まる）を、下の欄へ1回だけ貼ります。'],
  link: { label: '1Passwordの手順を開く', url: 'https://developer.1password.com/docs/service-accounts/' } }
const ERRORS = {
  rejected: { code: 'ONEPASSWORD_TOKEN_REJECTED', message: '1Passwordがこのトークンを受け付けませんでした。トークンを作り直して貼り直すか、ネットワークを確かめてください。' },
  cli: { code: 'ONEPASSWORD_CLI_MISSING', message: 'この本体に1Passwordの部品（op）がありません。本体を更新してください。' } }
// The onePassword item as the settings list returns it; absent mode is an older body.
function onePasswordItem() {
  const mode = state.mode.setting
  const connected = mode === 'connected' || mode === 'zero'
  return { id: 'onePassword', title: '1Password連携', enabled: connected || mode === 'rejected' || mode === 'cli', status: mode === 'off' ? 'unconfigured' : connected || mode === 'rejected' || mode === 'cli' ? 'enabled' : 'disabled',
    fields: [{ key: 'token', label: 'サービスアカウントのトークン', secret: true, value: '', configured: mode !== 'off' }],
    error: ERRORS[mode] ?? null, guide: GUIDE,
    ...(connected ? { connection: { vaults: ['Infra', 'Team'], sshKeys: mode === 'zero' ? 0 : 3 } } : {}) }
}
const settingsList = () => [
  { id: 'notifications', title: '通知', enabled: true, status: 'enabled', fields: [], error: null },
  { id: 'calendar', title: 'カレンダー', enabled: false, status: 'disabled', fields: [], error: null },
  ...(state.mode.setting === 'absent' ? [] : [onePasswordItem()])]
const ITEMS = [
  { title: 'Mac mini 本番', vault: 'Infra', reference: `op://${VAULT}/${ITEM}/private key?ssh-format=openssh` },
  { title: 'office-imac', vault: 'Infra', reference: `op://${VAULT}/${'c'.repeat(26)}/private key?ssh-format=openssh` },
  { title: '個人用ノートPC', vault: 'Team', reference: `op://${'d'.repeat(26)}/${'e'.repeat(26)}/private key?ssh-format=openssh` }]

const KINDS = { ssh: { purpose: 'terminal.ssh', configured: 'sshKeyConfigured', source: 'keySource', pending: 'sshKeyPending', label: 'SSH key' },
  sudo: { purpose: 'terminal.sudo', configured: 'sudoKeyConfigured', source: 'sudoKeySource', pending: 'sudoKeyPending', label: 'sudo password' } }

// Same public shape as registry.mjs publicView; keys=old drops the #811 fields (an older body).
const projection = record => {
  const { hostTrust, keySource, sudoKeySource, sshKeyRequest, sudoKeyRequest, loginRequest, authorized, pollsLeft, keyAuthorization, ...rest } = record
  const keys = state.mode.keys === 'old' ? {} : {
    keySource: record.sshKeyConfigured ? keySource ?? 'terminal-native' : null, sudoKeySource: record.sudoKeyConfigured ? sudoKeySource ?? 'secret' : null,
    sshKeyPending: Boolean(sshKeyRequest), sudoKeyPending: Boolean(sudoKeyRequest),
    ...(state.mode.keys === 'old' ? {} : { keyAuthorizationPending: Boolean(loginRequest), keyAuthorization: keyAuthorization ?? null }) }
  return { ...rest, ...keys, ...(hostTrust ? { hostTrust } : {}) }
}

function check(record) {
  const observedAt = new Date().toISOString()
  const base = { terminalId: record.terminalId, observedAt, reachable: false, reason: null }
  if (!record.sshKeyConfigured) return { ...base, reason: 'SSH_KEY_UNSET', action: `bind the SSH key of terminal ${record.terminalId} (bind_terminal_key)` }
  if (!record.hostTrust) return { ...base, reason: 'HOST_TRUST_MISSING', action: `confirm the host key of ${record.host}` }
  if (record.terminalId === 'sleeping-mini') return { ...base, reason: 'UNREACHABLE' }
  if (record.terminalId === 'closed-mac') return { ...base, reason: 'CONNECTION_REFUSED', action: 'Macの「システム設定 > 一般 > 共有」で「リモートログイン」がオンか確かめてから、もう一度確かめてください' }
  if (record.terminalId === 'locked-mac' && !record.authorized)
    return { ...base, reason: 'AUTH_FAILED', action: 'この鍵がまだMacに入っていないかもしれません。「このMacにこの鍵を入れる」で、Macのログインパスワードを使って入れられます' }
  if (record.terminalId === 'office-imac' && record.revision < 4) return { ...base, reason: 'HOST_KEY_MISMATCH', action: `confirm the new host key ${fingerprint('office-imac')} on ${record.host}` }
  return { ...base, reachable: true }
}

function validRoot(path) {
  return typeof path === 'string' && path.startsWith('/') && !path.includes('\0') && Buffer.byteLength(path) <= 4096
    && (path === '/' || !path.slice(1).split('/').some(part => !part || part === '.' || part === '..'))
}

const OUTCOMES = { authorized: 'AUTHORIZED', already: 'ALREADY_AUTHORIZED', rejected: 'PASSWORD_REJECTED', disabled: 'PASSWORD_AUTH_DISABLED', unconfirmed: 'AUTHORIZATION_UNCONFIRMED', unavailable: 'TERMINAL_UNAVAILABLE' }
// The outcome is recorded one read after the submit, so the app sees keyAuthorizationPending true first (#858).
function settleAuthorization(record) {
  if (!record?.loginRequest || record.pollsLeft === undefined) return
  if (record.pollsLeft > 0) { record.pollsLeft--; return }
  const outcome = OUTCOMES[state.mode.authorize] ?? 'AUTHORIZED'
  record.keyAuthorization = { requestId: record.loginRequest, outcome, observedAt: new Date().toISOString() }
  if (outcome === 'AUTHORIZED' || outcome === 'ALREADY_AUTHORIZED') record.authorized = true
  record.loginRequest = null
  delete record.pollsLeft
}

// members S5 (#859): a refused save carries only {error: code}. createFolder turns FOLDER_MISSING into a created folder.
const FOLDER_CODES = { missing: 'FOLDER_MISSING', notdir: 'FOLDER_NOT_DIRECTORY', notwritable: 'FOLDER_NOT_WRITABLE', notpermitted: 'FOLDER_NOT_PERMITTED' }
function folderRefusal(bot, input) {
  const terminalId = input.terminalId ?? bot.terminalId, projectRoot = input.projectRoot ?? bot.projectRoot
  const create = input.createFolder === true
  if (!terminalId || !projectRoot) return null
  state.proof.folderChecks.push({ terminalId, projectRoot, createFolder: create })
  const code = FOLDER_CODES[state.mode.folder]
  if (!code || state.createdFolders.has(projectRoot)) return null
  if (create && code === 'FOLDER_MISSING') { state.createdFolders.add(projectRoot); return null }
  return code
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
    for (const key of ['terminals', 'members', 'keys', 'onepassword', 'setting', 'picker', 'folders', 'trust', 'thismac', 'selfservice', 'authorize', 'folder', 'patchdelay', 'updates']) if (url.searchParams.has(key)) state.mode[key] = url.searchParams.get(key)
    if (state.mode.thismac === '1' && !state.terminals.some(item => item.terminalId === 'this-mac'))
      state.terminals.push({ terminalId: 'this-mac', host: '127.0.0.1', user: 'kite', port: 22, os: 'macos', accountOwner: 'owner', sshKeyConfigured: false, sudoKeyConfigured: false, revision: 1, maintenance: null })
    if ((state.mode.thismac === '1' || state.mode.selfservice === '1') && !state.terminals.some(item => item.terminalId === 'locked-mac'))
      state.terminals.push(
        { terminalId: 'locked-mac', host: '192.168.1.40', user: 'kite', port: 22, os: 'macos', accountOwner: 'owner', sshKeyConfigured: true, sudoKeyConfigured: false, keySource: 'secret', hostTrust: trust('locked-mac'), revision: 1, maintenance: null },
        { terminalId: 'closed-mac', host: '192.168.1.41', user: 'kite', port: 22, os: 'macos', accountOwner: 'owner', sshKeyConfigured: true, sudoKeyConfigured: false, keySource: 'secret', hostTrust: trust('closed-mac'), revision: 1, maintenance: null })
    return send(200, state.mode)
  }
  const bots = () => state.bots.map(bot => {
    if (state.mode.members === 'new') return bot
    const { terminalId, projectRoot, ...old } = bot
    return old
  })
  if (path === '/api/bots' && request.method === 'GET') return send(200, { bots: bots() })
  if (path === '/api/bots' && request.method === 'POST') {
    const input = await body(request)
    const { createFolder, ...fields } = input
    const bot = { ...structuredClone(state.bots[1]), id: `bot-new-${state.bots.length}`, terminalId: '', projectRoot: '', ...fields }
    let code = null
    if (bot.terminalId && !MEMBER_TERMINAL_ID.test(bot.terminalId)) code = 'BOT_TERMINAL_ID_INVALID'
    else if (bot.projectRoot && !validRoot(bot.projectRoot)) code = 'BOT_PROJECT_ROOT_INVALID'
    else if (Boolean(bot.terminalId) !== Boolean(bot.projectRoot)) code = 'BOT_REMOTE_BINDING_INVALID'
    if (code) { state.proof.rejectedBotSaves.push({ body: input, code }); return send(400, { error: code }) }
    const refusal = folderRefusal({ terminalId: '', projectRoot: '' }, input)
    if (refusal) { state.proof.rejectedBotSaves.push({ body: input, code: refusal }); return send(409, { error: refusal }) }
    state.proof.botSaves.push({ body: input })
    state.bots.push(bot)
    return send(200, { ok: true })
  }
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
    const refusal = folderRefusal(bot, input)
    if (refusal) { state.proof.rejectedBotSaves.push({ body: input, code: refusal }); return send(409, { error: refusal }) }
    state.proof.botSaves.push({ body: input })
    const { createFolder, ...fields } = input
    Object.assign(bot, fields)
    return send(200, { ok: true })
  }
  if (path === '/api/rooms') return send(200, { rooms: fixture.rooms })
  if (path === '/api/owner') return send(200, { owner: fixture.owner })
  if (path === '/api/models') return send(200, { models: { claude: { efforts: ['high'], models: [{ id: 'opus', efforts: ['high'], fast: true }] }, codex: { efforts: [], models: [] }, grok: { efforts: [], models: [] } } })
  if (path === '/api/queue' || path.endsWith('/queue')) return send(200, { items: [] })
  if (path.endsWith('/messages') || path.endsWith('/timeline')) return send(200, { messages: [], items: [], hasMore: false })

  if (path === '/api/events') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    response.write('event: ready\ndata: {}\n\n')
    return
  }
  if (path === '/api/updates' && request.method === 'GET' && state.mode.updates === 'waiting') {
    const base = updateExamples.no_update
    const part = (id, name, comparison) => ({ ...base.components[0], id, name, comparison: { state: comparison, reason: null }, capability: { supported: true, reason: null } })
    return send(200, { ...base, notice: { state: 'ready', code: null, message: '正式公開版と同じ版です。' },
      components: [part('notifications', '通知', 'up_to_date'), part('members', 'メンバー', 'up_to_date'), part('usage', '利用状況', 'incompatible')] })
  }
  if (path === '/api/settings' && request.method === 'GET') return send(200, { settings: settingsList() })
  if (path === '/api/settings/onePassword' && request.method === 'PATCH') {
    const input = await body(request)
    const token = input.values?.token
    if (Number(state.mode.patchdelay) > 0) await new Promise(resolve => setTimeout(resolve, Number(state.mode.patchdelay)))
    state.proof.settingPatches.push({ enabled: input.enabled, valueKeys: Object.keys(input.values ?? {}), tokenShape: token === undefined ? null : token.startsWith('ops_') ? 'ops_' : 'other' })
    if (state.mode.setting === 'absent') return fail(404, 'NOT_FOUND')
    if (!input.enabled) state.mode.setting = 'off'
    else if (token !== undefined) state.mode.setting = token.startsWith('ops_good') ? 'connected' : 'rejected'
    return send(200, { setting: onePasswordItem() })
  }
  const itemsMatch = /^\/api\/secret-requests\/([a-f0-9-]+)\/onepassword-items$/u.exec(path)
  if (itemsMatch) {
    state.proof.itemReads++
    if (state.mode.picker === 'missing') return fail(404, 'NOT_FOUND')
    if (state.mode.picker === 'error') return fail(503, 'SECRET_SOURCE_UNAVAILABLE')
    return send(200, { items: state.mode.picker === 'empty' ? [] : ITEMS })
  }
  const secretMatch = /^\/api\/secret-requests\/([a-f0-9-]+)(?:\/(submit|cancel))?$/u.exec(path)
  if (secretMatch) {
    const item = state.requests.get(secretMatch[1])
    if (!item) return fail(404, 'NOT_FOUND')
    if (!secretMatch[2] && request.method === 'GET') return send(200, { request: item })
    if (request.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED')
    const input = await body(request)
    // Proof keeps only the shape: which source and whether a value came, never the dummy value itself.
    state.proof.secretSubmits.push({ id: item.id, action: secretMatch[2], keys: Object.keys(input).sort(), source: input.source ?? null, referencePrefix: input.reference?.slice(0, 5) ?? null })
    if (item.status !== 'pending') return fail(409, 'SECRET_REQUEST_NOT_PENDING')
    if (secretMatch[2] === 'cancel') {
      item.status = 'cancelled'
      const login = state.terminals.find(terminal => terminal.loginRequest === item.id)
      if (login) { login.loginRequest = null; delete login.pollsLeft }
      return send(200, { request: item })
    }
    if (input.source === 'onepassword' ? !/^op:\/\/[a-z0-9]{26}\/[a-z0-9]{26}\/[^/?#]+(?:\?ssh-format=openssh)?$/u.test(input.reference ?? '') : typeof input.value !== 'string' || !input.value)
      return fail(400, input.source === 'onepassword' ? 'SECRET_REFERENCE_INVALID' : 'SECRET_VALUE_INVALID')
    item.status = 'submitted'
    if (item.purpose === 'terminal.login') {
      const login = state.terminals.find(terminal => terminal.terminalId === item.terminalId)
      if (login?.loginRequest === item.id) login.pollsLeft = 1
      return send(200, { request: item })
    }
    // Mika binds, terminals applies the event for the pending request id.
    const record = state.terminals.find(terminal => terminal.terminalId === item.terminalId)
    const kind = Object.values(KINDS).find(value => value.purpose === item.purpose)
    const requestField = kind === KINDS.ssh ? 'sshKeyRequest' : 'sudoKeyRequest'
    if (record && record[requestField] === item.id) Object.assign(record, { [kind.configured]: true, [kind.source]: 'secret', [requestField]: null })
    return send(200, { request: item })
  }

  const keyMatch = /^\/api\/terminals\/([a-z0-9][a-z0-9-]{0,63})\/keys\/([a-z]+)(\/authorize)?$/u.exec(path)
  if (keyMatch) {
    if (state.mode.terminals !== 'ok' || state.mode.keys === 'old') return fail(404, 'NOT_FOUND')
    const [, id, kindName, authorize] = keyMatch
    if (authorize) {
      if (request.method !== 'POST' || kindName !== 'ssh') return fail(request.method !== 'POST' ? 405 : 400, request.method !== 'POST' ? 'METHOD_NOT_ALLOWED' : 'INVALID_KEY_KIND')
      const input = await body(request)
      state.proof.authorizes.push({ terminalId: id, bodyKeys: Object.keys(input) })
      if (Object.keys(input).length) return fail(400, 'KEY_IN_REQUEST_REFUSED', 'Send no key, password or reference here; open the returned secret request and enter it there')
      const target = state.terminals.find(terminal => terminal.terminalId === id)
      if (!target) return fail(404, 'TERMINAL_NOT_FOUND', 'Terminal not found; list_terminals shows the registered terminalIds')
      if (!target.hostTrust) return fail(409, 'HOST_TRUST_MISSING', 'Confirm the host key of this terminal first')
      if (!target.sshKeyConfigured) return fail(409, 'SSH_KEY_UNSET', 'Set the SSH key of this terminal first')
      if (state.mode.keys === 'unavailable') return fail(503, 'CREDENTIAL_UNAVAILABLE', 'The secret input is not available now; try again later')
      const item = { id: randomUUID(), botId: null, roomId: null, toolId: 'terminal-key', terminalId: id, purpose: 'terminal.login',
        label: `端末 ${id} のMacのログインパスワード`, message: '', at: new Date().toISOString(), status: 'pending', inputOptions: { preferred: 'stored', onePasswordAvailable: false } }
      if (target.loginRequest) state.requests.get(target.loginRequest).status = 'cancelled'
      state.requests.set(item.id, item)
      Object.assign(target, { loginRequest: item.id })
      delete target.pollsLeft
      return send(200, { secretRequest: item })
    }
    const kind = Object.hasOwn(KINDS, kindName) ? KINDS[kindName] : null
    if (!kind) return fail(400, 'INVALID_KEY_KIND', 'Key kind must be ssh or sudo')
    const record = state.terminals.find(terminal => terminal.terminalId === id)
    if (!record) return fail(404, 'TERMINAL_NOT_FOUND', 'Terminal not found; list_terminals shows the registered terminalIds')
    const requestField = kind === KINDS.ssh ? 'sshKeyRequest' : 'sudoKeyRequest'
    if (request.method === 'POST') {
      const input = await body(request)
      state.proof.keyRequests.push({ terminalId: id, kind: kindName, bodyKeys: Object.keys(input) })
      if (Object.keys(input).length) return fail(400, 'KEY_IN_REQUEST_REFUSED', 'Send no key, password or reference here; open the returned secret request and enter it there')
      if (state.mode.keys === 'unavailable') return fail(503, 'CREDENTIAL_UNAVAILABLE', 'The secret input is not available now; try again later')
      const available = state.mode.onepassword === '1'
      const item = { id: randomUUID(), botId: null, roomId: null, toolId: 'terminal-key', terminalId: id, purpose: kind.purpose,
        label: `${kind.label} for terminal ${id}`, message: kind === KINDS.ssh ? `端末「${id}」で使うSSH鍵を登録してください。` : `端末「${id}」のsudo認証情報を登録してください。値や1Password参照は、この専用欄へ入力してください。`,
        at: new Date().toISOString(), status: 'pending', inputOptions: { preferred: available ? 'onepassword' : 'stored', onePasswordAvailable: available } }
      if (record[requestField]) state.requests.get(record[requestField]).status = 'cancelled'
      state.requests.set(item.id, item)
      record[requestField] = item.id
      return send(200, { secretRequest: item })
    }
    if (request.method === 'DELETE') {
      state.proof.keyDeletes.push({ terminalId: id, kind: kindName })
      if (record[requestField]) state.requests.get(record[requestField]).status = 'cancelled'
      Object.assign(record, { [kind.configured]: false, [kind.source]: null, [requestField]: null })
      return send(200, { terminal: projection(record) })
    }
    return fail(405, 'METHOD_NOT_ALLOWED')
  }

  const foldersMatch = /^\/api\/terminals\/([a-z0-9][a-z0-9-]{0,63})\/(folders|folder)$/u.exec(path)
  if (foldersMatch) {
    const [, id, kind] = foldersMatch
    if (state.mode.terminals !== 'ok' || state.mode.folders === 'old') return fail(404, 'NOT_FOUND')
    if (state.mode.folders === 'error') return fail(503, 'TERMINAL_UNAVAILABLE', 'The folders cannot be read now')
    const record = state.terminals.find(terminal => terminal.terminalId === id)
    if (!record) return fail(404, 'TERMINAL_NOT_FOUND', 'Terminal not found; list_terminals shows the registered terminalIds')
    const home = `/Users/${record.user}`
    const unreachable = state.mode.folders === 'offline' || !check(record).reachable
    const offline = { reason: 'UNREACHABLE', action: 'Macに届きませんでした。Macが起きていて同じネットワークにあるか確かめてください' }
    const dirname = value => value === '/' ? null : value.slice(0, value.lastIndexOf('/')) || '/'
    if (kind === 'folder') {
      if (request.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED')
      const input = await body(request)
      state.proof.folderCreates.push({ terminalId: id, body: input })
      if (typeof input.path !== 'string' || !validRoot(input.path)) return fail(400, 'INVALID_PATH', 'path must be absolute without ..')
      const status = { terminalId: id, path: input.path, observedAt: new Date().toISOString() }
      if (unreachable) return send(200, { ...status, exists: false, directory: false, writable: false, ...offline })
      const parent = dirname(input.path)
      if (!input.create) return send(200, { ...status, exists: state.folderTree.has(input.path), directory: state.folderTree.has(input.path), writable: true, reason: state.folderTree.has(input.path) ? null : 'FOLDER_MISSING' })
      if (!state.folderTree.has(parent ?? '')) return send(200, { ...status, exists: false, directory: false, writable: false, reason: 'FOLDER_MISSING', action: 'フォルダを作れる場所がありません' })
      if (parent.endsWith('/Desktop')) return send(200, { ...status, exists: false, directory: false, writable: false, reason: 'FOLDER_NOT_PERMITTED', action: 'Macがこのフォルダを開かせてくれません' })
      const names = state.folderTree.get(parent)
      const name = input.path.slice(input.path.lastIndexOf('/') + 1)
      if (!names.includes(name)) { names.push(name); names.sort(); state.folderTree.set(input.path, []) }
      return send(200, { ...status, exists: true, directory: true, writable: true, reason: null })
    }
    if (request.method !== 'GET') return fail(405, 'METHOD_NOT_ALLOWED')
    const asked = url.searchParams.get('path')
    state.proof.folderReads.push(asked)
    if (asked !== null && !validRoot(asked)) return fail(400, 'INVALID_PATH', 'path must be absolute without ..')
    const target = asked ?? home
    const view = { terminalId: id, observedAt: new Date().toISOString(), home: unreachable ? null : home, path: target, parent: dirname(target), entries: [], truncated: false }
    if (unreachable) return send(200, { ...view, ...offline })
    if (target.endsWith('/Desktop')) return send(200, { ...view, reason: 'FOLDER_NOT_PERMITTED', action: 'Macがこのフォルダを開かせてくれません' })
    if (!state.folderTree.has(target)) return send(200, { ...view, reason: 'FOLDER_MISSING', action: 'このフォルダはMacにありません' })
    let names = state.folderTree.get(target)
    if (target === home && state.mode.folders === 'empty') names = []
    if (target === home && state.mode.folders === 'truncated') names = MANY
    return send(200, { ...view, entries: names.map(name => ({ name, path: target === '/' ? `/${name}` : `${target}/${name}` })), reason: null, action: null, ...(target === home && state.mode.folders === 'truncated' ? { truncated: true } : {}) })
  }

  const terminalsMatch = /^\/api\/terminals(?:\/([a-z0-9][a-z0-9-]{0,63})(\/check|\/trust)?)?$/u.exec(path)
  if (terminalsMatch) {
    if (state.mode.terminals === 'unsupported') return fail(404, 'NOT_FOUND')
    if (state.mode.terminals === 'unavailable') return fail(503, 'TERMINALS_UNAVAILABLE')
    const [, id, sub] = terminalsMatch
    const isCheck = sub === '/check'
    const index = id ? state.terminals.findIndex(item => item.terminalId === id) : -1
    if (!id && request.method === 'GET') { state.proof.terminalReads++; state.terminals.forEach(settleAuthorization); return send(200, { terminals: state.terminals.map(projection) }) }
    if (id && isCheck && request.method === 'POST') {
      const result = index < 0 ? { terminalId: id, observedAt: new Date().toISOString(), reachable: false, reason: 'TERMINAL_NOT_FOUND' } : check(state.terminals[index])
      state.proof.checks.push({ terminalId: id, reachable: result.reachable, reason: result.reason })
      return send(200, result)
    }
    if (id && sub === '/trust') {
      if (request.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED')
      if (state.mode.trust === 'old') return fail(404, 'NOT_FOUND')
      const input = await body(request)
      state.proof.trusts.push({ terminalId: id, body: input })
      if (Object.keys(input).join() !== 'fingerprint' || !/^SHA256:[A-Za-z0-9+/]{43}$/u.test(input.fingerprint))
        return fail(400, 'INVALID_TERMINAL', 'Send only {fingerprint: "SHA256:..."} read on that Mac')
      if (index < 0) return fail(404, 'TERMINAL_NOT_FOUND', 'Terminal not found; list_terminals shows the registered terminalIds')
      if (state.mode.trust === 'mismatch') return fail(409, 'HOST_KEY_FINGERPRINT_MISMATCH', 'Host key did not match the confirmed fingerprint')
      if (state.mode.trust === 'unavailable') return fail(503, 'TERMINAL_UNAVAILABLE', 'The host key cannot be checked now; make sure the Mac is awake on the same network and try again')
      if (state.mode.trust === 'changed') { state.mode.trust = 'ok'; return fail(409, 'TERMINAL_CHANGED', 'The terminal changed while its host key was being checked; check it again') }
      state.terminals[index] = { ...state.terminals[index], hostTrust: trust(`${id}-attested`), revision: state.terminals[index].revision + 1 }
      return send(200, { terminal: projection(state.terminals[index]) })
    }
    if (id && request.method === 'GET') { if (index >= 0) settleAuthorization(state.terminals[index]); return index < 0 ? fail(404, 'TERMINAL_NOT_FOUND') : send(200, projection(state.terminals[index])) }
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
