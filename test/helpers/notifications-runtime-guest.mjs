// Synthetic bootstrap/client/business only; notification runtime and entry are exact image code.
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
  for (const part of ['data', 'home', 'data/bots', 'data/shared', 'data/shared/tools']) {
    const path = '/fixture-runtime/' + part
    await mkdir(path, { recursive: true }); await chown(path, 1001, 1001); await chmod(path, 0o755)
    const info = await stat(path)
    assert.equal(info.uid, 1001); assert.equal(info.gid, 1001); assert.equal(info.mode & 0o777, 0o755)
  }
  await chown('/fixture-runtime/data', 1000, 1000); await chmod('/fixture-runtime/data', 0o711)
  console.log(JSON.stringify({ initialized: true, syntheticDataOwner: 1000, privateOwner: '0:1001/0750' }))
} else if (mode === 'status') {
  console.log(await readFile(statusPath, 'utf8'))
} else if (mode === 'command') {
  const action = process.argv[3]
  assert.ok(['adopt-b', 'return-a'].includes(action))
  await write(commandPath, { action })
} else {
  assert.equal(mode, 'runtime'); assert.equal(process.getuid(), 1001); assert.equal(process.getgid(), 1001)
  assert.equal(Number(process.versions.node.split('.')[0]), 26)
  await assert.rejects(writeFile('/app/fixture-readonly', 'x'), { code: 'EROFS' })
  const ids = JSON.parse(await readFile('/fixture-input.json', 'utf8'))
  assert.match(ids.b, /^[a-f0-9]{64}$/); assert.match(ids.source, /^[a-f0-9]{40}$/)
  const devicesPath = `${state}/push-devices.json`, lockPath = `${state}/notifications.lock`
  const { writeNotificationsWebFixture } = await import('/app/test/fixtures/notifications-web-push-state.mjs')
  const fixture = await writeNotificationsWebFixture('/srv/bellteam')
  const devicesHash = hash(await readFile(devicesPath))
  const savedState = async () => Object.fromEntries(await Promise.all(['push-devices.json', 'web-push-keys.json', 'web-push-subscriptions.json'].map(async name => {
    const path = `${state}/${name}`, info = await stat(path)
    assert.equal(info.uid, 1001); assert.equal(info.mode & 0o7777, 0o600); assert.equal(info.nlink, 1)
    return [name, hash(await readFile(path))]
  })))
  const seeded = await savedState()
  let retainedState
  const seedPath = `${state}/fixture-seed.json`
  await write(seedPath, { schema: 'bellteam.bots.v1', bots: [] })
  const bots = new BotRegistry({ seedPath, botsRoot: '/srv/bellteam/bots' })
  const settings = new FeatureSettings({ root: '/srv/bellteam', environment: {} })
  const ownerProfile = new OwnerProfile({ root: '/srv/bellteam' }), userRules = new UserRules({ root: '/srv/bellteam' })
  for (const value of [bots, settings, ownerProfile, userRules]) await value.initialize()
  let clientCloses = 0, business, port, gatewayIdentity
  const runtime = await createApplicationRuntime({ root: '/srv/bellteam', appRoot: '/app', home: '/home/bell',
    environment: { BELLTEAM_WEB_PORT: '0', BELLTEAM_INTERNAL_PORT: '0' },
    bootstrap: { bots, settings, ownerProfile, userRules, refreshGlobalInstructions: async () => {},
      aiterm: { command: 'synthetic-never-run', args: [] }, models: { list: async () => [] } },
    client: { async call() { return { content: [{ type: 'text', text: '(セッション無し)' }] } }, async close() { clientCloses++ } },
  })
  const identity = async pid => ({ pid, startTime: (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1].split(' ')[19] })
  const childIdentity = async entry => {
    const children = (await readFile(`/proc/${process.pid}/task/${process.pid}/children`, 'utf8')).trim().split(/ +/u).filter(Boolean)
    const matches = []
    for (const pid of children) {
      const command = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
      if (command.includes(entry)) matches.push(Number(pid))
    }
    assert.equal(matches.length, 1, entry)
    return identity(matches[0])
  }
  const parentIdentity = await identity(process.pid)
  let businessIdentity, base, firstLock
  const evidence = { checks: [], scope: 'same-source builtin/archive/builtin; real C/locks/reader/installer; synthetic business, no APNs/AI' }
  const inspectLock = async () => {
    const value = await stat(lockPath)
    assert.equal(value.uid, 1001); assert.equal(value.gid, 1001); assert.equal(value.nlink, 1); assert.equal(value.mode & 4095, 0o600)
    return { ino: value.ino, uid: value.uid, gid: value.gid, mode: value.mode & 4095, nlink: value.nlink }
  }
  const invariant = async () => {
    assert.deepEqual(await identity(process.pid), parentIdentity)
    if (businessIdentity) assert.deepEqual(await identity(business.pid), businessIdentity)
    if (gatewayIdentity) assert.deepEqual(await childIdentity('src/http-gateway-entry.mjs'), gatewayIdentity)
    assert.equal(clientCloses, 0); assert.equal(runtime.gateway.address.port, port)
    assert.equal(hash(await readFile(devicesPath)), devicesHash)
    if (firstLock) assert.deepEqual(await inspectLock(), firstLock)
    if (retainedState) assert.deepEqual(await savedState(), retainedState)
  }
  const value = async () => {
    const response = await fetch(base + '/api/notifications-release'); assert.equal(response.status, 200)
    return (await response.json()).notificationsRelease
  }
  const publish = async phase => {
    await invariant()
    const snapshot = await value()
    assert.equal(snapshot.available, true); assert.equal(snapshot.status.apns.configured, false)
    assert.equal(snapshot.protocolVersion, 2); assert.equal(snapshot.stateSchema, 2)
    assert.equal(snapshot.status.webPush.enabled, true)
    assert.equal(snapshot.status.webPush.publicKey, fixture.applicationServerKey)
    assert.equal(snapshot.applyError.webPush, null)
    assert.equal(snapshot.appliedEpoch.webPush, snapshot.configurationEpoch)
    assert.equal(snapshot.builtinSourceCommit, ids.source)
    const record = { ...evidence, phase, parent: parentIdentity, business: businessIdentity, gateway: gatewayIdentity,
      notification: await childIdentity('src/notifications-entry.mjs'), port, currentVersionId: snapshot.currentVersionId,
      currentTarget: snapshot.currentTarget, configurationEpoch: snapshot.configurationEpoch, appliedEpoch: snapshot.appliedEpoch,
      webConfiguration: settings.configuration('webPush'), stateSha256: await savedState(), devicesSha256: devicesHash, writerLock: await inspectLock(), clientCloses }
    await write(statusPath + '.tmp', record); await rename(statusPath + '.tmp', statusPath)
  }
  const originChecks = async (replace = false) => {
    const notifications = runtime.services.notifications
    const endpoint = replace ? fixture.subscription.endpoint : fixture.replacementSubscription.endpoint
    const before = await savedState(), settingsBefore = hash(await readFile(settings.path))
    assert.deepEqual(await notifications.webStatus(endpoint, fixture.origin), { registered: true })
    assert.deepEqual(await notifications.webStatus(endpoint, fixture.otherOrigin), { registered: false })
    assert.deepEqual(await notifications.webUnregister({ endpoint }, fixture.otherOrigin), { registered: false })
    const input = { subscription: replace ? fixture.subscription : fixture.replacementSubscription, applicationServerKey: fixture.applicationServerKey }
    await assert.rejects(notifications.webStatus(endpoint), { code: 'WEB_PUSH_INPUT_INVALID' })
    for (const origin of [undefined, 'https://bellteam-fixture.example/path'])
      await assert.rejects(notifications.webRegister(input, origin), { code: 'WEB_PUSH_INPUT_INVALID' })
    await assert.rejects(notifications.webRegister(input, fixture.otherOrigin), { code: 'WEB_PUSH_SUBSCRIPTION_CONFLICT', status: 409 })
    for (const previousEndpoint of [fixture.foreignSubscription.endpoint, 'https://fcm.googleapis.com/missing'])
      await assert.rejects(notifications.webRegister({ ...input, previousEndpoint }, fixture.origin), { code: 'WEB_PUSH_SUBSCRIPTION_CONFLICT', status: 409 })
    assert.deepEqual(await savedState(), before)
    assert.equal(hash(await readFile(settings.path)), settingsBefore)
    if (replace) {
      assert.deepEqual(await notifications.webRegister({ subscription: fixture.replacementSubscription,
        applicationServerKey: fixture.applicationServerKey, previousEndpoint: fixture.subscription.endpoint }, fixture.origin), { registered: true })
      assert.deepEqual(await notifications.webStatus(fixture.subscription.endpoint, fixture.origin), { registered: false })
      assert.deepEqual(await notifications.webStatus(fixture.replacementSubscription.endpoint, fixture.origin), { registered: true })
      retainedState = await savedState()
      assert.equal(retainedState['push-devices.json'], seeded['push-devices.json'])
      assert.equal(retainedState['web-push-keys.json'], seeded['web-push-keys.json'])
    }
    evidence.checks.push({ originOwnership: true, malformedOriginRejected: true, conflict409AllFilesUnchanged: true, sameOriginReplacement: replace })
  }
  const latestConfiguration = async subject => {
    await settings.update('webPush', { enabled: true, values: { subject } })
    const current = runtime.services.notifications.controller.snapshot()
    assert.equal(current.appliedEpoch.webPush, current.configurationEpoch)
    await assert.rejects(runtime.services.notifications.configureWebPush({ enabled: false, subject: '' }), { code: 'PUSH_CONFIGURATION_STALE', status: 409 })
    return current.configurationEpoch
  }
  const command = async action => {
    const deadline = Date.now() + 150000
    while (Date.now() < deadline) {
      const record = await readFile(commandPath, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if (record?.action === action) return
      await delay(50)
    }
    throw Error('NOTIFICATIONS_FIXTURE_COMMAND_TIMEOUT')
  }
  const select = async target => {
    const previous = await childIdentity('src/notifications-entry.mjs')
    const response = await fetch(base + '/api/notifications-release', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ versionId: target }) })
    assert.equal(response.status, 202)
    assert.equal((await response.json()).notificationsRelease.update.status, 'accepted')
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      const snapshot = await value()
      if (snapshot.update?.status === 'failed') throw Error(snapshot.update.error)
      if (snapshot.update?.status === 'succeeded') {
        assert.equal(snapshot.currentVersionId, target === 'builtin' ? null : target)
        assert.notDeepEqual(await childIdentity('src/notifications-entry.mjs'), previous)
        const old = await identity(previous.pid).catch(error => { if (error.code === 'ENOENT') return null; throw error })
        assert.notDeepEqual(old, previous)
        const adoption = JSON.parse(await readFile(`${state}/notifications-release.json`, 'utf8'))
        assert.equal(adoption.currentVersionId, target === 'builtin' ? null : target)
        const info = await stat(`${state}/notifications-release.json`); assert.equal(info.uid, 1001); assert.equal(info.mode & 4095, 0o600)
        await invariant(); evidence.checks.push({ selected: target, adoption, accepted202ThenSucceededGET: true, oldChildEnded: true }); return
      }
      await delay(25)
    }
    throw Error('NOTIFICATIONS_FIXTURE_SELECT_TIMEOUT')
  }
  try {
    await runtime.start(); port = runtime.gateway.address.port; base = `http://127.0.0.1:${port}`
    business = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: {}, stdio: 'ignore' })
    await once(business, 'spawn'); businessIdentity = await identity(business.pid)
    gatewayIdentity = await childIdentity('src/http-gateway-entry.mjs'); firstLock = await inspectLock()
    const initial = await value(); assert.equal(initial.currentVersionId, null); assert.equal(initial.currentTarget, 'builtin')
    const internal = `http://127.0.0.1:${runtime.internalServer.address().port}/api/notifications-release`
    assert.equal((await fetch(internal)).status, 403)
    assert.equal((await fetch(internal, { method: 'POST', body: JSON.stringify({ versionId: ids.b }) })).status, 403)
    const second = spawn('/usr/local/libexec/bellteam-notifications-start', ['builtin'], { env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    assert.deepEqual(await once(second, 'close'), [126, null]); evidence.checks.push({ concurrentWriterRejectedByRealLock: true })
    await latestConfiguration('mailto:first@example.com'); await originChecks(true)
    await publish('ready')
    await command('adopt-b'); await latestConfiguration('mailto:archive@example.com'); await select(ids.b); await originChecks(); await publish('b-active')
    await command('return-a'); await latestConfiguration('mailto:latest@example.com'); await select('builtin'); await originChecks(); await publish('done')
    await new Promise(() => {})
  } catch (error) {
    await write(statusPath, { ...evidence, phase: 'failed', error: error.message }); throw error
  }
}
