// Synthetic bootstrap/data only; facade, controller, reader, fixed C and child use accepted image bytes.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { readFileSync, lstatSync } from 'node:fs'
import { mkdir, writeFile, readFile, stat, chown, chmod, rename, readlink } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer } from 'node:http'
import { createDiagnosticsProcess } from '/app/src/diagnostics-process.mjs'
import { createDiagnosticsFacade } from '/app/src/diagnostics-facade.mjs'
import { createHttpGatewayProcess } from '/app/src/http-gateway-process.mjs'
import { prepareServerStateRuntime } from '/app/src/server-state-transfer.mjs'

const mode = process.argv[2] ?? 'runtime', root = '/srv/bellteam', state = `${root}/state`
const statusPath = `${state}/fixture-status.json`, commandPath = `${state}/fixture-command.json`
const notes = `${root}/logs/fixture-investigations.json`, data = `${root}/logs/diagnostics.json`
const fingerprint = createHash('sha256').update('SERVER_HTTP_503:server').digest('hex')
const investigation = { summary: '人工設置別根拠', evidence: ['fixture/one'], updated_at: '2026-11-03T00:00:00Z' }
const write = (path, value) => writeFile(path, JSON.stringify(value) + '\n', { mode: 0o600 })
const hash = value => createHash('sha256').update(value).digest('hex')
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
  await write('/private/logs/fixture-investigations.json', { [fingerprint]: investigation })
  await chown('/private/logs/fixture-investigations.json', 1001, 1001)
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
  const entry = '/usr/local/libexec/bellteam-diagnostics-start', binary = await stat(entry)
  assert.deepEqual([binary.uid, binary.gid, binary.mode & 4095], [0, 0, 0o755])
  const children = [], events = [], checks = []
  const fileState = path => {
    try {
      const st = lstatSync(path); assert.ok(st.isFile()); assert.equal(st.nlink, 1)
      assert.deepEqual([st.uid, st.gid, st.mode & 4095], [1001, 1001, 0o600])
      return { bytes: st.size, sha256: hash(readFileSync(path)), mode: st.mode & 4095, mtimeMs: st.mtimeMs }
    } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }
  const savedState = () => ({ data: fileState(data), notes: fileState(notes) })
  const notesBefore = fileState(notes)
  // Observe the real spawn and close barriers without changing fixed command/options or child behavior.
  const observeSpawn = (command, args, options) => {
    assert.equal(command, entry); assert.deepEqual(options.env, { BELLTEAM_DIAGNOSTIC_INVESTIGATIONS: notes })
    assert.equal(options.serialization, 'advanced')
    for (const old of children) {
      assert.equal(old.exitCode, 0); assert.equal(old.signalCode, null); assert.equal(old.connected, false)
      assert.equal(old.stdout.closed, true); assert.equal(old.stderr.closed, true)
    }
    if (children.length) assert.deepEqual(savedState(), children.at(-1).savedAtClose)
    const child = spawn(command, args, options), index = children.length
    children.push(child); events.push({ event: 'spawn', index, pid: child.pid, target: args[0] })
    child.stderr.on('data', chunk => process.stderr.write(chunk))
    child.once('close', (code, signal) => {
      child.savedAtClose = savedState()
      events.push({ event: 'os-ipc-pipes-close', index, pid: child.pid, code, signal, connected: child.connected,
        stdoutClosed: child.stdout.closed, stderrClosed: child.stderr.closed, saved: child.savedAtClose })
    })
    return child
  }
  const controller = createDiagnosticsProcess({ root, investigationsFile: notes, spawnProcess: observeSpawn })
  const facade = createDiagnosticsFacade(controller)
  const identity = async pid => ({ pid, startTime: (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1].split(' ')[19] })
  const parent = await identity(process.pid)
  let business, businessIdentity, gatewayIdentity, port, base, originalLock, readonlyRestoreVerified = false, currentDataPreserved = false
  const childIdentity = async entryName => {
    const pids = (await readFile(`/proc/${process.pid}/task/${process.pid}/children`, 'utf8')).trim().split(/ +/u).filter(Boolean)
    const matches = []
    for (const pid of pids) {
      const command = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
      if (command.includes(entryName)) matches.push(Number(pid))
    }
    assert.equal(matches.length, 1); return identity(matches[0])
  }
  const inspectLock = async () => {
    const st = await stat(`${state}/diagnostics.lock`)
    assert.deepEqual([st.uid, st.gid, st.mode & 4095, st.nlink], [1001, 1001, 0o600, 1])
    return { dev: st.dev, ino: st.ino, uid: st.uid, mode: st.mode & 4095 }
  }
  const inspectChild = async target => {
    const child = children.at(-1), pid = child.pid
    const status = await readFile(`/proc/${pid}/status`, 'utf8')
    for (const kind of ['Uid', 'Gid']) assert.match(status, new RegExp(`^${kind}:\\s+1001\\s+1001\\s+1001\\s+1001\\s*$`, 'm'))
    const appRoot = target === 'builtin' ? '/app' : `/run/bellteam-maintenance/diagnostics/releases/${target}/payload`
    assert.equal(await readlink(`/proc/${pid}/cwd`), appRoot)
    assert.deepEqual((await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean),
      ['/usr/local/bin/node', `${appRoot}/src/diagnostics-entry.mjs`, target])
    const privateRoot = await stat('/run/bellteam-maintenance'), lock = await stat(`${state}/diagnostics.lock`)
    for (const [fd, expected, kind] of [[4, privateRoot, 'READ'], [5, lock, 'WRITE']]) {
      const actual = await stat(`/proc/${pid}/fd/${fd}`)
      assert.equal(actual.dev, expected.dev); assert.equal(actual.ino, expected.ino)
      assert.match(await readFile(`/proc/${pid}/fdinfo/${fd}`, 'utf8'), new RegExp(`^lock:\\s+\\d+:\\s+FLOCK\\s+ADVISORY\\s+${kind}\\s+${pid}\\s`, 'm'))
    }
    return { ...await identity(pid), target, uid: 1001, fixedEntry: true, locksVerified: true }
  }
  const server = createServer((_request, response) => { response.writeHead(200); response.end('fixture') })
  const socketPath = '/run/bellteam-server/diagnostics-fixture.sock'
  const gateway = createHttpGatewayProcess({ socketPath, port: 0, appRoot: '/app' })
  const progress = stage => write(statusPath, { phase: 'starting', stage, events })
  const invariant = async () => {
    assert.deepEqual(await identity(process.pid), parent)
    assert.deepEqual(await identity(business.pid), businessIdentity)
    assert.deepEqual(await childIdentity('src/http-gateway-entry.mjs'), gatewayIdentity)
    assert.equal(gateway.address.port, port); assert.equal((await fetch(base + '/api/fixture')).status, 200)
    assert.deepEqual(await inspectLock(), originalLock); assert.deepEqual(fileState(notes), notesBefore)
  }
  const publish = async phase => {
    await invariant(); const snapshot = controller.snapshot(); assert.equal(snapshot.available, true)
    await write(statusPath + '.tmp', { ...snapshot, runtimePhase: snapshot.phase, phase, checks, events, parent, business: businessIdentity,
      gateway: gatewayIdentity, port, currentDataPreserved, readonlyRestoreVerified,
      oldChildCloseBeforeRestore: checks.filter(c => c.oldCloseBeforeRestore).length === 2 })
    await rename(statusPath + '.tmp', statusPath)
  }
  const command = async action => {
    const deadline = Date.now() + 150000
    while (Date.now() < deadline) {
      const value = await readFile(commandPath, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if (value?.action === action) return
      await delay(50)
    }
    throw Error('DIAGNOSTICS_FIXTURE_COMMAND_TIMEOUT')
  }
  const replaceWithSave = async target => {
    const old = children.at(-1), before = controller.snapshot(), childCount = children.length
    const saving = facade.record({ code: 'SERVER_HTTP_503', module: 'server' })
    const replacing = controller.replace(target)
    const row = await saving; await saving.completion
    await replacing
    assert.equal(children.length, childCount + 1)
    assert.notEqual(controller.snapshot().generation, before.generation)
    assert.deepEqual(savedState(), old.savedAtClose, 'restore does not rewrite saved data or notes')
    const selected = await inspectChild(target), adoption = JSON.parse(await readFile(`${state}/diagnostics-release.json`, 'utf8'))
    assert.equal(adoption.currentVersionId, target === 'builtin' ? null : target)
    fileState(`${state}/diagnostics-release.json`)
    assert.equal((await facade.list())[0].occurrence_count, row.occurrence_count)
    checks.push({ target, adoption, oldCloseBeforeRestore: true, readonlyRestore: true, selected, occurrenceCount: row.occurrence_count })
  }
  try {
    await progress('controller-start'); await facade.initialize(); originalLock = await inspectLock()
    checks.push({ initial: await inspectChild('builtin') })
    await progress('record'); const row = await facade.record({ code: 'SERVER_HTTP_503', module: 'server', diagnostic_log: 'retained original\n本文' })
    assert.equal(row.fingerprint, fingerprint)
    await facade.setStatus(fingerprint, 'resolved', { note: 'retained management note' })
    const list = await facade.list(); assert.deepEqual(list[0].investigation, investigation)
    await progress('gateway-start'); await new Promise(resolve => server.listen(socketPath, resolve)); await gateway.start()
    port = gateway.address.port; base = `http://127.0.0.1:${port}`
    business = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: {}, stdio: 'ignore' })
    await once(business, 'spawn'); businessIdentity = await identity(business.pid); gatewayIdentity = await childIdentity('src/http-gateway-entry.mjs')
    await publish('ready'); await command('adopt-b')
    const rootPath = `/run/bellteam-maintenance/diagnostics/releases/${ids.b}`
    const manifest = JSON.parse(await readFile(`${rootPath}/manifest.json`, 'utf8'))
    assert.equal(manifest.sourceCommit, ids.source)
    const installedEntry = `${rootPath}/payload/src/diagnostics-entry.mjs`
    await assert.rejects(writeFile(installedEntry, 'x'), error => ['EROFS', 'EACCES'].includes(error.code))
    await replaceWithSave(ids.b)
    await facade.setNote(fingerprint, 'latest note on signed generation')
    await publish('b-active'); await command('return-a'); await replaceWithSave('builtin')
    const [returned] = await facade.list()
    assert.equal(returned.occurrence_count, 3); assert.equal(returned.status, 'open')
    assert.equal(returned.diagnostic_log, 'retained original\n本文')
    assert.equal(returned.investigation_note.summary, 'latest note on signed generation')
    assert.deepEqual(returned.investigation, investigation)
    readonlyRestoreVerified = currentDataPreserved = true
    await publish('done'); await command('finish')
    await controller.close(); await gateway.close(); business.kill('SIGTERM'); await once(business, 'close')
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    assert.equal(controller.snapshot().phase, 'closed'); assert.equal(children.length, 3)
    for (const child of children) { assert.equal(child.exitCode, 0); assert.equal(child.connected, false); assert.equal(child.stdout.closed, true); assert.equal(child.stderr.closed, true) }
    await assert.rejects(facade.record({ code: 'SERVER_HTTP_503', module: 'server' }), { code: 'DIAGNOSTICS_NOT_ACCEPTING' })
    await write(statusPath, { phase: 'closed', diagnosticsChildrenEnded: true, gatewayAndBusinessClosed: true, events })
    setInterval(() => {}, 1000); await new Promise(() => {})
  } catch (error) {
    await write(statusPath, { phase: 'failed', error: error.stack, checks, events }); throw error
  }
}
