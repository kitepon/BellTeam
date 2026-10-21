import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { stopRegisteredWork } from '../src/ai-control.mjs'
import { applyExecutionCancellation } from '../src/execution-transport.mjs'
import { BellTeamMessenger } from '../src/messenger.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

test('未送信取消は確認したsource/期待target世代にだけ結び、無関係な拒否や受理済み回答を停止にしない', () => {
  const a = { session_id: 'bot-a', launch_id: 'a'.repeat(32) }, d = { session_id: 'bot-d', launch_id: 'd'.repeat(32) }
  const make = source => ({ execution: { record: { source: { status: 'verified', point: { launch: source } } }, reservation: { target: { session_id: 'bot-b', expected_launch_id: null } } },
    executionStopResult: { targets: [{ launch: a, outcome: 'closed' }] } })
  const unrelated = make(d); applyExecutionCancellation(unrelated, { effect: 'not_started' }); assert.equal(unrelated.stopped, undefined)
  const cancelled = make(a); applyExecutionCancellation(cancelled, { effect: 'not_started' }); assert.equal(cancelled.stopped, true)
  const unknown = make(a); applyExecutionCancellation(unknown, { effect: 'possible' }); assert.equal(unknown.stopped, undefined)
  const accepted = { ...make(a), receipt: { mode: 'agent_dispatch' } }; applyExecutionCancellation(accepted, { effect: 'not_started' }); assert.equal(accepted.stopped, undefined)
})
async function fixture(t) {
  const project = await mkdtemp(join(tmpdir(), 'execution-transport-'))
  t.after(() => rm(project, { recursive: true, force: true }))
  const bots = ['a', 'b', 'd'].map(id => ({ id: `bot-${id}`, session: `bot-${id}`, project, harness: 'codex' }))
  const launches = new Map(bots.map((bot, i) => [bot.id, { session_id: bot.session, launch_id: String(i + 1).repeat(32) }]))
  const calls = [], waits = new Map(), records = []
  let stopTargets = bots.slice(0, 2).map(bot => launches.get(bot.id)), beforeSend = async () => {}, beforeStop = async () => {}, partial = false, missingRoots = false
  const bridge = {
    async reserve(input, options) {
      calls.push({ action: 'register', input: structuredClone(input), options: structuredClone(options) })
      assert.equal([...transport.active.values()].some(job => job.info.groupId === input.request.delivery_id), false)
      const handle = { reservation: structuredClone({ source: input.source, target: { session_id: input.targetSession } }),
        issued: new Set(), binding: null,
        async invoke(name, args, options) {
          calls.push({ action: name, args, options })
          this.issued.add(name === 'agent_launch' ? 'launch' : 'send')
          if (name === 'agent_launch') {
            const launch = { session_id: args.session_name, launch_id: 'f'.repeat(32) }
            launches.set(args.session_name, launch)
            this.binding = { target: { launch, boundary: null } }
            return { structuredContent: { session_id: args.session_name } }
          }
          await beforeSend()
          const cursor = records.indexOf(handle) + 1
          this.binding = { target: { launch: launches.get(args.session_id), boundary: { event_cursor: cursor, operation_id: null, turn_id: `turn-${cursor}`, steer_id: null } } }
          return { structuredContent: { mode: 'agent_dispatch', event_cursor: cursor, wait_process: { executable: 'synthetic', args: [String(cursor)] } } }
        },
        async finish(evidence) { calls.push({ action: 'finish', evidence }); return {} },
      }
      records.push(handle)
      return handle
    },
    async roots(session_id) {
      calls.push({ action: 'roots', session_id })
      return { roots: missingRoots ? [] : [{ session_id, launch_id: launches.get(session_id)?.launch_id ?? '1'.repeat(32) }], relation_coverage: missingRoots ? 'incomplete' : 'complete' }
    },
    async stop(roots) {
      calls.push({ action: 'stop', roots })
      await beforeStop()
      return { status: partial ? 'partial' : 'stopped', targets: stopTargets.map(launch => ({ launch, outcome: 'closed' })) }
    },
  }
  const client = { async call(name, args) {
    calls.push({ action: `raw:${name}`, args })
    assert.equal(name, 'pty_observe', 'bound mode must never fall back to raw mutation')
    const launch = launches.get(args.session_id)
    return { structuredContent: { schema: 'aiterm.pty-observe-result.v1', session_id: args.session_id, exists: !!launch, launch_id: launch?.launch_id ?? null } }
  } }
  const transport = new AitermTransport({ client, executionBridge: bridge, handoffContext: async () => '',
    waitProcess: (receipt, signal) => {
      const wait = deferred(); waits.set(receipt.args[0], wait)
      signal.addEventListener('abort', () => wait.reject(new Error('synthetic stopped')), { once: true })
      return wait.promise
    } })
  t.after(() => { for (const wait of waits.values()) wait.resolve({ outcome: 'done' }) })
  const start = (bot, id, options = {}) => {
    const statuses = []
    const completion = transport.submit(bot, 'synthetic', { info: { context: 'direct', groupId: id }, onStatus: status => statuses.push(status), ...options })
    return { completion, result: completion.catch(error => error), statuses }
  }
  return { bots, launches, calls, waits, records, transport, start,
    onSend(fn) { beforeSend = fn }, onStop(fn) { beforeStop = fn },
    setTargets(value) { stopTargets = value }, partial() { partial = true }, missingRoots() { missingRoots = true } }
}

