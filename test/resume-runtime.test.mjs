import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { seatCommandSpec } from '../src/seat-command.mjs'
import { runResumePipe, resumeDigest, RESUME_BUNDLE_BYTES } from '../src/resume-pipe.mjs'
import { saveResumeCheckpoint, publishResumeFile, readResumeFile } from '../src/resume-storage.mjs'
import { adoptResumeGeneration } from '../src/resume-boot.mjs'
import { loadBotEnvironment } from '../src/bot-environment.mjs'
import { writeHarnessConfig } from '../src/harness-config.mjs'
import { RESUME_STATE_BASE } from '../src/resume-policy.mjs'
import { adoptRuntimeResume } from '../src/runtime-resume.mjs'
import { stateWriterPlan, stateWriterSources, assertStateWritersStopped } from '../src/server-state-writers.mjs'

const target = { session_id: 'synthetic', launch_id: 'a'.repeat(32) }
const receipt = (operation, bundle, outcome = operation === 'checkpoint' ? 'saved' : 'restored') => ({
  schema: 'aiterm.resume-state-result.v1', operation, ...target, checkpoint_sha256: resumeDigest(bundle), outcome,
})
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-h1-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
const node = code => ({ command: process.execPath, args: ['--input-type=module', '-e', code], env: { PATH: '/usr/bin:/bin' } })

test('H1 keeps the full 16MiB wire bundle separate from its receipt and rejects either overflow', async () => {
  for (const [size, extra, succeeds] of [[RESUME_BUNDLE_BYTES, '', true], [RESUME_BUNDLE_BYTES + 1, '', false], [5, 'x'.repeat(513), false]]) {
    const spec = node(`import {createHash} from 'node:crypto';const b=Buffer.alloc(${size},97);b[b.length-1]=10;
      const r=${JSON.stringify(receipt('checkpoint', Buffer.from('a\n')))};
      r.checkpoint_sha256=createHash('sha256').update(b).digest('hex');
      process.stdout.write(b);process.stderr.write(${JSON.stringify(extra)}||JSON.stringify(r)+'\\n');`)
    if (succeeds) assert.equal((await runResumePipe(spec, 'checkpoint', target)).bundle.length, RESUME_BUNDLE_BYTES)
    else await assert.rejects(runResumePipe(spec, 'checkpoint', target), { code: 'RESUME_STREAM_EXCEEDED' })
  }
})

test('H1 rejects failed/partial or wrong receipts without returning private bytes', async () => {
  const secret = 'synthetic-private-byte'
  for (const code of [`process.stdout.write(${JSON.stringify(secret)});process.exitCode=2`,
    `process.stdout.write('x\\n');process.stderr.write('{}\\n')`,
    `process.stdout.write('x');process.stderr.write('{}\\n')`]) {
    await assert.rejects(runResumePipe(node(code), 'checkpoint', target), error => {
      assert.doesNotMatch(error.message, /synthetic-private-byte/);return true
    })
  }
})

test('H1 cancellation waits for close and never returns a partial bundle', async () => {
  const controller = new AbortController()
  const run = runResumePipe(node("process.stdout.write('partial');setInterval(()=>{},1000)"), 'checkpoint', target, { signal: controller.signal })
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(run, { code: 'ABORT_ERR' })
})

async function stored(t) {
  const root = await fixture(t), bundle = Buffer.from('{"private":"synthetic"}\n')
  const item = await saveResumeCheckpoint(root, 'generation', target, { bundle, receipt: receipt('checkpoint', bundle) })
  const plan = { schema: 'bellteam.resume-generation.v1', generation: 'generation', source_container: 'c'.repeat(64),
    source_image: 'sha256:' + 'd'.repeat(64), state_volume: 'new-generation', targets: [item] }
  await publishResumeFile(join(root, 'generation'), 'generation.json', Buffer.from(JSON.stringify(plan) + '\n'))
  return { root, bundle, item, plan }
}

test('private checkpoint publication preserves exact bytes, mode and rejects another digest/symlink', async t => {
  const x = await stored(t), path = join(x.root, 'generation', x.item.file)
  assert.deepEqual(await readResumeFile(path), x.bundle)
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  assert.equal((await stat(join(x.root, 'generation'))).mode & 0o777, 0o700)
  const other = Buffer.from('changed\n')
  await assert.rejects(saveResumeCheckpoint(x.root, 'generation', target, { bundle: other, receipt: receipt('checkpoint', other) }))
  const link = join(x.root, 'link');await symlink(path, link)
  await assert.rejects(readResumeFile(link))
})

