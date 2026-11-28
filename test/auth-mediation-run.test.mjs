import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuthCore } from '../src/auth-mediation/core.mjs'
import { createItemCache } from '../src/auth-mediation/items.mjs'
import { emptyPolicy } from '../src/auth-mediation/policy.mjs'
import { spawn } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { planRun, startRun, stopAllRuns, stopRuns, sweepStaleRuns } from '../src/auth-mediation/run.mjs'
import { validateAuthMediationRequest } from '../src/auth-mediation-protocol.mjs'

// The relay's side of a run: a socket the module child joins; frames come back as [tag, bytes].
async function relaySide(feed) {
  const dir = await mkdtemp(join(tmpdir(), 'run-')), path = join(dir, 'x.sock'), frames = []
  let buffer = Buffer.alloc(0), done
  const finished = new Promise(resolve => { done = resolve })
  const server = createServer({ allowHalfOpen: true }, socket => {
    socket.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); while (buffer.length >= 5 && buffer.length >= 5 + buffer.readUInt32BE(1)) { const n = buffer.readUInt32BE(1); frames.push([buffer[0], buffer.subarray(5, 5 + n)]); buffer = buffer.subarray(5 + n) } })
    socket.on('end', () => socket.end()); socket.on('close', done); feed?.(socket)
  })
  await new Promise(resolve => server.listen(path, resolve))
  return { path, dir, frames, finished, server, bytes: tag => Buffer.concat(frames.filter(f => f[0] === tag).map(f => f[1])) }
}
const FIELDS = { run_argv: JSON.stringify(['/bin/sh', '-c', 'cat']), run_max_seconds: '20' }
const go = async (fields, input, { feed } = {}) => {
  const side = await relaySide(socket => feed ? feed(socket) : (socket.end(input)))
  let end; const ended = new Promise(resolve => { end = resolve })
  await startRun(planRun(fields), { item: 'run t', stream: side.path, onEnd: end, root: join(side.dir, 'runs') })
  const summary = await ended; await side.finished; side.server.close()
  return { side, summary, exit: Number(side.bytes(3)) }
}

test('run: a binary stream goes in and comes back unchanged through the fixed command; the exit code and counts come last', async () => {
  const data = Buffer.alloc(5 * 1048576 + 7); for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 255
  const r = await go(FIELDS, data)
  assert.ok(r.side.bytes(1).equals(data)); assert.equal(r.exit, 0); assert.equal(r.summary.bytes_in, data.length); assert.equal(r.summary.bytes_out, data.length); assert.equal(r.summary.reason, 'exit')
})

test('run: secrets reach the command as env and as a 0600 file, and the first stdin bytes are the secret prefix; stderr never shows a secret', async () => {
  const fields = { run_argv: JSON.stringify(['/bin/sh', '-c', 'read first; printf "%s|%s|" "$first" "$TOKEN"; cat "$KEYFILE" | head -c 6; stat -c %a "$KEYFILE" >&2; echo "$TOKEN" >&2; cat']), run_env_TOKEN: 'tok-secret-12345', run_file_KEYFILE: 'file-secret-67890', run_stdin_prefix: 'prefix-secret-1' }
  const r = await go(fields, 'tail-bytes')
  assert.equal(r.side.bytes(1).toString(), 'prefix-secret-1|tok-secret-12345|file-stail-bytes') // a fixed command's stdout is its product
  assert.match(r.side.bytes(2).toString(), /^600\n\[redacted\]\n$/u); assert.equal(r.exit, 0)
})

test('run: an item with a secret in the command line is refused; a bad command or limits are refused', () => {
  assert.throws(() => planRun({ run_argv: JSON.stringify(['/bin/echo', 'tok-secret-12345']), run_env_TOKEN: 'tok-secret-12345' }), /command line/u)
  for (const run_argv of ['nope', '[]', '[1]', '[""]', JSON.stringify(['a\0b']), JSON.stringify(['has space/x']), undefined]) assert.throws(() => planRun({ run_argv }), /usable command/u)
  assert.throws(() => planRun({ ...FIELDS, run_max_seconds: '-1' }), /limits/u)
})

