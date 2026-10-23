import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Diagnostics } from '../src/diagnostics.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'

test('モデル一覧GET失敗を実HTTPからモデル取得の診断へ渡し秘密値を保存しない', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-model-context-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'diagnostics.json')
  const diagnostics = new Diagnostics(file)
  await diagnostics.initialize()
  const bots = new Map()
  bots.refresh = async () => {}
  const server = createBellTeamServer({ authorize: () => true, bots, diagnostics,
    models: { async list() { throw new Error('synthetic-private-error') } } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/models?harness=synthetic-private-harness`)
  assert.equal(response.status, 500)
  const [row] = diagnostics.list()
  assert.equal(row.report_context?.operation, 'model_catalog_read')
  for (const line of ['scope=server_request', 'request_method=GET', 'request_route=/api/models',
    'expected_result=model_catalog_response', 'actual_result=http_500_response_selected',
    'delivery_outcome=unknown', 'screen_observation=not_observed']) {
    assert.ok(row.diagnostic_log.split('\n').includes(line), line)
  }
  assert.doesNotMatch(await readFile(file, 'utf8'), /synthetic-private/u)
})

test('新しいモデル一覧のアプリ診断を具体化しても保存済みunknown原件を書き換えない', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-app-model-context-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const diagnostics = new Diagnostics(join(root, 'diagnostics.json'))
  await diagnostics.initialize()
  const oldLog = 'scope=app_request\noperation=unknown\nactual_result=network_failure\nrequest_route=/api/models'
  const old = await diagnostics.record({ code: 'IOS_NETWORK_FAILURE', module: 'settings', app_version: '1.0.3(58)',
    severity: 'warn', diagnostic_log: oldLog })
  const original = structuredClone(old)
  const current = await diagnostics.record({ code: 'IOS_NETWORK_FAILURE', module: 'settings', app_version: '1.0.3(61)',
    severity: 'warn', diagnostic_log: 'scope=app_request\noperation=model_catalog_read\nactual_result=network_failure\nrequest_route=/api/models\nexpected_result=model_catalog_loaded' })
  assert.equal(current.report_context?.operation, 'model_catalog_read')
  assert.match(current.message_template, /モデル一覧取得/u)
  assert.notEqual(current.fingerprint, old.fingerprint)
  assert.deepEqual(diagnostics.list().find(row => row.fingerprint === old.fingerprint), original)
  assert.equal(diagnostics.list().length, 2)
})
