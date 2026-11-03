import assert from 'node:assert/strict'
import { mkdtemp, stat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { createMemoryDispatcher, MEMORY_METHODS } from '../src/memory/dispatcher.mjs'
import { createMemoryService } from '../src/memory/factory.mjs'
import { BellTeamMemory } from '../src/memory-service.mjs'

const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'memory-module-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const registry = new Map([['bot-a', { id: 'bot-a', project: join(root, 'bots/bot-a') }]])
  const dispatcher = createMemoryDispatcher({ root })
  const connect = target => createMemoryService({ registry, dispatch(method, params) {
    target.validateRequest(method, params)
    return target.dispatch(method, params)
  } })
  const memory = connect(dispatcher)
  await dispatcher.control('initialize', {})
  await dispatcher.control('resume', {})
  return { root, registry, dispatcher, memory, connect }
}

test('restoreはDBを開かず、明示resumeまで受付を閉じる', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'memory-restore-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const root = join(parent, 'absent'), dispatcher = createMemoryDispatcher({ root })
  const input = { args: [], profiles: [] }
  assert.throws(() => dispatcher.validateRequest('initialize', input), /MEMORY_UNAVAILABLE/)
  await assert.rejects(dispatcher.control('resume', {}), /MEMORY_CONTROL_INVALID/)
  assert.deepEqual(await dispatcher.control('initialize', {}), { restored: true })
  await assert.rejects(stat(root), { code: 'ENOENT' })
  assert.throws(() => dispatcher.validateRequest('initialize', input), /MEMORY_UNAVAILABLE/)
  await assert.rejects(dispatcher.control('initialize', {}), /MEMORY_CONTROL_INVALID/)
  await assert.rejects(dispatcher.control('exit', {}), /MEMORY_NOT_QUIESCED/)
  await dispatcher.control('resume', {})
  dispatcher.validateRequest('initialize', input)
  assert.deepEqual(await dispatcher.control('quiesce', {}), { quiesced: true })
  assert.deepEqual(await dispatcher.control('exit', {}), { closed: true })
  assert.throws(() => dispatcher.dispatch('initialize', input), /MEMORY_UNAVAILABLE/)
})

test('factoryは既10操作・最終引数・呼出し時の最小台帳を保ち、結果をそのまま返す', async () => {
  const registry = new Map([['bot-a', { id: 'bot-a', project: '/synthetic/a', privateProfile: 'omit' }]])
  const requests = [], result = { accepted: 'original' }
  const memory = createMemoryService({ registry, dispatch(method, params) { requests.push({ method, ...params }); return result } })
  assert.deepEqual(Object.keys(memory), MEMORY_METHODS)
  registry.set('bot-new', { id: 'bot-new', project: '/synthetic/new', privateProfile: 'omit' })
  assert.equal(memory.initialize('ignored'), result)
  assert.deepEqual(requests.pop(), { method: 'initialize', args: [], profiles: [
    { id: 'bot-a', project: '/synthetic/a' }, { id: 'bot-new', project: '/synthetic/new' },
  ] })
  for (const method of MEMORY_METHODS.filter(method => !['initialize', 'ensureScope'].includes(method))) {
    for (const scope of [undefined, null, 'personal', 'shared', 'invalid']) {
      const input = { botId: 'bot-new', scope }
      assert.equal(memory[method](input, 'ignored'), result)
      const request = requests.pop()
      assert.equal(request.args[0], input)
      assert.deepEqual(request.profiles, scope === 'shared' ? [] : [{ id: 'bot-new', project: '/synthetic/new' }])
    }
    memory[method]({ botId: 'missing' })
    assert.deepEqual(requests.pop().profiles, [])
  }
  memory.ensureScope('bot-new', 'invalid', 'ignored')
  assert.deepEqual(requests.pop(), { method: 'ensureScope', args: ['bot-new', 'invalid'], profiles: [{ id: 'bot-new', project: '/synthetic/new' }] })
  memory.ensureScope('missing', 'shared')
  assert.deepEqual(requests.pop().profiles, [])
})

