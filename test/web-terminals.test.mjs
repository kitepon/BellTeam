import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectRootProblem, readTerminals, remoteBindingBody, terminalStatus } from '../web/terminals.js'

test('check observation -> plain words; host trust reasons ask for the fingerprint', () => {
  assert.equal(terminalStatus(null).label, '未確認')
  assert.equal(terminalStatus({ reachable: true }).tone, 'ok')
  assert.equal(terminalStatus({ reachable: false, reason: 'SSH_KEY_UNSET' }).label, 'SSH鍵が未設定')
  for (const reason of ['AUTH_FAILED', 'CREDENTIAL_UNAVAILABLE', 'CREDENTIAL_REVISION_STALE']) assert.equal(terminalStatus({ reachable: false, reason }).label, '鍵が使えません')
  for (const reason of ['HOST_TRUST_MISSING', 'HOST_KEY_MISMATCH', 'HOST_TRUST_STALE', 'TARGET_MISMATCH']) assert.equal(terminalStatus({ reachable: false, reason }).trust, true)
  for (const reason of ['UNREACHABLE', 'CONNECTION_LOST', 'TERMINAL_UNAVAILABLE', 'SOMETHING_NEW', null]) assert.equal(terminalStatus({ reachable: false, reason }).label, '届きません')
  assert.equal(terminalStatus({ reachable: false, reason: 'UNREACHABLE' }).reason, 'UNREACHABLE')
})

test('projectRoot follows members C1', () => {
  for (const ok of ['', '/', '/Users/kite/work/app']) assert.equal(projectRootProblem(ok), '')
  for (const bad of ['Users/kite', '/Users//kite', '/Users/./kite', '/Users/../etc', '/Users/kite/', '/a\0b', `/${'a'.repeat(4096)}`]) assert.notEqual(projectRootProblem(bad), '', bad)
})

test('binding body: both or neither, only when changed', () => {
  assert.deepEqual(remoteBindingBody(null, '', ''), { body: {} })
  assert.deepEqual(remoteBindingBody({ terminalId: '', projectRoot: '' }, '', '/ignored'), { body: {} })
  assert.ok(remoteBindingBody(null, 'owner-macbook', ' ').error)
  assert.ok(remoteBindingBody(null, 'owner-macbook', 'relative').error)
  assert.deepEqual(remoteBindingBody(null, 'owner-macbook', ' /Users/kite/app '), { body: { terminalId: 'owner-macbook', projectRoot: '/Users/kite/app' } })
  assert.deepEqual(remoteBindingBody({ terminalId: 'owner-macbook', projectRoot: '/Users/kite/app' }, 'owner-macbook', '/Users/kite/app'), { body: {} })
  assert.deepEqual(remoteBindingBody({ terminalId: 'owner-macbook', projectRoot: '/Users/kite/app' }, '', '/Users/kite/app'), { body: { terminalId: '', projectRoot: '' } })
})

test('readTerminals tolerates older bodies and an unmounted core', async () => {
  const failing = error => async () => { throw error }
  assert.deepEqual(await readTerminals(async () => ({ terminals: [{ terminalId: 'a' }] })), { terminals: [{ terminalId: 'a' }] })
  const old = await readTerminals(failing({ status: 404 }))
  assert.equal(old.unsupported, true)
  assert.match(old.message, /まだ端末に対応していません/)
  assert.match((await readTerminals(failing({ status: 503, code: 'TERMINALS_UNAVAILABLE' }))).message, /動いていません/)
  await assert.rejects(readTerminals(failing(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
})
