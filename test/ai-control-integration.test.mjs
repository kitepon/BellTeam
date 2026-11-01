import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { AiControl, aiControlError, stopRegisteredWork } from '../src/ai-control.mjs'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { BotRegistry } from '../src/bot-registry.mjs'
import { RoomRegistry } from '../src/room-registry.mjs'
import { BotScheduler, runShellCommand } from '../src/scheduler.mjs'
import { BellTeamMessenger } from '../src/messenger.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'
import { createSeatMcp } from '../src/seat-mcp.mjs'
import { RoomMessenger } from '../src/room-messenger.mjs'

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const tick = () => new Promise(r => setImmediate(r))
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'bellteam-control-integration-'))
  t.after(() => rm(path, { force: true, recursive: true }))
  return path
}
async function serve(t, options) {
  const server = createBellTeamServer({ bots: new Map(), messenger: {}, store: {}, transport: {}, authorize: r => r.headers.authorization === 'fixture', writeLog: () => {}, ...options })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const base = `http://127.0.0.1:${server.address().port}`
  return { server, base, request: (path, options = {}) => fetch(base + path, { ...options, headers: { authorization: 'fixture', 'content-type': 'application/json', ...options.headers } }) }
}

test('全体停止は全登録席と台帳から消えた進行jobを止め、一部失敗でも残りとcommandを処理する', async () => {
  const waiting = deferred(), called = []
  const transport = new AitermTransport()
  for (const id of ['deleted', 'a']) transport.activity.register({ bot: { id } })
  transport.interrupt = bot => {
    called.push(bot.id)
    if (bot.id === 'b') throw Error('fixture reject')
    return waiting.promise.then(() => ({ botId: bot.id, status: 'interrupted', sessionPreserved: true }))
  }
  const operation = stopRegisteredWork({
    bots: new Map(['a', 'b'].map(id => [id, { id }])),
    transport,
    scheduler: { interruptCommands() { called.push('command'); return true } },
  })
  assert.deepEqual(called, ['a', 'b', 'deleted', 'command'])
  waiting.resolve()
  assert.deepEqual(await operation, { unconfirmedBotIds: ['b'], commandsConfirmed: true })
})

test('認証済みAPIだけが全体ON/OFFを変更し、ON中は送信・再起動を拒み個別停止と閲覧を許す', async t => {
  const root = await directory(t), stopped = deferred(), bot = { id: 'bot-a' }
  let restarts = 0, individual = 0
  const c = new AiControl({ path: join(root, 'control.json'), stopAll: () => stopped.promise })
  await c.initialize()
  const bots = new Map([[bot.id, bot]])
  const messenger = new BellTeamMessenger({ bots, transport: {}, logPath: join(root, 'messages.jsonl'), requireAccess: () => c.assertEnabled() })
  const f = await serve(t, { aiControl: c, bots, messenger,
    store: { timeline: async () => [] },
    transport: { restart() { restarts++; return Promise.resolve() }, async interrupt() { individual++; return { botId: bot.id, status: 'interrupted', sessionPreserved: true } } },
  })
  assert.equal((await fetch(f.base + '/api/ai-control')).status, 401)
  assert.equal((await fetch(f.base + '/api/ai-control', { method: 'PATCH', body: '{"paused":true}' })).status, 401)
  for (const value of [null, [], { paused: 'true' }, { paused: true, extra: 1 }, {}])
    assert.equal((await f.request('/api/ai-control', { method: 'PATCH', body: JSON.stringify(value) })).status, 400)
  assert.equal((await f.request('/api/ai-control', { method: 'POST' })).status, 405)
  const on = await f.request('/api/ai-control', { method: 'PATCH', body: '{"paused":true}' })
  assert.equal(on.status, 202); assert.equal((await on.json()).control.state, 'stopping')
  for (const path of ['/api/bots/bot-a/messages', '/api/bots/bot-a/restart']) {
    const response = await f.request(path, { method: 'POST', body: '{"message":"fixture"}' })
    assert.equal(response.status, 423); assert.equal((await response.json()).error, 'AI_GLOBAL_PAUSED')
  }
  assert.equal(restarts, 0)
  assert.equal((await f.request('/api/bots/bot-a/stop', { method: 'POST' })).status, 200)
  assert.equal(individual, 1)
  assert.equal((await f.request('/api/bots/bot-a/messages')).status, 200)
  stopped.resolve({ unconfirmedBotIds: ['bot-a'], commandsConfirmed: true }); await c.enforcement
  const partial = await f.request('/api/ai-control', { method: 'PATCH', body: '{"paused":true}' })
  assert.equal(partial.status, 202); assert.equal((await partial.json()).control.paused, true)
  assert.equal((await f.request('/api/ai-control', { method: 'PATCH', body: '{"paused":false}' })).status, 200)
  assert.equal((await (await f.request('/api/ai-control')).json()).control.state, 'enabled')
})

