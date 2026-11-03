import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Test-only business state; the caller owns runtime construction, exchange and cleanup.
export async function createConversationPreservationFixture({ root, appRoot }) {
  assert(isAbsolute(root) && isAbsolute(appRoot))
  const load = path => import(pathToFileURL(join(appRoot, path)))
  const [{ ConversationWriter }, { RoomRegistry }, { observerProjectScope }] = await Promise.all([
    load('src/conversation-writer.mjs'), load('src/room-registry.mjs'), load('src/conversation/observer.mjs'),
  ])
  const probe = JSON.parse(await readFile(join(appRoot, 'src/conversation/probe-fixture.json'), 'utf8'))
  assert.equal(probe.bots.length, 1)
  const bot = { ...probe.bots[0], harness: 'codex', session: probe.bots[0].id,
    project: join(root, 'bots', probe.bots[0].id), position: 'Fixture', role: 'Preserved display' }
  const botId = bot.id, roomId = Object.values(probe.files).find(value => value.schema === 'bellteam.room.v1').id
  const paths = ['logs/self-turns.json', `rooms/${roomId}/room.json`, `rooms/${roomId}/schedule.json`]
  assert.deepEqual(Object.keys(probe.files).sort(), [...paths].sort())
  const scope = observerProjectScope(bot.project)
  let self = { project: scope, cursor: 'fixture-cursor-0', checkToken: 'tloc1.fixture_0',
    seen: ['1'.repeat(64)], lastCompletedAt: 1730000000000 }
  probe.files['logs/self-turns.json'].bots[botId] = { ...self }
  for (const relative of paths) {
    const path = join(root, relative)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, JSON.stringify(probe.files[relative]) + '\n', { flag: 'wx', mode: 0o600 })
  }
  const seedPath = join(root, 'conversation-fixture-seed.json')
  await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [bot] }) + '\n', { flag: 'wx', mode: 0o600 })
  const logPath = join(root, 'logs/direct-messages.jsonl')
  await writeFile(logPath, '', { flag: 'wx', mode: 0o600 })
  const writer = new ConversationWriter({ logPath, onMessage() {}, now: () => '2026-11-04T00:00:00Z', id: () => 'fixture-word' })
  const record = message => ({ schema: 'bellteam.direct-message.v1', delivery_id: message, from: botId,
    target: 'user', message, at: '2026-11-04T00:00:00Z', delivery: 'delivered' })
  await writer.append(record('fixture-before'))
  await appendFile(logPath, Buffer.concat([Buffer.alloc(147), Buffer.from(JSON.stringify(record('must-not-salvage')) + '\n')]))
  await writer.append(record('fixture-after'))
  const originalLog = await readFile(logPath)
  const registry = new RoomRegistry({ roomsRoot: join(root, 'rooms'), bots: new Map([[botId, bot]]) })
  await registry.restore()
  await registry.appendMessage(roomId, { schema: 'bellteam.room-message.v1', id: 'fixture-room-message',
    at: '2026-11-04T00:00:00Z', message: 'fixture-room-history', sender: { id: botId, name: bot.name },
    room: { id: roomId, name: registry.get(roomId).name, members: [{ id: botId, name: bot.name }] },
    routing: { status: 'ready', responders: [] }, deliveries: [] })
  paths.push('logs/direct-messages.jsonl', `rooms/${roomId}/messages.jsonl`, 'conversation-fixture-seed.json')
  const snapshot = async () => Object.fromEntries(await Promise.all(paths.map(async relative => {
    const path = join(root, relative), info = await stat(path, { bigint: true }), bytes = await readFile(path)
    return [relative, { bytes: bytes.toString('base64'), mode: `${info.mode}`, mtimeNs: `${info.mtimeNs}` }]
  })))
  let prior = await snapshot(), priorCounts = { effects: 0, native: 0 }, effects = 0, native = 0, backgroundPolls = 0, activePoll = null
  let roomName = registry.get(roomId).name
  const messages = ['fixture-before', 'fixture-after'], labels = new Set(), receipts = [], polls = new WeakMap()
  const activity = () => ({ effects, native })
  const counts = () => ({ ...activity(), backgroundPolls })
  const wrapEffects = original => async (method, params, context) => {
    const observing = context.rootMethod === 'observation.poll'
    if (!observing) effects++
    if (/^execution\.(notify|turn|report|background\.begin|observation\.source|reconcile|closeLaunch)$/u.test(method)) {
      native++; assert.fail('fixture must not start or replay a delivery')
    }
    if (!method.startsWith('runtime.observer.')) return original(method, params, context)
    assert(observing, 'restore must not issue observer effects')
    assert.equal(context.actor.kind, 'observer')
    if (method === 'runtime.observer.snapshot') {
      const manual = activePoll?.operationContext === context.operationContext ? activePoll : null
      polls.set(context, manual)
      if (!manual) backgroundPolls++
      return { projects: [{ botId, scope, projectBytes: Buffer.byteLength(JSON.stringify(bot.project)) }] }
    }
    assert(polls.has(context))
    const manual = polls.get(context)
    if (method === 'runtime.observer.check') {
      if (!manual) {
        assert.equal(params.projects.length, 1)
        const item = params.projects[0]
        assert.equal(item.id, botId); assert.equal(item.scope, scope)
        assert([self.checkToken, activePoll?.next.checkToken].includes(item.after))
        return { schema: 'throughline.observer_check_result.v1', status: 'complete',
          results: [{ id: botId, status: 'unchanged', token: item.after }] }
      }
      assert.deepEqual(params.projects, [{ id: botId, scope, after: self.checkToken }])
      return { schema: 'throughline.observer_check_result.v1', status: 'complete',
        results: [{ id: botId, status: 'changed', token: manual.next.checkToken }] }
    }
    assert(manual, 'unchanged background polls must not read turns')
    assert.equal(method, 'runtime.observer.read')
    assert.equal(params.botId, botId); assert.equal(params.scope, scope); assert.equal(params.afterCursor, self.cursor)
    manual.read = true
    return { status: 'delta', throughCursor: manual.next.cursor, page: { complete: true }, turns: [] }
  }
  const exercise = async ({ runtime, label, versionId }) => {
    assert(/^[a-z0-9-]+$/u.test(label) && !labels.has(label), 'each stage must be unique')
    const { services } = runtime, assembly = services.conversationAssembly
    assert(assembly, 'default runtime must expose its real conversation assembly')
    assert.equal(services.store, assembly.facade.store)
    assert.equal(assembly.controller.snapshot().currentVersionId, versionId === 'builtin' ? null : versionId)
    assert.deepEqual(activity(), priorCounts, 'restore must not issue business effects or native deliveries')
    assert.deepEqual(await snapshot(), prior, 'restore must preserve the latest business state bytes/mode/mtime')
    const owner = operation => assembly.run({ kind: 'owner' }, operation)
    assert.deepEqual((await owner(() => services.store.timeline(botId))).map(row => row.message), messages)
    assert.equal((await owner(() => services.rooms.read(roomId))).name, roomName)
    assert.deepEqual((await owner(() => services.rooms.messages(roomId))).map(row => row.message), ['fixture-room-history'])
    assert.deepEqual(await owner(() => services.rooms.listSchedules(roomId)), [])
    await owner(() => services.bots.refresh())
    const current = services.bots.get(botId)
    for (const key of ['id', 'name', 'position', 'role']) assert.equal(current[key], bot[key])
    const direct = `${label}-direct`, word = `${label}-word`
    const delivery = assembly.run({ kind: 'bot', botId }, () => services.messenger.sendmessage({ from: botId, target: 'user', message: direct }))
    assert(delivery.completion instanceof Promise)
    await delivery; await delivery.completion
    const display = assembly.run({ kind: 'observer' }, () => services.messenger.appendInterimWords(botId, `fixture-${label}`, [{ text: word }]))
    assert(display.completion instanceof Promise)
    await display; await display.completion
    roomName = `Conversation ${label}`
    await owner(() => services.rooms.update(roomId, { name: roomName }))
    const operationContext = assembly.moduleOperations.reserve()
    activePoll = { operationContext, read: false,
      next: { ...self, cursor: `fixture-cursor-${labels.size + 1}`, checkToken: `tloc1.fixture_${labels.size + 1}` } }
    let manualAttempts = 0
    try {
      // A first call can join the child's already running background poll.
      for (let attempt = 0; attempt < 3 && !activePoll.read; attempt++) {
        manualAttempts++
        const poll = assembly.run({ kind: 'observer' }, () => assembly.facade.selfTurns.poll({ operationContext }))
        assert(poll.completion instanceof Promise)
        await poll; await poll.completion
      }
      assert(activePoll.read, 'manual poll repeatedly joined a background poll')
      assert.deepEqual(JSON.parse(await readFile(join(root, 'logs/self-turns.json'), 'utf8')).bots[botId], activePoll.next)
      self = activePoll.next
    } finally { activePoll = null; assembly.moduleOperations.finish(operationContext) }
    messages.push(direct, word)
    assert.deepEqual((await owner(() => services.store.timeline(botId))).map(row => row.message), messages)
    assert.equal((await owner(() => services.rooms.read(roomId))).name, roomName)
    assert((await readFile(logPath)).subarray(0, originalLog.length).equals(originalLog), 'original corrupt bytes must remain intact')
    assert.equal(native, 0)
    labels.add(label); prior = await snapshot(); priorCounts = activity()
    const receipt = { label, versionId, historyRows: messages.length, cursor: self.cursor, checkToken: self.checkToken,
      stateSha256: createHash('sha256').update(JSON.stringify(prior)).digest('hex'), nativeDeliveries: native, backgroundPolls, manualAttempts }
    receipts.push(receipt)
    return receipt
  }
  return { botId, roomId, seedPath, bots: [bot], wrapEffects, exercise, snapshot, counts, receipts }
}
