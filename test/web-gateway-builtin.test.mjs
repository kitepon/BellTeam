import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setImmediate as immediate } from 'node:timers/promises'
import test from 'node:test'
import { createHttpGatewayProcess } from '../src/http-gateway-process.mjs'
import { createWebGatewayControl } from '../src/web-gateway-control.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'

const appRoot = fileURLToPath(new URL('../', import.meta.url))
const signed = 'a'.repeat(64)
const adoption = (currentVersionId, previousVersionId = null) => ({
  schema: 'bellteam.web-gateway.adoption.v1', currentVersionId, previousVersionId,
})

async function fixture(t, backend = createServer((_request, response) => response.end('{"authenticated":true}'))) {
  const root = await mkdtemp(join(tmpdir(), 'gateway-builtin-')), socketPath = join(root, 'business.sock')
  const adoptionPath = join(root, 'adoption.json'), childrenPath = join(root, 'children.jsonl')
  const roots = {}, prepared = [], gateways = []
  backend.listen(socketPath); await once(backend, 'listening')
  t.after(async () => {
    for (const gateway of gateways) await gateway.close()
    await new Promise(resolve => backend.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  for (const name of ['builtin', 'signed']) {
    const directory = roots[name] = join(root, name)
    await mkdir(join(directory, 'src'), { recursive: true });
    await symlink(join(appRoot, 'src/http-gateway.mjs'), join(directory, 'src/http-gateway.mjs'))
    const entry = await readFile(join(appRoot, 'src/http-gateway-entry.mjs'), 'utf8')
    await writeFile(join(directory, 'src/http-gateway-entry.mjs'),
      `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(childrenPath)}, JSON.stringify({name:${JSON.stringify(name)},pid:process.pid,key:process.argv[4],catalog:JSON.parse(process.argv[5])})+'\\n')\n${entry}`)
  }
  const create = (options = {}) => {
    const gateway = createHttpGatewayProcess({ socketPath, port: 0, appRoot: roots.builtin, adoptionPath,
      prepareRelease: async id => {
        prepared.push(id)
        assert.equal(id, signed, 'the reader only accepts signed SHA, never builtin/null')
        return { versionId: id, appRoot: roots.signed, protocolVersion: 1,
          sourceCommit: 'b'.repeat(40), platform: { os: 'linux', arch: 'amd64' } }
      }, ...options })
    gateways.push(gateway); return gateway
  }
  const children = async () => (await readFile(childrenPath, 'utf8')).trim().split('\n').map(JSON.parse)
  // a487: which child answers is read from its version header (the key it was started with), not from a page.
  const serving = async url => { const key = (await fetch(url)).headers.get('x-bellteam-gateway-version'); return (await children()).findLast(child => child.key === key)?.name }
  return { root, roots, adoptionPath, create, prepared, children, serving }
}

test('signed→builtin→採用再読込は固定appRoot/同port/旧SHA資材を保持し実ready版を登録する', { timeout: 5000 }, async t => {
  const f = await fixture(t), gateway = f.create()
  await gateway.start()
  const port = gateway.address.port, base = `http://127.0.0.1:${port}`
  await gateway.replace(signed)
  const signedPid = gateway.pid
  assert.deepEqual(await gateway.replace('builtin'), { versionId: null, address: gateway.address })
  assert.equal(gateway.address.port, port)
  assert.throws(() => process.kill(signedPid, 0), { code: 'ESRCH' })
  assert.deepEqual(JSON.parse(await readFile(f.adoptionPath, 'utf8')), adoption(null, signed))
  assert.equal((await stat(f.adoptionPath)).mode & 0o777, 0o600)
  const version = (await fetch(base)).headers.get('x-bellteam-gateway-version')
  assert.equal(await f.serving(base), 'builtin')
  assert.ok(version && !['null', 'builtin', signed].includes(version))
  const builtinPid = gateway.pid
  await gateway.replace('builtin')
  assert.equal(gateway.pid, builtinPid, 'already builtin does not spawn another child')
  await gateway.close(); f.prepared.length = 0
  const reloaded = f.create({ port }); await reloaded.start()
  assert.equal(reloaded.versionId, null); assert.equal(reloaded.address.port, port)
  assert.deepEqual(f.prepared, [signed])
  assert.equal(await f.serving(base), 'builtin')
  for (const child of await f.children()) {
    assert.ok(child.catalog.every(([key]) => typeof key === 'string' && key && !['builtin', 'null'].includes(key)))
  }
  const last = (await f.children()).at(-1)
  assert.deepEqual(last.catalog, [[signed, f.roots.signed]])
})

test('明示null以外の欠落/不正currentはbuiltinへ補完せず起動前拒否する', async t => {
  const f = await fixture(t)
  for (const value of [undefined, 'builtin', '', 0, false, {}, []]) {
    await writeFile(f.adoptionPath, JSON.stringify(adoption(value)), { mode: 0o600 })
    const gateway = f.create()
    await assert.rejects(gateway.start(), /GATEWAY_ADOPTION_INVALID/)
    assert.equal(gateway.pid, null)
  }
  assert.deepEqual(f.prepared, [])
  await assert.rejects(readFile(join(f.root, 'children.jsonl')), { code: 'ENOENT' })
})

test('builtin起動失敗は旧signed子を止めずに配り続け、採用記録を保持する', { timeout: 5000 }, async t => {
  const f = await fixture(t), gateway = f.create()
  await gateway.start(); await gateway.replace(signed)
  const port = gateway.address.port, saved = await readFile(f.adoptionPath, 'utf8'), signedPid = gateway.pid
  await writeFile(join(f.roots.builtin, 'src/http-gateway-entry.mjs'), 'process.exit(1)\n')
  await assert.rejects(gateway.replace('builtin'), error => error.message === 'GATEWAY_REPLACE_ROLLED_BACK'
    && error.cause.message === 'GATEWAY_START_FAILED')
  assert.equal(gateway.versionId, signed); assert.equal(gateway.address.port, port)
  assert.equal(await readFile(f.adoptionPath, 'utf8'), saved)
  assert.equal(await f.serving(`http://127.0.0.1:${port}`), 'signed')
  // 95eef79b: the signed child was never stopped, so nothing is re-prepared or restarted.
  assert.equal(gateway.pid, signedPid)
  assert.deepEqual(f.prepared, [signed])
})

test('builtin採用保存失敗は新子を回収しsignedの記録と公開版を保持する', { timeout: 5000 }, async t => {
  const f = await fixture(t)
  await writeFile(f.adoptionPath, JSON.stringify(adoption(signed)), { mode: 0o600 })
  const gateway = f.create(); await gateway.start()
  const saved = await readFile(f.adoptionPath, 'utf8'), port = gateway.address.port
  // rename cannot replace a directory; the original record remains available for inspection.
  const { rename } = await import('node:fs/promises')
  await rename(f.adoptionPath, f.adoptionPath + '.saved'); await mkdir(f.adoptionPath)
  await assert.rejects(gateway.replace('builtin'), error => error.message === 'GATEWAY_REPLACE_ROLLED_BACK'
    && ['EISDIR', 'ENOTEMPTY'].includes(error.cause.code))
  assert.equal(gateway.versionId, signed); assert.equal(gateway.address.port, port)
  const spawnedBuiltin = (await f.children()).find(child => child.name === 'builtin')
  assert.throws(() => process.kill(spawnedBuiltin.pid, 0), { code: 'ESRCH' })
  assert.equal(await readFile(f.adoptionPath + '.saved', 'utf8'), saved)
  assert.equal(await f.serving(`http://127.0.0.1:${port}`), 'signed')
})

test('builtin戻しの交換中に親closeすると旧子も新子も回収し、子を残さない', { timeout: 5000 }, async t => {
  const entered = Promise.withResolvers(), released = Promise.withResolvers()
  const backend = createServer(async (request, response) => {
    if (request.url === '/api/held') { entered.resolve(); await released.promise }
    response.end('{"authenticated":true}')
  })
  const f = await fixture(t, backend), gateway = f.create()
  t.after(() => released.resolve())
  await gateway.start(); await gateway.replace(signed)
  const count = (await f.children()).length
  const held = fetch(`http://127.0.0.1:${gateway.address.port}/api/held`)
  await entered.promise
  const replacing = gateway.replace('builtin')
  const rejected = assert.rejects(replacing, { name: 'AbortError' })
  await immediate()
  const closing = gateway.close(); released.resolve()
  assert.equal((await held).status, 200)
  await closing; await rejected
  assert.equal(gateway.pid, null)
  // 95eef79b: the builtin child may already be up beside the old one; close() ends every child it started.
  const spawned = await f.children()
  assert.ok(spawned.length <= count + 1)
  for (const child of spawned) assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' })
})

test('builtin予約はcompletion/同時拒否/cancel/closeを保ち現在nullと操作builtinを区別する', async () => {
  const finished = Promise.withResolvers(), calls = []
  const gateway = { versionId: signed, async replace(id) { calls.push(id); await finished.promise; this.versionId = null } }
  const control = createWebGatewayControl({ gateway: () => gateway })
  for (const invalid of [null, undefined, {}, 'BUILTIN', '../builtin', 'builtin/'])
    assert.throws(() => control.reserve(invalid), { code: 'WEB_GATEWAY_VERSION_INVALID', status: 400 })
  const cancelled = control.reserve('builtin'); cancelled.cancel(); cancelled.start(); await cancelled.completion
  assert.deepEqual(calls, []); assert.equal(control.snapshot().update.status, 'not_started')
  const pending = control.reserve('builtin')
  assert.throws(() => control.reserve(signed), { status: 409 })
  pending.start(); pending.start(); await immediate()
  assert.deepEqual(calls, ['builtin']); assert.equal(control.snapshot().currentVersionId, signed)
  assert.equal(control.snapshot().update.status, 'running')
  finished.resolve(); await pending.completion
  assert.deepEqual(control.snapshot(), { currentVersionId: null, update: { versionId: 'builtin', status: 'succeeded' } })
  const last = control.reserve('builtin'); control.close(); last.start(); await last.completion
  assert.deepEqual(calls, ['builtin']); assert.equal(control.snapshot().update.status, 'not_started')
})

test('実Owner HTTP builtinの202後に実子切替し完了GETへ反映、未認証/内部は拒否する', { timeout: 5000 }, async t => {
  let control, pending
  const options = { bots: {}, rooms: {}, store: {}, transport: {}, administration: {},
    // The page shell's session check (GET /api/session only) passes, as in production: the gateway's ready probe (module-ready-probe,
    // 2026-11-06) reads / without a token and the gateway asks GET /api/session for it. Every other method and API still needs the owner token.
    authorize: request => request.method === 'GET' && request.url === '/api/session' || request.headers.authorization === 'Bearer synthetic-owner', writeLog: () => {},
    webGatewayControl: { snapshot: () => control.snapshot(), reserve: id => { pending = control.reserve(id); return pending } } }
  const backend = createBellTeamServer(options), f = await fixture(t, backend), gateway = f.create()
  control = createWebGatewayControl({ gateway: () => gateway })
  await gateway.start(); await gateway.replace(signed)
  const port = gateway.address.port, pid = gateway.pid, base = `http://127.0.0.1:${port}`
  const headers = { authorization: 'Bearer synthetic-owner', 'content-type': 'application/json' }
  const request = (body, authenticated = true) => fetch(base + '/api/web-gateway-release', {
    method: 'POST', headers: authenticated ? headers : {}, body: JSON.stringify(body),
  })
  // Only GET /api/session is open without the token (the page shell check); other methods still need it.
  assert.equal((await fetch(base + '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401)
  assert.equal((await request({ versionId: 'builtin' }, false)).status, 401)
  assert.equal((await request({ versionId: 'builtin', path: f.roots.signed })).status, 400)
  assert.equal(gateway.pid, pid)
  const accepted = await request({ versionId: 'builtin' })
  assert.equal(accepted.status, 202)
  assert.equal((await accepted.json()).webGatewayRelease.update.status, 'accepted')
  await pending.completion
  const result = await (await fetch(base + '/api/web-gateway-release', { headers })).json()
  assert.deepEqual(result.webGatewayRelease, { currentVersionId: null, update: { versionId: 'builtin', status: 'succeeded' } })
  assert.equal(gateway.address.port, port); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  assert.equal(JSON.parse(await readFile(f.adoptionPath, 'utf8')).currentVersionId, null)
  const internal = createBellTeamServer({ ...options, internal: true })
  internal.listen(0, '127.0.0.1'); await once(internal, 'listening')
  t.after(() => new Promise(resolve => internal.close(resolve)))
  for (const method of ['GET', 'POST']) assert.equal((await fetch(`http://127.0.0.1:${internal.address().port}/api/web-gateway-release`, {
    method, headers, ...(method === 'POST' ? { body: JSON.stringify({ versionId: 'builtin' }) } : {}),
  })).status, 403)
})
