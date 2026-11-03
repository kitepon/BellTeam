// Synthetic supervisor only; C entry, anchor acquisition and storage are exact image code.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, chown, chmod, readFile, lstat, writeFile } from 'node:fs/promises'
import { acquireConfigurationStateAnchor } from '/app/src/configuration-state-anchor.mjs'
import { ConfigurationIntents } from '/app/src/configuration-intents.mjs'
import { configurationDigest, configurationSettings, CONFIGURATION_VERSION } from '/app/src/configuration-request.mjs'

if (process.argv[2] === 'initialize') {
  assert.equal(process.getuid(), 0)
  await mkdir('/private/state', { recursive: true })
  for (const [path, uid, gid, mode] of [
    ['/private', 0, 1001, 0o750], ['/private/state', 1001, 1001, 0o711],
    ['/fixture-data', 1000, 1000, 0o711],
  ]) {
    await chown(path, uid, gid); await chmod(path, mode)
  }
} else {
  assert.equal(process.argv.length, 2)
  assert.deepEqual([process.getuid(), process.geteuid(), process.getgid(), process.getegid()], [1001, 1001, 1001, 1001])
  await assert.rejects(writeFile('/app/storage-fixture-write', 'x'), { code: 'EROFS' })
  const anchor = acquireConfigurationStateAnchor('/srv/bellteam')
  assert.equal(anchor.path, '/srv/bellteam/state'); assert.equal(anchor.uid, 1001)
  assert(Object.isFrozen(anchor))
  const store = new ConfigurationIntents('/srv/bellteam/state/configuration-intents', { trustedAnchor: anchor })
  const botId = 'bot-storage-fixture', id = randomUUID()
  const requested = configurationSettings({ model: 'fixture-model', reasoning_effort: 'high', fast: false })
  const binding = { id, session_id: 'fixture-session', launch_id: '1'.repeat(32), digest: configurationDigest(requested) }
  const original = { schema: 'bellteam.configuration-intent.v1', botId, binding, requested, version: CONFIGURATION_VERSION }
  await store.publish(botId, original)
  assert.deepEqual(await store.read(botId, id), original)
  await store.saveNotIssued(botId, binding)
  assert.equal(await store.notIssued(botId, binding), true)
  assert.equal(await store.terminal(botId, binding), null)
  const metadata = {}
  for (const [name, mode] of [['', 0o700], [`/${botId}`, 0o700],
    [`/${botId}/${id}.intent.json`, 0o600], [`/${botId}/${id}.not-issued.json`, 0o600]]) {
    const info = await lstat(store.root + name)
    assert.equal(info.uid, 1001); assert.equal(info.gid, 1001); assert.equal(info.mode & 0o7777, mode)
    assert.equal(info.isSymbolicLink(), false)
    if (info.isFile()) assert.equal(info.nlink, 1)
    metadata[name || '/'] = { uid: info.uid, gid: info.gid, mode, nlink: info.nlink }
  }
  assert.deepEqual(acquireConfigurationStateAnchor('/srv/bellteam'), anchor)
  const distribution = JSON.parse(await readFile('/app/distribution.json', 'utf8'))
  console.log(JSON.stringify({ schema: 'bellteam.configuration-storage-image-proof.v1',
    source: distribution.sourceCommit, uid: process.getuid(), pid: process.pid, anchor,
    realCEntry: true, actualFd3Fd4AndMountsVerified: true, realConsumerPublishReadAndNotIssued: true,
    metadata, nativeConfigurationRpc: 0, historicalRequestsTouched: 0, syntheticSupervisor: true }))
}