test('bound配送はactive前に登録し、固定source/contextと既存参照を使い、対応doneだけfinishする', async t => {
  const f = await fixture(t)
  const source = { sourceSession: 'bot-source', source: { launch: { session_id: 'bot-source', launch_id: 'a'.repeat(32) }, boundary: null } }
  const a = f.start(f.bots[0], 'existing-delivery', { executionSource: source })
  source.source.launch.launch_id = 'b'.repeat(32)
  await a.completion.accepted; await tick()
  const registration = f.calls.find(call => call.action === 'register')
  assert.equal(registration.input.request.delivery_id, 'existing-delivery')
  assert.equal(registration.options.sourceContext.launch.launch_id, 'a'.repeat(32))
  f.waits.get('1').resolve({ outcome: 'done' })
  assert.deepEqual(await a.completion, { delivery: 'delivered' })
  assert.deepEqual(f.calls.filter(call => call.action === 'finish').map(call => call.evidence), [{ kind: 'completion', target: f.records[0].binding.target }])
})

test('absent席は同じ登録の空launch→send各1回で起動し、生closeや再送を使わない', async t => {
  const f = await fixture(t)
  f.launches.delete(f.bots[0].id)
  const a = f.start(f.bots[0], 'existing-delivery')
  await a.completion.accepted; await tick()
  assert.deepEqual(f.calls.filter(call => ['agent_launch', 'pty_send'].includes(call.action)).map(call => call.action), ['agent_launch', 'pty_send'])
  assert.equal(f.calls.find(call => call.action === 'register').input.expectedLaunch, null)
  f.waits.get('1').resolve({ outcome: 'done' }); await a.completion
})

test('親absentでも保存rootsを使い、連鎖先のclosedが停止receiptに先行してもstoppedへ整理する', { timeout: 2000 }, async t => {
  const f = await fixture(t)
  const a = f.start(f.bots[0], 'a'), b = f.start(f.bots[1], 'b'), d = f.start(f.bots[2], 'd')
  await Promise.all([a.completion.accepted, b.completion.accepted, d.completion.accepted]); await tick()
  const entered = deferred(), release = deferred()
  f.onStop(async () => { entered.resolve(); await release.promise })
  f.launches.delete(f.bots[0].id)
  const stopped = f.transport.interrupt(f.bots[0])
  await entered.promise
  f.waits.get('2').reject(new Error('AITERM_TURN_CLOSED'))
  await tick()
  assert.deepEqual(b.statuses, ['running'])
  release.resolve()
  assert.equal((await stopped).status, 'stopped')
  assert.equal((await a.result).code, 'BOT_STOPPED')
  assert.equal((await b.result).code, 'BOT_STOPPED')
  assert.deepEqual(b.statuses, ['running', 'stopped'])
  assert.equal(f.transport.queueItems().some(item => item.botId === f.bots[2].id), true)
  f.waits.get('3').resolve({ outcome: 'done' }); await d.completion
  assert.equal(f.calls.filter(call => call.action === 'stop').length, 1)
})

