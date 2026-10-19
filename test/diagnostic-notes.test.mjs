import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Diagnostics, createDiagnosticsAdminServer } from '../src/diagnostics.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-diagnostic-notes-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'diagnostics.json'), investigationsFile = join(root, 'investigations.json')
  const diagnostics = new Diagnostics(file, { investigationsFile })
  const original = await diagnostics.record({ code: 'IOS_NETWORK_TIMEOUT', module: 'conversation',
    app_version: '1.0.1(52)', severity: 'warn', diagnostic_log: 'original diagnostic, not a closure reason' })
  await writeFile(investigationsFile, JSON.stringify({ [original.fingerprint]: {
    summary: 'existing investigation', evidence: ['saved-evidence-ref'], updated_at: '2026-10-19T00:00:00.000Z',
  } }))
  await diagnostics.initialize()
  const server = createDiagnosticsAdminServer({ diagnostics, key: 'synthetic-admin-key' })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/api/admin/logs`
  const headers = { authorization: 'Bearer synthetic-admin-key' }
  const post = (action, body, auth = headers) => fetch(`${base}/${action}`, { method: 'POST', headers: auth, body: JSON.stringify(body) })
  const get = async () => (await fetch(base, { headers })).json()
  return { diagnostics, original: structuredClone(original), file, investigationsFile, post, get }
}

test('resolveの理由を保存し、再読込と管理GETでも原文・回数・重大度を保持する', async t => {
  const { diagnostics, original, file, investigationsFile, post, get } = await fixture(t)
  const note = '情報不足・原因特定不能。修理成功を意味しない。根拠: saved-assessment'
  const response = await post('resolve', { fingerprint: original.fingerprint, note })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).investigation_note.summary, note)
  const persisted = await readFile(file, 'utf8')
  const [row] = await get()
  assert.equal(await readFile(file, 'utf8'), persisted)
  assert.equal(row.diagnostic_context.investigation_note.summary, note)
  assert.equal(row.investigation.summary, 'existing investigation')
  assert.deepEqual(row.investigation.evidence, ['saved-evidence-ref'])
  const { investigation_note, ...source } = diagnostics.rows.get(original.fingerprint)
  assert.deepEqual(source, { ...original, status: 'resolved' })
  assert.equal(investigation_note.occurrence_count, original.occurrence_count)
  const reloaded = new Diagnostics(file, { investigationsFile })
  await reloaded.initialize()
  assert.deepEqual(reloaded.list(), diagnostics.list())
})

test('既存resolvedへ注記だけを保存し、再resolveせず状態と原文全項目を維持する', async t => {
  const { diagnostics, original, file, investigationsFile, post, get } = await fixture(t)
  await diagnostics.setStatus(original.fingerprint, 'resolved')
  const before = structuredClone(diagnostics.rows.get(original.fingerprint))
  const configured = await readFile(investigationsFile, 'utf8')
  assert.equal((await post('annotate', { fingerprint: original.fingerprint, note: 'closed as unidentifiable, not fixed' })).status, 200)
  const { investigation_note, ...after } = diagnostics.rows.get(original.fingerprint)
  assert.deepEqual(after, before)
  assert.equal(investigation_note.status, 'resolved')
  assert.equal(await readFile(investigationsFile, 'utf8'), configured)
  const persisted = await readFile(file, 'utf8')
  assert.equal((await get())[0].status, 'resolved')
  assert.equal(await readFile(file, 'utf8'), persisted)
})

test('未認証・不正な注記は保存も状態変更もしない', async t => {
  const { original, file, post } = await fixture(t)
  const before = await readFile(file, 'utf8')
  assert.equal((await post('annotate', { fingerprint: original.fingerprint, note: 'private note' }, {})).status, 401)
  for (const note of [undefined, null, 42, '', '  ', 'x'.repeat(2001)]) {
    assert.equal((await post('annotate', { fingerprint: original.fingerprint, note })).status, 400)
    if (note !== undefined) assert.equal((await post('resolve', { fingerprint: original.fingerprint, note })).status, 400)
    assert.equal(await readFile(file, 'utf8'), before)
  }
  assert.equal((await post('annotate', { fingerprint: 'a'.repeat(64), note: 'missing row' })).status, 404)
  assert.equal(await readFile(file, 'utf8'), before)
})

test('新しい発生で開き直しても過去注記を失わず、過去件数の理由と区別する', async t => {
  const { diagnostics, original, get } = await fixture(t)
  await diagnostics.setStatus(original.fingerprint, 'resolved', { note: 'first occurrence cannot be identified' })
  const note = structuredClone(diagnostics.rows.get(original.fingerprint).investigation_note)
  await diagnostics.record({ code: 'IOS_NETWORK_TIMEOUT', module: 'conversation', severity: 'warn' })
  const [row] = await get()
  assert.equal(row.status, 'open')
  assert.equal(row.occurrence_count, 2)
  assert.deepEqual(row.investigation_note, note)
  assert.equal(row.diagnostic_context.investigation_note.occurrence_count, 1)
  assert.equal(row.diagnostic_context.investigation_note.status, 'resolved')
})

test('上限4000字の既存調査と20件の根拠/元時刻を省略せず新noteを別に表示する', async t => {
  const { diagnostics, original, investigationsFile, file, post, get } = await fixture(t)
  const existing = { summary: '既'.repeat(3998) + '末尾', evidence: Array.from({ length: 20 }, (_, i) => `ref-${i}`), updated_at: '2026-10-19T00:00:00.000Z' }
  await writeFile(investigationsFile, JSON.stringify({ [original.fingerprint]: existing }))
  await diagnostics.initialize()
  diagnostics.rows.get(original.fingerprint).diagnostic_context = { existing_context: 'preserved' }
  const note = '注'.repeat(2000)
  assert.equal((await post('annotate', { fingerprint: original.fingerprint, note })).status, 200)
  const persisted = await readFile(file, 'utf8')
  const [row] = await get()
  assert.deepEqual(row.investigation, existing)
  assert.equal(row.diagnostic_context.existing_context, 'preserved')
  assert.equal(row.diagnostic_context.investigation_note.summary, note)
  assert.equal(row.diagnostic_context.investigation_note.occurrence_count, 1)
  assert.equal(row.diagnostic_context.investigation_note.status, 'open')
  assert.ok(Number.isFinite(Date.parse(row.diagnostic_context.investigation_note.updated_at)))
  assert.equal(await readFile(file, 'utf8'), persisted)
})
