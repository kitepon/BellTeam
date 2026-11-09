import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTerminalRegistry } from '../src/terminals/registry.mjs'

const sshKeyRef = 'a1b2c3d4-1234-4234-8234-123456789abc'
const sudoKeyRef = 'b1b2c3d4-1234-4234-8234-123456789abc'
const input = { host: 'mac.local', user: 'alice', os: 'macos', accountOwner: 'owner', sshKeyRef }

async function fixture(t) {
  const stateRoot = await mkdtemp(join(tmpdir(), 'terminal-registry-'))
  t.after(async () => { await chmod(stateRoot, 0o700); await rm(stateRoot, { recursive: true, force: true }) })
  const events = []
  return { stateRoot, events, registry: createTerminalRegistry({ stateRoot, onChange: event => events.push(event) }) }
}

test('validates target fields and rejects source references', async t => {
  const { registry } = await fixture(t)
  for (const patch of [
    { sshKeyRef: 'op://vault/item/field' }, { sshKeyRef: '/private/key' },
    { host: 'host; touch /tmp/x' }, { user: 'alice -o ProxyCommand=x' },
    { port: 0 }, { port: 65536 }, { os: 'linux' }, { accountOwner: 'other' },
    { unexpected: true }, { hostTrust: { provider: 'op://vault/item', revision: 1 } }
  ]) await assert.rejects(registry.register({ ...input, ...patch }), { code: 'INVALID_TERMINAL' })
  // A pasted key is refused with the next action, and its value is never echoed back.
  const key = '-----BEGIN OPENSSH PRIVATE KEY----- abc'
  await assert.rejects(registry.register({ ...input, sshKeyRef: key }), error => error.message.includes('secret input card') && !error.message.includes('abc'))
  await assert.rejects(registry.register({ ...input, port: '22' }), { message: /port must be an integer/ })
  assert.deepEqual(await registry.list(), [])
  const { sshKeyRef: _key, ...keyless } = input
  assert.equal((await registry.register(keyless)).sshKeyConfigured, false, 'key is bound later')
})

test('persists revisions, redacts references and serializes updates', async t => {
  const { stateRoot, registry, events } = await fixture(t)
  const created = await registry.register({ ...input, sudoKeyRef, hostTrust: { provider: 'aiterm.known-hosts.v1', revision: `sha256:${'a'.repeat(64)}` } })
  assert.equal(created.port, 22)
  assert.equal(created.revision, 1)
  assert.equal(created.sshKeyConfigured, true)
  assert.equal(created.sudoKeyConfigured, true)
  assert.equal('sshKeyRef' in created, false)
  assert.equal('sudoKeyRef' in created, false)
  const [first, second] = await Promise.all([
    registry.update(created.terminalId, { host: 'new.local' }),
    registry.update(created.terminalId, { port: 2222 })
  ])
  assert.equal(first.revision, 2)
  assert.equal(second.revision, 3)
  const reopened = createTerminalRegistry({ stateRoot })
  const result = await reopened.get(created.terminalId)
  assert.equal(result.host, 'new.local')
  assert.equal(result.port, 2222)
  assert.deepEqual(await reopened.list(), [result])
  const target = await reopened.target(created.terminalId)
  assert.equal(target.sshKeyRef, sshKeyRef)
  target.hostTrust.revision = 'changed'
  assert.equal((await reopened.target(created.terminalId)).hostTrust.revision, `sha256:${'a'.repeat(64)}`)
  assert.deepEqual(events.map(({ revision, removed }) => [revision, removed]), [[1, false], [2, false], [3, false]])
  assert.equal(JSON.stringify(events).includes(sshKeyRef), false)
  await assert.rejects(registry.update('missing', { port: 22 }), { code: 'TERMINAL_NOT_FOUND' })
  assert.equal(await registry.get('missing'), null)
  assert.equal((await registry.remove(created.terminalId)).terminalId, created.terminalId)
  assert.equal(await registry.remove(created.terminalId), null)
  assert.deepEqual(events.at(-1), { terminalId: created.terminalId, revision: 4, removed: true })
  assert.equal(events.length, 4)
})

test('failed atomic save preserves store and emits no event', async t => {
  const { stateRoot, registry, events } = await fixture(t)
  const created = await registry.register(input)
  const path = join(stateRoot, 'terminals.json')
  const before = await readFile(path, 'utf8')
  await chmod(stateRoot, 0o500)
  await assert.rejects(registry.update(created.terminalId, { port: 2222 }))
  await chmod(stateRoot, 0o700)
  assert.equal(await readFile(path, 'utf8'), before)
  assert.equal((await registry.get(created.terminalId)).revision, 1)
  assert.equal(events.length, 1)
})

test('malformed store is preserved and corrected source recovers on next operation', async t => {
  const { stateRoot, registry, events } = await fixture(t)
  const path = join(stateRoot, 'terminals.json')
  const malformed = '{"terminals":[{"host":"bad"}]}'
  await writeFile(path, malformed)
  await assert.rejects(registry.register(input), { code: 'INVALID_TERMINAL_STORE' })
  assert.equal(await readFile(path, 'utf8'), malformed)
  assert.equal(events.length, 0)
  await writeFile(path, '{"terminals":[]}')
  assert.equal((await registry.register(input)).revision, 1)
})

test('legacy ingressUrl is dropped on read and refused as input', async t => {
  const { stateRoot, registry } = await fixture(t)
  const legacy = { ...input, terminalId: 'owner-macbook', port: 22, revision: 1, ingressUrl: 'http://192.168.1.20:18891' }
  await writeFile(join(stateRoot, 'terminals.json'), JSON.stringify({ terminals: [legacy] }))
  assert.equal('ingressUrl' in (await registry.get('owner-macbook')), false)
  await assert.rejects(registry.update('owner-macbook', { ingressUrl: 'http://x' }), { code: 'INVALID_TERMINAL' })
  await assert.rejects(registry.register({ ...input, terminalId: 'other', ingressUrl: 'http://x' }), { message: /ingressUrl was removed/ })
  await registry.update('owner-macbook', { user: 'kite' })
  assert.equal(JSON.parse(await readFile(join(stateRoot, 'terminals.json'), 'utf8')).terminals[0].ingressUrl, undefined)
})
