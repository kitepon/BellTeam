// Container-only fixture, substituted for supervisor.mjs in this test image.
import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { SeatRuntime } from '../../src/seat-runtime.mjs'
import { createSeatStreamRunner } from '../../src/seat-stream.mjs'
import { createBellTeamServer } from '../../src/http-server.mjs'

assert.equal(process.getuid(), 1001); assert.equal(process.getgid(), 1001)
assert.equal(process.env.HOME, '/run/bellteam-server')
assert.equal(process.env.BELLTEAM_HOME, '/home/bell')
assert.equal(process.env.PATH, '/usr/local/bin:/usr/bin:/bin')
assert.equal(process.env.NODE_OPTIONS, undefined); assert.equal(process.env.NODE_PATH, undefined)
assert.equal(process.env.BELLTEAM_SYNTHETIC_SERVER_SECRET, 'fixture-only')
const root = '/srv/bellteam', project = root + '/bots/bot-private'
const privateFile = project + '/assets/character-sheet/large.png'
await assert.rejects(readFile(privateFile), { code: 'EACCES' })
const readers = []
const seat = new SeatRuntime({ root, home: '/home/bell', stream: createSeatStreamRunner(root, {
  spawnProcess(...args) {
    const child = spawn(...args)
    readers.push({ pid: child.pid, closed: once(child, 'close') })
    return child
  },
}) })
const sheets = seat.characterSheets(() => project)
const listed = await sheets.list('bot-private')
assert.deepEqual(listed.map(row => row.file), ['large.png'])
assert.equal(listed[0].size, 26 * 1024 * 1024 + 17)
await assert.rejects(sheets.open('bot-private', '../private'), /CHARACTER_SHEET_INVALID/)
await assert.rejects(sheets.open('bot-private', 'missing.png'), /CHARACTER_SHEET_NOT_FOUND/)
await assert.rejects(sheets.open('bot-private', 'link.png'), { code: 'ELOOP' })

const bots = new Map([['bot-private', { id: 'bot-private' }]])
const server = createBellTeamServer({ bots, rooms: new Map(), store: {}, transport: {}, characterSheets: sheets,
  authorize: async req => req.headers.authorization === 'synthetic-owner', writeLog() {} })
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const url = `http://127.0.0.1:${server.address().port}/api/bots/bot-private/character-sheet/large.png`
const headers = { authorization: 'synthetic-owner' }
let bytes = 0
try {
  const response = await fetch(url, { headers })
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png')
  assert.equal(Number(response.headers.get('content-length')), listed[0].size)
  for await (const chunk of response.body) { assert.equal(chunk.findIndex(byte => byte !== 0), -1); bytes += chunk.length }
  assert.equal(bytes, listed[0].size)
  const aborted = await fetch(url, { headers }), reader = aborted.body.getReader()
  await reader.read(); await reader.cancel()
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
}
await Promise.race([Promise.all(readers.map(item => item.closed)), new Promise((_, reject) => {
  const timer = setTimeout(() => reject(Error('owned seat reader did not close')), 3000); timer.unref()
})])
for (const child of readers) assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' })
await assert.rejects(access(project + '/preload-ran'), { code: 'EACCES' })
console.log(JSON.stringify({ passed: true, parentUid: process.getuid(), privateServerReadRejected: true,
  streamedBytes: bytes, exceeds25MiB: bytes > 25 * 1024 * 1024, httpDisconnectReadersClosed: true,
  ownedReaderPidsGone: true, invalidMissingSymlinkRejected: true, fixedServerEntryUsed: true,
  nodePreloadRemoved: true, serverCanaryStayedInServer: true, actualSupervisorBooted: false }))
