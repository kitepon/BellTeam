import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createUsageNativeFixture } from './helpers/usage-native-business.mjs'

test('native business fixture uses staged real wrapper and default reader refusal without fabricated signed exchange', { timeout: 10000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-usage-native-business-')), children = []
  await mkdir(join(root, 'state'))
  const fixture = createUsageNativeFixture({ root, spawnProcess: (entry, args, options) => {
    assert.equal(entry, '/usr/local/libexec/bellteam-usage-start'); assert.equal(options.serialization, 'advanced')
    assert.deepEqual(options.env, {})
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/usage-runtime-child.mjs', import.meta.url)), root, args[0]], options)
    children.push(child); return child
  } })
  t.after(async () => {
    await fixture.close().catch(() => {})
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
  })
  const started = await fixture.start()
  assert.equal(started.started, true); assert.equal(started.authStarts, 1)
  assert.equal(started.secretCompletions, 1); assert.equal(started.notificationOnce, true)
  assert.equal(started.latestEpoch, 1); assert.equal(started.settingsKept, true)
  await assert.rejects(fixture.verify(), /USAGE_FIXTURE_EXCHANGE_INCOMPLETE/)
  await assert.rejects(fixture.replace('builtin'), { code: 'USAGE_FIXTURE_TARGET_UNCHANGED' })
  const pid = children[0].pid
  await assert.rejects(fixture.replace('9'.repeat(64)), error => ['ENOENT', 'EACCES'].includes(error.code) || /^GATEWAY_RELEASE_/.test(error.code))
  assert.equal(children.length, 1); assert.equal(children[0].pid, pid); assert.equal(children[0].exitCode, null)
  assert.equal(fixture.controller.snapshot().available, true)
  const result = fixture.snapshot()
  assert.equal(result.exchanges, 0); assert.equal(result.failedExchanges, 1)
  assert.equal(result.errorCallbacks, 1); assert.equal(result.secretCompletions, 1); assert.equal(result.authStarts, 1)
  assert.equal(result.latestEpoch, 2)
  const saved = JSON.parse(await readFile(join(root, 'shared/tools/bellteam-settings/settings.json'), 'utf8'))
  assert.equal(saved.routing.apiKey, 'synthetic-usage-native-key'); assert.equal(saved.routing.enabled, false)
  assert.doesNotMatch(JSON.stringify(result), /synthetic-usage-native-(key|secret|session)|\/tmp\/|secret-values|capturedAuthorization|usageLease/)
  assert.equal(result.nativeAuth, false); assert.equal(result.externalEffects, 0)
  await mkdir(join(root, 'shared/tools/bellteam-settings/settings.json.tmp'))
  await assert.rejects(fixture.replace('8'.repeat(64)), { code: 'USAGE_OPERATION_FAILED', status: 500 })
  assert.equal(fixture.snapshot().failedExchanges, 2)
  assert.equal(fixture.snapshot().settingsEffects, 2)
  assert.equal(fixture.controller.snapshot().available, true)
  await fixture.close()
  assert.equal(fixture.snapshot().closed, true)
  assert.equal(children[0].exitCode, 0); assert.equal(children[0].connected, false)
  assert.equal(children[0].stdout.closed, true); assert.equal(children[0].stderr.closed, true)
})
