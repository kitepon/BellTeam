import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { avatarVersion } from '../src/avatar-value.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'
import { createMembersParentChannel, waitMembersChildClose } from '../src/members-ipc.mjs'
import { createMembersProjection } from '../src/members-projection.mjs'
import { createMembersFacade } from '../src/members-facade.mjs'
import { operateMembersProject } from '../src/members-project-files.mjs'

test('facade adopts streamed real IPC receipts without SSE read loops and continues the old lease', async t => {
  const root = await mkdtemp(join(process.cwd(), '.members-facade-ipc-')), home = join(root, 'home')
  await mkdir(join(root, 'state/bots'), { recursive: true, mode: 0o700 })
  await writeFile(join(root, 'state/bots/.initialized'), '', { mode: 0o600 })
  await mkdir(join(root, 'owner')); await mkdir(join(root, 'bots'))
  await writeFile(join(root, 'owner/profile.json'), JSON.stringify({ schema: 'bellteam.owner-profile.v1', name: 'fixture', profile: '', avatar: '', xUrl: '', githubUrl: '', links: [] }))
  await writeFile(join(root, 'owner/user-rules.md'), '')
  for (const cli of ['.claude', '.codex', '.grok', '.cursor', '.gemini']) await mkdir(join(home, cli), { recursive: true })
  const child = spawn(process.execPath, [new URL('./fixtures/members-runtime-child.mjs', import.meta.url).pathname, 'builtin', root], { env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const ended = waitMembersChildClose(child), admission = new MembersAdmission('fixture')
  let notifications = 0
  const projection = createMembersProjection({ onChange: () => { notifications++ } }); projection.begin('fixture')
  const channel = createMembersParentChannel(child, { generation: 'fixture', admission,
    onProjection: (record, context) => projection.accept(record, context),
    onEffect: async (method, params) => {
      if (method.startsWith('project.') || method === 'global.writeInstructions') return operateMembersProject({ root, home }, method, params)
      if (method === 'cli.configure') return null
      if (method === 'models.read') return { models: [], efforts: [] }
      throw new Error('UNEXPECTED_EFFECT')
    },
  })
  t.after(async () => { child.kill('SIGKILL'); await ended; channel.reaped(); await rm(root, { recursive: true, force: true }) })
  await channel.control('initialize', { generation: 'fixture' }); await channel.ready; await channel.control('resume')
  const { bots } = createMembersFacade({ admission, projection, request: (...args) => channel.request(...args), callback: (...args) => channel.callback(...args) })
  const avatar = 'data:image/png;base64,AAAA'
  const bot = await bots.create({ name: 'facade fixture', harness: 'codex', avatar })
  const changes = notifications
  const snapshot = await bots.refresh()
  assert.equal(snapshot.length, 1)
  assert.equal(snapshot[0].avatarVersion, avatarVersion(avatar))
  assert.equal(snapshot[0].avatarLargeVersion, avatarVersion(avatar))
  assert.equal(snapshot[0].avatarSourceVersion, '')
  assert.equal(snapshot[0].avatarLargeSourceVersion, '')
  assert.equal(Object.hasOwn(snapshot[0], 'avatar'), false)
  const listed = await bots.listForClient()
  assert.equal(listed[0].id, bot.id)
  assert.equal(Object.hasOwn(listed[0], 'avatar'), false)
  assert.equal(listed[0].avatarVersion, avatarVersion(avatar))
  assert.equal(notifications, changes)
  const lease = admission.enter(), ticket = admission.close()
  await assert.rejects(bots.refresh(), { status: 503 })
  assert.equal((await bots.refresh({ membersLease: lease }))[0].id, bot.id)
  await bots.prepareStartupContext(bot.id, '', { membersLease: lease })
  assert.equal((await bots.updateSession(bot.id, 'test-session', { membersLease: lease })).session, 'test-session')
  admission.finish(lease); await admission.drain(ticket)
  await channel.control('quiesce'); await channel.control('exit')
  assert.deepEqual(await ended, { code: 0, signal: null })
})