test('run: the command is the item\'s, a wrong exit code is the caller\'s exit code, input over the limit stops the run, stop kills it', async () => {
  assert.equal((await go({ run_argv: JSON.stringify(['/bin/sh', '-c', 'exit 3']) }, '')).exit, 3)
  const big = await go({ ...FIELDS, run_max_bytes_in: '1000' }, Buffer.alloc(100000, 1)); assert.equal(big.summary.reason, 'size')
  const slow = await go({ run_argv: JSON.stringify(['/bin/sh', '-c', 'sleep 30']), run_max_seconds: '0' }, '', { feed: socket => setTimeout(() => stopRuns('run t'), 200) }); assert.equal(slow.summary.reason, 'stopped'); assert.ok(slow.exit >= 124)
})

test('run: one run per item at a time unless the item says run_parallel', async () => {
  const first = relaySide(() => {}); const a = await first
  await startRun(planRun({ run_argv: JSON.stringify(['/bin/sh', '-c', 'sleep 5']), run_max_seconds: '0' }), { item: 'run one', stream: a.path, root: join(a.dir, 'runs') })
  const b = await relaySide(() => {})
  await assert.rejects(startRun(planRun(FIELDS), { item: 'run one', stream: b.path, root: join(b.dir, 'runs') }), /already in use/u)
  stopRuns('run one'); a.server.close(); b.server.close()
})

test('protocol: run takes exactly name, via, the relay\'s stream path and the caller identity', () => {
  const ok = { name: 'age-restore', via: 'host-socket', cwd: '/home/kite/x', stream: '/srv/bellteam/shared/tools/auth-mediation/runs/0f8fad5b-d9cb-469f-a165-70867728950e.sock' }
  const context = { generation: 'g1' }; validateAuthMediationRequest('run', ok, context)
  for (const bad of [{ ...ok, stream: '/tmp/x.sock' }, { ...ok, stream: undefined }, { ...ok, extra: 1 }, { ...ok, name: '../x' }]) assert.throws(() => validateAuthMediationRequest('run', bad, context))
})

test('run through the core: needs the grant "run <name>", reads the item, hands the plan and the relay\'s stream to the runner, audits start and end without any secret', async () => {
  const UNIT = '/home/kite/gretel', lines = [], calls = []
  const store = { policy: { ...emptyPolicy(), vault: 'v', units: { [UNIT]: { grants: [{ command: 'run age-restore' }] } } }, read: async () => structuredClone(store.policy) }
  const fields = { run_argv: JSON.stringify(['/bin/cat']), run_file_AGE: 'AGE-SECRET-KEY-1ABCDEF' }
  const items = createItemCache({ runOp: async () => JSON.stringify({ fields: Object.entries(fields).map(([label, value]) => ({ label, value })) }) })
  const core = createAuthCore({ store, items, audit: l => lines.push(l), roots: () => ({}), runner: async (plan, options) => { calls.push({ plan, options }); options.onEnd({ exit: 0, reason: 'exit', bytes_in: 5, bytes_out: 5, seconds: 1 }) } })
  const ask = (name, extra = {}) => core.run({ name, via: 'host-socket', cwd: UNIT, unit: UNIT, stream: '/s/runs/x.sock', ...extra })
  assert.deepEqual(await ask('age-restore'), { outcome: 'granted' }); assert.equal(calls[0].options.stream, '/s/runs/x.sock'); assert.equal(calls[0].plan.files.AGE, 'AGE-SECRET-KEY-1ABCDEF')
  assert.equal((await ask('other')).outcome, 'denied'); assert.equal(calls.length, 1)
  await new Promise(r => setImmediate(r)); assert.ok(!JSON.stringify(lines).includes('AGE-SECRET')); assert.deepEqual(lines.map(l => l.outcome), ['granted', 'run-ended', 'denied'].sort((a, b) => lines.findIndex(l => l.outcome === a) - lines.findIndex(l => l.outcome === b)))
  assert.equal(lines.find(l => l.outcome === 'run-ended').bytes_in, 5)
})

