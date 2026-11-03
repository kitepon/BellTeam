import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

for (const component of ['diagnostics', 'memory']) {
  test(`${component} fixture phases survive the running controller snapshot`, async () => {
    const source = await readFile(new URL(`./helpers/${component}-runtime-guest.mjs`, import.meta.url), 'utf8')
    const body = source.match(/  const publish = async phase => \{[\s\S]*?\n  \}/)?.[0]
    assert.ok(body)
    const snapshot = Object.freeze({ phase: 'running', available: true, generation: 'fixed', currentVersionId: null })
    const writes = [], renames = []
    let fail = false
    const context = { assert, invariant: async () => { if (fail) throw new Error('invariant') },
      controller: { snapshot: () => snapshot }, statusPath: '/fixture/status',
      write: async (path, value) => writes.push({ path, value }), rename: async (...args) => renames.push(args),
      checks: [], events: [], parent: {}, parentIdentity: {}, businessIdentity: {}, gatewayIdentity: {},
      port: 1234, currentDataPreserved: false, readonlyRestoreVerified: false, codeViewVerified: false }
    const publish = vm.runInNewContext(`${body}; publish`, context)
    for (const phase of ['ready', 'b-active', 'done']) {
      await publish(phase)
      assert.equal(writes.at(-1).value.phase, phase)
      assert.equal(writes.at(-1).value.runtimePhase, 'running')
      assert.equal(writes.at(-1).value.generation, 'fixed')
      assert.equal(writes.at(-1).path, '/fixture/status.tmp')
      assert.deepEqual(renames.at(-1), ['/fixture/status.tmp', '/fixture/status'])
    }
    fail = true
    await assert.rejects(publish('ready'), /invariant/)
    assert.equal(writes.length, 3); assert.equal(renames.length, 3)
    assert.equal(snapshot.phase, 'running')
  })
}
