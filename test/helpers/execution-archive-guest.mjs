import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function probeExecutionArchive(payload, data, uid) {
  assert.equal(process.getuid(), uid)
  assert.equal(process.getgid(), uid)
  assert.equal(process.versions.node.split('.')[0], '26')
  const from = name => import(pathToFileURL(join(payload, 'src', name)).href)
  const { createExecutionDispatcher, EXECUTION_STATE_COMPATIBILITY } = await from('execution-dispatcher.mjs')
  const { MembersAdmission } = await from('members-admission.mjs')
  const { taskSettingsReminder } = await from('global-instructions.mjs')
  const rules = await readFile(join(payload, 'config/common-agents.md'), 'utf8')
  const expected = rules.match(/(?:^|\n)(SECTION models\n[\s\S]*?)(?=\n\n|$)/)?.[1]
  assert.ok(expected); assert.equal(await taskSettingsReminder(), expected)
  assert.equal(EXECUTION_STATE_COMPATIBILITY, 'bellteam.execution-state.v1')
  const bot = { id: 'bot-synthetic', session: 'synthetic-session', harness: 'codex' }
  let nativeCloses = 0, reads = 0
  const ports = { bots: new Map(), rooms: {}, membersAdmission: new MembersAdmission(),
    configurationStorage: { root: join(data, 'intents'), ownerUid: uid },
    access: { assertWorkAllowed() {} }, observer: { report() {} },
    native: { async call(name) { assert.equal(name, 'pty_list'); reads++; return { content: [{ type: 'text', text: '' }] } },
      async close() { nativeCloses++ } } }
  let handoff = null
  for (const generation of ['unsigned-original', 'unsigned-restored']) {
    const engine = createExecutionDispatcher({ generation, ports, handoff })
    try {
      await engine.control('initialize')
      const captured = engine.project
      assert.equal(captured({ method: 'transport.session', args: [bot] }), bot.session)
      await engine.control('quiesce', { timeoutMs: 1000 })
      handoff = engine.exportState()
      assert.equal(handoff.stateCompatibility, EXECUTION_STATE_COMPATIBILITY)
      assert.deepEqual(await engine.disconnect(), { closed: true })
      assert.throws(() => captured({ method: 'transport.session', args: [bot] }))
    } finally {
      try { await engine.control('quiesce', { timeoutMs: 1000 }) } catch {}
      try { await engine.disconnect() } catch {}
    }
  }
  assert.equal(nativeCloses, 0)
  assert.deepEqual(await readdir(data), [])
  return { schema: 'bellteam.execution.archive-probe.v1', uid, stateCompatibility: EXECUTION_STATE_COMPATIBILITY,
    generations: 2, assetRead: true, dataUnchanged: true, nativeCloses, syntheticNativeReads: reads, realNative: false }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 4)
  console.log(JSON.stringify(await probeExecutionArchive(process.argv[2], process.argv[3], 1001)))
}