test('a crash-left hardlink in runtime storage fails closed without truncating published bytes', async t => {
  const x = await stored(t), path = join(x.root, 'generation', x.item.file)
  await link(path, join(x.root, 'generation', 'crash-left.pending'))
  await assert.rejects(readResumeFile(path), { code: 'RESUME_STORAGE_INVALID' })
  const other = Buffer.from('another private bundle\n')
  await assert.rejects(saveResumeCheckpoint(x.root, 'generation', target, { bundle: other, receipt: receipt('checkpoint', other) }))
  assert.deepEqual(await readFile(path), x.bundle)
})

test('direct seat execution cannot bypass the server startup identity boundary', { skip: process.getuid() === 1001 }, async () => {
  const previous = process.env.BELLTEAM_RESUME_GENERATION
  process.env.BELLTEAM_RESUME_GENERATION = '.bellteam-compose.synthetic'
  try { await assert.rejects(adoptRuntimeResume(), /RESUME_STARTUP_ADMISSION/) }
  finally {
    if (previous === undefined) delete process.env.BELLTEAM_RESUME_GENERATION
    else process.env.BELLTEAM_RESUME_GENERATION = previous
  }
})

test('startup adoption restores before bootstrap and does not replay after normal state changes', async t => {
  const x = await stored(t), calls = []
  const restore = async (received, bytes) => { calls.push('restore');assert.deepEqual(bytes, x.bundle);return { receipt: receipt('restore', bytes) } }
  await adoptResumeGeneration(x.root, 'generation', 'new-generation', restore);calls.push('bootstrap')
  await writeFile(join(x.root, 'generation', x.item.file), 'changed by ordinary runtime\n', { mode: 0o600 })
  await adoptResumeGeneration(x.root, 'generation', 'new-generation', restore)
  assert.deepEqual(calls, ['restore', 'bootstrap'])
})

test('failed adoption prevents automatic replay; explicit same-generation retry can finish', async t => {
  const x = await stored(t);let calls = 0
  const failed = async () => { calls++;throw Error('synthetic restore failure') }
  await assert.rejects(adoptResumeGeneration(x.root, 'generation', 'new-generation', failed))
  await assert.rejects(adoptResumeGeneration(x.root, 'generation', 'new-generation', failed), { code: 'RESUME_ADOPTION_PENDING' })
  assert.equal(calls, 1)
  await adoptResumeGeneration(x.root, 'generation', 'new-generation', async (_, bytes) => ({ receipt: receipt('restore', bytes, 'already_restored') }), { retry: true })
  await assert.rejects(adoptResumeGeneration(x.root, 'generation', 'wrong-volume', failed), { code: 'RESUME_GENERATION_INVALID' })
})

test('the fixed H1 base survives configured loading only when the Bot keeps that base', async t => {
  const root = await fixture(t);await mkdir(join(root, 'environment'))
  const inherited = { PATH: '/usr/bin:/bin', BELLTEAM_HOME: root, AITERM_STATE_BASE: RESUME_STATE_BASE }
  for (const script of ['export AITERM_STATE_BASE=/synthetic-other', 'unset AITERM_STATE_BASE']) {
    await writeFile(join(root, 'environment/env.sh'), script)
    await assert.rejects(loadBotEnvironment(root, inherited), { code: 'RESUME_STATE_BASE_CONFLICT' })
  }
  await writeFile(join(root, 'environment/env.sh'), 'export CUSTOM=retained')
  const env = await loadBotEnvironment(root, inherited)
  assert.equal(env.AITERM_STATE_BASE, RESUME_STATE_BASE);assert.equal(env.CUSTOM, 'retained')
})