test('閉じたdispatcherは業務内部や任意rootを実行せず、既scopeの検証順を保持する', async t => {
  const { dispatcher, memory } = await fixture(t)
  const input = { args: [], profiles: [] }
  for (const method of ['constructor', 'openMemory', 'scopeRoot', '__proto__', 'close'])
    assert.throws(() => dispatcher.dispatch(method, input), /MEMORY_INPUT_INVALID/)
  for (const params of [null, {}, { ...input, root: '/other' }, { ...input, profiles: [{ id: 'a', project: 'relative' }] },
    { ...input, profiles: [{ id: 'a', project: '/valid', privateProfile: 'omit' }] }])
    assert.throws(() => dispatcher.dispatch('initialize', params), /MEMORY_INPUT_INVALID/)
  await assert.rejects(dispatcher.control('restore-files', {}), /MEMORY_CONTROL_INVALID/)
  await assert.rejects(dispatcher.control('resume', { root: '/other' }), /MEMORY_CONTROL_INVALID/)
  await assert.rejects(memory.remember({ botId: 'missing', scope: 'invalid', kind: 'invalid' }), /MEMORY_SCOPE_INVALID/)
  await assert.rejects(memory.remember({ botId: 'missing', kind: 'invalid' }), /BOT_NOT_FOUND/)
  await assert.rejects(memory.remember({ botId: 'bot-a', kind: 'invalid' }), /MEMORY_KIND_INVALID/)
  await memory.ensureScope('bot-a', 'invalid')
  await memory.remember({ botId: 'missing', scope: 'shared', content: '共有の保存' })
  assert.equal((await memory.recallMemory({ botId: 'missing', scope: 'shared', query: '保存' })).items.length, 1)
  await dispatcher.disconnect()
})

test('旧→新→旧factoryの復元でも、現DB/Markdown・改訂・固定・成長・再構築を保持する', async t => {
  const { root, dispatcher, memory, connect } = await fixture(t)
  await memory.initialize()
  const old = await memory.remember({ botId: 'bot-a', content: '古い記憶' })
  const revised = await memory.reviseMemory({ botId: 'bot-a', id: old.id, content: '更新した記憶' })
  await memory.pinMemory({ botId: 'bot-a', id: revised.id })
  const note = await memory.recordKnowledge({ botId: 'bot-a', title: '保存の手順', content: '同じ保存先から復元する' })
  await dispatcher.control('quiesce', {})
  await dispatcher.control('exit', {})
  const next = createMemoryDispatcher({ root })
  await next.control('initialize', {})
  await next.control('resume', {})
  const nextMemory = connect(next)
  const growth = await nextMemory.consolidateGrowth({ botId: 'bot-a', memoryIds: [revised.id], content: '成長した記憶' })
  assert.ok((await nextMemory.recallMemory({ botId: 'bot-a', query: '更新した記憶' })).items.some(item => item.id === revised.id && item.metadata.pinned))
  assert.equal((await nextMemory.rebuildKnowledgeIndex({ botId: 'bot-a' })).count, 1)
  assert.ok((await nextMemory.searchKnowledge({ botId: 'bot-a', query: '復元' })).items.some(item => item.id === note.id))
  await next.control('quiesce', {})
  await next.control('exit', {})
  const restored = createMemoryDispatcher({ root })
  await restored.control('initialize', {})
  await restored.control('resume', {})
  assert.ok((await connect(restored).recallMemory({ botId: 'bot-a', query: '成長した記憶' })).items.some(item => item.id === growth.id))
  await restored.disconnect()
})

test('成長の保存後にdrainしても、内部rememberから元記憶の整理まで完了する', async t => {
  const { dispatcher, memory } = await fixture(t)
  const original = await memory.remember({ botId: 'bot-a', content: '整理する記憶' })
  const opened = deferred(), release = deferred(), openMemory = BellTeamMemory.prototype.openMemory
  let calls = 0
  t.mock.method(BellTeamMemory.prototype, 'openMemory', async function (...args) {
    if (++calls === 2) { opened.resolve(); await release.promise }
    return openMemory.apply(this, args)
  })
  t.after(() => release.resolve())
  const operation = memory.consolidateGrowth({ botId: 'bot-a', memoryIds: [original.id], content: '統合した記憶' })
  await opened.promise
  let finished = false
  const drain = dispatcher.control('quiesce', {}).then(value => { finished = true; return value })
  await tick()
  assert.equal(finished, false)
  assert.throws(() => memory.remember({ botId: 'bot-a', content: '未受付' }), /MEMORY_UNAVAILABLE/)
  await assert.rejects(dispatcher.control('exit', {}), /MEMORY_NOT_QUIESCED/)
  release.resolve()
  const result = await operation
  assert.deepEqual(await drain, { quiesced: true })
  await dispatcher.control('resume', {})
  const items = (await memory.recallMemory({ botId: 'bot-a', query: '記憶' })).items
  assert.ok(items.some(item => item.id === result.id))
  assert.ok(!items.some(item => item.id === original.id))
  await dispatcher.disconnect()
})

