import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkResumeReceipt, resumeDigest } from '../src/resume-pipe.mjs'

const stub = fileURLToPath(new URL('./helpers/resume-state-contract-stub.mjs', import.meta.url))
const target = { session_id: 'offline', launch_id: 'a'.repeat(32) }
const run = (home, args, input) => spawnSync(process.execPath, [stub, ...args], { env: { HOME: home }, input })
const args = (op, launch = target.launch_id, ...more) => [op, '--session', 'offline', '--launch', launch, ...more]

test('stub honours the resume-state CLI contract that BellTeam parses', async t => {
  const home = await mkdtemp(join(tmpdir(), 'h1-stub-')); t.after(() => rm(home, { recursive: true, force: true }))
  const saved = run(home, args('checkpoint'))
  assert.equal(saved.status, 0)
  const sha = resumeDigest(saved.stdout)
  checkResumeReceipt(saved.stderr, 'checkpoint', target, sha)
  const first = run(home, args('restore', target.launch_id, '--sha256', sha), saved.stdout)
  assert.equal(first.status, 0); assert.equal(first.stderr.length, 0)
  assert.equal(checkResumeReceipt(first.stdout, 'restore', target, sha).outcome, 'restored')
  assert.equal((await stat(join(home, 'h1-restored-checkpoint'))).mode & 0o777, 0o600)
  assert.deepEqual(await readFile(join(home, 'h1-restored-checkpoint')), saved.stdout)
  const again = run(home, args('restore', target.launch_id, '--sha256', sha), saved.stdout)
  assert.equal(checkResumeReceipt(again.stdout, 'restore', target, sha).outcome, 'already_restored')
})

test('stub refuses with exit 2 and the one confirmation line', async t => {
  const home = await mkdtemp(join(tmpdir(), 'h1-stub-')); t.after(() => rm(home, { recursive: true, force: true }))
  const { stdout } = run(home, args('checkpoint'))
  for (const result of [run(home, args('restore', target.launch_id, '--sha256', '0'.repeat(64)), stdout),
    run(home, args('checkpoint', 'b'.repeat(32))), run(home, args('restore', 'b'.repeat(32), '--sha256', resumeDigest(stdout)), stdout)]) {
    assert.equal(result.status, 2); assert.equal(result.stdout.length, 0)
    assert.equal(result.stderr.toString(), 'aiterm: RESUME_STATE_UNCONFIRMED\n')
  }
  await assert.rejects(stat(join(home, 'h1-restored-checkpoint')), { code: 'ENOENT' })
})
