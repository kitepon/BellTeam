import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'
import { createModuleStreams } from '../src/module-streams.mjs'

// A burst of frames arrives in one read; the first is invalid, so the failure path closes the streams and the channel
// while Node still has queued frames for that read. With no 'message' listener left, Node 26 died with an uncaught TypeError.
test('closing the streams on the first bad frame of a burst never kills the parent process', async () => {
  const child = fork(new URL('./helpers/ipc-burst-child.mjs', import.meta.url), { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  let failure = null
  const streams = createModuleStreams(child, { onStream: () => {}, onFailure: error => { failure = error; streams.close(); child.disconnect() } })
  await once(child, 'exit')
  assert.ok(failure, 'the invalid first frame reached onFailure')
})
