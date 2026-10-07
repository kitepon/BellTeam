import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { Diagnostics, createDiagnosticsAdminServer } from '../src/diagnostics.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'

const root = await mkdtemp(join(tmpdir(), 'bellteam-diagnostics-'))
after(() => rm(root, { recursive: true, force: true }))

test('診断を署名で集計し、解決後の再発を開き直す', async () => {
  const file = join(root, 'diagnostics.json')
  const diagnostics = new Diagnostics(file)
  await diagnostics.initialize()
  await diagnostics.record({ code: 'IOS_HANG', module: 'app', app_version: '0.1.0(6)' })
  const first = diagnostics.list()[0]
  assert.equal(first.severity, 'high')
  assert.equal(first.occurrence_count, 1)
  await diagnostics.setStatus(first.fingerprint, 'resolved')
  assert.equal(diagnostics.list('open').length, 0)
  await diagnostics.record({ code: 'IOS_HANG', module: 'app', app_version: '0.1.0(6)' })
  assert.equal(diagnostics.list('open')[0].occurrence_count, 2)
  const reloaded = new Diagnostics(file)
  await reloaded.initialize()
  assert.equal(reloaded.list('open')[0].fingerprint, first.fingerprint)
  await assert.rejects(() => diagnostics.record({ code: 'IOS_HANG', module: 'private text' }), /DIAGNOSTIC_INVALID/u)
})

