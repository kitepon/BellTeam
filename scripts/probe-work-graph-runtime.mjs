import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createWorkGraphParentChannel } from '../src/work-graph-ipc.mjs'
import { WORK_GRAPH_STATE_COMPATIBILITY } from '../src/work-graph-protocol.mjs'
import { waitNotificationsChildClose } from '../src/notifications-ipc.mjs'

if (process.argv.length !== 2 || process.getuid() !== 0 || Number(process.versions.node.split('.')[0]) !== 26)
  throw new Error('WORK_GRAPH_PROBE_ENVIRONMENT')
const generation = 'builtin:probe'
const child = spawn('/usr/local/libexec/bellteam-work-graph-start', ['builtin'], {
  uid: 1001, gid: 1001, env: {}, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'advanced',
})
const ended = waitNotificationsChildClose(child)
const channel = createWorkGraphParentChannel(child, { generation, onEffect: async () => { throw new Error('WORK_GRAPH_PROBE_EFFECT') } })
let finished = false, timer
try {
  await Promise.race([(async () => {
    await channel.control('initialize', { generation, mode: 'restore' }, 45000)
    const ready = await channel.ready
    assert.equal(ready.versionId, null)
    assert.equal(ready.protocolVersion, 1)
    assert.deepEqual(ready.stateCompatibility, WORK_GRAPH_STATE_COMPATIBILITY)
    await channel.control('resume')
    await channel.control('quiesce', {}, 60000)
    await channel.control('exit')
    assert.deepEqual(await ended, { code: 0, signal: null })
    finished = true
  })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('WORK_GRAPH_PROBE_TIMEOUT')), 65000) })])
} catch { process.exitCode = 1 }
finally {
  clearTimeout(timer)
  if (!finished) { child.kill('SIGKILL'); await ended }
  channel.reaped()
}
if (finished) process.stdout.write(JSON.stringify({ schema: 'bellteam.work-graph.runtime-probe.v1', ok: true,
  uid: 1001, protocolVersion: 1, stateCompatibility: WORK_GRAPH_STATE_COMPATIBILITY, childClosed: true }) + '\n')
else process.stderr.write('WORK_GRAPH_PROBE_FAILED\n')
