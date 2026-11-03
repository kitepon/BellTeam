import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { observerCheckRequests, checkObserverProjects, validateObserverCheckResult, runObserverCommand } from '../src/observer-check.mjs'
import { SelfTurns, readObserverTurns } from '../src/self-turns.mjs'

const schema = 'throughline.observer_check_result.v1'
const complete = results => ({ schema, status: 'complete', results })
const changed = request => complete(request.projects.map(({ id }) => ({ id, status: 'changed', token: 'tloc1.new' })))
const unchanged = request => complete(request.projects.map(({ id, after }) => ({ id, status: 'unchanged', token: after })))
const page = (cursor = 'c2', turns = [], extra = {}) => ({ status: 'delta', throughCursor: cursor, turns, page: { complete: true }, ...extra })
const turn = key => ({ source_sha256: key, turn_start: 'self', assistant: key, completed_at: 2000 })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

async function fixture(t, n = 1) {
  const dir = await mkdtemp(join(tmpdir(), 'observer-check-consumer-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const bots = new Map(Array.from({ length: n }, (_, i) => [`b${i}`, { id: `b${i}`, project: `/fixture/${i}` }]))
  const checks = [], reads = [], answers = [], reports = []
  const service = new SelfTurns({ bots, statePath: join(dir, 'state.json'),
    check: async (request, options) => { checks.push([request, options]); return unchanged(request) },
    read: async (request, options) => { reads.push([request, options]); return page() },
    appendAnswer: async (...args) => { answers.push(args) }, report: message => reports.push(message),
  })
  service.state = Object.fromEntries([...bots.values()].map(bot => [bot.id, {
    project: bot.project, cursor: 'c1', seen: [], lastCompletedAt: 1000, checkToken: 'tloc1.old',
  }]))
  await service.save()
  return { service, bots, checks, reads, answers, reports, saved: async () => JSON.parse(await readFile(service.statePath, 'utf8')).bots }
}

test('quiet 0/1/16/64/133/257/513: count-bound chunks, no read, single concurrency and complete coverage', async t => {
  for (const n of [0, 1, 16, 64, 133, 257, 513]) {
    const f = await fixture(t, n)
    let active = 0, peak = 0
    f.service.check = async (request, options) => {
      active++; peak = Math.max(peak, active); f.checks.push([request, options])
      await new Promise(resolve => setImmediate(resolve))
      active--; return unchanged(request)
    }
    await f.service.poll()
    assert.equal(peak, n ? 1 : 0)
    assert.equal(active, 0)
    assert.equal(f.checks.length, Math.ceil(n / 256))
    assert.equal(f.reads.length, 0)
    assert.deepEqual(f.checks.flatMap(([r]) => r.projects.map(x => x.id)), [...f.bots.keys()])
    for (const [r, o] of f.checks) {
      assert.ok(r.projects.length <= 256 && Buffer.byteLength(JSON.stringify(r)) <= 1048576)
      assert.ok(o.signal instanceof AbortSignal)
      assert.equal('signal' in r, false)
    }
  }
})

test('JSON-escaped project bytes split before count limit; invalid fields and duplicate IDs fail explicitly', () => {
  const projects = Array.from({ length: 133 }, (_, i) => ({ id: `b${i}`, projectPath: '/' + '\u0001'.repeat(4000), after: null }))
  const requests = observerCheckRequests(projects)
  assert.ok(requests.length > 1)
  assert.deepEqual(requests.flatMap(r => r.projects), projects)
  assert.ok(requests.every(r => r.projects.length < 256 && Buffer.byteLength(JSON.stringify(r)) <= 1048576))
  for (const item of [{ id: '' }, { id: 'あ'.repeat(43) }, { projectPath: 'relative' }, { projectPath: '/' + 'a'.repeat(4096) }, { after: '' }, { after: 'a'.repeat(513) }]) {
    assert.throws(() => observerCheckRequests([{ ...projects[0], ...item }]), /OBSERVER_CHECK_INVALID/)
  }
  assert.throws(() => observerCheckRequests([projects[0], projects[0]]), /OBSERVER_CHECK_INVALID/)
})

test('pending last Bot reads first, is excluded from same check, and keeps old token until next cycle', async t => {
  const f = await fixture(t, 3), order = []
  f.service.pending.add('b2')
  f.service.read = async r => { order.push(`read:${r.project}`); return page('c2') }
  f.service.check = async r => { order.push(`check:${r.projects.map(x => x.id)}`); return unchanged(r) }
  await f.service.poll()
  assert.deepEqual(order, ['read:/fixture/2', 'check:b0,b1'])
  assert.equal((await f.saved()).b2.checkToken, 'tloc1.old')
  f.service.check = async r => {
    assert.equal(r.projects.find(x => x.id === 'b2').after, 'tloc1.old')
    return complete(r.projects.map(x => ({ id: x.id, status: x.id === 'b2' ? 'changed' : 'unchanged', token: x.id === 'b2' ? 'tloc1.new' : x.after })))
  }
  await f.service.poll()
  assert.equal((await f.saved()).b2.checkToken, 'tloc1.new')
})

test('all pending and empty targets start no check; pending failures remain pending', async t => {
  const f = await fixture(t, 3)
  f.service.pending = new Set(f.bots.keys())
  f.service.read = async r => r.project.endsWith('/2') ? { status: 'projection_pending' } : page()
  await f.service.poll()
  assert.equal(f.checks.length, 0)
  assert.deepEqual([...f.service.pending], ['b2'])
  assert.equal((await f.saved()).b2.cursor, 'c1')
})

test('changed token commits with cursor only after all pages and append; later read cursor never becomes the check token', async t => {
  const f = await fixture(t), trace = []
  f.service.check = async r => changed(r)
  f.service.read = async r => {
    assert.equal((await f.saved()).b0.checkToken, 'tloc1.old')
    trace.push(r)
    return r.pageToken ? page('c9', [turn('two')]) : page('c9', [turn('one')], { page: { complete: false, nextToken: 'next' } })
  }
  f.service.appendAnswer = async (...a) => {
    assert.equal((await f.saved()).b0.cursor, 'c1')
    f.answers.push(a)
  }
  await f.service.poll()
  assert.equal(trace[1].throughCursor, 'c9')
  assert.equal(trace[1].afterCursor, 'c1')
  assert.equal(trace[1].pageToken, 'next')
  const saved = (await f.saved()).b0
  assert.equal(saved.cursor, 'c9')
  assert.equal(saved.checkToken, 'tloc1.new')
  assert.deepEqual(saved.seen, ['one', 'two'])
})

test('append failure preserves seen/shown/cursor/token, retries pending before check and appends once', async t => {
  const f = await fixture(t), shown = { words: ['prefix'], endedAt: null }
  f.service.shown = () => shown
  f.service.check = async r => changed(r)
  f.service.read = async () => page('c2', [{ ...turn('one'), assistant: 'prefix\nanswer' }])
  f.service.appendAnswer = async () => { throw new Error('private stderr /secret') }
  await f.service.poll()
  assert.deepEqual(f.service.state.b0.seen, [])
  assert.deepEqual(shown.words, ['prefix'])
  assert.equal(f.service.state.b0.cursor, 'c1')
  assert.equal(f.service.state.b0.checkToken, 'tloc1.old')
  f.service.check = () => assert.fail('pending excluded')
  f.service.appendAnswer = async (...a) => f.answers.push(a)
  await f.service.poll()
  assert.equal(f.answers.length, 1)
  assert.equal(f.answers[0][2], 'answer')
  assert.deepEqual(shown.words, [])
  assert.equal((await f.saved()).b0.checkToken, 'tloc1.old')
  assert.doesNotMatch(f.reports.join(), /private|secret/)
})

test('state-save failure restores cursor/token while retaining successful append dedup, then retries without duplicate append', async t => {
  const f = await fixture(t), save = f.service.save.bind(f.service)
  f.service.check = async r => changed(r)
  f.service.read = async () => page('c2', [turn('one')])
  f.service.save = async () => { throw new Error('disk failure') }
  await f.service.poll()
  assert.equal(f.answers.length, 1)
  assert.equal(f.service.state.b0.checkToken, 'tloc1.old')
  assert.equal(f.service.state.b0.cursor, 'c1')
  assert.equal((await f.saved()).b0.checkToken, 'tloc1.old')
  assert.ok(f.service.pending.has('b0'))
  f.service.save = save
  await f.service.poll()
  assert.equal(f.answers.length, 1)
  assert.equal((await f.saved()).b0.cursor, 'c2')
  assert.equal((await f.saved()).b0.checkToken, 'tloc1.old')
})

test('later page failure retains old cursor/token and earlier appended seen, pending retry recovers remaining pages', async t => {
  const f = await fixture(t)
  f.service.check = async r => changed(r)
  f.service.read = async r => {
    if (r.pageToken) throw new Error('page failed')
    return page('c2', [turn('one')], { page: { complete: false, nextToken: 'next' } })
  }
  await f.service.poll()
  assert.equal(f.service.state.b0.cursor, 'c1')
  assert.equal(f.service.state.b0.checkToken, 'tloc1.old')
  assert.deepEqual(f.service.state.b0.seen, ['one'])
  f.service.read = async r => r.pageToken ? page('c2', [turn('two')]) : page('c2', [turn('one')], { page: { complete: false, nextToken: 'next' } })
  await f.service.poll()
  assert.deepEqual(f.answers.map(a => a[2]), ['one', 'two'])
  assert.equal((await f.saved()).b0.checkToken, 'tloc1.old')
})

test('check resync/error preserve read cursor; only resync invalidates check token after successful read', async t => {
  for (const status of ['resync_required', 'error']) {
    const f = await fixture(t)
    f.service.check = async () => complete([{ id: 'b0', status, token: null, ...(status === 'error' ? { code: 'E_OBSERVER_CHECK_SOURCE' } : {}) }])
    await f.service.poll()
    assert.equal(f.reads[0][0].afterCursor, 'c1')
    assert.equal((await f.saved()).b0.checkToken, status === 'error' ? 'tloc1.old' : null)
    f.service.check = async r => { assert.equal(r.projects[0].after, status === 'error' ? 'tloc1.old' : null); return changed(r) }
    await f.service.poll()
    assert.equal((await f.saved()).b0.checkToken, 'tloc1.new')
  }
})

test('whole invalid results are never partially adopted; unknown read status and missing continuation stay pending', async t => {
  for (const mutate of [r => { r.results.pop() }, r => { r.results.reverse() }, r => { r.results[1].status = 'unknown' },
    r => { r.results[1].token = null }, r => { r.results[1].id = 'b0' }, r => { r.results[1].extra = 'bad' },
    r => { r.status = 'error' }, r => { r.results[1].status = 'unchanged' }]) {
    const f = await fixture(t, 2)
    f.service.check = async request => { const r = changed(request); mutate(r); return r }
    await f.service.poll()
    assert.equal(f.reads.length, 0)
    assert.equal(f.service.state.b0.checkToken, 'tloc1.old')
    assert.equal(f.service.pending.size, 2)
  }
  for (const result of [{ status: 'ambiguous_parent' }, { status: 'unknown' }, page('c2', [], { page: { complete: false, nextToken: null } })]) {
    const f = await fixture(t)
    f.service.check = async r => changed(r)
    f.service.read = async () => result
    await f.service.poll()
    assert.equal(f.service.state.b0.cursor, 'c1')
    assert.equal(f.service.state.b0.checkToken, 'tloc1.old')
    assert.ok(f.service.pending.has('b0'))
  }
})

test('old projectless state and project changes reset without old cursor/token or past answers; deletion starts no read', async t => {
  const f = await fixture(t)
  delete f.service.state.b0.project
  f.service.check = async r => { assert.equal(r.projects[0].after, null); return changed(r) }
  f.service.read = async r => { assert.equal(r.afterCursor, undefined); return page('c2', [turn('past')], { status: 'snapshot' }) }
  await f.service.poll()
  assert.equal(f.answers.length, 0)
  f.service.check = async r => { f.bots.set('b0', { id: 'b0', project: '/new-project' }); return changed(r) }
  f.service.read = () => assert.fail('old project response must not read')
  await f.service.poll()
  f.service.check = async r => { assert.equal(r.projects[0].after, null); return changed(r) }
  f.service.read = async r => { assert.equal(r.afterCursor, undefined); assert.equal(r.project, '/new-project'); return page('c3', [], { status: 'snapshot' }) }
  // The project-change failure is retried as pending and excluded from check.
  await f.service.poll()
  assert.equal((await f.saved()).b0.project, '/new-project')
  f.service.check = async r => { f.bots.delete('b0'); return changed(r) }
  f.service.read = () => assert.fail('deleted bot')
  await f.service.poll()
})

test('stop waits for check collection and starts no later chunk/read; concurrent poll shares the same request', async t => {
  const f = await fixture(t, 257), entered = deferred(), close = deferred()
  let calls = 0, signal
  f.service.check = async (_r, o) => { calls++; signal = o.signal; entered.resolve(); await close.promise; throw new Error('ABORT_ERR') }
  const poll = f.service.poll()
  assert.equal(f.service.poll(), poll)
  await entered.promise
  let stopped = false
  const stop = f.service.stop().then(() => { stopped = true })
  await Promise.resolve()
  assert.equal(signal.aborted, true)
  assert.equal(stopped, false)
  close.resolve()
  await stop
  assert.equal(calls, 1)
  assert.equal(f.reads.length, 0)
  assert.equal(f.service.state.b0.checkToken, 'tloc1.old')
  await f.service.poll()
  assert.equal(calls, 1)
})

test('stop during a pending read waits for collection and prevents next page and check', async t => {
  const f = await fixture(t, 2), entered = deferred(), close = deferred()
  f.service.pending.add('b1')
  let signal
  f.service.read = async (_r, o) => { signal = o.signal; entered.resolve(); await close.promise; return page('c2', [], { page: { complete: false, nextToken: 'next' } }) }
  const poll = f.service.poll()
  await entered.promise
  let stopped = false
  const stop = f.service.stop().then(() => { stopped = true })
  await Promise.resolve()
  assert.ok(signal.aborted)
  assert.equal(stopped, false)
  close.resolve()
  await Promise.all([stop, poll])
  assert.equal(f.checks.length, 0)
  assert.equal(f.service.state.b1.cursor, 'c1')
})

test('successful earlier chunk remains committed when the following request fails', async t => {
  const f = await fixture(t, 257)
  let calls = 0
  f.service.check = async r => {
    if (calls++) throw new Error('partial JSON')
    return complete(r.projects.map(x => ({ id: x.id, status: x.id === 'b0' ? 'changed' : 'unchanged', token: x.id === 'b0' ? 'tloc1.new' : x.after })))
  }
  await f.service.poll()
  assert.equal((await f.saved()).b0.checkToken, 'tloc1.new')
  assert.equal(f.service.state.b256.checkToken, 'tloc1.old')
  assert.ok(f.service.pending.has('b256'))
  assert.equal(f.reads.length, 1)
})

test('public adapters pass JSON+EOF, same signal, default 16MiB and base environment without exposing signal in JSON', async () => {
  const signal = new AbortController().signal
  const request = observerCheckRequests([{ id: 'b', projectPath: '/p', after: null }])[0]
  const result = changed(request), calls = []
  const run = async (command, args, options) => { calls.push({ command, args, options }); return { stdout: JSON.stringify(result), stderr: '' } }
  await checkObserverProjects(request, { run, seatCommands: true, root: '/root-fixture', signal })
  assert.equal(calls[0].command, 'throughline')
  assert.deepEqual(calls[0].args, ['observer-check', '--json'])
  assert.equal(calls[0].options.input, JSON.stringify(request))
  assert.equal(calls[0].options.signal, signal)
  assert.equal(calls[0].options.maxBuffer, 16 * 1024 * 1024)
  assert.equal('env' in calls[0].options, false)
  await assert.rejects(checkObserverProjects(request, { run: async () => ({ stdout: JSON.stringify(result), stderr: 'unexpected' }) }), /OBSERVER_CHECK_INVALID/)
  await assert.rejects(checkObserverProjects(request, { run: async () => ({ stdout: '{' }) }), /OBSERVER_CHECK_INVALID/)
  await assert.rejects(checkObserverProjects(request, { run: async () => { throw new Error('SEAT_PROCESS_FAILED') } }), /SEAT_PROCESS_FAILED/)
  await assert.rejects(checkObserverProjects(observerCheckRequests([])[0], { run }), /OBSERVER_CHECK_INVALID/)
  const abort = new AbortController(); abort.abort()
  await assert.rejects(checkObserverProjects(request, { run: () => assert.fail('already aborted'), signal: abort.signal }))
  const readCalls = []
  await readObserverTurns({ project: '/p' }, { seatCommands: true, signal, run: async (_c, _a, options) => {
    readCalls.push(options); return { stdout: JSON.stringify({ schema: 'throughline.observer_read.v2' }) }
  } })
  assert.equal(readCalls[0].signal, signal)
  assert.equal('env' in readCalls[0], false)
  assert.throws(() => validateObserverCheckResult(unchanged(request), request), /OBSERVER_CHECK_INVALID/)
})

test('local CLI input reaches EOF and early cancellation rejects after collection', { timeout: 5000 }, async () => {
  const output = await runObserverCommand(process.execPath, ['-e', `let text=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', x => text+=x); process.stdin.on('end', () => process.stdout.write(text))`], { input: 'fixture\n', maxBuffer: 1024 })
  assert.equal(output.stdout, 'fixture\n')
  const controller = new AbortController()
  const pending = runObserverCommand(process.execPath, ['-e', `setInterval(()=>{},1000)`], {
    signal: controller.signal, maxBuffer: 1024,
  })
  pending.catch(() => {})
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
})