const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const until = async (check, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await check()) return true; await new Promise(r => setTimeout(r, 50)) } return false }

test('run: the child\'s own end stops every run and removes its folder', async () => {
  const side = await relaySide(() => {}), root = join(side.dir, 'runs')
  await startRun(planRun({ run_argv: JSON.stringify(['/bin/sh', '-c', 'sleep 120']), run_env_SECRETX: 'secret-value-xyz', run_max_seconds: '0' }), { item: 'run end', stream: side.path, root })
  assert.equal((await readdir(root)).length, 1)
  await stopAllRuns(); assert.deepEqual(await readdir(root), []); side.server.close()
})

test('run: a child killed hard leaves its command and secret file behind; the next child sweeps both at start', async () => {
  const side = await relaySide(() => {}), root = join(side.dir, 'runs')
  const script = `import { planRun, startRun } from ${JSON.stringify(new URL('../src/auth-mediation/run.mjs', import.meta.url).href)}
    await startRun(planRun({ run_argv: JSON.stringify(['/bin/sh', '-c', 'sleep 120']), run_env_SECRETX: 'secret-value-xyz', run_max_seconds: '0' }), { item: 'run x', stream: process.argv[1], root: process.argv[2] }); console.log('up'); setInterval(() => {}, 1000)`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, side.path, root]); await new Promise(resolve => child.stdout.once('data', resolve))
  const [folder] = await readdir(root), pids = JSON.parse(await readFile(join(root, folder, 'pids.json'), 'utf8')), command = pids.procs.find(p => p.group).pid
  child.kill('SIGKILL'); await until(() => child.exitCode !== null || child.signalCode !== null)
  assert.ok(alive(command)) // the orphan the hard kill leaves
  assert.equal(await sweepStaleRuns(root), 1)
  assert.ok(await until(() => !alive(command))); assert.deepEqual(await readdir(root), []); side.server.close()
})

test('run: run_state_dir / run_socket_dir give the process persistent and host-reachable folders named after the item, never after the caller', async () => {
  const side = await relaySide(() => {}), root = join(side.dir, 'runs'), stateRoot = join(side.dir, 'state'), socketRoot = join(side.dir, 'socks')
  const plan = planRun({ run_argv: JSON.stringify(['/bin/sh', '-c', 'echo $STATE_DIR $SOCKET_DIR > "$STATE_DIR/seen.txt"; sleep 1']), run_state_dir: '1', run_socket_dir: '1', run_max_seconds: '20' })
  await startRun(plan, { item: 'run mabimoba-bot', stream: side.path, root, stateRoot, socketRoot })
  await until(async () => (await import('node:fs')).existsSync(join(stateRoot, 'mabimoba-bot', 'seen.txt')))
  assert.equal((await readFile(join(stateRoot, 'mabimoba-bot', 'seen.txt'), 'utf8')).trim(), join(stateRoot, 'mabimoba-bot') + ' ' + join(socketRoot, 'mabimoba-bot'))
  const { stat } = await import('node:fs/promises'); assert.equal((await stat(join(stateRoot, 'mabimoba-bot'))).mode & 0o777, 0o700); assert.equal((await stat(join(socketRoot, 'mabimoba-bot'))).mode & 0o777, 0o755)
  stopRuns('run mabimoba-bot'); side.server.close()
  assert.throws(() => planRun({ run_argv: JSON.stringify(['/bin/true']), run_state_dir: 'yes' }), /folders/u)
  await assert.rejects(startRun(planRun({ run_argv: JSON.stringify(['/bin/true']), run_state_dir: '1' }), { item: 'run ../x', stream: '/nope', root, stateRoot, socketRoot }), /folders/u)
})
