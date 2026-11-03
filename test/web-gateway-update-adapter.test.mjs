import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createWebGatewayUpdateAdapter } from '../src/web-gateway-update-adapter.mjs'
import { createHttpGatewayProcess } from '../src/http-gateway-process.mjs'

const builtinSourceCommit = 'b'.repeat(40), signed = 'a'.repeat(64), releaseSource = 'c'.repeat(40)
const builtin = { version: builtinSourceCommit, digest: null, sourceCommit: builtinSourceCommit, origin: 'builtin' }
const target = { version: signed, digest: `sha256:${signed}`, sourceCommit: releaseSource, origin: 'release' }
const release = { platform: { os: 'linux', arch: 'amd64' } }
const descriptor = { versionId: signed, sourceCommit: releaseSource, protocolVersion: 1, platform: release.platform }

test('current/capture/availableは同processを読み、builtin sourceは親の固定closureだけを使う', () => {
  let child = { versionId: null, pid: 123 }
  const adapter = createWebGatewayUpdateAdapter({ gateway: () => child, builtinSourceCommit })
  assert.deepEqual(adapter.current(), builtin)
  assert.deepEqual(adapter.capture(), { generation: null, pid: 123 })
  assert.equal(adapter.available(), true)
  child.versionId = signed
  assert.deepEqual(adapter.current(), { ...target, sourceCommit: null })
  child = null
  assert.equal(adapter.current(), null); assert.equal(adapter.available(), false)
  assert.deepEqual(adapter.capture(), { generation: null, pid: null })
})

test('builtin source不明/不正や不明currentを既知builtinへ補完しない', async () => {
  let applied = 0
  for (const value of [null, undefined, '', 'b'.repeat(39), 'B'.repeat(40), { sourceCommit: builtinSourceCommit }]) {
    const adapter = createWebGatewayUpdateAdapter({ gateway: () => ({ versionId: null, pid: 123,
      replace: () => { applied++ } }), builtinSourceCommit: value })
    assert.equal(adapter.current(), null)
    assert.equal(adapter.canRollback(builtin), false)
    await assert.rejects(adapter.prepare({ target: builtin }), { code: 'UPDATE_ROLLBACK_UNAVAILABLE', status: 503 })
    await assert.rejects(adapter.apply({ target: builtin }), { code: 'UPDATE_ROLLBACK_UNAVAILABLE' })
  }
  for (const versionId of [undefined, 'builtin', false, 'x']) {
    const adapter = createWebGatewayUpdateAdapter({ gateway: () => ({ versionId, pid: 123 }), builtinSourceCommit })
    assert.equal(adapter.current(), null)
  }
  assert.equal(applied, 0)
})

test('builtin targetは確認済みsource/version/digestの全一致だけを通しreaderへ渡さない', async () => {
  let prepared = 0, applied = 0
  const adapter = createWebGatewayUpdateAdapter({ builtinSourceCommit,
    gateway: () => ({ versionId: signed, pid: 123, replace: () => { applied++ } }),
    prepare: () => { prepared++ } })
  assert.equal(adapter.canRollback(builtin), true)
  await adapter.prepare({ target: builtin })
  for (const invalid of [
    { ...builtin, sourceCommit: releaseSource }, { ...builtin, version: releaseSource },
    { ...builtin, digest: `sha256:${signed}` }, { ...builtin, sourceCommit: null },
  ]) {
    assert.equal(adapter.canRollback(invalid), false)
    await assert.rejects(adapter.prepare({ target: invalid }), { code: 'UPDATE_ROLLBACK_UNAVAILABLE' })
    await assert.rejects(adapter.apply({ target: invalid }), { code: 'UPDATE_ROLLBACK_UNAVAILABLE' })
  }
  assert.equal(prepared, 0); assert.equal(applied, 0)
  assert.equal(adapter.canRollback(null), false)
  assert.equal(adapter.canRollback(target), true)
})

test('SHA prepareは既readerへ同expectedReleaseを渡しversion/source/protocol/platform差異を拒否する', async () => {
  let value = descriptor, calls = 0
  const adapter = createWebGatewayUpdateAdapter({ gateway: () => null, builtinSourceCommit,
    prepare: async (versionId, options) => {
      calls++; assert.equal(versionId, signed); assert.equal(options.expectedRelease, release); return value
    } })
  await adapter.prepare({ target, release })
  for (const [changed, code] of [
    [null, 'UPDATE_TARGET_CHANGED'], [{ ...descriptor, versionId: 'd'.repeat(64) }, 'UPDATE_TARGET_CHANGED'],
    [{ ...descriptor, sourceCommit: builtinSourceCommit }, 'UPDATE_TARGET_CHANGED'],
    [{ ...descriptor, protocolVersion: 2 }, 'UPDATE_INCOMPATIBLE'],
    [{ ...descriptor, platform: { os: 'darwin', arch: 'amd64' } }, 'UPDATE_INCOMPATIBLE'],
    [{ ...descriptor, platform: { os: 'linux', arch: 'arm64' } }, 'UPDATE_INCOMPATIBLE'],
    [{ ...descriptor, platform: null }, 'UPDATE_INCOMPATIBLE'],
  ]) {
    value = changed
    await assert.rejects(adapter.prepare({ target, release }), { code, status: 503 })
  }
  assert.equal(calls, 8)
})