test('保存失敗はHTTP503で正本ONを返し、SSEは状態変更を知らせる', async t => {
  const root = await directory(t)
  const c = new AiControl({ path: join(root, 'control.json'), save: async () => { throw Error('fixture disk') }, stopAll: () => ({ unconfirmedBotIds: [], commandsConfirmed: true }) })
  await c.initialize()
  const f = await serve(t, { aiControl: c, store: { watch: async () => () => {} } })
  await f.server.startMessageWatch()
  const abort = new AbortController()
  t.after(() => abort.abort())
  const events = await f.request('/api/events', { signal: abort.signal })
  const reader = events.body.getReader()
  const read = reader.read()
  const response = await f.request('/api/ai-control', { method: 'PATCH', body: '{"paused":true}' })
  assert.equal(response.status, 503)
  assert.equal((await response.json()).control.paused, true)
  let text = new TextDecoder().decode((await read).value)
  while (!text.includes('ai-control')) text += new TextDecoder().decode((await reader.read()).value)
  assert.match(text, /"type":"ai-control"/)
  abort.abort()
})

test('全体ONの後に起動準備が返ってもlaunch/sendせず停止として整理する', async t => {
  const root = await directory(t), preparing = deferred(), release = deferred(), calls = []
  let paused = false
  const bot = { id: 'bot-a', session: 'bot-a', project: root, harness: 'codex' }
  const transport = new AitermTransport({ handoffContext: async () => '',
    assertWorkAllowed() { if (paused) throw aiControlError('AI_GLOBAL_PAUSED', 423, 'fixture') },
    prepareStartup: async () => { preparing.resolve(); await release.promise },
    client: { async call(name, args) {
      calls.push(name)
      if (name === 'pty_list') return { content: [{ type: 'text', text: '(セッション無し)' }] }
      if (name === 'pty_observe') return { structuredContent: { schema: 'aiterm.pty-observe-result.v1', session_id: args.session_id, exists: false } }
      throw Error('unexpected ' + name)
    } },
  })
  const statuses = []
  const sending = transport.submit(bot, 'fixture', { onStatus: value => statuses.push(value) })
  const failed = sending.catch(e => e)
  await preparing.promise
  const sentBeforePause = calls.filter(name => name === 'pty_send').length
  paused = true
  const stop = transport.interrupt(bot).catch(error => error)
  release.resolve()
  assert.equal((await stop).code, 'BOT_STOP_UNCONFIRMED')
  assert.equal((await failed).code, 'AI_GLOBAL_PAUSED')
  assert.equal(statuses.at(-1), 'stopped')
  assert.equal(calls.includes('agent_launch'), false)
  assert.equal(calls.filter(name => name === 'pty_send').length, sentBeforePause)
  await assert.rejects(transport.ensure(bot), { code: 'AI_GLOBAL_PAUSED' })
  await assert.rejects(transport.restart(bot), { code: 'AI_GLOBAL_PAUSED' })
})

test('全体ONでcommandを取消し、未確認は未確認とし、新しい手動実行も拒む', async () => {
  let paused = false, signal, sent = 0
  const done = deferred()
  const scheduler = new BotScheduler({ registry: {}, messenger: { async sendmessage() { sent++ } },
    assertWorkAllowed() { if (paused) throw aiControlError('AI_GLOBAL_PAUSED', 423, 'fixture') },
    runCommand: async value => { signal = value.signal; return done.promise },
  })
  const command = scheduler.runCommandSchedule({ project: '/fixture' }, { command: 'fixture' })
  paused = true
  const stopping = scheduler.interruptCommands()
  assert.equal(signal.aborted, true)
  assert.throws(() => scheduler.runCommandSchedule({}, {}), { code: 'AI_GLOBAL_PAUSED' })
  done.resolve({ code: null, signal: 'SIGTERM', stdout: '', stderr: '', stopConfirmed: false })
  assert.equal(await stopping, false)
  await command; assert.equal(sent, 0)
})