test('停止が部分未確認なら、停止待ち中のdoneを失わず通常の完了結果へ戻す', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred()
  f.partial(); f.setTargets([])
  f.onStop(async () => { entered.resolve(); await release.promise })
  const a = f.start(f.bots[0], 'a'); await a.completion.accepted; await tick()
  const stopped = f.transport.interrupt(f.bots[0]).catch(error => error)
  await entered.promise
  f.waits.get('1').resolve({ outcome: 'done' }); await tick()
  assert.deepEqual(a.statuses, ['running'])
  release.resolve()
  assert.equal((await stopped).code, 'BOT_STOP_UNCONFIRMED')
  assert.deepEqual(await a.completion, { delivery: 'delivered' })
  assert.deepEqual(a.statuses, ['running', 'delivered'])
})

test('RPC応答待ちより先に停止を届け、後着した受付receiptを保持して整理する', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred()
  f.onSend(async () => { entered.resolve(); await release.promise })
  const a = f.start(f.bots[0], 'a'); await entered.promise
  const stopped = f.transport.interrupt(f.bots[0])
  await stopped
  assert.equal(f.calls.some(call => call.action === 'stop'), true)
  release.resolve()
  assert.equal((await a.result).code, 'BOT_STOPPED')
  assert.equal(f.calls.filter(call => call.action === 'pty_send').length, 1)
})

test('無関係な席の未着手dispatch/wake/旧変更は停止要求を待たせず、その席を抑止しない', async t => {
  const f = await fixture(t), pending = deferred()
  f.transport.dispatches.set(f.bots[2].id, pending.promise)
  f.transport.waking.set(f.bots[2].id, pending.promise)
  pending.promise.executionSession = f.bots[2].session
  f.transport.sessionChanges.set(f.bots[2].id, new Set([pending.promise]))
  assert.equal((await f.transport.interrupt(f.bots[0])).status, 'stopped')
  assert.equal(f.transport.uncertainChanges.has(f.bots[2].id), false)
  pending.resolve()
})

test('未接続の旧変更が対象に残る場合もstopは先に送り、成功へ丸めず再利用を抑止する', async t => {
  const f = await fixture(t), pending = deferred()
  pending.promise.executionSession = f.bots[0].session
  f.transport.sessionChanges.set(f.bots[0].id, new Set([pending.promise]))
  await assert.rejects(f.transport.interrupt(f.bots[0]), { code: 'BOT_STOP_UNCONFIRMED' })
  assert.equal(f.calls.filter(call => call.action === 'stop').length, 1)
  await assert.rejects(f.transport.ensure(f.bots[0]), { code: 'BOT_SESSION_UNCONFIRMED' })
  pending.resolve()
})

test('同じ席名でも古い世代の停止結果を新世代jobの停止確認に流用しない', async t => {
  const f = await fixture(t), old = f.launches.get(f.bots[0].id)
  f.launches.set(f.bots[0].id, { ...old, launch_id: 'e'.repeat(32) })
  f.setTargets([old])
  const a = f.start(f.bots[0], 'new'); await a.completion.accepted; await tick()
  await assert.rejects(f.transport.interrupt(f.bots[0]), { code: 'BOT_STOP_UNCONFIRMED' })
  f.waits.get('1').resolve({ outcome: 'done' })
  assert.deepEqual(await a.completion, { delivery: 'delivered' })
  assert.deepEqual(a.statuses, ['running', 'delivered'])
})

test('全体ONはroots集合へstopを1回だけ渡し、コマンド取消も行う', async t => {
  const f = await fixture(t)
  let commands = 0
  f.setTargets([...f.launches.values()])
  const result = await stopRegisteredWork({ bots: new Map(f.bots.map(bot => [bot.id, bot])), transport: f.transport,
    scheduler: { interruptCommands() { commands++; return true } } })
  assert.deepEqual(result, { unconfirmedBotIds: [], commandsConfirmed: true })
  assert.equal(f.calls.filter(call => call.action === 'stop').length, 1)
  assert.equal(f.calls.find(call => call.action === 'stop').roots.length, 3)
  assert.equal(commands, 1)
})

