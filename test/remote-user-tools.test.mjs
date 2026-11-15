import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findUserTool, listUserTools, MANAGED_MCP_IDS, userToolHeaders } from '../src/user-tools.mjs'
import { createUserToolRelay } from '../src/remote-user-tools.mjs'
import { RemoteSeats } from '../src/remote-seats.mjs'

test('U1: each harness file gives names/kinds only; managed, disabled, sse and bad names are skipped', async t => {
  const home = await mkdtemp(join(tmpdir(), 'user-tools-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, '.codex'), { recursive: true }); await mkdir(join(home, '.grok'), { recursive: true })
  await mkdir(join(home, '.cursor'), { recursive: true }); await mkdir(join(home, '.gemini/config'), { recursive: true })
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: {
    bellteam: { type: 'http', url: 'http://127.0.0.1:4181/mcp' }, aiterm: { command: 'aiterm' },
    meta: { command: 'meta-mcp', env: { META_TOKEN: 'private-canary' } }, xarticle: { type: 'http', url: 'http://lan/mcp', headers: { Authorization: 'Bearer private-canary' } },
    legacy: { type: 'sse', url: 'http://lan/sse' }, 'bad name': { command: 'x' } } }))
  await writeFile(join(home, '.codex/config.toml'), [
    '[mcp_servers.bellteam]', 'url = "http://127.0.0.1:4181/mcp"', '',
    '[mcp_servers.meta]', 'command = "meta-mcp"', 'args = ["--a", "b"]', '[mcp_servers.meta.env]', 'META_TOKEN = "private-canary"', '',
    '[mcp_servers.off]', 'command = "true"', 'enabled = false', '',
    '[mcp_servers.typesafe]', 'url = "https://docs.example/mcp"', 'bearer_token_env_var = "TS_TOKEN"', ''].join('\n'))
  await writeFile(join(home, '.grok/config.toml'), '[mcp_servers.meta]\ncommand = "meta-mcp"\nenabled = true\n')
  await writeFile(join(home, '.cursor/mcp.json'), JSON.stringify({ mcpServers: { meta: { command: 'meta-mcp' }, web: { url: 'https://x/mcp' } } }))
  await writeFile(join(home, '.gemini/config/mcp_config.json'), JSON.stringify({ mcpServers: { meta: { command: 'meta-mcp' } } }))
  assert.deepEqual(listUserTools('claude-code', home), [{ name: 'meta', kind: 'stdio' }, { name: 'xarticle', kind: 'http' }])
  assert.deepEqual(listUserTools('codex-cli', home), [{ name: 'meta', kind: 'stdio' }, { name: 'typesafe', kind: 'http' }])
  assert.deepEqual(listUserTools('grok', home), [{ name: 'meta', kind: 'stdio' }])
  assert.deepEqual(listUserTools('cursor', home), [{ name: 'meta', kind: 'stdio' }, { name: 'web', kind: 'http' }])
  assert.deepEqual(listUserTools('antigravity', home), [{ name: 'meta', kind: 'stdio' }])
  for (const harness of ['claude', 'codex', 'grok', 'cursor', 'antigravity']) assert.doesNotMatch(JSON.stringify(listUserTools(harness, home)), /private-canary/)
  assert.deepEqual(findUserTool('codex', 'meta', home).spec, { command: 'meta-mcp', args: ['--a', 'b'], env: { META_TOKEN: 'private-canary' } })
  assert.deepEqual(userToolHeaders(findUserTool('codex', 'typesafe', home).spec, { TS_TOKEN: 't' }), { Authorization: 'Bearer t' })
  for (const name of [...MANAGED_MCP_IDS, 'off', 'missing']) assert.throws(() => findUserTool('codex', name, home), { code: 'USER_TOOL_NOT_CONFIGURED' })
  assert.deepEqual(listUserTools('claude', join(home, 'absent')), [])
})

// A fake U2 host: answers initialize and tools/call, records what it received.
function fakeHosts() {
  const started = []
  const spawnHost = (binding, name) => {
    const child = new EventEmitter()
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.received = []
    child.kill = () => { if (!child.exited) { child.exited = true; child.emit('exit', 0) } }
    createInterface({ input: child.stdin }).on('line', line => {
      const message = JSON.parse(line); child.received.push(message)
      if (message.id === undefined) return
      const result = message.method === 'initialize' ? { protocolVersion: message.params.protocolVersion, capabilities: {}, serverInfo: { name } } : { echo: message.params }
      child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
    })
    child.stdin.on('finish', () => child.kill())
    started.push({ binding, name, child })
    return child
  }
  return { started, spawnHost }
}
function exchange(relay, binding, name, { method = 'POST', body, headers = {} }) {
  const request = PassThrough.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  request.method = method; request.headers = headers
  return new Promise(resolve => {
    const response = { writeHead(status, head) { this.status = status; this.head = head }, end(text) { resolve({ status: this.status, headers: this.head, body: text ? JSON.parse(text) : null }) } }
    relay.handle(request, response, binding, name)
  })
}

