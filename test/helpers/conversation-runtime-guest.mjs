// Synthetic data/native ports; actual ApplicationRuntime, conversation C, loader, child and adoption use the accepted image.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { readlink } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, writeFile, readFile, stat, chown, chmod, rename } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
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
  const [{ createApplicationRuntime }, { createConversationAssembly }, { createConversationProcess }, { BotRegistry }, { FeatureSettings }, { OwnerProfile }, { UserRules }, { createSyntheticNotificationsProcess }, { createConversationPreservationFixture }, { createConversationExecutionLifetimeFixture }] = await Promise.all([
    import('/app/src/application-runtime.mjs'),
    import('/app/src/conversation-assembly.mjs'),
    import('/app/src/conversation-process.mjs'),
    import('/app/src/bot-registry.mjs'),
    import('/app/src/feature-settings.mjs'),
    import('/app/src/owner-profile.mjs'),
    import('/app/src/user-rules.mjs'),
    import('/app/test/helpers/notifications-process.mjs'),
    import('/app/test/helpers/conversation-preservation.mjs'),
    import('/app/test/helpers/conversation-execution-lifetime.mjs'),
  ])
  await assert.rejects(writeFile('/app/fixture-readonly', 'x'), { code: 'EROFS' })
  const ids = JSON.parse(await readFile('/fixture-input.json', 'utf8'))
  assert.match(ids.b, /^[a-f0-9]{64}$/); assert.match(ids.source, /^[a-f0-9]{40}$/)
  const entry = '/usr/local/libexec/bellteam-conversation-start', binary = await stat(entry)
  assert.deepEqual([binary.uid, binary.gid, binary.mode & 4095], [0, 0, 0o755])
  const fixture = await createConversationPreservationFixture({ root, appRoot: '/app' })
  const lifetime = createConversationExecutionLifetimeFixture({ botId: fixture.botId })
  const children = [], events = [], checks = [], busyCases = []
  const hash = value => createHash('sha256').update(value).digest('hex')
  const savedState = () => {
    const result = {}
    const scan = directory => {
      for (const name of readdirSync(directory)) {
        if (directory === state && (/^fixture-/.test(name) || ['conversation.lock', 'conversation-release.json'].includes(name))) continue
        const path = `${directory}/${name}`, st = lstatSync(path)
        assert.equal(st.isSymbolicLink(), false)
        if (st.isDirectory()) scan(path)
        else {
          assert.equal(st.isFile(), true); assert.equal(st.nlink, 1)
          result[path] = { bytes: st.size, sha256: hash(readFileSync(path)), mode: st.mode & 4095, uid: st.uid, gid: st.gid, mtimeMs: st.mtimeMs }
        }
      }
    }
    for (const directory of ['state', 'rooms', 'logs', 'owner']) scan(`${root}/${directory}`)
    return result
  }
  const observeSpawn = (command, args, options) => {
    assert.equal(command, entry); assert.deepEqual(options.env, {}); assert.equal(options.serialization, 'advanced')
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
  const bots = new BotRegistry({ seedPath: fixture.seedPath, botsRoot: `${root}/bots` })
  const settings = new FeatureSettings({ root, environment: {} }), ownerProfile = new OwnerProfile({ root }), userRules = new UserRules({ root })
  for (const value of [bots, settings, ownerProfile, userRules]) await value.initialize()
  let runtime, controller, business, businessIdentity, gatewayIdentity, port, base, originalLock
  let businessVerified = false, readonlyRestoreVerified = false
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
  const inspectChild = async target => {
    const child = children.at(-1), pid = child.pid, status = await readFile(`/proc/${pid}/status`, 'utf8')
    for (const kind of ['Uid', 'Gid']) assert.match(status, new RegExp(`^${kind}:\\s+1001\\s+1001\\s+1001\\s+1001\\s*$`, 'm'))
    const appRoot = target === 'builtin' ? '/app' : `/run/bellteam-maintenance/conversation/releases/${target}/payload`
    assert.equal(await readlink(`/proc/${pid}/cwd`), appRoot)
    assert.deepEqual((await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean), ['/usr/local/bin/node', `${appRoot}/src/conversation-entry.mjs`, target])
    const lock = await stat(`${state}/conversation.lock`), privateRoot = await stat('/run/bellteam-maintenance')
    for (const [fd, expected, kind] of [[4, privateRoot, 'READ'], [5, lock, 'WRITE']]) {
      const actual = await stat(`/proc/${pid}/fd/${fd}`)
      assert.equal(actual.dev, expected.dev); assert.equal(actual.ino, expected.ino)
      assert.match(await readFile(`/proc/${pid}/fdinfo/${fd}`, 'utf8'), new RegExp(`^lock:\\s+\\d+:\\s+FLOCK\\s+ADVISORY\\s+${kind}\\s+${pid}\\s`, 'm'))
    }
    assert.deepEqual([lock.uid, lock.gid, lock.mode & 4095, lock.nlink], [1001, 1001, 0o600, 1])
    return { ...await identity(pid), target, fixedEntry: true, uid: 1001, locksVerified: true }
  }
  const inspectLock = async () => {
    const lock = await stat(`${state}/conversation.lock`)
    return { dev: lock.dev, ino: lock.ino, uid: lock.uid, mode: lock.mode & 4095 }
  }
  const gatewayBirth = async () => {
    const pids = (await readFile(`/proc/${process.pid}/task/${process.pid}/children`, 'utf8')).trim().split(/ +/u).filter(Boolean)
    const matches = []
    for (const pid of pids) {
      const command = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
      if (command.includes('src/http-gateway-entry.mjs')) matches.push(Number(pid))
    }
    assert.equal(matches.length, 1); return identity(matches[0])
  }
  const invariant = async () => {
    assert.deepEqual(await identity(process.pid), parent); assert.deepEqual(await identity(business.pid), businessIdentity)
    assert.deepEqual(await gatewayBirth(), gatewayIdentity); assert.equal(runtime.gateway.address.port, port)
    assert.equal((await fetch(base + '/api/settings')).status, 200)
    assert.deepEqual(await inspectLocks(), parentLocks); assert.deepEqual(await inspectLock(), originalLock)
    assert.equal(runtime.services.transport.client, lifetime.client)
  }
  const publish = async phase => {
    await invariant(); const snapshot = controller.snapshot(); assert.equal(snapshot.available, true)
    await write(statusPath + '.tmp', { ...snapshot, runtimePhase: snapshot.phase, phase, checks, businessChecks: { state: await fixture.snapshot(), counts: fixture.counts(), receipts: fixture.receipts }, events,
      parent, business: businessIdentity, gateway: gatewayIdentity, port, parentLocks, parentLocksRetained: true,
      businessVerified, adoptionAcksVerified: checks.filter(value => value.target).length === 4,
      oldChildCloseBeforeRestore: checks.filter(value => value.oldCloseBeforeRestore).length === 4,
      readonlyRestoreVerified, actualApplicationRuntime: true, busyCases, lifetimeChecks: lifetime.snapshot() })
    await rename(statusPath + '.tmp', statusPath)
  }
  const command = async action => {
    const deadline = Date.now() + 300000
    while (Date.now() < deadline) {
      const value = await readFile(commandPath, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if (value?.action === action) return
      await delay(50)
    }
    throw Error('CONVERSATION_FIXTURE_COMMAND_TIMEOUT')
  }
  const replace = async target => {
    const before = controller.snapshot(), old = children.at(-1), childCount = children.length
    await controller.replace(target)
    assert.equal(children.length, childCount + 1); assert.notEqual(controller.snapshot().generation, before.generation)
    assert.deepEqual(savedState(), old.savedAtClose)
    const selected = await inspectChild(target), path = `${state}/conversation-release.json`, st = await stat(path)
    assert.deepEqual([st.uid, st.gid, st.mode & 4095, st.nlink], [1001, 1001, 0o600, 1])
    const adoption = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(adoption.currentVersionId, target === 'builtin' ? null : target)
    checks.push({ target, generation: controller.snapshot().generation, adoption, durableSelectionReadBack: true,
      oldCloseBeforeRestore: true, readonlyRestore: true, selected })
  }
  const progress = stage => write(statusPath, { phase: 'starting', stage, events })
  try {
    await progress('application-create')
    runtime = await createApplicationRuntime({ root, appRoot: '/app', home: '/home/bell',
      environment: { BELLTEAM_WEB_PORT: '0', BELLTEAM_INTERNAL_PORT: '0' }, client: lifetime.client,
      bootstrap: { bots, settings, ownerProfile, userRules, refreshGlobalInstructions: async () => {},
        aiterm: { command: 'synthetic', args: [] }, olrwManagement: null,
        createNotificationsProcess: createSyntheticNotificationsProcess,
        createExecutionAssembly: lifetime.createExecutionAssembly,
        createConversationAssembly: options => createConversationAssembly({ ...options,
          createProcess: options => {
            const preserve = fixture.wrapEffects(options.onEffect)
            return createConversationProcess({ ...options, spawnProcess: observeSpawn,
              onEffect: preserve })
          } }),
      } })
    lifetime.attach(runtime)
    controller = runtime.services.conversationAssembly.controller
    originalLock = await inspectLock(); checks.push({ initial: await inspectChild('builtin') })
    await progress('application-start'); await runtime.start()
    port = runtime.gateway.address.port; base = `http://127.0.0.1:${port}`; gatewayIdentity = await gatewayBirth()
    business = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: {}, stdio: 'ignore' })
    await once(business, 'spawn'); businessIdentity = await identity(business.pid)
    await fixture.exercise({ runtime, label: 'builtin-before', versionId: 'builtin' })
    await publish('ready'); await command('adopt-b')
    const release = `/run/bellteam-maintenance/conversation/releases/${ids.b}`
    assert.equal(JSON.parse(await readFile(`${release}/manifest.json`, 'utf8')).sourceCommit, ids.source)
    await assert.rejects(writeFile(`${release}/payload/src/conversation-entry.mjs`, 'x'), error => ['EROFS', 'EACCES'].includes(error.code))
    await replace(ids.b); await fixture.exercise({ runtime, label: 'signed', versionId: ids.b })
    await publish('b-active'); await command('return-a'); await replace('builtin')
    await fixture.exercise({ runtime, label: 'builtin-return', versionId: 'builtin' })
    for (const kind of ['ai', 'callback', 'report']) {
      const held = await lifetime.hold(kind), before = controller.snapshot(), count = children.length
      const child = await identity(children.at(-1).pid), started = performance.now()
      let elapsed
      try {
        await assert.rejects(controller.replace(ids.b), { code: 'CONVERSATION_DRAIN_TIMEOUT' })
        elapsed = performance.now() - started
        assert.ok(elapsed >= 59000 && elapsed < 90000)
        assert.equal(children.length, count); assert.deepEqual(await identity(children.at(-1).pid), child)
        assert.equal(controller.snapshot().generation, before.generation); assert.equal(controller.snapshot().available, true)
        assert.equal(controller.snapshot().currentVersionId, before.currentVersionId)
        await held.assertResumed()
      } finally { await held.release() }
      busyCases.push({ kind, elapsedMilliseconds: elapsed, generation: before.generation,
        sameChildIdentity: true, noNewChild: true, oldResumed: true, actualRootDoneBeforeNext: true })
    }
    await replace(ids.b); await replace('builtin')
    readonlyRestoreVerified = businessVerified = true
    await publish('done'); await command('finish')
    const completed = lifetime.snapshot()
    for (const [key, value] of Object.entries({ holds: 3, resumed: 3, released: 3, sourceSends: 3, reportSends: 1, nativeDone: 4, nativeAborts: 0, nativeStops: 0, bodyResends: 0, sdkCloses: 0, ptyCloses: 0 })) assert.equal(completed[key], value, key)
    assert.equal(completed.reportUsesOriginalOperation, true)
    await lifetime.close(); await runtime.close(); business.kill('SIGTERM'); await once(business, 'close')
    assert.equal(controller.snapshot().phase, 'closed')
    for (const child of children) {
      assert.equal(child.exitCode, 0); assert.equal(child.connected, false)
      assert.equal(child.stdout.closed, true); assert.equal(child.stderr.closed, true)
    }
    assert.equal(children.length, 5)
    await write(statusPath, { phase: 'closed', conversationChildrenEnded: true, gatewayAndBusinessClosed: true,
      events, businessChecks: { state: await fixture.snapshot(), counts: fixture.counts(), receipts: fixture.receipts },
      busyCases, lifetimeChecks: lifetime.snapshot() })
    setInterval(() => {}, 1000); await new Promise(() => {})
  } catch (error) {
    await write(statusPath, { phase: 'failed', error: error.stack, checks, events }); throw error
  }
}