test('roots空/coverage欠測を成功にせず、旧closeへfallbackしない', async t => {
  const f = await fixture(t); f.missingRoots()
  await assert.rejects(f.transport.interrupt(f.bots[0]), { code: 'BOT_STOP_UNCONFIRMED' })
  assert.equal(f.calls.some(call => call.action === 'stop'), false)
  assert.equal(f.calls.some(call => call.action === 'raw:pty_close'), false)
})

test('停止RPCの作用不明は同名再利用を抑止し、受理済みの元回答は観測を続ける', async t => {
  const f = await fixture(t)
  f.onStop(async () => { throw Object.assign(Error('synthetic lost stop response'), { effect: 'possible' }) })
  const a = f.start(f.bots[0], 'a'); await a.completion.accepted; await tick()
  await assert.rejects(f.transport.interrupt(f.bots[0]), { code: 'BOT_STOP_UNCONFIRMED' })
  await assert.rejects(f.transport.ensure(f.bots[0]), { code: 'BOT_SESSION_UNCONFIRMED' })
  f.waits.get('1').resolve({ outcome: 'done' })
  assert.deepEqual(await a.completion, { delivery: 'delivered' })
  assert.equal(f.calls.filter(call => call.action === 'pty_send').length, 1)
})

test('roots読取後の連鎖停止中に来た未結合変更は発行せず、対象の変更を取消す', async t => {
  const operations = {
    restart: f => f.transport.restart(f.bots[0]),
    reconfigure: f => f.transport.reconfigure(f.bots[0], { ...f.bots[0], model: 'synthetic-next' }),
    configurationClose: f => f.transport.stopForConfiguration(f.bots[0]),
    idleClose: f => f.transport.closeIdle(f.bots[0]),
    directLaunch: f => f.transport.changeSession(f.bots[0], 'agent_launch', { session_name: f.bots[0].session }),
  }
  for (const [name, operation] of Object.entries(operations)) await t.test(name, { timeout: 2000 }, async t => {
    const f = await fixture(t), entered = deferred(), release = deferred()
    f.onStop(async () => { entered.resolve(); await release.promise })
    const stopped = f.transport.interrupt(f.bots[0])
    await entered.promise
    const change = operation(f).catch(error => error)
    await tick()
    assert.equal(f.calls.some(call => call.action.startsWith('raw:') && call.action !== 'raw:pty_observe'), false)
    release.resolve()
    assert.equal((await stopped).status, 'stopped', 'unissued changes must not create legacy pending gaps')
    assert.equal((await change).code, 'BOT_STOPPED')
    assert.equal(f.transport.uncertainChanges.has(f.bots[0].id), false)
  })
})

test('連鎖で到達したidle席への設定変更も、root以外だからと停止中に発行しない', { timeout: 2000 }, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred()
  f.onStop(async () => { entered.resolve(); await release.promise })
  const stopped = f.transport.interrupt(f.bots[0])
  await entered.promise
  const change = f.transport.reconfigure(f.bots[1], { ...f.bots[1], model: 'synthetic-next' }).catch(error => error)
  await tick(); release.resolve()
  assert.equal((await stopped).status, 'stopped')
  assert.equal((await change).code, 'BOT_STOPPED')
  assert.equal(f.calls.some(call => call.action === 'raw:agent_configure'), false)
})

test('無関係な席の新しい設定変更は停止を待たせず、停止終了後に一度だけ発行する', { timeout: 2000 }, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred()
  const original = f.transport.client.call.bind(f.transport.client)
  f.transport.client.call = async (name, args, options) => {
    if (name !== 'agent_configure') return original(name, args, options)
    f.calls.push({ action: 'raw:agent_configure', args })
    return { structuredContent: {} }
  }
  f.onStop(async () => { entered.resolve(); await release.promise })
  const stopped = f.transport.interrupt(f.bots[0])
  await entered.promise
  const change = f.transport.reconfigure(f.bots[2], { ...f.bots[2], model: 'synthetic-next' })
  await tick()
  assert.equal(f.calls.some(call => call.action === 'raw:agent_configure'), false)
  release.resolve()
  assert.equal((await stopped).status, 'stopped')
  assert.equal((await change).mode, 'configure')
  assert.equal(f.calls.filter(call => call.action === 'raw:agent_configure').length, 1)
})