test('fixed-base intent crosses the clearenv argument boundary and is checked after configured loading', async t => {
  const root = await fixture(t), previous = process.env.AITERM_STATE_BASE
  process.env.AITERM_STATE_BASE = RESUME_STATE_BASE
  try {
    const spec = seatCommandSpec('synthetic', [], { project: root, environment: 'base' })
    assert.ok(spec.args.includes('--resume-state-base'))
    assert.deepEqual(spec.env, { PATH: '/usr/local/bin:/usr/bin:/bin' })
  } finally {
    if (previous === undefined) delete process.env.AITERM_STATE_BASE
    else process.env.AITERM_STATE_BASE = previous
  }
  // Run only the post-UID wrapper with a synthetic cleared environment, never sudo/C.
  const wrapper = fileURLToPath(new URL('../src/run-seat-command.mjs', import.meta.url))
  const env = { PATH: '/usr/bin:/bin', HOME: root }
  const output = 'console.log(JSON.stringify({base:process.env.AITERM_STATE_BASE,server:process.env.SYNTHETIC_SERVER_SECRET}))'
  const run = mode => promisify(execFile)(process.execPath, [wrapper, root, ...mode, '--resume-state-base', '--', process.execPath, '-e', output], { env })
  assert.deepEqual(JSON.parse((await run(['--base-environment'])).stdout), { base: RESUME_STATE_BASE })
  await mkdir(join(root, 'environment'));await writeFile(join(root, 'environment/env.sh'), 'export AITERM_STATE_BASE=/other')
  await assert.rejects(run([]), error => error.stderr === 'BELLTEAM_SEAT_COMMAND_FAILED\n')
})

test('all managed MCP registrations retain the fixed H1 base with and without the lazy relay', async t => {
  const root = await fixture(t)
  for (const relay of [null, '/synthetic/relay']) {
    const home = join(root, relay ? 'relay' : 'direct')
    await writeHarnessConfig(new Map(), home, { environment: { AITERM_STATE_BASE: RESUME_STATE_BASE },
      aiterm: async () => ({ command: '/synthetic/node', args: ['/synthetic/index.js'] }), relay: async () => relay })
    for (const file of ['.claude.json', '.cursor/mcp.json', '.gemini/config/mcp_config.json'])
      assert.equal(JSON.parse(await readFile(join(home, file))).mcpServers.aiterm.env.AITERM_STATE_BASE, RESUME_STATE_BASE)
    for (const file of ['.codex/config.toml', '.grok/config.toml'])
      assert.match(await readFile(join(home, file), 'utf8'), /AITERM_STATE_BASE = "\/srv\/bellteam-aiterm"/)
  }
})

test('writer plans retain empty/removed generations and block restart-capable/aliased writers', () => {
  const config = { services: { bellteam: { environment: { AITERM_STATE_BASE: RESUME_STATE_BASE }, volumes: [
    { type: 'bind', source: '/runtime/data', target: '/srv/bellteam' }, { type: 'bind', source: '/runtime/home', target: '/home/bell' },
    { type: 'volume', source: 'cursor', target: '/home/bell/.local' },
    { type: 'volume', source: 'resume', target: RESUME_STATE_BASE, volume: { nocopy: true } },
  ] } }, volumes: { cursor: { name: 'cursor' }, resume: { name: 'new-generation', external: true } } }
  const plan = stateWriterPlan(config);plan.resumeVolumes.push('old-generation')
  const volumes = ['new-generation', 'old-generation'].map(name => ({ name, driver: 'local', mountpoint: '/volumes/' + name,
    optionCount: 0, type: null, device: null, options: null }))
  const writer = { id: 'other', running: false, restarting: false, restartPolicy: 'unless-stopped',
    mounts: [{ Type: 'bind', Source: '/alias', RW: true }] }
  const aliases = stateWriterSources(plan, [writer], volumes).map(source => ({ source, canonical: source === '/alias' ? '/volumes/old-generation' : source }))
  assert.throws(() => assertStateWritersStopped(plan, [writer], aliases, volumes), /WRITERS_RUNNING/)
  writer.restartPolicy = 'no'
  assert.deepEqual(assertStateWritersStopped(plan, [writer], aliases, volumes), { writers: 0 })
  assert.throws(() => stateWriterSources(plan, [], []), /METADATA_INVALID/)
  const sameBacking = volumes.map(v => ({ ...v, mountpoint: '/volumes/same' }))
  const sameAliases = stateWriterSources(plan, [], sameBacking).map(source => ({ source, canonical: source }))
  assert.throws(() => assertStateWritersStopped(plan, [], sameAliases, sameBacking), /METADATA_INVALID/)
})
