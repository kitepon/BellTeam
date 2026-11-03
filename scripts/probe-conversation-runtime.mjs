import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createConversationParentChannel, waitConversationChildClose } from '../src/conversation-ipc.mjs'
import { ConversationLifetimes } from '../src/conversation-lifetimes.mjs'
import { CONVERSATION_STATE_COMPATIBILITY } from '../src/conversation/state-compatibility.mjs'

if (process.argv.length !== 2 || process.getuid() !== 0 || Number(process.versions.node.split('.')[0]) !== 26)
  throw new Error('CONVERSATION_PROBE_ENVIRONMENT')
const fixture = JSON.parse(await readFile(new URL('../src/conversation/probe-fixture.json', import.meta.url), 'utf8'))
const child = spawn('/usr/local/libexec/bellteam-conversation-start', ['builtin'], {
  uid: 1001, gid: 1001, env: {}, serialization: 'advanced', stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
})
child.stdout.resume(); child.stderr.resume()
const ended = waitConversationChildClose(child), generation = 'conversation-probe', admission = new ConversationLifetimes(generation)
let forbiddenCalls = 0
const forbidden = () => { forbiddenCalls++; throw new Error('CONVERSATION_PROBE_EFFECT') }
const channel = createConversationParentChannel(child, { generation, admission, authorizeActor: forbidden, onEffect: forbidden, onEvent: forbidden, onDiagnostic: forbidden })
let finished = false, timer
try {
  await Promise.race([(async () => {
    await channel.control('initialize', { generation, mode: 'restore', bots: fixture.bots }, 45000)
    const ready = await channel.ready
    assert.equal(ready.versionId, null); assert.equal(ready.protocolVersion, 1)
    assert.deepEqual(ready.stateCompatibility, CONVERSATION_STATE_COMPATIBILITY)
    await channel.control('resume'); await channel.control('quiesce'); await channel.control('exit')
    assert.deepEqual(await ended, { code: 0, signal: null })
    assert.equal(forbiddenCalls, 0)
    await channel.drainIncoming(); finished = true
  })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('CONVERSATION_PROBE_TIMEOUT')), 65000) })])
} catch { process.exitCode = 1 }
finally {
  clearTimeout(timer)
  if (!finished) { child.kill('SIGKILL'); await ended; await channel.drainIncoming() }
  await channel.reaped()
}
if (finished) process.stdout.write(JSON.stringify({ schema: 'bellteam.conversation.runtime-probe.v1', ok: true, uid: 1001,
  protocolVersion: 1, stateCompatibility: CONVERSATION_STATE_COMPATIBILITY, childClosed: true, nativeAuth: false, externalEffects: 0 }) + '\n')
else process.stderr.write('CONVERSATION_PROBE_FAILED\n')