test('合成commandのprocess groupを終了させ、終了と消失を確認する', { timeout: 5000 }, async t => {
  const root = await directory(t), abort = new AbortController()
  const script = join(root, 'fixture.cjs'), ready = join(root, 'ready')
  // Publish a complete PID only after the child has installed its signal handler.
  // A direct write creates an empty file before writing its bytes.
  await writeFile(script, 'const fs = require("node:fs"); process.on("SIGTERM", () => {}); fs.writeFileSync("ready.tmp", String(process.pid)); fs.renameSync("ready.tmp", "ready"); setInterval(() => {}, 1000)')
  const operation = runShellCommand({ cwd: root, command: `exec "${process.execPath}" "${script}"`, signal: abort.signal })
  t.after(async () => { abort.abort(); await operation })
  let pid
  for (let i = 0; i < 100; i++) {
    try { pid = Number(await readFile(ready, 'utf8')); break } catch { await new Promise(r => setTimeout(r, 10)) }
  }
  assert.ok(pid); abort.abort()
  const result = await operation
  assert.equal(result.stopConfirmed, true)
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})

test('停止中のBot/room予定は実行せず、解除前の期限を飛ばして新しい予定から再開する', async t => {
  const root = await directory(t), before = new Date('2026-10-21T00:00:00Z')
  const seed = join(root, 'seed.json'); let sequence = 0
  await writeFile(seed, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [{ id: 'bot-a', displayName: 'A', session: 'bot-a', harness: 'codex', project: root }] }))
  const registry = new BotRegistry({ seedPath: seed, botsRoot: join(root, 'bots'), now: () => before, id: () => `schedule-${++sequence}` })
  await registry.initialize()
  const rooms = new RoomRegistry({ roomsRoot: join(root, 'rooms'), bots: registry, now: () => before, id: () => `schedule-${++sequence}`, roomId: () => 'room-a' })
  await rooms.initialize(); await rooms.create({ name: 'fixture', memberIds: ['bot-a'] })
  for (const [owner, id] of [[registry, 'bot-a'], [rooms, 'room-a']]) {
    await owner.setSchedule(id, { kind: 'once', at: '2026-10-21T00:05:00Z', prompt: 'old' })
    await owner.setSchedule(id, { kind: 'cron', expression: '* * * * *', timezone: 'UTC', prompt: 'repeat' })
    await owner.setSchedule(id, { kind: 'once', at: '2026-10-21T00:12:00Z', prompt: 'new' })
  }
  let paused = true; const sent = []
  const scheduler = new BotScheduler({ registry, rooms, paused: () => paused,
    messenger: { async sendmessage(value) { sent.push(value.message) } }, roomMessenger: { async sendroommessage(value) { sent.push(value.message) } },
  })
  await scheduler.runDue(new Date('2026-10-21T00:10:01Z')); assert.deepEqual(sent, [])
  await scheduler.prepareResume(new Date('2026-10-21T00:10:00Z'))
  paused = false
  await scheduler.runDue(new Date('2026-10-21T00:10:01Z')); assert.deepEqual(sent, [])
  for (const [owner, id] of [[registry, 'bot-a'], [rooms, 'room-a']]) {
    const schedules = await owner.listSchedules(id)
    assert.equal(schedules[0].enabled, false); assert.equal(schedules[0].lastRunAt, null)
    assert.equal(schedules[1].lastRunAt, null); assert.equal(schedules[1].nextRunAt, '2026-10-21T00:11:00.000Z')
  }
  await scheduler.runDue(new Date('2026-10-21T00:12:01Z'))
  assert.equal(sent.length, 4); assert.equal(sent.some(value => value.includes('old')), false)
  await registry.setSchedule('bot-a', { kind: 'once', at: '2026-10-21T00:05:00Z', prompt: 'newly-created-past' })
  await scheduler.runDue(new Date('2026-10-21T00:12:02Z'))
  assert.equal(sent.at(-1).includes('newly-created-past'), true)
})

test('ON中の通話MCPは上流へ接続せず、BellTeamの読取MCPは残す', async t => {
  let calls = 0
  const bots = new Map([['bot-a', { id: 'bot-a', session: 'bot-a' }]])
  const mcp = createSeatMcp({ bots, tools: {}, assertWorkAllowed() { throw aiControlError('AI_GLOBAL_PAUSED', 423, 'fixture') }, callBridge() { calls++; throw Error('must not connect') } })
  const f = await serve(t, { internal: true, seatMcp: mcp })
  const response = await f.request('/mcp/call-bridge', { method: 'POST', headers: { 'x-bellteam-seat': 'bot-a' }, body: '{}' })
  assert.equal(response.status, 423); assert.equal((await response.json()).error, 'AI_GLOBAL_PAUSED'); assert.equal(calls, 0)
})

