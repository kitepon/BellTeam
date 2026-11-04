import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createHttpGatewayProcess, GATEWAY_START_TIMEOUT_MS } from '../src/http-gateway-process.mjs'

const ids = { one: 'a'.repeat(64), two: 'b'.repeat(64), broken: 'c'.repeat(64), incompatible: 'd'.repeat(64), unknown: 'f'.repeat(64) }

const appRoot = fileURLToPath(new URL('../', import.meta.url))

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'gateway-switch-'))
  const socketPath = join(root, 'business.sock')
  const backend = createServer((_request, response) => response.end('{"authenticated":true}'))
  backend.listen(socketPath); await once(backend, 'listening')
  t.after(async () => { await new Promise(resolve => backend.close(resolve)); await rm(root, { recursive: true, force: true }) })
  const releases = new Map()
  for (const versionId of ['one', 'two', 'broken']) {
    const dir = join(root, versionId)
    await mkdir(join(dir, 'src'), { recursive: true })
    await mkdir(join(dir, 'web'))
    await symlink(join(appRoot, 'src/http-gateway.mjs'), join(dir, 'src/http-gateway.mjs'))
    await copyFile(join(appRoot, 'src/http-gateway-entry.mjs'), join(dir, 'src/http-gateway-entry.mjs'))
    await copyFile(join(appRoot, 'web/assets.mjs'), join(dir, 'web/assets.mjs'))
    await writeFile(join(dir, 'web/index.html'), `<h1>${versionId}</h1><script src="/app.js?v=__ASSET_VERSION__"></script>`)
    await writeFile(join(dir, 'web/app.js'), `${versionId}:__ASSET_VERSION__`)
    if (versionId === 'broken') await writeFile(join(dir, 'src/http-gateway-entry.mjs'), 'throw new Error("synthetic startup failure")\n')
    releases.set(ids[versionId], { versionId: ids[versionId], appRoot: dir, protocolVersion: 1 })
  }
  return { root, socketPath, releases }
}

