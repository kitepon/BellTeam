import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModuleProcess } from '../src/module-process.mjs'
import { ConversationLifetimes } from '../src/conversation-lifetimes.mjs'
import { moduleTerminationLog } from '../src/module-exchange-diagnostic.mjs'
const tick = () => new Promise(resolve => setImmediate(resolve))

test('termination stages expose actual incoming and reaped waits without starting recovery early', async t => {
  const root = await mkdtemp(join(tmpdir(), 'termination-observation-'))
  await mkdir(join(root, 'state'))
  const incoming = Promise.withResolvers(), reaped = Promise.withResolvers()
  const admission = new ConversationLifetimes(), children = [], logs = [], origins = []
  const close = admission.close.bind(admission)
  admission.close = source => { origins.push(source); return close(source) }
  t.mock.method(console, 'error', line => { if (String(line).startsWith('{')) logs.push(JSON.parse(line)) })
  const end = child => {
    child.exitCode = 0; child.connected = false; child.stdout.closed = child.stderr.closed = true
    child.stdout.emit('close'); child.stderr.emit('close'); child.emit('exit', 0, null); child.emit('close', 0, null)
  }
  const controller = createModuleProcess({ component: 'conversation', root, admission,
    prepareRelease: async () => assert.fail('builtin only'), validateReady: () => {},
    spawnProcess: () => {
      const child = Object.assign(new EventEmitter(), { connected: true, exitCode: null, signalCode: null,
        stdout: Object.assign(new EventEmitter(), { closed: false, resume() {} }),
        stderr: Object.assign(new EventEmitter(), { closed: false, resume() {} }) })
      child.kill = () => { end(child); return true }; child.disconnect = () => end(child)
      children.push(child); return child
    },
    createChannel: child => ({ ready: Promise.resolve({ versionId: null, protocolVersion: 1 }),
      control: async method => { if (method === 'exit') queueMicrotask(() => end(child)); return { resumed: true, quiesced: true } },
      request: async () => null, callback: async () => null,
      drainIncoming: () => child === children[0] ? incoming.promise : Promise.resolve(),
      reaped: () => child === children[0] ? reaped.promise : Promise.resolve(),
    }),
  })
  t.after(async () => { incoming.resolve(); reaped.resolve(); await tick(); await controller.close(); await rm(root, { recursive: true, force: true }) })
  await controller.start(); assert.equal(origins[0], 'module_start')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const stages = () => logs.filter(v => v.code === 'MODULE_CHILD_TERMINATION').map(v => [v.stage, v.event])
  end(children[0]); await tick()
  assert.equal(admission.inspectAdmission().closedBy, 'module_child_exit')
  assert.equal(admission.inspectAdmission().ticket, true)
  assert.deepEqual(stages(), [['os_closed','completed'], ['incoming','waiting']])
  t.mock.timers.tick(30000); await tick(); assert.equal(children.length, 1)
  incoming.resolve(); await tick()
  assert.deepEqual(stages().slice(-2), [['incoming','completed'], ['reaped','waiting']])
  t.mock.timers.tick(30000); await tick(); assert.equal(children.length, 1)
  reaped.resolve(); await tick()
  assert.deepEqual(stages().slice(-2), [['reaped','completed'], ['lost','completed']])
  assert.equal(children.length, 1)
  t.mock.timers.tick(1000); await tick(); assert.equal(children.length, 2)
  assert.equal(controller.snapshot().available, true)
  assert.deepEqual(origins.slice(0,3), ['module_start','module_child_exit','module_recovery'])
  for (const row of logs.filter(v => v.code === 'MODULE_CHILD_TERMINATION')) {
    assert.equal(row.childSequence, 1); assert.ok(Number.isFinite(Date.parse(row.observedAt)))
    assert.equal(Object.hasOwn(row, 'generation'), false)
  }
  // Observation failure must not block the real writer barrier or recovery.
  t.mock.method(console, 'error', line => { if (String(line).includes('MODULE_CHILD_TERMINATION')) throw Error('sink unavailable') })
  end(children[1]); await tick(); t.mock.timers.tick(2000); await tick()
  assert.equal(children.length, 3); assert.equal(controller.snapshot().available, true)
  await controller.close(); assert.equal(origins.at(-1), 'module_close')
})

test('termination formatter emits closed values and keeps unavailable evidence null', () => {
  const value = moduleTerminationLog('conversation','reaped','failed',2,3,
    { snapshot() { throw Error('secret') } }, { code: 'CONVERSATION_IPC_INVALID', message: 'secret', generation: 'secret' })
  assert.equal(value.failureCode, 'CONVERSATION_IPC_INVALID')
  assert.equal(value.admissionActive, null); assert.equal(value.admissionClosed, null)
  assert.equal(JSON.stringify(value).includes('secret'), false)
  assert.equal(moduleTerminationLog('conversation','incoming','failed',1,-1,null,{code:'SECRET'}).failureCode, null)
  assert.equal(moduleTerminationLog('conversation','unknown','waiting',1,0,null), null)
})
