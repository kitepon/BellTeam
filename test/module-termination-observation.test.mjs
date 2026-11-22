import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModuleProcess } from '../src/module-process.mjs'
import { ConversationLifetimes } from '../src/conversation-lifetimes.mjs'
import { moduleTerminationLog } from '../src/module-exchange-diagnostic.mjs'
// Recovery rereads the adoption file (real fs I/O) before prepare, so one turn is not enough.
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)) }

async function fixture(t, component) {
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
  const controller = createModuleProcess({ component, root, admission,
    prepareRelease: async () => assert.fail('builtin only'), validateReady: () => {},
    // Every start and recovery needs a passing ready probe (module-ready-probe, 7971c7a5); neither component has a default.
    probeCandidate: async () => {},
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
  await controller.start()
  const stages = () => logs.filter(v => v.code === 'MODULE_CHILD_TERMINATION').map(v => [v.stage, v.event])
  const rowsValid = () => { for (const row of logs.filter(v => v.code === 'MODULE_CHILD_TERMINATION')) {
    assert.equal(row.childSequence, 1); assert.ok(Number.isFinite(Date.parse(row.observedAt)))
    assert.equal(Object.hasOwn(row, 'generation'), false)
  } }
  // Observation failure must not block the real writer barrier or recovery.
  const sinkFailureKeepsRecovery = async () => {
    t.mock.method(console, 'error', line => { if (String(line).includes('MODULE_CHILD_TERMINATION')) throw Error('sink unavailable') })
    end(children[1]); await tick(); t.mock.timers.tick(2000); await tick()
    assert.equal(children.length, 3); assert.equal(controller.snapshot().available, true)
  }
  return { controller, admission, children, logs, origins, incoming, reaped, end, stages, rowsValid, sinkFailureKeepsRecovery }
}

test('usage termination stages expose actual incoming and reaped waits without starting recovery early', async t => {
  const f = await fixture(t, 'usage')
  assert.equal(f.origins[0], 'module_start')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  f.end(f.children[0]); await tick()
  assert.equal(f.admission.inspectAdmission().closedBy, 'module_child_exit')
  assert.equal(f.admission.inspectAdmission().ticket, true)
  assert.deepEqual(f.stages(), [['os_closed','completed'], ['incoming','waiting']])
  t.mock.timers.tick(30000); await tick(); assert.equal(f.children.length, 1)
  f.incoming.resolve(); await tick()
  assert.deepEqual(f.stages().slice(-2), [['incoming','completed'], ['reaped','waiting']])
  t.mock.timers.tick(30000); await tick(); assert.equal(f.children.length, 1)
  f.reaped.resolve(); await tick()
  assert.deepEqual(f.stages().slice(-2), [['reaped','completed'], ['lost','completed']])
  assert.equal(f.children.length, 2); assert.equal(f.controller.snapshot().available, true)
  assert.deepEqual(f.origins.slice(0,3), ['module_start','module_child_exit','module_recovery'])
  f.rowsValid()
  await f.sinkFailureKeepsRecovery()
  await f.controller.close(); assert.equal(f.origins.at(-1), 'module_close')
})

// Owner 2026-11-07 (module-process.md "Current conversation lifecycle"): conversation has no admission close, and
// observed OS death permits the next child without waiting for the old child's incoming/reaped references.
test('conversation termination records exit origin and loss at OS death; pending incoming and reaped never hold recovery', async t => {
  const f = await fixture(t, 'conversation')
  f.children[0].stderr.emit('data', JSON.stringify({ code: 'CONVERSATION_CHILD_EXIT_ORIGIN', origin: 'peer_failure', failureCode: 'CONVERSATION_IPC_INVALID' }) + '\n')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  f.end(f.children[0]); await tick()
  const cause = f.logs.find(v => v.code === 'MODULE_CHILD_EXIT_ORIGIN')
  assert.equal(cause.childSequence, 1); assert.equal(cause.origin, 'peer_failure')
  assert.equal(cause.failureCode, 'CONVERSATION_IPC_INVALID')
  assert.deepEqual(f.stages(), [['os_closed','completed'], ['lost','completed']])
  assert.equal(f.children.length, 1, 'recovery waits for its backoff timer')
  t.mock.timers.tick(1000); await tick()
  assert.equal(f.children.length, 2); assert.equal(f.controller.snapshot().available, true)
  f.reaped.reject(Object.assign(Error('late'), { code: 'CONVERSATION_IPC_DISCONNECTED' })); await tick()
  const late = f.logs.filter(v => v.code === 'MODULE_CHILD_TERMINATION').at(-1)
  assert.deepEqual([late.stage, late.event, late.failureCode], ['reaped', 'failed', 'CONVERSATION_IPC_DISCONNECTED'])
  assert.equal(f.controller.snapshot().available, true)
  f.rowsValid()
  await f.sinkFailureKeepsRecovery()
  await f.controller.close()
  assert.deepEqual(f.origins, []); assert.equal(f.admission.inspectAdmission().closedBy, null)
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
