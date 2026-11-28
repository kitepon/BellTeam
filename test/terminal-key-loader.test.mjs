import assert from 'node:assert/strict'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createTerminalKeyLoader } from '../src/terminal-key-loader.mjs'

const REF = '11111111-1111-4111-8111-111111111111', HANDLE = '22222222-2222-4222-8222-222222222222'
const DTO = { schema: 'aiterm.credential-load.v1', accepted: true, ref: REF, handle: HANDLE, revision: 3 }
const make = answer => {
  const calls = []
  const loader = createTerminalKeyLoader({ operatorBotId: 'bot-k', authMediation: () => ({ exec: async request => { calls.push(request); return typeof answer === 'function' ? answer() : answer } }) })
  return { loader, calls }
}
const load = loader => loader.load({ terminalId: 'macbook', ref: REF, handle: HANDLE, revision: 3 })

test('the parent starts the fixed loader as the operator Bot and gets only the DTO', async () => {
  const { loader, calls } = make({ outcome: 'granted', exit_code: 0, stdout: JSON.stringify(DTO) + '\n', stderr: '' })
  assert.deepEqual(await load(loader), DTO)
  assert.deepEqual(calls, [{ botId: 'bot-k', command: ['/app/scripts/terminal-key-load', 'macbook'], args: ['--ref', REF, '--handle', HANDLE, '--revision', '3'], timeoutSec: 60 }])
})

test('refusals: not mediated falls back, a refused grant turns availability off, a binding error keeps its code, junk fails', async () => {
  assert.equal((await load(make({ outcome: 'not-registered' }).loader).catch(error => error)).code, 'KEY_NOT_MEDIATED')
  const denied = make({ outcome: 'denied' }).loader
  assert.equal((await load(denied).catch(error => error)).code, 'CREDENTIAL_UNAVAILABLE')
  assert.deepEqual(await denied.available('macbook'), { available: false, revision: 1 })
  const binding = { schema: 'aiterm.remote-binding-error.v1', code: 'HOST_TRUST_STALE' }
  const error = await load(make({ outcome: 'granted', exit_code: 2, stdout: JSON.stringify(binding) }).loader).catch(e => e)
  assert.deepEqual([error.code, error.status, error.binding], ['HOST_TRUST_STALE', 409, binding])
  assert.equal((await load(make({ outcome: 'granted', exit_code: 1, stdout: 'x' }).loader).catch(e => e)).code, 'TERMINAL_KEY_LOAD_UNAVAILABLE')
  const ok = make({ outcome: 'granted', exit_code: 0, stdout: JSON.stringify(DTO) }).loader
  await load(ok); assert.equal((await ok.available('macbook')).available, true)
})

test('the loader file passes the key to credential-load stdin only, prints no key, rejects bad arguments', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tkl-'))
  const bin = join(dir, 'aiterm-remote-terminal')
  await writeFile(bin, '#!/bin/sh\ncat > "$0.stdin"\nprintf \'%s\\n\' \'' + JSON.stringify(DTO) + '\'\n')
  await chmod(bin, 0o755)
  const run = args => spawnSync(process.execPath, ['scripts/terminal-key-load', ...args], { env: { PATH: dir + ':/usr/bin:/bin', SSH_KEY: 'KEYTEXT\n' }, encoding: 'utf8' })
  const ok = run(['macbook', '--ref', REF, '--handle', HANDLE, '--revision', '3'])
  assert.equal(ok.status, 0)
  assert.deepEqual(JSON.parse(ok.stdout.trim()), DTO)
  assert.ok(!ok.stdout.includes('KEYTEXT') && !ok.stderr.includes('KEYTEXT'))
  assert.equal(spawnSync('cat', [bin + '.stdin'], { encoding: 'utf8' }).stdout, 'KEYTEXT\n')
  assert.equal(run(['Bad Terminal', '--ref', REF, '--handle', HANDLE, '--revision', '3']).status, 64)
  assert.equal(run(['macbook', '--ref', 'x', '--handle', HANDLE, '--revision', '3']).status, 64)
})
