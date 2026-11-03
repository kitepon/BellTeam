// Synthetic bootstrap/client/business only; member runtime and entry are exact image code.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { cp, readdir, mkdir, writeFile, readFile, stat, chown, chmod, rename } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer } from 'node:http'
import { createMembersAssembly } from '/app/src/members-assembly.mjs'
import { MembersAdmission } from '/app/src/members-admission.mjs'
import { createMembersOwnerAuthorization } from '/app/src/members-owner-authorization.mjs'
import { createHttpGatewayProcess } from '/app/src/http-gateway-process.mjs'

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
  await cp('/fixture-members-state/state/bots', '/private/state/bots', { recursive: true })
  await cp('/fixture-members-state/owner', '/private/owner', { recursive: true })
  const secure = async path => {
    const info = await stat(path); await chown(path, 1001, 1001); await chmod(path, info.isDirectory() ? 0o700 : 0o600)
    if (info.isDirectory()) for (const name of await readdir(path)) await secure(`${path}/${name}`)
  }
  await secure('/private/state/bots'); await secure('/private/owner')
  await mkdir('/fixture-runtime/data/bots/bot-fixture', { recursive: true })
  await chown('/fixture-runtime/data/bots', 1001, 1001); await chmod('/fixture-runtime/data/bots', 0o755)
  await chown('/fixture-runtime/data/bots/bot-fixture', 1001, 1001)
  console.log(JSON.stringify({ initialized: true, syntheticDataOwner: 1001, privateOwner: '0:1001/0750' }))
} else if (mode === 'status') {
  console.log(await readFile(statusPath, 'utf8'))
} else if (mode === 'command') {
  const action = process.argv[3]
  assert.ok(['adopt-b', 'return-a', 'finish'].includes(action))
  await write(commandPath, { action })
} else {
  assert.equal(mode, 'runtime'); assert.equal(process.getuid(), 1001); assert.equal(process.getgid(), 1001)
  assert.equal(Number(process.versions.node.split('.')[0]), 26)
  await assert.rejects(writeFile('/app/fixture-readonly', 'x'), { code: 'EROFS' })
  const ids = JSON.parse(await readFile('/fixture-input.json', 'utf8'))
  assert.match(ids.b, /^[a-f0-9]{64}$/); assert.match(ids.source, /^[a-f0-9]{40}$/)
  const lockPath = `${state}/members.lock`
  const preserved = ['state/bots/.initialized', 'state/bots/bot-fixture/bot.json',
    'state/bots/bot-fixture/schedule.json', 'owner/profile.json', 'owner/user-rules.md']
  const savedHashes = async () => Object.fromEntries(await Promise.all(preserved.map(async path => [path, hash(await readFile('/srv/bellteam/' + path))])))
  const initialHashes = await savedHashes(), savedStateHash = hash(JSON.stringify(initialHashes))
  let business, port, gatewayIdentity
  const members = createMembersAssembly({ root: '/srv/bellteam', seatRuntime: null,
    aiterm: { command: 'synthetic-never-run', args: [] }, settings: { configuration: () => ({ enabled: false }) },
    models: { forHarness: async () => { throw Error('UNEXPECTED_MODEL_EFFECT') } },
    membersAdmission: new MembersAdmission(), membersAuthorization: createMembersOwnerAuthorization(),
    diagnostics: { record: async () => {} }, dependencies: () => ({}) })
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"fixture":true}') })
  const socketPath = '/run/bellteam-server/members-fixture.sock'
  const gateway = createHttpGatewayProcess({ socketPath, port: 0, appRoot: '/app' })
  const runtime = { services: { members, bots: members.bots }, gateway, async start() {
    await members.controller.start()
    await new Promise(resolve => server.listen(socketPath, resolve))
    await gateway.start()
  } }
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
  const evidence = { checks: [], scope: 'same-source builtin/archive/builtin; real C/locks/reader/installer; synthetic business, controller boundary, synthetic parent business, no AI or public Update coordinator' }
  const inspectLock = async () => {
    const value = await stat(lockPath)
    assert.equal(value.uid, 1001); assert.equal(value.gid, 1001); assert.equal(value.nlink, 1); assert.equal(value.mode & 4095, 0o600)
    return { ino: value.ino, uid: value.uid, gid: value.gid, mode: value.mode & 4095, nlink: value.nlink }
  }
  const invariant = async () => {
    assert.deepEqual(await identity(process.pid), parentIdentity)
    if (businessIdentity) assert.deepEqual(await identity(business.pid), businessIdentity)
    if (gatewayIdentity) assert.deepEqual(await childIdentity('src/http-gateway-entry.mjs'), gatewayIdentity)
    assert.equal(runtime.gateway.address.port, port)
    assert.deepEqual(await savedHashes(), initialHashes)
    if (firstLock) assert.deepEqual(await inspectLock(), firstLock)
  }
  const value = async () => runtime.services.members.controller.snapshot()
  const publish = async phase => {
    await invariant()
    assert.equal((await fetch(base + '/api/fixture')).status, 200)
    const snapshot = await value()
    assert.equal(snapshot.available, true)
    assert.equal(snapshot.builtinSourceCommit, ids.source)
    const record = { ...evidence, phase, parent: parentIdentity, business: businessIdentity, gateway: gatewayIdentity,
      member: await childIdentity('src/members-entry.mjs'), port, currentVersionId: snapshot.currentVersionId,
      currentTarget: snapshot.currentTarget, savedStateSha256: savedStateHash, writerLock: await inspectLock(), sharedMcpClientConstructed: false }
    await write(statusPath + '.tmp', record); await rename(statusPath + '.tmp', statusPath)
  }
  const command = async action => {
    const deadline = Date.now() + 150000
    while (Date.now() < deadline) {
      const record = await readFile(commandPath, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if (record?.action === action) return
      await delay(50)
    }
    throw Error('MEMBERS_FIXTURE_COMMAND_TIMEOUT')
  }
  const select = async target => {
    const previous = await childIdentity('src/members-entry.mjs')
    const pending = runtime.services.members.controller.reserve(target)
    assert.equal((await value()).update.status, 'accepted'); pending.start()
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      const snapshot = await value()
      if (snapshot.update?.status === 'failed') throw Error(snapshot.update.error)
      if (snapshot.update?.status === 'succeeded') {
        assert.equal(snapshot.currentVersionId, target === 'builtin' ? null : target)
        assert.notDeepEqual(await childIdentity('src/members-entry.mjs'), previous)
        const old = await identity(previous.pid).catch(error => { if (error.code === 'ENOENT') return null; throw error })
        assert.notDeepEqual(old, previous)
        const adoption = JSON.parse(await readFile(`${state}/members-release.json`, 'utf8'))
        assert.equal(adoption.currentVersionId, target === 'builtin' ? null : target)
        const info = await stat(`${state}/members-release.json`); assert.equal(info.uid, 1001); assert.equal(info.mode & 4095, 0o600)
        await invariant(); evidence.checks.push({ selected: target, adoption, reservedThenSucceededSnapshot: true, oldChildEnded: true }); return
      }
      await delay(25)
    }
    throw Error('MEMBERS_FIXTURE_SELECT_TIMEOUT')
  }
  try {
    await runtime.start(); port = runtime.gateway.address.port; base = `http://127.0.0.1:${port}`
    business = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: {}, stdio: 'ignore' })
    await once(business, 'spawn'); businessIdentity = await identity(business.pid)
    gatewayIdentity = await childIdentity('src/http-gateway-entry.mjs'); firstLock = await inspectLock()
    const initial = await value(); assert.equal(initial.currentVersionId, null); assert.equal(initial.currentTarget, 'builtin')
    assert.equal((await runtime.services.bots.listForClient()).length, 1)
    const schedules = await runtime.services.bots.listSchedules('bot-fixture')
    assert.equal(schedules.length, 1); assert.equal(schedules[0].enabled, false)
    const second = spawn('/usr/local/libexec/bellteam-members-start', ['builtin'], { env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    assert.deepEqual(await once(second, 'close'), [126, null]); evidence.checks.push({ concurrentWriterRejectedByRealLock: true })
    await publish('ready')
    await command('adopt-b'); await select(ids.b); await publish('b-active')
    await command('return-a'); await select('builtin'); await publish('done')
    await command('finish')
    const last = await childIdentity('src/members-entry.mjs')
    await members.controller.close(); await gateway.close()
    business.kill('SIGTERM'); await once(business, 'close')
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    assert.equal(await identity(last.pid).catch(error => { if (error.code === 'ENOENT') return null; throw error }), null)
    assert.deepEqual(await savedHashes(), initialHashes)
    await write(statusPath, { phase: 'closed', membersChildEnded: true, gatewayAndBusinessClosed: true, preserved: initialHashes })
    setInterval(() => {}, 1000)
    await new Promise(() => {})
  } catch (error) {
    await write(statusPath, { ...evidence, phase: 'failed', error: error.message }); throw error
  }
}