test('U3: initialize mints a session, calls are relayed, an unknown session is adopted with a self-initialize, DELETE and closeSeat end hosts', async () => {
  const { started, spawnHost } = fakeHosts()
  const relay = createUserToolRelay({ spawnHost, log: () => {} })
  const seat = { sessionName: 'bot-a-1st-x', botId: 'bot-a' }
  const init = await exchange(relay, seat, 'meta', { body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude' } } } })
  assert.equal(init.status, 200); assert.equal(init.body.result.serverInfo.name, 'meta')
  const session = init.headers['mcp-session-id']; assert.match(session, /^[0-9a-f-]{36}$/u)
  assert.equal((await exchange(relay, seat, 'meta', { body: { jsonrpc: '2.0', method: 'notifications/initialized' }, headers: { 'mcp-session-id': session } })).status, 202)
  const call = await exchange(relay, seat, 'meta', { body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x' } }, headers: { 'mcp-session-id': session } })
  assert.deepEqual(call.body.result, { echo: { name: 'x' } }); assert.equal(started.length, 1)

  // Body restart (relay state gone): the seat's old session is adopted, initialized by the relay, then the call runs.
  const fresh = createUserToolRelay({ spawnHost, log: () => {} })
  const after = await exchange(fresh, seat, 'meta', { body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'y' } }, headers: { 'mcp-session-id': session, 'mcp-protocol-version': '2025-03-26' } })
  assert.equal(after.status, 200); assert.deepEqual(after.body.result, { echo: { name: 'y' } }); assert.equal(after.headers['mcp-session-id'], session)
  const adopted = started.at(-1).child.received
  assert.deepEqual(adopted.map(message => message.method), ['initialize', 'notifications/initialized', 'tools/call'])
  assert.equal(adopted[0].params.protocolVersion, '2025-03-26')

  assert.equal((await exchange(fresh, seat, 'meta', { method: 'DELETE', headers: { 'mcp-session-id': session } })).status, 200)
  assert.equal(started.at(-1).child.exited, true); assert.equal(fresh.size(), 0)
  assert.equal((await exchange(fresh, seat, 'meta', { method: 'GET' })).status, 405)

  await exchange(relay, seat, 'xarticle', { body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } } })
  assert.equal(relay.size(), 2)
  relay.closeSeat(seat.sessionName)
  assert.equal(relay.size(), 0); assert.equal(started.filter(entry => entry.binding === seat).every(entry => entry.child.exited), true)
})

test('U4: prepare adds one http entry per user tool with the seat headers; a list failure still prepares the launch', async () => {
  const make = (list, callerReplace = true) => new RemoteSeats({
    terminals: { connection: { async target(request) { return { terminal: { ref: 't', target: {} }, cwd: request.projectRoot, accountOwner: 'owner' } } }, watch: () => () => {} },
    ingress: { seatCredential: { async issue() { return { url: 'http://127.0.0.1:4183/api/seat-mcp', credentialRef: {} } }, async revoke() {}, async reveal() { return 'secret' } },
      userTools: { list, callerReplace } },
    launchContext: async () => ({ text: 'RULES' }) })
  const bot = { id: 'bot-a', terminalId: 'mac', projectRoot: '/Users/q/app' }
  const args = { harness: 'claude-code', session_name: 'bot-a-1st-x' }
  const ok = await make(async botId => { assert.equal(botId, 'bot-a'); return [{ name: 'meta', kind: 'stdio' }] }).prepare(bot, args, { harness: 'claude-code' })
  const servers = ok.args.mcp_config.mcpServers
  assert.deepEqual(Object.keys(servers), ['meta', 'bellteam', 'call-bridge'])
  assert.deepEqual(servers.meta, { type: 'http', url: 'http://127.0.0.1:4183/api/seat-mcp/user/meta', headers: servers.bellteam.headers })
  // a138: only BellTeam's managed servers knowingly replace a same-name terminal server; user tools never do.
  assert.equal(servers.bellteam.replace, true); assert.equal(servers['call-bridge'].replace, true); assert.equal(Object.hasOwn(servers.meta, 'replace'), false)
  // An older bundled Aiterm (< 0.70.62): exactly today's config, no user tools, no replace key.
  const old = await make(async () => { throw new Error('must not be listed') }, false).prepare(bot, args, { harness: 'claude-code' })
  assert.deepEqual(Object.keys(old.args.mcp_config.mcpServers), ['bellteam', 'call-bridge'])
  assert.equal(Object.hasOwn(old.args.mcp_config.mcpServers.bellteam, 'replace'), false)
  const failed = await make(async () => { throw Object.assign(new Error('USER_TOOL_LIST_FAILED'), { code: 'USER_TOOL_LIST_FAILED' }) }).prepare(bot, args, { harness: 'claude-code' })
  assert.deepEqual(Object.keys(failed.args.mcp_config.mcpServers), ['bellteam', 'call-bridge'])
})