test('reader未供給/拒否は成功にせず、catalog無しの旧SHA戻しもsource確認を保つ', async () => {
  const missing = createWebGatewayUpdateAdapter({ gateway: () => null })
  await assert.rejects(missing.prepare({ target }), { code: 'UPDATE_EXECUTOR_UNAVAILABLE' })
  const rejected = new Error('SYNTHETIC_RELEASE_REJECTED')
  const denied = createWebGatewayUpdateAdapter({ gateway: () => null, prepare: async () => { throw rejected } })
  await assert.rejects(denied.prepare({ target }), error => error === rejected)
  const rollback = createWebGatewayUpdateAdapter({ gateway: () => null, prepare: async () => descriptor })
  await rollback.prepare({ target, release: null })
  await rollback.prepare({ target: { ...target, sourceCommit: null }, release: null })
})

test('applyはbuiltin literal又はSHAだけを同processへ渡し実Promiseの終端を返す', async () => {
  const finished = Promise.withResolvers(), calls = []
  const adapter = createWebGatewayUpdateAdapter({ builtinSourceCommit,
    gateway: () => ({ replace: version => { calls.push(version); return finished.promise } }) })
  let settled = false
  const pending = adapter.apply({ target: builtin }).then(result => { settled = true; return result })
  await Promise.resolve(); assert.equal(settled, false); assert.deepEqual(calls, ['builtin'])
  finished.resolve({ versionId: null }); assert.deepEqual(await pending, { versionId: null })
  await adapter.apply({ target }); assert.deepEqual(calls, ['builtin', signed])
  const failure = new Error('GATEWAY_REPLACE_ROLLED_BACK')
  const failed = createWebGatewayUpdateAdapter({ builtinSourceCommit,
    gateway: () => ({ replace: async () => { throw failure } }) })
  await assert.rejects(failed.apply({ target: builtin }), error => error === failure)
})

test('固有adapterから実gatewayをSHA→builtinへ戻し、同port/採用null/旧資材/currentとpidを結ぶ', { timeout: 5000 }, async t => {
  const appRoot = fileURLToPath(new URL('../', import.meta.url)), root = await mkdtemp(join(tmpdir(), 'gateway-adapter-'))
  const socketPath = join(root, 'business.sock'), releaseRoot = join(root, 'signed'), adoptionPath = join(root, 'adoption.json')
  const backend = createServer((_request, response) => response.end('{"authenticated":true}'))
  let gateway, reads = 0
  t.after(async () => { await gateway?.close(); await new Promise(resolve => backend.close(resolve)); await rm(root, { recursive: true, force: true }) })
  await mkdir(join(releaseRoot, 'src'), { recursive: true }); await mkdir(join(releaseRoot, 'web'))
  await copyFile(join(appRoot, 'src/http-gateway-entry.mjs'), join(releaseRoot, 'src/http-gateway-entry.mjs'))
  await symlink(join(appRoot, 'src/http-gateway.mjs'), join(releaseRoot, 'src/http-gateway.mjs'))
  await copyFile(join(appRoot, 'web/assets.mjs'), join(releaseRoot, 'web/assets.mjs'))
  await writeFile(join(releaseRoot, 'web/index.html'), '<h1>signed</h1>')
  await writeFile(join(releaseRoot, 'web/app.js'), 'signed:__ASSET_VERSION__')
  backend.listen(socketPath); await once(backend, 'listening')
  const prepare = async id => { reads++; assert.equal(id, signed); return { ...descriptor, appRoot: releaseRoot } }
  gateway = createHttpGatewayProcess({ socketPath, port: 0, appRoot, prepareRelease: prepare, adoptionPath })
  const adapter = createWebGatewayUpdateAdapter({ gateway: () => gateway, builtinSourceCommit, prepare })
  await gateway.start(); const port = gateway.address.port, base = `http://127.0.0.1:${port}`
  assert.deepEqual(adapter.current(), builtin)
  await adapter.prepare({ target, release }); await adapter.apply({ target, release })
  const signedPid = gateway.pid; assert.equal(adapter.current().version, signed)
  await adapter.prepare({ target: builtin }); await adapter.apply({ target: builtin })
  assert.equal(gateway.address.port, port); assert.equal(adapter.available(), true)
  assert.deepEqual(adapter.current(), builtin); assert.deepEqual(adapter.capture(), { generation: null, pid: gateway.pid })
  assert.throws(() => process.kill(signedPid, 0), { code: 'ESRCH' })
  const state = JSON.parse(await readFile(adoptionPath, 'utf8'))
  assert.equal(state.currentVersionId, null); assert.equal(state.previousVersionId, signed)
  assert.equal(await (await fetch(base + '/app.js?v=' + signed)).text(), `signed:${signed}`)
  assert.equal(reads, 2, 'builtin preparation/application must not enter signed reader')
})
