import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createSeatStreamRunner } from '../src/seat-stream.mjs'

function reader(program) {
  let child
  const run = createSeatStreamRunner('/synthetic', { spawnProcess(command, args, options) {
    assert.equal(command, 'sudo')
    assert.deepEqual(options.env, { PATH: '/usr/local/bin:/usr/bin:/bin' })
    child = spawn(process.execPath, ['--input-type=module', '-e', program], options)
    return child
  } })
  return { open: () => run('synthetic-reader', [], {}), child: () => child }
}

test('seat stream retains binary content beyond the former image buffer limit', async () => {
  const size = 26 * 1024 * 1024 + 17
  const f = reader(`import {once} from 'node:events';process.stdin.resume();
    process.stdout.write(JSON.stringify({result:{mime:'image/png',size:${size}}})+'\\n');
    let remaining=${size};while(remaining){const n=Math.min(65536,remaining);remaining-=n;
      if(!process.stdout.write(Buffer.alloc(n,173)))await once(process.stdout,'drain');}`)
  const { mime, size: returnedSize, stream } = await f.open()
  assert.equal(mime, 'image/png'); assert.equal(returnedSize, size)
  let bytes = 0, chunks = 0
  for await (const chunk of stream) {
    assert.equal(chunk.findIndex(byte => byte !== 173), -1)
    bytes += chunk.length; chunks++
  }
  assert.equal(bytes, size); assert.ok(chunks > 1)
})

test('seat file errors are returned before HTTP receives binary metadata', async () => {
  const f = reader(`process.stdin.resume();process.stdout.write(JSON.stringify({error:{message:'CHARACTER_SHEET_NOT_FOUND'}})+'\\n');process.exitCode=1`)
  await assert.rejects(f.open(), /CHARACTER_SHEET_NOT_FOUND/)
})

test('a body reader failure after metadata remains a stream error', async () => {
  const f = reader(`process.stdin.resume();process.stdout.write(JSON.stringify({result:{mime:'image/png',size:4}})+'\\n');process.stdout.write('four');process.exitCode=7`)
  const { stream } = await f.open()
  await assert.rejects(async () => { for await (const _chunk of stream) {} }, { code: 'SEAT_STREAM_PROCESS_FAILED' })
})

test('closing a partially consumed stream terminates its owned reader', async () => {
  const f = reader(`process.stdin.resume();process.stdout.write(JSON.stringify({result:{mime:'image/png',size:99999999}})+'\\n');setInterval(()=>process.stdout.write(Buffer.alloc(1024)),10)`)
  const { stream } = await f.open(), child = f.child()
  const closed = once(child, 'close')
  await once(stream, 'data'); stream.destroy()
  const [code, signal] = await closed
  assert.equal(code, null); assert.equal(signal, 'SIGTERM')
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' })
})

test('truncated bodies and malformed metadata fail without yielding a successful sheet', async () => {
  for (const header of [{ result: { mime: 'image/png', size: 4 } }, { result: { mime: 'text/html', size: 0 } }]) {
    const f = reader(`process.stdin.resume();process.stdout.write(${JSON.stringify(JSON.stringify(header) + '\n')})`)
    if (header.result.mime !== 'image/png') await assert.rejects(f.open(), { code: 'SEAT_STREAM_METADATA_INVALID' })
    else {
      const { stream } = await f.open()
      await assert.rejects(async () => { for await (const _chunk of stream) {} }, { code: 'SEAT_STREAM_SIZE_CHANGED' })
    }
  }
})