test('確認済版だけへ同じportで交換し、拒否は旧版維持、起動失敗は旧版に戻す', { timeout: 5000 }, async t => {
  const { socketPath, releases } = await fixture(t)
  let prepareCalls = 0
  const gateway = createHttpGatewayProcess({ socketPath, port: 0, appRoot: releases.get(ids.one).appRoot,
    prepareRelease: async id => {
      prepareCalls++
      if (!releases.has(id)) throw new Error('SYNTHETIC_RELEASE_REJECTED')
      return releases.get(id)
    } })
  t.after(() => gateway.close())
  await assert.rejects(gateway.replace(ids.two), /GATEWAY_NOT_INITIALIZED/)
  assert.equal(prepareCalls, 0)
  await gateway.start()
  const base = `http://127.0.0.1:${gateway.address.port}`, originalPid = gateway.pid
  const oldHtml = await (await fetch(base)).text()
  assert.match(oldHtml, /<h1>one<\/h1>/)
  const oldVersion = oldHtml.match(/app\.js\?v=([^"]+)/)[1]
  await assert.rejects(gateway.replace(ids.unknown), /SYNTHETIC_RELEASE_REJECTED/)
  assert.equal(gateway.pid, originalPid)
  releases.set(ids.incompatible, { ...releases.get(ids.two), versionId: ids.incompatible, protocolVersion: 2 })
  await assert.rejects(gateway.replace(ids.incompatible), /GATEWAY_RELEASE_INVALID/)
  assert.equal(gateway.pid, originalPid)
  await gateway.replace(ids.two)
  assert.notEqual(gateway.pid, originalPid)
  assert.equal(gateway.versionId, ids.two)
  assert.match(await (await fetch(base)).text(), /<h1>two<\/h1>/)
  assert.equal(await (await fetch(base + '/app.js?v=' + oldVersion)).text(), `one:${oldVersion}`)
  assert.equal((await fetch(base + '/app.js?v=unknown')).status, 404)
  await assert.rejects(gateway.replace(ids.broken), error => error.message === 'GATEWAY_REPLACE_ROLLED_BACK'
    && error.cause.message === 'GATEWAY_START_FAILED')
  assert.equal(gateway.versionId, ids.two)
  assert.match(await (await fetch(base)).text(), /<h1>two<\/h1>/)
})

test('親closeはprepare待ちを止めて旧子を回収し、遅いprepare完了後に新子を起こさない', { timeout: 5000 }, async t => {
  const { socketPath, releases } = await fixture(t)
  const waiting = Promise.withResolvers(), prepared = Promise.withResolvers()
  const gateway = createHttpGatewayProcess({ socketPath, port: 0, appRoot: releases.get(ids.one).appRoot,
    prepareRelease: async (_id, { signal }) => { waiting.resolve(signal); return prepared.promise } })
  t.after(() => gateway.close())
  await gateway.start()
  const replacing = gateway.replace(ids.two)
  const signal = await waiting.promise
  await assert.rejects(gateway.replace(ids.two), /GATEWAY_UPDATE_IN_PROGRESS/)
  await gateway.close()
  assert.equal(signal.aborted, true)
  assert.equal(gateway.pid, null)
  prepared.resolve(releases.get(ids.two))
  await assert.rejects(replacing, { name: 'AbortError' })
  assert.equal(gateway.pid, null)
})

test('不正portのreadyを拒否して新子を回収し、元の公開portで旧版へ戻す', { timeout: 5000 }, async t => {
  const { root, socketPath, releases } = await fixture(t)
  const gateway = createHttpGatewayProcess({ socketPath, port: 0, appRoot: releases.get(ids.one).appRoot,
    prepareRelease: async id => releases.get(id) })
  t.after(() => gateway.close())
  await gateway.start()
  const port = gateway.address.port, base = `http://127.0.0.1:${port}`
  const pidPath = join(root, 'rejected-child.pid')
  for (const readyPort of [0, -1, 65536, port === 65535 ? port - 1 : port + 1]) {
    await writeFile(join(releases.get(ids.broken).appRoot, 'src/http-gateway-entry.mjs'), `
      import { writeFileSync } from 'node:fs'
      writeFileSync(${JSON.stringify(pidPath)}, String(process.pid))
      process.send({ type: 'ready', protocolVersion: 1, assetVersion: process.argv[4], address: { port: ${readyPort} } })
      setInterval(() => {}, 1000)
    `)
    await assert.rejects(gateway.replace(ids.broken), error => error.message === 'GATEWAY_REPLACE_ROLLED_BACK'
      && error.cause.message === 'GATEWAY_START_FAILED')
    const rejectedPid = Number(await readFile(pidPath, 'utf8'))
    assert.throws(() => process.kill(rejectedPid, 0), { code: 'ESRCH' })
    assert.equal(gateway.address.port, port)
    assert.equal(gateway.versionId, null)
    assert.match(await (await fetch(base)).text(), /<h1>one<\/h1>/)
  }
  await gateway.replace(ids.two)
  assert.equal(gateway.address.port, port)
  assert.match(await (await fetch(base)).text(), /<h1>two<\/h1>/)
})

test('readyを返さない新子を期限で回収して旧版へ戻す', { timeout: 20000 }, async t => {
  const { socketPath, releases } = await fixture(t)
  const blocked = releases.get(ids.broken)
  await writeFile(join(blocked.appRoot, 'src/http-gateway-entry.mjs'), 'setInterval(() => {}, 1000)\n')
  const gateway = createHttpGatewayProcess({ socketPath, port: 0, appRoot: releases.get(ids.one).appRoot,
    prepareRelease: async id => releases.get(id) })
  t.after(() => gateway.close())
  await gateway.start()
  const base = `http://127.0.0.1:${gateway.address.port}`
  const startedAt = performance.now()
  await assert.rejects(gateway.replace(ids.broken), error => error.message === 'GATEWAY_REPLACE_ROLLED_BACK'
    && error.cause.message === 'GATEWAY_START_TIMEOUT')
  assert.ok(performance.now() - startedAt >= GATEWAY_START_TIMEOUT_MS)
  assert.match(await (await fetch(base)).text(), /<h1>one<\/h1>/)
})

test('ready後だけ採用版を保存し、再起動でcurrent/previousを再確認、破損はfallbackしない', { timeout: 5000 }, async t => {
  const { root, socketPath, releases } = await fixture(t)
  const adoptionPath = join(root, 'adoption.json'), prepared = []
  const create = () => createHttpGatewayProcess({ socketPath, port: 0, adoptionPath, appRoot: releases.get(ids.one).appRoot,
    prepareRelease: async id => { prepared.push(id); return releases.get(id) } })
  const first = create(); t.after(() => first.close())
  await first.start()
  await first.replace(ids.two)
  assert.deepEqual(JSON.parse(await readFile(adoptionPath, 'utf8')), {
    schema: 'bellteam.web-gateway.adoption.v1', currentVersionId: ids.two, previousVersionId: null,
  })
  assert.equal((await stat(adoptionPath)).mode & 0o777, 0o600)
  await first.close()
  const second = create(); t.after(() => second.close())
  await second.start()
  assert.equal(second.versionId, ids.two)
  await second.replace(ids.one)
  await second.close()
  prepared.length = 0
  const third = create(); t.after(() => third.close())
  await third.start()
  assert.deepEqual(prepared, [ids.one, ids.two])
  assert.equal(await (await fetch(`http://127.0.0.1:${third.address.port}/app.js?v=${ids.two}`)).text(), `two:${ids.two}`)
  await third.close()
  await writeFile(adoptionPath, '{invalid')
  const corrupt = create()
  await assert.rejects(corrupt.start(), /GATEWAY_ADOPTION_INVALID/)
  assert.equal(corrupt.pid, null)
})

test('採用recordを書けない時は新子を回収して旧版へ戻す', { timeout: 5000 }, async t => {
  const { socketPath, releases } = await fixture(t)
  const gateway = createHttpGatewayProcess({ socketPath, port: 0, appRoot: releases.get(ids.one).appRoot,
    adoptionPath: `/proc/${process.pid}/synthetic-gateway-adoption.json`, prepareRelease: async id => releases.get(id) })
  t.after(() => gateway.close())
  await gateway.start()
  const base = `http://127.0.0.1:${gateway.address.port}`
  await assert.rejects(gateway.replace(ids.two), error => error.message === 'GATEWAY_REPLACE_ROLLED_BACK' && error.cause.code === 'ENOENT')
  assert.equal(gateway.versionId, null)
  assert.match(await (await fetch(base)).text(), /<h1>one<\/h1>/)
})


test('automatic recovery restarts the same gateway version and port', async t => {
  const { releases, socketPath } = await fixture(t)
  const gateway = createHttpGatewayProcess({ socketPath, port: 0, appRoot: releases.get(ids.one).appRoot })
  t.after(() => gateway.close())
  const address = await gateway.start(), oldPid = gateway.pid
  process.kill(oldPid, 'SIGKILL')
  await new Promise(resolve => setTimeout(resolve, 1400))
  assert.notEqual(gateway.pid, oldPid)
  assert.ok(gateway.pid)
  assert.equal(gateway.address.port, address.port)
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/`)).status, 200)
})
