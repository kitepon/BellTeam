import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { SeatRuntime } from '../src/seat-runtime.mjs'
import { createSeatStreamRunner } from '../src/seat-stream.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'

async function fixture(t, program) {
  let child, started, childClosed
  const readerStarted = new Promise(resolve => { started = resolve })
  const stream = createSeatStreamRunner('/synthetic', { spawnProcess(_command, _args, options) {
    child = spawn(process.execPath, ['--input-type=module', '-e', program], options)
    childClosed = once(child, 'close'); started(child); return child
  } })
  const seat = new SeatRuntime({ root: '/synthetic', home: '/synthetic', stream })
  const server = createBellTeamServer({ bots: new Map([['bot-fixture', { id: 'bot-fixture' }]]),
    rooms: new Map(), store: {}, transport: {}, authorize: async () => true, writeLog() {},
    characterSheets: seat.characterSheets(() => '/synthetic') })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    if (childClosed) await childClosed
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  })
  return { server, readerStarted, closed: () => childClosed,
    url: `http://127.0.0.1:${server.address().port}/api/bots/bot-fixture/character-sheet/four.png` }
}

test('HTTP disconnect before seat metadata cancels and reaps the pending reader', async t => {
  const f = await fixture(t, 'process.stdin.resume();setInterval(()=>{},1000)')
  const request = http.get(f.url); request.on('error', () => {})
  const child = await f.readerStarted
  request.destroy()
  await Promise.race([f.closed(), new Promise((_, reject) => {
    const timer = setTimeout(() => reject(Error('reader survived disconnected metadata request')), 1500); timer.unref()
  })])
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' })
})

for (const size of [0, 4]) test(`HTTP cannot finish ${size} bytes before the reader's delayed failure`, async t => {
  const f = await fixture(t, `process.stdin.resume();
    process.stdout.write(JSON.stringify({result:{mime:'image/png',size:${size}}})+'\\n');
    ${size ? "process.stdout.write('four');" : ''}setTimeout(()=>{process.exitCode=7},100)`)
  await assert.rejects(async () => { const response = await fetch(f.url); await response.arrayBuffer() })
  const child = await f.readerStarted; await f.closed(); assert.equal(child.exitCode, 7)
})

test('an empty sheet succeeds after the owned reader finishes successfully', async t => {
  const f = await fixture(t, `process.stdin.resume();
    process.stdout.write(JSON.stringify({result:{mime:'image/png',size:0}})+'\\n');setTimeout(()=>{},100)`)
  const response = await fetch(f.url)
  assert.equal(response.status, 200); assert.equal((await response.arrayBuffer()).byteLength, 0)
  const child = await f.readerStarted; await f.closed(); assert.equal(child.exitCode, 0)
})
