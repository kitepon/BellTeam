import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { observerProjectScope, observerScopedRequests } from '../src/conversation/observer.mjs'
import { createConversationObserverParentEffects } from '../src/conversation/observer-parent.mjs'
import { observerCheckRequests } from '../src/observer-check.mjs'
import { SelfTurns } from '../src/self-turns.mjs'

test('opaque project planning retains actual UTF8 JSON path and token chunk boundaries', () => {
  const projects = Array.from({ length: 600 }, (_, i) => ({ id: `bot-${i}`, projectPath: '/' + '\\"日本語'.repeat(360), after: 'tloc1.' + 'x'.repeat(500) }))
  const original = observerCheckRequests(projects)
  const opaque = observerScopedRequests(projects.map(p => ({ id: p.id, scope: observerProjectScope(p.projectPath),
    projectBytes: Buffer.byteLength(JSON.stringify(p.projectPath)), after: p.after })))
  assert.deepEqual(opaque.map(r => r.projects.map(p => p.id)), original.map(r => r.projects.map(p => p.id)))
  assert(original.length > 2)
  assert.throws(() => observerScopedRequests([{ id: 'bot-a', scope: 'forged', projectBytes: 10, after: null }]))
})

test('parent public observer binds a poll to the actual Bot/project and rejects foreign scope and changed identity', async () => {
  const bots = new Map([['bot-a', { id: 'bot-a', project: '/private/project-a' }]])
  const context = { generation: 'generation-a', operationId: 'op-a', actor: { kind: 'observer' }, continuation: false, rootMethod: 'observation.poll' }
  const requests = []
  const parent = createConversationObserverParentEffects({ snapshot: () => [...bots.values()], current: id => bots.get(id),
    check: async request => { requests.push(request); return { schema: 'throughline.observer_check_result.v1', status: 'complete', results: [{ id: 'bot-a', status: 'changed', token: 'tloc1.new' }] } },
    read: async request => { requests.push(request); return { schema: 'throughline.observer_read.v2', status: 'snapshot', throughCursor: 'cursor-a', turns: [] } },
  })
  const snapshot = await parent('runtime.observer.snapshot', {}, context)
  assert(!JSON.stringify(snapshot).includes('/private'))
  const scope = snapshot.projects[0].scope
  await parent('runtime.observer.check', { projects: [{ id: 'bot-a', scope, after: null }] }, context)
  await parent('runtime.observer.read', { botId: 'bot-a', scope }, context)
  assert.equal(requests[0].projects[0].projectPath, '/private/project-a')
  assert.equal(requests[1].project, '/private/project-a')
  await assert.rejects(parent('runtime.observer.read', { botId: 'bot-a', scope }, { ...context }))
  await assert.rejects(parent('runtime.observer.read', { botId: 'bot-a', scope: observerProjectScope('/other') }, context))
  await assert.rejects(parent('runtime.observer.read', { botId: 'bot-a', scope, project: '/other' }, context))
  bots.set('bot-a', { ...bots.get('bot-a') })
  await assert.rejects(parent('runtime.observer.read', { botId: 'bot-a', scope }, context))
  assert.equal(requests.length, 2)
})

test('module observer preserves legacy cursor/token, commits earlier bot, and excludes pending bot from the next check', async t => {
  const root = await mkdtemp(join(tmpdir(), 'observer-module-')); t.after(() => rm(root, { recursive: true, force: true }))
  const statePath = join(root, 'self-turns.json'), bots = new Map(['bot-a', 'bot-b'].map(id => [id, { id }]))
  const projects = [...bots.keys()].map(id => ({ id, project: observerProjectScope('/real/' + id), projectBytes: 13 }))
  const checks = [], reads = [], answers = [], shown = { shownId: 'shown-a', words: ['prefix'], endedAt: null }
  let failB = true, consumed = 0
  const self = new SelfTurns({ bots, statePath, report: () => {}, shown: async () => shown, consumeShown: async () => { consumed++ },
    appendAnswer: async (...args) => { answers.push(args) }, observer: {
      snapshot: async () => projects,
      check: async request => { checks.push(request); return { schema: 'throughline.observer_check_result.v1', status: 'complete', results: request.projects.map(p => ({ id: p.id, status: p.after === 'tloc1.new' ? 'unchanged' : 'changed', token: 'tloc1.new' })) } },
      read: async request => { reads.push(request); if (request.botId === 'bot-b' && failB) throw new Error('read failed')
        return { status: 'delta', throughCursor: 'next-' + request.botId, turns: [{ source_sha256: request.botId, turn_start: 'self', assistant: 'prefix answer', completed_at: 123 }] } },
    } })
  self.state = Object.fromEntries([...bots.keys()].map(id => [id, { project: '/real/' + id, cursor: 'old-' + id, checkToken: 'tloc1.old', seen: [], lastCompletedAt: 1 }]))
  await self.poll()
  assert.equal(reads[0].afterCursor, 'old-bot-a')
  let saved = JSON.parse(await readFile(statePath, 'utf8')).bots
  assert.equal(saved['bot-a'].cursor, 'next-bot-a'); assert.equal(saved['bot-a'].checkToken, 'tloc1.new')
  assert.equal(self.state['bot-b'].cursor, 'old-bot-b'); assert.equal(self.state['bot-b'].checkToken, 'tloc1.old')
  assert.equal(consumed, 1); assert.equal(answers[0][2], 'answer')
  failB = false; await self.poll()
  assert.deepEqual(checks[1].projects.map(p => p.id), ['bot-a'])
  saved = JSON.parse(await readFile(statePath, 'utf8')).bots
  assert.equal(saved['bot-b'].cursor, 'next-bot-b'); assert.equal(saved['bot-b'].checkToken, 'tloc1.old')
  assert.equal(consumed, 2)
  const parentForm = new SelfTurns({ bots: new Map([['bot-a', { id: 'bot-a', project: '/real/bot-a' }]]), statePath })
  parentForm.state = saved
  assert.equal(parentForm.stateFor(parentForm.bots.get('bot-a')).cursor, 'next-bot-a')
})