test('管理口はBearerを要求し、BugHubの取得・解決契約を返す', async () => {
  const diagnostics = new Diagnostics(join(root, 'admin.json'))
  await diagnostics.initialize()
  const row = await diagnostics.record({ code: 'IOS_NETWORK_TIMEOUT', module: 'conversation' })
  const server = createDiagnosticsAdminServer({ diagnostics, key: 'test-secret' })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const base = `http://127.0.0.1:${server.address().port}`
    assert.equal((await fetch(`${base}/api/admin/logs`)).status, 401)
    const headers = { authorization: 'Bearer test-secret' }
    const response = await fetch(`${base}/api/admin/logs?status=all&limit=500`, { headers })
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).map(item => item.fingerprint), [row.fingerprint])
    const resolved = await fetch(`${base}/api/admin/logs/resolve`, {
      method: 'POST', headers, body: JSON.stringify({ fingerprint: row.fingerprint, note: '確認済み' }),
    })
    assert.equal((await resolved.json()).status, 'resolved')
    const reopened = await fetch(`${base}/api/admin/logs/reopen`, {
      method: 'POST', headers, body: JSON.stringify({ fingerprint: row.fingerprint }),
    })
    assert.equal((await reopened.json()).status, 'open')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('診断ログを保存して管理口へ渡し、ログなしの続報でも保持する', async () => {
  const diagnostics = new Diagnostics(join(root, 'logs.json'))
  await diagnostics.initialize()
  const log = 'hang_duration_seconds=3\ncall_stack_tree={"callStacks":[]}'
  await diagnostics.record({ code: 'IOS_HANG', module: 'app', app_version: '0.1.0(8)', diagnostic_log: log })
  await diagnostics.record({ code: 'IOS_HANG', module: 'app' })
  const server = createDiagnosticsAdminServer({ diagnostics, key: 'test-secret' })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/logs`, {
      headers: { authorization: 'Bearer test-secret' },
    })
    const [row] = await response.json()
    assert.equal(row.diagnostic_log, log)
    assert.equal(row.diagnostic_log_version, '0.1.0(8)')
    assert.ok(Number.isFinite(Date.parse(row.diagnostic_log_received_at)))
    assert.equal(row.occurrence_count, 2)
    await assert.rejects(() => diagnostics.record({ code: 'IOS_HANG', module: 'app', diagnostic_log: 42 }), /DIAGNOSTIC_INVALID/u)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('iPhone診断の受付はCloudflare認証後に限り、Bot一覧の更新を待たない', async () => {
  const diagnostics = new Diagnostics(join(root, 'intake.json'))
  await diagnostics.initialize()
  const server = createBellTeamServer({
    authorize: async request => request.headers['cf-access-jwt-assertion'] === 'test-assertion',
    bots: { async refresh() { throw new Error('診断受付では呼ばない') } },
    diagnostics,
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/diagnostics`
    const body = JSON.stringify({ code: 'IOS_HANG', module: 'app', app_version: '0.1.0(6)', diagnostic_log: 'call_stack_tree={"callStacks":[]}' })
    assert.equal((await fetch(url, { method: 'POST', body })).status, 401)
    const headers = { 'cf-access-jwt-assertion': 'test-assertion' }
    assert.equal((await fetch(url, { method: 'POST', headers, body })).status, 202)
    assert.equal(diagnostics.list()[0].occurrence_count, 1)
    assert.equal(diagnostics.list()[0].diagnostic_log, 'call_stack_tree={"callStacks":[]}')
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ code: 'SERVER_HTTP_500', module: 'server' }) })).status, 400)
    const handled = JSON.stringify({ code: 'IOS_NETWORK_FAILURE', module: 'queue', app_version: '1.0.1(46)', severity: 'info', diagnostic_log: 'outcome=recovered' })
    assert.equal((await fetch(url, { method: 'POST', headers, body: handled })).status, 202)
    assert.equal(diagnostics.list().find(row => row.category === 'IOS_NETWORK_FAILURE').severity, 'info')
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ code: 'IOS_NETWORK_FAILURE', module: 'queue', severity: 'urgent' }) })).status, 400)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('サーバーの500エラーはメッセージを除いたスタックを保存する', async () => {
  const diagnostics = new Diagnostics(join(root, 'server-error.json'))
  await diagnostics.initialize()
  const server = createBellTeamServer({
    authorize: async () => true,
    bots: { async refresh() { throw new Error('private response content') } },
    diagnostics,
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bots`)
    assert.equal(response.status, 500)
    const row = diagnostics.list()[0]
    assert.equal(row.category, 'SERVER_HTTP_500')
    assert.match(row.diagnostic_log, /^Error\n\s+at /u)
    assert.doesNotMatch(row.diagnostic_log, /private response content/u)
    assert.doesNotMatch(row.diagnostic_log, new RegExp(process.cwd(), 'u'))
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('通信の失敗は、送信元が付けた重大度で登録する。付いていない報告は未確認のwarnにする', async () => {
  const diagnostics = new Diagnostics(join(root, 'network.json'))
  await diagnostics.initialize()
  const unassessed = await diagnostics.record({ code: 'IOS_NETWORK_TIMEOUT', module: 'conversation', app_version: '1.0.1(45)' })
  assert.equal(unassessed.severity, 'warn')
  assert.equal(unassessed.message_template, 'Appleアプリの通信が時間切れになった（影響とアプリの対処は未確認）')
  const harmed = await diagnostics.record({ code: 'IOS_NETWORK_TIMEOUT', module: 'conversation', severity: 'high', diagnostic_log: 'impact=input_lost' })
  assert.equal(harmed.severity, 'high')
  assert.equal(harmed.message_template, 'Appleアプリの通信が時間切れになった（影響あり）')
  assert.notEqual(harmed.fingerprint, unassessed.fingerprint)
  assert.equal(diagnostics.list().find(row => row.fingerprint === unassessed.fingerprint).occurrence_count, 1)
  await assert.rejects(() => diagnostics.record({ code: 'IOS_NETWORK_TIMEOUT', module: 'conversation', severity: 'critical' }), /DIAGNOSTIC_INVALID/u)
  await assert.rejects(() => diagnostics.record({ code: 'IOS_HTTP_5XX', module: 'bots', severity: 3 }), /DIAGNOSTIC_INVALID/u)
  // アプリ自身の異常（ハング・クラッシュ）は、送信元の重大度を読まない。
  assert.equal((await diagnostics.record({ code: 'IOS_CRASH', module: 'app', severity: 'info' })).severity, 'fatal')
})

test('適切に処理した通信の失敗（info）は参考として残し、解決済みの行を開き直さない', async () => {
  const diagnostics = new Diagnostics(join(root, 'reference.json'))
  await diagnostics.initialize()
  const report = { code: 'IOS_NETWORK_FAILURE', module: 'queue', severity: 'info', diagnostic_log: 'outcome=recovered' }
  const first = await diagnostics.record(report)
  assert.equal(first.severity, 'info')
  assert.equal(first.status, 'open')
  assert.equal(first.message_template, 'Appleアプリの通信に失敗した（適切に処理した参考記録）')
  await diagnostics.setStatus(first.fingerprint, 'resolved')
  const again = await diagnostics.record(report)
  assert.equal(again.status, 'resolved')
  assert.equal(again.occurrence_count, 2)
  // 影響のあった報告は別の行で、解決済みでも開き直す。
  const harmed = await diagnostics.record({ ...report, severity: 'warn' })
  await diagnostics.setStatus(harmed.fingerprint, 'resolved')
  assert.equal((await diagnostics.record({ ...report, severity: 'warn' })).status, 'open')
  assert.equal(diagnostics.list().find(row => row.fingerprint === first.fingerprint).status, 'resolved')
})

test('サーバーの通知と設定の失敗は、影響ごとのcodeで登録する', async () => {
  const diagnostics = new Diagnostics(join(root, 'server-reports.json'))
  await diagnostics.initialize()
  assert.equal((await diagnostics.record({ code: 'SERVER_PUSH_FAILED', module: 'notifications', diagnostic_log: 'APNS_TIMEOUT' })).severity, 'warn')
  assert.equal((await diagnostics.record({ code: 'SERVER_PUSH_UNAVAILABLE', module: 'notifications', diagnostic_log: 'PUSH_RELAY_CONNECTION_FAILED' })).severity, 'high')
  // 起動時の記録が弾かれると、設定を反映できなかった機能があるだけでサーバーが起動できなくなる。
  assert.equal((await diagnostics.record({ code: 'SERVER_FEATURE_CONFIGURATION_FAILED', module: 'server', diagnostic_log: 'notifications' })).severity, 'high')
  assert.equal((await diagnostics.record({ code: 'SERVER_CALL_CONFIGURATION_FAILED', module: 'server', diagnostic_log: 'CALL_CONFIGURATION_FAILED' })).severity, 'warn')
})