test('画像・会話保存中にON/OFFしても古い個別配送を復活させない', async t => {
  const root = await directory(t), entered = deferred(), release = deferred()
  const bot = { id: 'bot-a', session: 'bot-a', project: root }
  const c = new AiControl({ path: join(root, 'control.json'), stopAll: () => ({ unconfirmedBotIds: [], commandsConfirmed: true }) })
  await c.initialize()
  let sent = 0; const records = []
  const messenger = new BellTeamMessenger({ bots: new Map([[bot.id, bot], ['bot-b', { id: 'bot-b' }]]),
    transport: { async notify() { sent++; return {} } }, logPath: join(root, 'messages'), admitWork: () => c.admit(),
  })
  messenger.append = async record => {
    records.push(record)
    if (record.schema === 'bellteam.direct-message.v1') { entered.resolve(); await release.promise }
  }
  const old = messenger.sendmessage({ from: 'bot-b', target: bot.id, message: 'old' }).catch(e => e)
  await entered.promise; await c.update(true); await c.enforcement; await c.update(false)
  release.resolve()
  assert.equal((await old).code, 'BOT_STOPPED'); assert.equal(sent, 0)
  assert.equal(records.at(-1).delivery, 'stopped')
})

test('全体停止前に保存したユーザー入力はOFF後も未送信の停止となる', async t => {
  const root = await directory(t), bot = { id: 'bot-a', session: 'bot-a', project: root }
  const c = new AiControl({ path: join(root, 'control.json'), stopAll: () => ({ unconfirmedBotIds: [], commandsConfirmed: true }) })
  await c.initialize()
  let calls = 0
  const transport = new AitermTransport({ assertWorkAllowed: () => c.assertEnabled(), client: { async call() { calls++; throw Error('unexpected') } } })
  const messenger = new BellTeamMessenger({ bots: new Map([[bot.id, bot]]), transport,
    logPath: join(root, 'messages.jsonl'), admitWork: () => c.admit(),
  })
  const prepared = await messenger.prepareUserTurn({ target: bot.id, message: 'old' })
  await c.update(true); await c.enforcement; await c.update(false)
  const old = messenger.startUserTurn(prepared)
  await assert.rejects(old.accepted, { code: 'BOT_STOPPED' })
  await assert.rejects(old, { code: 'BOT_STOPPED' }); assert.equal(calls, 0)
  assert.equal((await messenger.store.timeline(bot.id))[0].delivery, 'stopped')
  assert.doesNotThrow(c.admit())
})

test('部屋の順序待ちと履歴読取をON/OFFがまたいでもAI選択や配送を始めない', async t => {
  const root = await directory(t), entered = deferred(), release = deferred()
  const c = new AiControl({ path: join(root, 'control.json'), stopAll: () => ({ unconfirmedBotIds: [], commandsConfirmed: true }) })
  await c.initialize()
  const bot = { id: 'bot-a', name: 'A' }, room = { id: 'room-a', name: 'fixture', memberIds: ['bot-a'] }
  const bots = new Map([[bot.id, bot]]), rooms = new Map([[room.id, room]]), records = []
  rooms.appendMessage = async (_id, record) => records.push(record)
  let calls = 0
  const messenger = new RoomMessenger({ bots, rooms, admitWork: () => c.admit(),
    roomTurns: async () => { entered.resolve(); await release.promise; return [] },
    chooseResponder: async () => { calls++; return ['bot-a'] }, transport: { async notify() { calls++; return {} } },
  })
  const input = { from: 'user', room: room.id, message: 'old' }
  const first = messenger.sendroommessage(input).catch(e => e)
  const queued = messenger.sendroommessage(input).catch(e => e)
  await entered.promise; await c.update(true); await c.enforcement; await c.update(false)
  release.resolve()
  assert.equal((await first).code, 'BOT_STOPPED'); assert.equal((await queued).code, 'BOT_STOPPED')
  assert.equal(calls, 0)
  assert.equal(records.filter(r => r.schema === 'bellteam.room-message.v1').length, 1)
  assert.equal(records.at(-1).delivery, 'stopped')
})

test('commandの環境設定読取中も同じprocess groupで取消し、本文を起動しない', { timeout: 5000 }, async t => {
  const root = await directory(t), abort = new AbortController()
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(root, 'environment'))
  await writeFile(join(root, 'environment/env.sh'), 'echo ready > ready-env\nsleep 60\n')
  const command = runShellCommand({ cwd: root, command: 'echo bad > payload', signal: abort.signal })
  let ready = false
  for (let i = 0; i < 100; i++) {
    try { await readFile(join(root, 'ready-env')); ready = true; break } catch { await new Promise(r => setTimeout(r, 10)) }
  }
  assert.equal(ready, true); abort.abort()
  const result = await command
  assert.equal(result.stopConfirmed, true)
  await assert.rejects(readFile(join(root, 'payload')), { code: 'ENOENT' })
})
