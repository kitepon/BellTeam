// Only this supervisor fixture replaces image code. All gateway/install/reader code is the image's.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdir, writeFile, readFile, stat, chown, chmod, rename } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { createApplicationRuntime } from '/app/src/application-runtime.mjs'
import { BotRegistry } from '/app/src/bot-registry.mjs'
import { FeatureSettings } from '/app/src/feature-settings.mjs'
import { OwnerProfile } from '/app/src/owner-profile.mjs'
import { UserRules } from '/app/src/user-rules.mjs'

const mode = process.argv[2] ?? 'runtime'
const state = '/srv/bellteam/state', statusPath = `${state}/fixture-status.json`, commandPath = `${state}/fixture-command.json`
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const write = (path, value) => writeFile(path, JSON.stringify(value) + '\n', { mode: 0o600 })
if (mode === 'initialize') {
  assert.equal(process.getuid(), 0)
  for (const part of ['state', 'rooms', 'owner', 'logs', 'bellteam-settings', 'apns']) {
    const path = '/private/' + part
    await mkdir(path, { recursive: true }); await chown(path, 1001, 1001); await chmod(path, 0o700)
  }
  await chown('/private', 0, 1001); await chmod('/private', 0o750)
  // Nested mounts otherwise leave root-owned shared/tools before the synthetic bootstrap.
  for (const part of ['data', 'home', 'data/shared', 'data/shared/tools']) {
    const path = '/fixture-runtime/' + part
    await mkdir(path, { recursive: true }); await chown(path, 1001, 1001); await chmod(path, 0o755)
    const info = await stat(path)
    assert.equal(info.uid, 1001); assert.equal(info.gid, 1001); assert.equal(info.mode & 0o777, 0o755)
  }
  console.log(JSON.stringify({ initialized: true, syntheticDataOwner: 1001, privateOwner: '0:1001/0750' }))
} else if (mode === 'status') {
  console.log(await readFile(statusPath, 'utf8'))
} else if (mode === 'command') {
  const action = process.argv[3]
  assert.ok(['adopt-a', 'adopt-b', 'return-a'].includes(action))
  await write(commandPath, { action })
} else {
  assert.equal(mode, 'runtime'); assert.equal(process.getuid(), 1001); assert.equal(process.getgid(), 1001)
  assert.equal(Number(process.versions.node.split('.')[0]), 26)
  await assert.rejects(writeFile('/app/fixture-readonly', 'x'), { code: 'EROFS' })
  const ids = JSON.parse(await readFile('/fixture-input.json', 'utf8'))
  assert.match(ids.a, /^[a-f0-9]{64}$/); assert.match(ids.b, /^[a-f0-9]{64}$/); assert.notEqual(ids.a, ids.b)
  const seedPath = `${state}/fixture-seed.json`
  await write(seedPath, { schema: 'bellteam.bots.v1', bots: [] })
  const bots = new BotRegistry({ seedPath, botsRoot: '/srv/bellteam/bots' })
  const settings = new FeatureSettings({ root: '/srv/bellteam', environment: {} })
  const ownerProfile = new OwnerProfile({ root: '/srv/bellteam' }), userRules = new UserRules({ root: '/srv/bellteam' })
  for (const value of [bots, settings, ownerProfile, userRules]) await value.initialize()
  let clientCloses = 0, modelCalls = 0, business
  const entered = Promise.withResolvers(), retained = Promise.withResolvers()
  const runtime = await createApplicationRuntime({ root: '/srv/bellteam', appRoot: '/app', home: '/home/bell',
    environment: { BELLTEAM_WEB_PORT: '0', BELLTEAM_INTERNAL_PORT: '0' },
    bootstrap: { bots, settings, ownerProfile, userRules, refreshGlobalInstructions: async () => {},
      aiterm: { command: 'synthetic-never-run', args: [] },
      models: { list: async () => { modelCalls++; entered.resolve(); return retained.promise } } },
    client: { async call() { return { content: [{ type: 'text', text: '(セッション無し)' }] } }, async close() { clientCloses++ } },
  })
  const identity = async pid => ({ pid, startTime: (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1].split(' ')[19] })
  const parentIdentity = await identity(process.pid)
  let businessIdentity, port
  const evidence = { fixture: 'synthetic bootstrap/client/business; real image admission/runtime/API/reader/gateway', checks: [] }
  const invariant = async () => {
    assert.deepEqual(await identity(process.pid), parentIdentity)
    if (businessIdentity) assert.deepEqual(await identity(business.pid), businessIdentity)
    assert.equal(clientCloses, 0)
    assert.equal(runtime.gateway.address.port, port)
  }
  const publish = async phase => {
    await invariant()
    const value = { ...evidence, phase, uid: process.getuid(), parent: parentIdentity, business: businessIdentity,
      port, currentVersionId: runtime.gateway.versionId, clientCloses, modelCalls }
    await write(statusPath + '.tmp', value); await rename(statusPath + '.tmp', statusPath)
  }
  const command = async action => {
    const deadline = Date.now() + 150000
    while (Date.now() < deadline) {
      const value = await readFile(commandPath, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if (value?.action === action) return
      await delay(50)
    }
    throw Error('FIXTURE_COMMAND_TIMEOUT_' + action)
  }
  let base
  const select = async (id, finishBusiness = false) => {
    const response = await fetch(base + '/api/web-gateway-release', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ versionId: id }) })
    assert.equal(response.status, 202)
    assert.equal((await response.json()).webGatewayRelease.update.status, 'accepted')
    if (finishBusiness) business.send('finish')
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const value = await fetch(base + '/api/web-gateway-release').then(r => r.json()).catch(() => null)
      if (value?.webGatewayRelease.update?.status === 'failed') throw Error(value.webGatewayRelease.update.error)
      if (value?.webGatewayRelease.update?.status === 'succeeded') {
        assert.equal(value.webGatewayRelease.currentVersionId, id)
        const record = JSON.parse(await readFile(`${state}/web-gateway-release.json`, 'utf8'))
        assert.equal(record.currentVersionId, id)
        const st = await stat(`${state}/web-gateway-release.json`); assert.equal(st.uid, 1001); assert.equal(st.mode & 0o777, 0o600)
        await invariant(); evidence.checks.push({ selected: id, accepted202ThenSucceededGET: true, adoption: record }); return
      }
      await delay(25)
    }
    throw Error('FIXTURE_SELECT_TIMEOUT')
  }
  try {
    await runtime.start(); port = runtime.gateway.address.port; base = `http://127.0.0.1:${port}`
    const internal = `http://127.0.0.1:${runtime.internalServer.address().port}/api/web-gateway-release`
    assert.equal((await fetch(internal)).status, 403)
    assert.equal((await fetch(internal, { method: 'POST', body: JSON.stringify({ versionId: ids.a }) })).status, 403)
    await publish('ready')
    await command('adopt-a'); await select(ids.a)
    const oldA = await (await fetch(base + '/?v=' + ids.a)).text(); assert.ok(oldA.includes(ids.a))
    business = spawn(process.execPath, ['-e', `process.on('message',m=>{if(m==='finish')setTimeout(()=>process.send({pid:process.pid,result:'synthetic retained business'}),100)});setInterval(()=>{},1000)`], { env: {}, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
    await once(business, 'spawn'); businessIdentity = await identity(business.pid)
    business.once('message', value => { assert.equal(value.pid, business.pid); retained.resolve([value.result]) })
    const held = fetch(base + '/api/models'); await entered.promise
    await publish('a-held')
    await command('adopt-b'); await select(ids.b, true)
    assert.deepEqual(await (await held).json(), { models: ['synthetic retained business'] })
    assert.equal(modelCalls, 1)
    assert.equal(hash(await (await fetch(base + '/?v=' + ids.a)).text()), hash(oldA))
    const oldB = await (await fetch(base + '/?v=' + ids.b)).text(); assert.ok(oldB.includes(ids.b))
    evidence.checks.push({ heldRequestCompletedOnce: true, oldAAssetBytesRetained: true })
    await publish('b-active')
    await command('return-a'); await select(ids.a)
    assert.equal(hash(await (await fetch(base + '/?v=' + ids.b)).text()), hash(oldB))
    evidence.checks.push({ oldBAssetBytesRetained: true, parentAndBusinessIdentityUnchanged: true })
    await publish('done')
    await new Promise(() => {})
  } catch (error) {
    await write(statusPath, { ...evidence, phase: 'failed', error: error.message }); throw error
  }
}
