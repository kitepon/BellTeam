import assert from 'node:assert/strict'
import test from 'node:test'
import { fork } from 'node:child_process'
import { once } from 'node:events'

async function observe(mode) {
  const child = fork(new URL('./fixtures/conversation-exit-origin-child.mjs', import.meta.url), [mode],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let stderr = '', stdout = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdout.on('data', chunk => { stdout += chunk })
  const exited = once(child, 'exit'), stderrEnded = once(child.stderr, 'end'), stdoutEnded = once(child.stdout, 'end')
  await once(child, 'message')
  if (mode === 'parent_disconnect') child.disconnect()
  const [code, signal] = await exited
  await Promise.all([stderrEnded, stdoutEnded])
  assert.equal(code, 0); assert.equal(signal, null); assert.equal(stdout, '')
  return stderr.trim() ? stderr.trim().split('\n').map(line => JSON.parse(line)) : []
}

test('real child IPC preserves the first closed exit origin and leaves no private text', { timeout: 10000 }, async () => {
  const cases = [['exit', 'exit_control'], ['exitWriter', 'exit_writer_control'],
    ['parent_disconnect', 'parent_disconnect'], ['PRIVATE_UNKNOWN', 'peer_failure']]
  for (const [mode, origin] of cases) {
    assert.deepEqual(await observe(mode), [{ code: 'CONVERSATION_CHILD_EXIT_ORIGIN', origin, failureCode: null }])
  }
  for (const suffix of ['IPC_INVALID', 'IPC_DISCONNECTED', 'IPC_TIMEOUT', 'IPC_ACK_TIMEOUT', 'IPC_SEND_FAILED',
    'CHILD_EXITED', 'BACKGROUND_UNCONFIRMED', 'DELIVERY_RELEASE_UNCONFIRMED', 'PROTOCOL_UNCONFIRMED']) {
    const code = `CONVERSATION_${suffix}`
    assert.deepEqual(await observe(code), [{ code: 'CONVERSATION_CHILD_EXIT_ORIGIN', origin: 'peer_failure', failureCode: code }])
  }
  assert.deepEqual(await observe('parent'), [])
  assert.deepEqual(await observe('sink_failure'), [])
})