test('検索の索引writerもdrain対象にして、DB close後に終了する', async t => {
  const { registry, dispatcher, memory } = await fixture(t)
  await memory.remember({ botId: 'bot-a', content: '索引の確認' })
  const opened = deferred(), release = deferred(), openMemory = BellTeamMemory.prototype.openMemory
  let closed = false
  t.mock.method(BellTeamMemory.prototype, 'openMemory', async function (...args) {
    const db = await openMemory.apply(this, args), close = db.close.bind(db)
    db.close = () => { close(); closed = true }
    opened.resolve()
    await release.promise
    return db
  })
  t.after(() => release.resolve())
  const query = memory.recallMemory({ botId: 'bot-a', query: '索引' })
  await opened.promise
  let finished = false
  const drain = dispatcher.control('quiesce', {}).then(value => { finished = true; return value })
  await tick()
  assert.equal(finished, false)
  assert.equal(closed, false)
  release.resolve()
  assert.equal((await query).items.length, 1)
  assert.deepEqual(await drain, { quiesced: true })
  assert.equal(closed, true)
  const db = new DatabaseSync(join(registry.get('bot-a').project, 'memory/memory.db'))
  try { assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_index').get().n, 1) }
  finally { db.close() }
  await dispatcher.control('exit', {})
})

test('保存済み操作のclose失敗を元callerへ返し、drainは再送しない', async t => {
  const { dispatcher, memory } = await fixture(t)
  const opened = deferred(), release = deferred(), openMemory = BellTeamMemory.prototype.openMemory
  const failure = new Error('synthetic close failed')
  let calls = 0
  t.mock.method(BellTeamMemory.prototype, 'openMemory', async function (...args) {
    calls++
    const db = await openMemory.apply(this, args), close = db.close.bind(db)
    db.close = () => { close(); throw failure }
    opened.resolve()
    await release.promise
    return db
  })
  t.after(() => release.resolve())
  const operation = memory.remember({ botId: 'bot-a', content: '保存済みの記憶' })
  const rejected = assert.rejects(operation, error => error === failure)
  await opened.promise
  const drain = dispatcher.control('quiesce', {})
  release.resolve()
  await rejected
  assert.deepEqual(await drain, { quiesced: true })
  assert.equal(calls, 1)
  await dispatcher.control('exit', {})
})

test('quiesce待ちのresumeで旧世代を維持し、未完のdrainを交換成功にしない', async t => {
  const { dispatcher, memory } = await fixture(t)
  const started = deferred(), release = deferred()
  t.after(() => release.resolve())
  t.mock.method(BellTeamMemory.prototype, 'remember', async () => { started.resolve(); await release.promise; return { completed: true } })
  const operation = memory.remember({ botId: 'bot-a', content: '保持' })
  await started.promise
  const drain = dispatcher.control('quiesce', {})
  await dispatcher.control('resume', {})
  release.resolve()
  assert.deepEqual(await operation, { completed: true })
  assert.deepEqual(await drain, { quiesced: false })
  await assert.rejects(dispatcher.control('exit', {}), /MEMORY_NOT_QUIESCED/)
  await dispatcher.control('quiesce', {})
  await dispatcher.control('exit', {})
})

test('受付済の遅延dispatchをdrain後も保持し、終了前に再drainを要求する', async t => {
  const { dispatcher, registry } = await fixture(t)
  const input = { args: [{ botId: 'bot-a', content: '受付済' }], profiles: [...registry.values()] }
  dispatcher.validateRequest('remember', input)
  assert.deepEqual(await dispatcher.control('quiesce', {}), { quiesced: true })
  const operation = dispatcher.dispatch('remember', input)
  await assert.rejects(dispatcher.control('exit', {}), /MEMORY_NOT_QUIESCED/)
  assert.ok((await operation).id)
  await assert.rejects(dispatcher.control('exit', {}), /MEMORY_NOT_QUIESCED/)
  await dispatcher.control('quiesce', {})
  await dispatcher.control('exit', {})
})

test('disconnectも受付済の処理を待ち、新しい受付を拒否する', async t => {
  const { dispatcher, memory } = await fixture(t)
  const started = deferred(), release = deferred()
  t.after(() => release.resolve())
  t.mock.method(BellTeamMemory.prototype, 'recordKnowledge', async () => { started.resolve(); await release.promise; return { id: 'completed' } })
  const operation = memory.recordKnowledge({ botId: 'bot-a', title: '保持', content: '本文' })
  await started.promise
  let finished = false
  const disconnect = dispatcher.disconnect().then(() => { finished = true })
  await tick()
  assert.equal(finished, false)
  assert.throws(() => memory.searchKnowledge({ botId: 'bot-a', query: '保持' }), /MEMORY_UNAVAILABLE/)
  release.resolve()
  assert.deepEqual(await operation, { id: 'completed' })
  await disconnect
  assert.equal(finished, true)
  await assert.rejects(dispatcher.control('resume', {}), /MEMORY_CONTROL_INVALID/)
})
