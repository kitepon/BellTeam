import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, get } from 'node:http'
import { connect } from 'node:net'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createHttpGatewayProcess, GATEWAY_ASSET_SHARE_TIMEOUT_MS, GATEWAY_START_TIMEOUT_MS } from '../src/http-gateway-process.mjs'
import { writeAtomic } from '../src/json-file.mjs'

const ids = { one: 'a'.repeat(64), two: 'b'.repeat(64), broken: 'c'.repeat(64), incompatible: 'd'.repeat(64), unknown: 'f'.repeat(64) }

const appRoot = fileURLToPath(new URL('../', import.meta.url))

async function fixture(t, handler = (_request, response) => response.end('{"authenticated":true}')) {
  const root = await mkdtemp(join(tmpdir(), 'gateway-switch-'))
  const socketPath = join(root, 'business.sock')
  const backend = createServer(handler)
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

test('a request still running in the old gateway cannot veto the exchange: the drain times out and the new version starts', { timeout: 20000 }, async t => {
  const held = new Set()
  const { socketPath, releases } = await fixture(t, (request, response) => {
    if (request.url === '/api/slow') { held.add(response); return }
    response.end('{"authenticated":true}')
  })
  t.after(() => { for (const response of held) response.destroy() })
  const gateway = createHttpGatewayProcess({ socketPath, port: 0, appRoot: releases.get(ids.one).appRoot, prepareRelease: async id => releases.get(id) })
  t.after(() => gateway.close())
  await gateway.start()
  const base = `http://127.0.0.1:${gateway.address.port}`, oldPid = gateway.pid
  const inflight = fetch(base + '/api/slow').then(() => 'answered', () => 'reset')
  while (held.size === 0) await new Promise(resolve => setTimeout(resolve, 10))
  const started = Date.now()
  assert.deepEqual(await gateway.replace(ids.two), { versionId: ids.two, address: gateway.address })
  assert.ok(Date.now() - started >= 4500, 'the old gateway got its bounded drain first')
  assert.notEqual(gateway.pid, oldPid)
  assert.equal(gateway.versionId, ids.two)
  assert.match(await (await fetch(base)).text(), /<h1>two<\/h1>/)
  assert.equal(await inflight, 'reset')
})

// 95eef79b: the new gateway listens beside the old one (SO_REUSEPORT) and is ready before the old one stops.
const refusalsDuring = async (port, work) => {
  let refused = 0, connected = 0, running = true
  const loop = (async () => {
    while (running) {
      await new Promise(resolve => {
        const socket = connect(port, '127.0.0.1')
        socket.once('connect', () => { connected++; socket.destroy(); resolve() })
        socket.once('error', error => { if (error.code === 'ECONNREFUSED') refused++; resolve() })
      })
    }
  })()
  try { await work() } finally { running = false; await loop }
  return { refused, connected }
}
const exited = pid => { try { process.kill(pid, 0); return false } catch (error) { return error.code === 'ESRCH' } }

test('an exchange never leaves the public port without a listener, and stopping the old child is not a crash', { timeout: 10000 }, async t => {
  const { socketPath, releases } = await fixture(t)
  const exits = []
  const gateway = createHttpGatewayProcess({ socketPath, port: 0, appRoot: releases.get(ids.one).appRoot,
    prepareRelease: async id => releases.get(id), onModuleChildExit: exit => exits.push(exit) })
  t.after(() => gateway.close())
  const { port } = await gateway.start(), oldPid = gateway.pid
  const { refused, connected } = await refusalsDuring(port, () => gateway.replace(ids.two))
  assert.equal(refused, 0)
  assert.ok(connected > 0)
  assert.notEqual(gateway.pid, oldPid)
  assert.ok(exited(oldPid))
  assert.equal(gateway.address.port, port)
  assert.match(await (await fetch(`http://127.0.0.1:${port}`)).text(), /<h1>two<\/h1>/)
  await new Promise(resolve => setTimeout(resolve, 1200))
  assert.deepEqual(exits, [])
})

test('a child bound without SO_REUSEPORT on either side falls back to stop-then-start and still completes', { timeout: 10000 }, async t => {
  const { socketPath, releases } = await fixture(t)
  // Release one stands for the entry before 95eef79b (the child live in production when this ships).
  const legacy = join(releases.get(ids.one).appRoot, 'src/http-gateway-entry.mjs')
  await writeFile(legacy, (await readFile(legacy, 'utf8')).replace('reusePort: true', 'reusePort: false'))
  const gateway = createHttpGatewayProcess({ socketPath, port: 0, appRoot: releases.get(ids.one).appRoot,
    prepareRelease: async id => releases.get(id) })
  t.after(() => gateway.close())
  const { port } = await gateway.start()
  const base = `http://127.0.0.1:${port}`
  const firstPid = gateway.pid
  await gateway.replace(ids.two)
  assert.ok(exited(firstPid))
  assert.equal(gateway.versionId, ids.two)
  assert.match(await (await fetch(base)).text(), /<h1>two<\/h1>/)
  // Back to the legacy entry: it cannot bind beside the reusePort child either.
  await gateway.replace(ids.one)
  assert.equal(gateway.versionId, ids.one)
  assert.equal(gateway.address.port, port)
  assert.match(await (await fetch(base)).text(), /<h1>one<\/h1>/)
})

test('a new child that fails to start or to answer its own ready read leaves the old child serving untouched', { timeout: 10000 }, async t => {
  const { root, socketPath, releases } = await fixture(t)
  const adoptionPath = join(root, 'adoption.json'), exits = []
  const gateway = createHttpGatewayProcess({ socketPath, port: 0, adoptionPath, appRoot: releases.get(ids.one).appRoot,
    prepareRelease: async id => releases.get(id), onModuleChildExit: exit => exits.push(exit) })
  t.after(() => gateway.close())
  const { port } = await gateway.start(), oldPid = gateway.pid
  const base = `http://127.0.0.1:${port}`
  const { refused } = await refusalsDuring(port, () => assert.rejects(gateway.replace(ids.broken),
    error => error.message === 'GATEWAY_REPLACE_ROLLED_BACK' && error.cause.message === 'GATEWAY_START_FAILED'))
  assert.equal(refused, 0)
  assert.equal(gateway.pid, oldPid)
  // The public port of this candidate answers 200, so only a read addressed to the candidate itself can fail it.
  await writeFile(join(releases.get(ids.broken).appRoot, 'src/http-gateway-entry.mjs'), `
    import { createServer } from 'node:http'
    const pub = createServer((_request, response) => response.end('candidate'))
    await new Promise(resolve => pub.listen({ port: Number(process.argv[3]), host: '0.0.0.0', reusePort: true }, resolve))
    const probe = createServer((_request, response) => { response.statusCode = 500; response.end() })
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
    process.send({ type: 'ready', protocolVersion: 1, assetVersion: process.argv[4], address: pub.address(), probePort: probe.address().port })
    process.on('message', () => process.exit(0))
  `)
  await assert.rejects(gateway.replace(ids.broken), { code: 'READY_PROBE_FAILED' })
  assert.equal(gateway.pid, oldPid)
  assert.equal(gateway.versionId, null)
  await assert.rejects(readFile(adoptionPath), { code: 'ENOENT' })
  assert.match(await (await fetch(base)).text(), /<h1>one<\/h1>/)
  await new Promise(resolve => setTimeout(resolve, 1200))
  assert.equal(gateway.pid, oldPid)
  assert.deepEqual(exits, [])
})

test('close() during an exchange stops both the old child and the new one', { timeout: 10000 }, async t => {
  const { root, socketPath, releases } = await fixture(t)
  const pidPath = join(root, 'candidate.pid')
  await writeFile(join(releases.get(ids.broken).appRoot, 'src/http-gateway-entry.mjs'), `
    import { writeFileSync } from 'node:fs'
    writeFileSync(${JSON.stringify(pidPath)}, String(process.pid))
    process.on('message', () => process.exit(0))
  `)
  const gateway = createHttpGatewayProcess({ socketPath, port: 0, appRoot: releases.get(ids.one).appRoot,
    prepareRelease: async id => releases.get(id) })
  t.after(() => gateway.close())
  await gateway.start()
  const oldPid = gateway.pid
  const replacing = gateway.replace(ids.broken).then(() => 'replaced', () => 'stopped')
  let candidatePid
  while (!(candidatePid = Number(await readFile(pidPath, 'utf8').catch(() => 0)))) await new Promise(resolve => setTimeout(resolve, 10))
  await gateway.close()
  assert.ok(exited(oldPid))
  assert.ok(exited(candidatePid))
  assert.equal(gateway.pid, null)
  assert.equal(await replacing, 'stopped')
})

// A fresh connection each time, so a pooled keep-alive socket cannot pick the child.
const read = url => new Promise((resolve, reject) => get(url, { agent: false }, response => {
  let body = ''
  response.setEncoding('utf8').on('data', chunk => { body += chunk }).once('end', () => resolve({ status: response.statusCode, body }))
}).once('error', reject))

test('during the overlap the old child resolves the new ?v= assets and the new child resolves the old ones', { timeout: 10000 }, async t => {
  const { root, socketPath, releases } = await fixture(t)
  // The candidate holds off listening, so the old child is the only one on the port after the share ack.
  const marker = join(root, 'candidate-started'), candidate = join(releases.get(ids.two).appRoot, 'src/http-gateway-entry.mjs')
  await writeFile(candidate, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, '')\n`
    + `await new Promise(resolve => setTimeout(resolve, 1500))\n${await readFile(candidate, 'utf8')}`)
  const gateway = createHttpGatewayProcess({ socketPath, port: 0, appRoot: releases.get(ids.one).appRoot,
    prepareRelease: async id => releases.get(id) })
  t.after(() => gateway.close())
  const { port } = await gateway.start(), oldPid = gateway.pid, base = `http://127.0.0.1:${port}`
  const oldVersion = (await read(base)).body.match(/app\.js\?v=([^"]+)/)[1]
  const replacing = gateway.replace(ids.two)
  while (!await stat(marker).catch(() => null)) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(gateway.pid, oldPid)
  assert.deepEqual(await read(`${base}/app.js?v=${ids.two}`), { status: 200, body: `two:${ids.two}` })
  await replacing
  assert.ok(exited(oldPid))
  assert.deepEqual(await read(`${base}/app.js?v=${oldVersion}`), { status: 200, body: `one:${oldVersion}` })
  assert.deepEqual(await read(`${base}/app.js?v=${ids.two}`), { status: 200, body: `two:${ids.two}` })
})

test('an old child that never acknowledges the shared asset version falls back to stop-then-start and still completes', { timeout: 20000 }, async t => {
  const { socketPath, releases } = await fixture(t)
  const entry = join(releases.get(ids.one).appRoot, 'src/http-gateway-entry.mjs'), source = await readFile(entry, 'utf8')
  const handler = "process.on('message', message => { if (message?.type === 'asset-version') void shareAssetVersion(message) })"
  assert.ok(source.includes(handler))
  await writeFile(entry, source.replace(handler, ''))
  const gateway = createHttpGatewayProcess({ socketPath, port: 0, appRoot: releases.get(ids.one).appRoot,
    prepareRelease: async id => releases.get(id) })
  t.after(() => gateway.close())
  const { port } = await gateway.start(), oldPid = gateway.pid
  const started = Date.now()
  await gateway.replace(ids.two)
  assert.ok(Date.now() - started >= GATEWAY_ASSET_SHARE_TIMEOUT_MS - 100, 'waited for the bounded ack first')
  assert.ok(exited(oldPid))
  assert.equal(gateway.versionId, ids.two)
  assert.deepEqual(await read(`http://127.0.0.1:${port}/app.js?v=${ids.two}`), { status: 200, body: `two:${ids.two}` })
})

test('a candidate that exits during the adoption write is not committed: the old child keeps serving and the record is restored', { timeout: 15000 }, async t => {
  const { root, socketPath, releases } = await fixture(t)
  const adoptionPath = join(root, 'adoption.json'), pidPath = join(root, 'latest.pid')
  const entry = join(releases.get(ids.one).appRoot, 'src/http-gateway-entry.mjs')
  await writeFile(entry, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(pidPath)}, String(process.pid))\n${await readFile(entry, 'utf8')}`)
  let pause = null
  // The new record lands, then the write is held open: the window Epinel named.
  const writeAdoption = async (path, value) => {
    await writeAtomic(path, value)
    if (pause && value.currentVersionId === ids.one) { pause.entered.resolve(); await pause.released.promise }
  }
  const gateway = createHttpGatewayProcess({ socketPath, port: 0, adoptionPath, appRoot: releases.get(ids.one).appRoot,
    prepareRelease: async id => releases.get(id), writeAdoption })
  t.after(() => gateway.close())
  const { port } = await gateway.start()
  await gateway.replace(ids.two)
  const saved = await readFile(adoptionPath, 'utf8'), servingPid = gateway.pid
  pause = { entered: Promise.withResolvers(), released: Promise.withResolvers() }
  let outcome
  const { refused } = await refusalsDuring(port, async () => {
    const replacing = gateway.replace(ids.one).then(() => null, error => error)
    await pause.entered.promise
    const candidatePid = Number(await readFile(pidPath, 'utf8'))
    assert.notEqual(candidatePid, servingPid)
    process.kill(candidatePid, 'SIGKILL')
    while (!exited(candidatePid)) await new Promise(resolve => setTimeout(resolve, 10))
    await new Promise(resolve => setTimeout(resolve, 100))
    pause.released.resolve()
    outcome = await replacing
  })
  assert.equal(outcome?.message, 'GATEWAY_REPLACE_ROLLED_BACK')
  assert.equal(outcome.cause.message, 'GATEWAY_START_FAILED')
  assert.equal(refused, 0)
  assert.equal(gateway.pid, servingPid)
  assert.equal(gateway.versionId, ids.two)
  assert.deepEqual(JSON.parse(await readFile(adoptionPath, 'utf8')), JSON.parse(saved))
  assert.match((await read(`http://127.0.0.1:${port}`)).body, /<h1>two<\/h1>/)
  // Recovery stayed with the serving child: no restart replaces it.
  await new Promise(resolve => setTimeout(resolve, 1500))
  assert.equal(gateway.pid, servingPid)
})