test('停止前に受け付けた再起動は、準備が後着しても依頼時versionを保持して取消す', { timeout: 2000 }, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred()
  f.transport.requireAccess = async () => { entered.resolve(); await release.promise }
  const change = f.transport.restart(f.bots[0]).catch(error => error)
  await entered.promise
  assert.equal((await f.transport.interrupt(f.bots[0])).status, 'stopped')
  release.resolve()
  assert.equal((await change).code, 'BOT_STOPPED')
  assert.equal(f.calls.some(call => call.action === 'raw:pty_close'), false)
})

test('job整理のawait中に判明した旧変更の作用不明も、返却直前に再照合して保持する', { timeout: 2000 }, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred()
  const a = f.start(f.bots[0], 'a'); await a.completion.accepted; await tick()
  f.records[0].finish = async () => { entered.resolve(); await release.promise }
  const stopped = f.transport.interrupt(f.bots[0]).catch(error => error)
  await entered.promise
  f.transport.uncertainChanges.set(f.bots[0].id, 'synthetic-late-rpc-timeout')
  release.resolve()
  assert.equal((await stopped).code, 'BOT_STOP_UNCONFIRMED')
  await assert.rejects(f.transport.ensure(f.bots[0]), { code: 'BOT_SESSION_UNCONFIRMED' })
  assert.equal((await a.result).code, 'BOT_STOPPED')
})

test('jobを持たない連鎖先も、停止前の設定準備のversionを進めて後着変更を取消す', { timeout: 2000 }, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred()
  f.transport.requireAccess = async () => { entered.resolve(); await release.promise }
  const change = f.transport.reconfigure(f.bots[1], { ...f.bots[1], model: 'synthetic-next' }).catch(error => error)
  await entered.promise
  assert.equal((await f.transport.interrupt(f.bots[0])).status, 'stopped')
  release.resolve()
  assert.equal((await change).code, 'BOT_STOPPED')
  assert.equal(f.calls.some(call => call.action === 'raw:agent_configure'), false)
})

test('通話の各配送はsession/event/seqと実targetで登録し、世代不明の外部発信元は補完しない', async t => {
  for (const [event, seq] of [['session.message', 0], ['session.reply', 2], ['session.reply', null], ['session.reply', '2']]) {
    await t.test(`${event}/${seq ?? 'missing'}/${typeof seq}`, { timeout: 2000 }, async t => {
      const f = await fixture(t), bot = f.bots[0]
      const messenger = new BellTeamMessenger({ bots: new Map(f.bots.map(bot => [bot.id, bot])), transport: f.transport,
        logPath: join(bot.project, 'calls.jsonl'), deliveryId: () => 'existing-call-delivery' })
      await messenger.receiveCallBridge({ event, seq, session_id: 'existing-call', target_id: bot.id,
        source_system: 'bellteam', source_id: f.bots[1].id, source_label: 'synthetic', message: 'synthetic',
        executionSource: { sourceSession: f.bots[1].id, source: { launch: f.launches.get(f.bots[1].id), boundary: null } } })
      const registration = f.calls.find(call => call.action === 'register')
      assert.deepEqual(registration.input.request, typeof seq === 'number'
        ? { kind: 'call', call_session_id: 'existing-call', event, seq, target_session_id: bot.session }
        : { kind: 'delivery', delivery_id: 'existing-call-delivery', target_session_id: bot.session })
      assert.equal(registration.input.sourceSession, null)
      assert.deepEqual(registration.input.source, { launch: null, boundary: null })
      assert.equal(registration.options.sourceContext, null)
      assert.equal(f.calls.filter(call => call.action === 'pty_send').length, 1)
      // Confirmed closure finishes this accepted delivery without inventing an
      // external source edge or a native completion based on its call label.
      assert.equal((await f.transport.interrupt(bot)).status, 'stopped')
      await f.transport.idle(bot.id)
      assert.equal(f.calls.find(call => call.action === 'finish').evidence.kind, 'interrupted')
    })
  }
})
