// Synthetic bootstrap/ports only; actual host generation, default loader and adoption store use accepted image bytes.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, writeFile, readFile, stat, chown, chmod, rename } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer } from 'node:http'
import { createHttpGatewayProcess } from '/app/src/http-gateway-process.mjs'
import { prepareServerStateRuntime } from '/app/src/server-state-transfer.mjs'

const mode = process.argv[2] ?? 'runtime', root = '/srv/bellteam', state = `${root}/state`
const statusPath = `${state}/fixture-status.json`, commandPath = `${state}/fixture-command.json`
const write = (path, value) => writeFile(path, JSON.stringify(value) + '\n', { mode: 0o600 })
if (mode === 'initialize') {
  assert.equal(process.getuid(), 0)
  for (const part of ['data', 'home', 'data/shared', 'data/shared/tools', 'data/bots']) {
    const path = '/fixture-runtime/' + part
    await mkdir(path, { recursive: true }); await chown(path, 1001, 1001); await chmod(path, 0o755)
  }
  const prepare = await prepareServerStateRuntime({ root: '/fixture-runtime', privateRoot: '/private' })
  const receipt = await readFile('/private/.prepared.json'), before = await stat('/private/.prepared.json')
  assert.equal((await prepareServerStateRuntime({ root: '/fixture-runtime', privateRoot: '/private' })).status, 'already-prepared')
  assert.deepEqual(await readFile('/private/.prepared.json'), receipt)
  assert.equal((await stat('/private/.prepared.json')).ino, before.ino)
  for (const part of ['state', 'rooms', 'owner', 'logs', 'bellteam-settings', 'apns']) {
    const path = '/private/' + part
    await mkdir(path, { recursive: true }); await chown(path, 1001, 1001); await chmod(path, 0o700)
  }
  const control = await stat('/private')
  assert.deepEqual([control.uid, control.gid, control.mode & 4095], [0, 1001, 0o750])
  console.log(JSON.stringify({ prepare, secondPrepareRetainsReceipt: true, private: '0:1001/0750' }))
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
  const { createExecutionNativeFixture } = await import('/app/test/helpers/execution-native-business.mjs')
  const fixture = createExecutionNativeFixture({ root }), controller = fixture.controller, checks = []
  const identity = async pid => ({ pid, startTime: (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1].split(' ')[19] })
  const parent = await identity(process.pid)
  const inspectLocks = async () => {
    const result = []
    for (const [fd, path, kind] of [[3, '/run/bellteam-maintenance', 'READ'], [4, state, 'WRITE']]) {
      const expected = await stat(path), actual = await stat(`/proc/self/fd/${fd}`)
      assert.equal(actual.dev, expected.dev); assert.equal(actual.ino, expected.ino)
      assert.match(await readFile(`/proc/self/fdinfo/${fd}`, 'utf8'), new RegExp(`^lock:\\s+\\d+:\\s+FLOCK\\s+ADVISORY\\s+${kind}\\s+${process.pid}\\s`, 'm'))
      result.push({ fd, dev: actual.dev, ino: actual.ino, kind })
    }
    return result
  }
  const parentLocks = await inspectLocks()
  let business, businessIdentity, gatewayIdentity, port, base, businessVerified = false
  const childIdentity = async entryName => {
    const pids = (await readFile(`/proc/${process.pid}/task/${process.pid}/children`, 'utf8')).trim().split(/ +/u).filter(Boolean)
    const matches = []
    for (const pid of pids) {
      const command = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
      if (command.includes(entryName)) matches.push(Number(pid))
    }
    assert.equal(matches.length, 1); return identity(matches[0])
  }
  const server = createServer((_request, response) => { response.writeHead(200); response.end('fixture') })
  const socketPath = '/run/bellteam-server/execution-fixture.sock'
  const gateway = createHttpGatewayProcess({ socketPath, port: 0, appRoot: '/app' })
  const invariant = async () => {
    assert.deepEqual(await identity(process.pid), parent)
    assert.deepEqual(await identity(business.pid), businessIdentity)
    assert.deepEqual(await childIdentity('src/http-gateway-entry.mjs'), gatewayIdentity)
    assert.equal(gateway.address.port, port); assert.equal((await fetch(base + '/api/fixture')).status, 200)
    assert.deepEqual(await inspectLocks(), parentLocks)
  }
  const publish = async phase => {
    await invariant(); const snapshot = controller.snapshot(); assert.equal(snapshot.available, true)
    await write(statusPath + '.tmp', { ...snapshot, runtimePhase: snapshot.phase, phase, checks, businessChecks: fixture.snapshot(),
      parent, business: businessIdentity, gateway: gatewayIdentity, port, parentLocks, parentLocksRetained: true,
      businessVerified, adoptionAcksVerified: checks.length === 2 })
    await rename(statusPath + '.tmp', statusPath)
  }
  const command = async action => {
    const deadline = Date.now() + 150000
    while (Date.now() < deadline) {
      const value = await readFile(commandPath, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if (value?.action === action) return
      await delay(50)
    }
    throw Error('EXECUTION_FIXTURE_COMMAND_TIMEOUT')
  }
  const replace = async target => {
    const before = controller.snapshot()
    await fixture.replace(target)
    const after = controller.snapshot()
    assert.notEqual(after.generation, before.generation)
    assert.equal(after.currentVersionId, target === 'builtin' ? null : target)
    const path = `${state}/execution-release.json`, st = await stat(path)
    assert.deepEqual([st.uid, st.gid, st.mode & 4095, st.nlink], [1001, 1001, 0o600, 1])
    const adoption = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(adoption.currentVersionId, after.currentVersionId)
    checks.push({ target, generation: after.generation, adoption, durableSelectionReadBack: true })
  }
  const progress = stage => write(statusPath, { phase: 'starting', stage })
  try {
    await progress('engine-start'); await fixture.start()
    assert.equal(controller.snapshot().builtinSourceCommit, ids.source)
    await progress('gateway-start'); await new Promise(resolve => server.listen(socketPath, resolve)); await gateway.start()
    port = gateway.address.port; base = `http://127.0.0.1:${port}`
    business = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: {}, stdio: 'ignore' })
    await once(business, 'spawn'); businessIdentity = await identity(business.pid); gatewayIdentity = await childIdentity('src/http-gateway-entry.mjs')
    await publish('ready'); await command('adopt-b')
    const release = `/run/bellteam-maintenance/execution/releases/${ids.b}`
    assert.equal(JSON.parse(await readFile(`${release}/manifest.json`, 'utf8')).sourceCommit, ids.source)
    await assert.rejects(writeFile(`${release}/payload/src/execution-dispatcher.mjs`, 'x'), error => ['EROFS', 'EACCES'].includes(error.code))
    await replace(ids.b); await publish('b-active'); await command('return-a'); await replace('builtin')
    await fixture.verify(); businessVerified = true
    await publish('done'); await command('finish')
    await fixture.close(); await gateway.close(); business.kill('SIGTERM'); await once(business, 'close')
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    assert.equal(controller.snapshot().phase, 'closed')
    await write(statusPath, { phase: 'closed', engineClosed: true, gatewayAndBusinessClosed: true, businessChecks: fixture.snapshot() })
    setInterval(() => {}, 1000); await new Promise(() => {})
  } catch (error) {
    await write(statusPath, { phase: 'failed', error: error.stack, checks }); throw error
  }
}
