import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createUsageParentChannel } from '../src/usage/channel.mjs'
import { createUsageAuthority } from '../src/usage/authority.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'
import { waitNotificationsChildClose } from '../src/notifications-ipc.mjs'

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
const bootstrap = { environment: {}, seatRuntime: false, subscription: {} }

test('after real child OS exit, incoming effect and commit drain before reaped without waiting on outgoing credit', async t => {
  for (const held of ['effect', 'commit']) {
    const root = await mkdtemp(join(tmpdir(), 'bellteam-usage-incoming-'))
    const child = fork(new URL('./fixtures/usage-channel-child.mjs', import.meta.url), [root], { serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    const ended = waitNotificationsChildClose(child), entered = deferred(), release = deferred()
    const generation = `incoming-${held}`, admission = new MembersAdmission(generation), authority = createUsageAuthority()
    const channel = createUsageParentChannel(child, { generation, admission, authorizeActor: authority.authorizeActor,
      onEffect: method => {
        if (method === 'members.read') return []
        if (method === 'settings.changed' && held === 'effect') { entered.resolve(); return release.promise }
        throw new Error('UNEXPECTED_EFFECT')
      },
      onSnapshotEnd: held === 'commit' ? () => { entered.resolve(); return release.promise } : async () => {},
    })
    t.after(async () => {
      release.resolve(null)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await ended; await channel.drainIncoming(); channel.reaped(); await rm(root, { recursive: true, force: true })
    })
    await channel.control('initialize', { generation, mode: 'settings', bootstrap, restore: false }); await channel.ready
    await channel.control('initialize', { generation, mode: 'subscriptions' })
    let operation, lease
    if (held === 'effect') {
      await channel.control('initialize', { generation, mode: 'services' })
      lease = admission.enter()
      operation = channel.request('settings.update', { id: 'routing', input: { enabled: false } }, { usageLease: lease,
        capturedAuthorization: authority.capture('settings.update', { kind: 'owner', botId: null }) })
    } else operation = channel.control('initialize', { generation, mode: 'services' })
    operation.catch(() => {})
    await entered.promise; child.kill('SIGTERM'); assert.equal((await ended).signal, 'SIGTERM')
    let incomingDone = false, completed = false
    operation.completion.finally(() => { completed = true }).catch(() => {})
    const draining = channel.drainIncoming().then(() => { incomingDone = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(incomingDone, false); assert.equal(completed, false)
    release.resolve(null); await draining
    assert.equal(completed, false)
    channel.reaped(); await assert.rejects(operation.completion, { code: 'USAGE_CHILD_EXITED' })
    if (lease) admission.finish(lease)
  }
})
