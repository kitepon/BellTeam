import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SeatRuntime, SEAT_MEMORY_METHODS } from '../src/seat-runtime.mjs'

function memoryRuntime(root, requests = []) {
  return new SeatRuntime({ root, home: root, run: (command, args, options) => new Promise((resolve, reject) => {
    requests.push(JSON.parse(options.input))
    const child = execFile(command, args, { cwd: root }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }))
    child.stdin.end(options.input)
  }) })
}

test('新規BotのHTTP/MCP共通ensureScopeを席ユーザーへ渡し、記憶とRAGを作成する', async t => {
  const root = await mkdtemp(join(tmpdir(), 'seat-memory-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'bots/bot-new')
  await mkdir(project, { recursive: true })
  const runtime = memoryRuntime(root)
  const memory = runtime.memory(new Map([['bot-new', { id: 'bot-new', project }]]))
  await memory.ensureScope('bot-new', 'personal')
  for (const file of ['memory', 'rag/raw', 'rag/notes', 'rag/INDEX.md', 'rag/index.db'])
    assert.ok(await stat(join(project, file)))
  await assert.rejects(memory.ensureScope('bot-missing', 'personal'), /BOT_NOT_FOUND/u)
})

test('記憶の全公開操作は呼出し時の対象scopeだけを子へ送り、初期化だけ全台帳を渡す', async () => {
  const requests = [], bots = new Map([['bot-a', { id: 'bot-a', project: '/synthetic/a', privateProfile: 'omit' }]])
  const runtime = new SeatRuntime({ root: '/synthetic', home: '/synthetic', run: async (command, args, options) => {
    requests.push(JSON.parse(options.input)); return { stdout: '{"result":null}' }
  } })
  const memory = runtime.memory(bots)
  bots.set('bot-new', { id: 'bot-new', project: '/synthetic/new', privateProfile: 'omit' })
  await memory.initialize()
  assert.deepEqual(requests.pop().profiles, [{ id: 'bot-a', project: '/synthetic/a' }, { id: 'bot-new', project: '/synthetic/new' }])
  for (const method of SEAT_MEMORY_METHODS.filter(method => !['initialize', 'ensureScope'].includes(method))) {
    for (const scope of [undefined, null, 'personal', 'shared', 'invalid']) {
      const input = { botId: 'bot-a', ...{ botId: 'bot-new', scope } }
      await memory[method](input)
      const request = requests.pop()
      assert.deepEqual(request.args, JSON.parse(JSON.stringify(input)))
      assert.deepEqual(request.profiles, scope === 'shared' ? [] : [{ id: 'bot-new', project: '/synthetic/new' }])
    }
    await memory[method]({ botId: 'missing' })
    assert.deepEqual(requests.pop().profiles, [])
  }
  for (const scope of [undefined, null, 'personal', 'shared', 'invalid']) {
    await memory.ensureScope('bot-new', scope)
    const request = requests.pop()
    assert.deepEqual(request.args, ['bot-new', scope ?? null])
    assert.deepEqual(request.profiles, scope === 'shared' ? [] : [{ id: 'bot-new', project: '/synthetic/new' }])
  }
})

test('絞った台帳で実際の子がscopeと未知Botの検証を行い、personalとsharedを分離する', async t => {
  const root = await mkdtemp(join(tmpdir(), 'seat-memory-scope-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const requests = [], bots = new Map(), memory = memoryRuntime(root, requests).memory(bots)
  bots.set('bot-new', { id: 'bot-new', project: join(root, 'bots/bot-new') })
  await memory.ensureScope('bot-new', 'invalid')
  await memory.remember({ botId: 'bot-new', content: 'personal marker', scope: null })
  await memory.remember({ botId: 'missing', content: 'shared marker', scope: 'shared' })
  const personal = await memory.recallMemory({ botId: 'bot-new', query: 'marker' })
  const shared = await memory.recallMemory({ botId: 'missing', scope: 'shared', query: 'marker' })
  assert.deepEqual(personal.items.map(item => item.content), ['personal marker'])
  assert.deepEqual(shared.items.map(item => item.content), ['shared marker'])
  await assert.rejects(memory.remember({ botId: 'missing', scope: 'invalid', kind: 'invalid' }), /MEMORY_SCOPE_INVALID/)
  assert.deepEqual(requests.at(-1).profiles, [])
  await assert.rejects(memory.remember({ botId: 'missing', kind: 'invalid' }), /BOT_NOT_FOUND/)
  await assert.rejects(memory.remember({ botId: 'bot-new', kind: 'invalid' }), /MEMORY_KIND_INVALID/)
  await assert.rejects(memory.ensureScope('missing', 'invalid'), /BOT_NOT_FOUND/)
})
