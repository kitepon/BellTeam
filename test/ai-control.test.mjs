import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AiControl } from '../src/ai-control.mjs'

const done = () => ({ unconfirmedBotIds: [], commandsConfirmed: true })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-ai-control-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const control = new AiControl({ path: join(root, 'control.json'), stopAll: done, ...options })
  await control.initialize()
  return control
}

test('ONは保存待ちより先に受付を止め、停止完了を確認してからstoppedとなる', async t => {
  const save = deferred(), stopping = deferred(); let calls = 0
  const c = await fixture(t, { save: () => save.promise, stopAll: () => { calls++; return stopping.promise } })
  const on = c.update(true)
  assert.throws(() => c.assertEnabled(), { code: 'AI_GLOBAL_PAUSED', status: 423 })
  assert.equal(c.snapshot().state, 'stopping'); assert.equal(calls, 0)
  assert.equal(c.update(true), on)
  save.resolve(); assert.equal((await on).status, 202); assert.equal(calls, 1)
  const pending = c.enforcement
  stopping.resolve(done()); await pending
  assert.equal(c.snapshot().state, 'stopped')
  assert.equal((await c.update(true)).status, 200); assert.equal(calls, 1)
})

test('一部未確認でもONを維持し、成功表示や同じONの自動再実行をしない', async t => {
  let calls = 0
  const c = await fixture(t, { stopAll: () => { calls++; return { unconfirmedBotIds: ['bot-b', 'bot-b'], commandsConfirmed: true } } })
  await c.update(true); await c.enforcement
  assert.deepEqual(c.snapshot().unconfirmedBotIds, ['bot-b'])
  assert.equal(c.snapshot().state, 'unconfirmed'); assert.equal(c.snapshot().paused, true)
  assert.equal((await c.update(true)).status, 502); assert.equal(calls, 1)
})

test('コマンド未確認と停止結果の破損を全体停止成功にしない', async t => {
  for (const result of [{ unconfirmedBotIds: [], commandsConfirmed: false }, null]) {
    const c = await fixture(t, { stopAll: () => result })
    await c.update(true); await c.enforcement
    assert.equal(c.snapshot().state, 'unconfirmed'); assert.equal(c.snapshot().paused, true)
  }
})

test('ONの保存失敗でも実停止を試みて受付抑止を残す', async t => {
  let calls = 0
  const c = await fixture(t, { save: async () => { throw Error('synthetic disk failure') }, stopAll: () => { calls++; return done() } })
  assert.equal((await c.update(true)).status, 503); await c.enforcement
  assert.equal(calls, 1); assert.equal(c.snapshot().state, 'unconfirmed')
  assert.equal(c.snapshot().error, 'AI_CONTROL_SAVE_FAILED')
  assert.throws(() => c.assertEnabled(), { code: 'AI_GLOBAL_PAUSED' })
})

test('OFFは保存成功まで再開せず、保存に失敗したらONのままにする', async t => {
  let fail = false
  const c = await fixture(t, { save: async () => { if (fail) throw Error('synthetic') } })
  await c.update(true); await c.enforcement
  fail = true; assert.equal((await c.update(false)).status, 503)
  assert.equal(c.snapshot().paused, true)
  fail = false; assert.equal((await c.update(false)).status, 200)
  assert.equal(c.snapshot().state, 'enabled'); c.assertEnabled()
})

test('OFF後に古い停止結果が届いても状態を停止済みへ戻さない', async t => {
  const stopping = deferred()
  const c = await fixture(t, { stopAll: () => stopping.promise })
  await c.update(true); const pending = c.enforcement
  await c.update(false); stopping.resolve(done()); await pending
  assert.equal(c.snapshot().paused, false); assert.equal(c.snapshot().state, 'enabled')
})

test('別端末のOFF保存中に届いた新しいONを古いOFFが解除しない', async t => {
  const saveOff = deferred(); let writes = 0
  const c = await fixture(t, { save: async (_path, value) => { writes++; if (!value.paused) await saveOff.promise } })
  await c.update(true); await c.enforcement
  const off = c.update(false), on = c.update(true)
  assert.equal(c.snapshot().paused, true)
  saveOff.resolve(); await off; assert.equal(c.snapshot().paused, true)
  await on; await c.enforcement
  assert.equal(writes, 3); assert.equal(c.snapshot().state, 'stopped')
})

test('保存したONは再起動後も抑止し、過去の停止確認だけでstoppedにしない', async t => {
  const c = await fixture(t); await c.update(true); await c.enforcement
  const restored = new AiControl({ path: c.path, stopAll: done }); await restored.initialize()
  assert.equal(restored.snapshot().paused, true); assert.equal(restored.snapshot().state, 'unconfirmed')
  assert.throws(() => restored.assertEnabled(), { code: 'AI_GLOBAL_PAUSED' })
  await restored.enforce(); assert.equal(restored.snapshot().state, 'stopped')
  await restored.update(false)
  assert.equal(JSON.parse(await readFile(c.path, 'utf8')).paused, false)
})

test('破損した正本を動作可能と誤認せず、明示OFFの成功で修復できる', async t => {
  const c = await fixture(t); await writeFile(c.path, '{invalid')
  const restored = new AiControl({ path: c.path, stopAll: done }); await restored.initialize()
  assert.equal(restored.snapshot().error, 'AI_CONTROL_STATE_INVALID')
  await restored.enforce(); assert.equal(restored.snapshot().state, 'unconfirmed')
  assert.equal((await restored.update(false)).status, 200); restored.assertEnabled()
})

test('SSE通知先の故障が停止そのものを妨げない', async t => {
  const c = await fixture(t); c.watch(() => { throw Error('synthetic listener failure') })
  await c.update(true); await c.enforcement
  assert.equal(c.snapshot().state, 'stopped')
  assert.throws(() => c.update('true'), { code: 'AI_CONTROL_INVALID', status: 400 })
})

test('OFFは期限済み予定の保存を終えるまで受付を開かず、失敗時も停止を維持する', async t => {
  const resume = deferred(); let fail = false
  const c = await fixture(t, { beforeResume: async () => { await resume.promise; if (fail) throw Error('schedule write failed') } })
  await c.update(true); await c.enforcement
  const off = c.update(false)
  assert.throws(() => c.assertEnabled(), { code: 'AI_GLOBAL_PAUSED' })
  fail = true; resume.resolve()
  assert.equal((await off).status, 503)
  assert.equal(c.snapshot().paused, true)
  assert.equal(JSON.parse(await readFile(c.path, 'utf8')).paused, true)
  fail = false; await c.update(false)
  c.assertEnabled()
})
