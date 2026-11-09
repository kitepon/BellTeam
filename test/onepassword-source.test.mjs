import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { createOnePasswordSource, validateOnePasswordReference } from '../src/usage/onepassword-source.mjs'

const vault = 'a'.repeat(26)
const item = 'b'.repeat(26)
const reference = `op://${vault}/${item}/section/private%20key%26name?attribute=otp`

test('missing optional op on PATH does not reject startup', () => {
  const sourceUrl = new URL('../src/usage/onepassword-source.mjs', import.meta.url).href
  const script = `
    import assert from 'node:assert/strict'
    import { createRequire, syncBuiltinESMExports } from 'node:module'
    const require = createRequire(import.meta.url)
    const fsPromises = require('node:fs/promises')
    const originalAccess = fsPromises.access
    fsPromises.access = async function (path, ...args) {
      if (String(path) === '/srv/bellteam/shared/tools/onepassword/bin/op') {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return originalAccess.call(this, path, ...args)
    }
    syncBuiltinESMExports()
    const { createOnePasswordSource } = await import(${JSON.stringify(sourceUrl)})
    let executeCalls = 0
    const source = createOnePasswordSource({
      environment: { PATH: '/nonexistent' },
      execute: async () => { executeCalls++; throw new Error('must not execute') },
    })
    assert.equal(await source.refresh(), false)
    assert.equal(executeCalls, 0)
    source.close()
    await new Promise(resolve => setImmediate(resolve))
  `
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', script], {
    encoding: 'utf8',
  })
  assert.equal(child.status, 0, `child process failed: ${child.stderr}`)
})

test('validates references and captures only the read value through argv', async t => {
  const calls = []
  const source = createOnePasswordSource({ command: process.execPath, environment: {}, execute: async (...args) => {
    calls.push(args)
    return { stdout: Buffer.from('captured-value') }
  } })
  t.after(() => source.close())

  assert.equal(await source.resolve(reference), 'captured-value')
  assert.deepEqual(calls[0][0], process.execPath)
  assert.deepEqual(calls[0][1], ['read', '-n', reference])
  assert.equal(calls[0][2].encoding, 'buffer')
  assert.equal(calls[0][2].maxBuffer, 16384)
  assert.equal(calls[0][2].timeout, 10000)
  assert.equal(validateOnePasswordReference(reference), reference)
  for (const invalid of [
    `op://${'A'.repeat(26)}/${item}/field`, `op://${vault}/${item}/field?attribute=unknown`,
    `op://${vault}/${item}/field?x=1`, `op://${vault}/${item}/field/extra/third`,
    `op://${vault}/${item}/field%zz`, `op://${vault}/${item}/field%2fextra`,
    `op://${vault}/${item}/..`, `op://${vault}/${item}/field\nvalue`,
    `op://${vault}/${item}/${'x'.repeat(2045)}`,
  ]) {
    await assert.rejects(source.resolve(invalid), error => error.code === 'SECRET_REFERENCE_INVALID' && error.status === 400)
  }
  assert.equal(calls.length, 1)
})

test('refresh hides command errors and emits availability transitions; retry can recover', async t => {
  let fail = true
  const events = []
  let calls = 0
  const source = createOnePasswordSource({ command: process.execPath, environment: {}, retryMs: 5, execute: async (_command, args) => {
    calls++
    assert.deepEqual(args, ['whoami', '--format', 'json'])
    if (fail) throw Object.assign(new Error('secret argv and private stderr'), { stderr: 'private stderr' })
    return { stdout: Buffer.from(JSON.stringify({ account_uuid: 'account-id', user_uuid: 'user-id' })) }
  } })
  t.after(() => source.close())
  source.watch(event => events.push(event))

  assert.equal(await source.refresh(), false)
  assert.equal(source.available, false)
  fail = false
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(source.available, true)
  assert.deepEqual(events, [{ available: true }])
  await assert.rejects(source.resolve(reference.replace('attribute=otp', 'attribute=unknown')), error =>
    error.code === 'SECRET_REFERENCE_INVALID' && !error.message.includes('private'))
})

test('an item read failure stays local to that read and is redacted', async t => {
  const events = []
  let calls = 0
  const source = createOnePasswordSource({ command: process.execPath, environment: {}, retryMs: 5, autoRetry: false, execute: async (_command, args) => {
    calls++
    if (args[0] === 'whoami') return { stdout: Buffer.from('{"user_uuid":"user-id"}') }
    throw Object.assign(new Error('private command and stderr'), { stderr: 'private value' })
  } })
  t.after(() => source.close())
  source.watch(event => events.push(event))
  await source.refresh()
  await assert.rejects(source.resolve(reference), error => error.code === 'SECRET_SOURCE_UNAVAILABLE'
    && error.status === 503 && !error.message.includes('private'))
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(calls, 2)
  assert.equal(source.available, true)
  assert.deepEqual(events, [{ available: true }])
})

test('close prevents retry or late notifications', async t => {
  let calls = 0
  let finishRead
  const events = []
  const source = createOnePasswordSource({ command: process.execPath, environment: {}, retryMs: 5, execute: async (_command, args) => {
    calls++
    if (args[0] === 'whoami') return { stdout: Buffer.from('{"user_uuid":"user-id"}') }
    return new Promise(resolve => { finishRead = resolve })
  } })
  source.watch(event => events.push(event))
  await source.refresh()
  const pending = source.resolve(reference)
  while (!finishRead) await new Promise(resolve => setTimeout(resolve, 1))
  source.close()
  finishRead({ stdout: Buffer.alloc(0) })
  await assert.rejects(pending, error => error.code === 'SECRET_SOURCE_UNAVAILABLE' && error.status === 503)
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(calls, 2)
  assert.deepEqual(events, [{ available: true }])
})
