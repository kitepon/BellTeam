import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink, link } from 'node:fs/promises'
import { join } from 'node:path'
import { BotRegistry } from '../src/bot-registry.mjs'
import { ProjectFiles } from '../src/project-files.mjs'
import { renderBotInstructions } from '../src/members/instructions.mjs'
import { callMemberTool } from '../src/members/profiles-mcp.mjs'
import { createMembersDispatcher } from '../src/members/dispatcher.mjs'
import { operateMembersProject } from '../src/members-project-files.mjs'
import { OwnerProfile } from '../src/owner-profile.mjs'
import { UserRules } from '../src/user-rules.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(process.cwd(), '.local-instructions-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const seedPath = join(root, 'seed.json')
  await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [
    { id: 'bot-fixture', displayName: 'Synthetic', harness: 'grok', session: 'bot-fixture', project: '/unused' },
  ] }))
  const registry = new BotRegistry({ seedPath, botsRoot: join(root, 'bots'), stateRoot: join(root, 'state/bots') })
  await registry.initialize()
  const project = registry.get('bot-fixture').project
  return { root, registry, project, local: join(project, 'AGENTS.local.md') }
}

test('new and existing seats without a local source keep the exact generated instructions', async t => {
  const f = await fixture(t)
  const files = new ProjectFiles(), profile = f.registry.get('bot-fixture')
  assert.equal(await readFile(join(f.project, 'AGENTS.md'), 'utf8'), renderBotInstructions(profile))
  await assert.rejects(stat(f.local), { code: 'ENOENT' })
  await writeFile(f.local, ' \n\t')
  await files.prepareStartupContext(profile, 'synthetic memory')
  assert.equal(await readFile(join(f.project, 'AGENTS.md'), 'utf8'), renderBotInstructions(profile, 'synthetic memory'))
  assert.equal(await readFile(f.local, 'utf8'), ' \n\t')
  assert.equal(await readFile(join(f.project, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n')
})

test('existing empty-profile update is the regeneration entry and preserves edits across CLI changes', async t => {
  const f = await fixture(t)
  await writeFile(f.local, 'SYNTHETIC LOCAL V1\n', { mode: 0o600 })
  const before = await stat(f.local)
  await callMemberTool({ name: 'update_self', args: {}, from: 'bot-fixture', registry: f.registry })
  let body = await readFile(join(f.project, 'AGENTS.md'), 'utf8')
  assert(body.includes('SYNTHETIC LOCAL V1'))
  assert(body.indexOf('SYNTHETIC LOCAL V1') < body.indexOf('# 前セッションの短期記憶'))
  assert.equal((await stat(f.local)).mtimeMs, before.mtimeMs)
  assert.equal((await stat(f.local)).mode, before.mode)
  await writeFile(f.local, 'SYNTHETIC LOCAL V2\n')
  for (const harness of ['codex', 'claude', 'cursor', 'grok']) {
    await f.registry.update('bot-fixture', { name: `Synthetic ${harness}`, harness })
    await f.registry.prepareStartupContext('bot-fixture', `memory ${harness}`)
    body = await readFile(join(f.project, 'AGENTS.md'), 'utf8')
    assert(body.includes(`Synthetic ${harness}`) && body.includes(`memory ${harness}`))
    assert(body.includes('SYNTHETIC LOCAL V2') && !body.includes('SYNTHETIC LOCAL V1'))
    assert.equal(await readFile(f.local, 'utf8'), 'SYNTHETIC LOCAL V2\n')
    assert.equal(await readFile(join(f.project, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n')
  }
  const restarted = new BotRegistry({ seedPath: join(f.root, 'seed.json'), botsRoot: join(f.root, 'bots'), stateRoot: join(f.root, 'state/bots') })
  await restarted.initialize()
  assert((await readFile(join(f.project, 'AGENTS.md'), 'utf8')).includes('SYNTHETIC LOCAL V2'))
  assert.equal(await readFile(f.local, 'utf8'), 'SYNTHETIC LOCAL V2\n')
  await rm(f.local)
  await f.registry.update('bot-fixture', {})
  assert(!(await readFile(join(f.project, 'AGENTS.md'), 'utf8')).includes('SYNTHETIC LOCAL V2'))
})

test('members dispatcher and the real seat writer compose the same source for update and startup', async t => {
  const f = await fixture(t)
  await new OwnerProfile({ root: f.root }).initialize()
  await new UserRules({ root: f.root }).initialize()
  await writeFile(f.local, 'SYNTHETIC CHILD LOCAL\n')
  const dispatcher = createMembersDispatcher({ root: f.root, projection: async () => {},
    effect: (method, params) => operateMembersProject({ root: f.root, home: join(f.root, 'home') }, method, params),
  })
  const context = { generation: 'synthetic', rootId: 'test', leaseId: 'test', ownerWrite: false, continuation: false }
  await dispatcher.control('initialize', { generation: 'synthetic' }, { ...context, leaseId: null })
  await dispatcher.control('resume', {})
  await dispatcher.dispatch('profile.update', { botId: 'bot-fixture', changes: { name: 'Child synthetic' } }, context)
  await writeFile(f.local, 'SYNTHETIC CHILD REVISION\n')
  await dispatcher.dispatch('profile.startup', { botId: 'bot-fixture', shortTermMemory: 'child synthetic memory' }, context)
  const body = await readFile(join(f.project, 'AGENTS.md'), 'utf8')
  assert(body.includes('Child synthetic') && body.includes('child synthetic memory'))
  assert(body.includes('SYNTHETIC CHILD REVISION') && !body.includes('SYNTHETIC CHILD LOCAL'))
  assert.equal(await readFile(f.local, 'utf8'), 'SYNTHETIC CHILD REVISION\n')
  assert.equal(await readFile(join(f.project, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n')
  await dispatcher.control('quiesce', {}); await dispatcher.control('exit', {})
})

test('invalid local sources fail before replacing either generated instruction file', async t => {
  const f = await fixture(t)
  const files = new ProjectFiles(), profile = f.registry.get('bot-fixture')
  const original = await readFile(join(f.project, 'AGENTS.md'), 'utf8')
  const target = join(f.root, 'synthetic-outside.txt'); await writeFile(target, 'SYNTHETIC OUTSIDE')
  const writers = [
    () => files.writeInstructions(profile),
    () => operateMembersProject({ root: f.root, home: join(f.root, 'home') }, 'project.writeInstructions', { botId: profile.id, body: 'replacement' }),
  ]
  for (const create of [() => symlink(target, f.local), () => link(target, f.local), () => mkdir(f.local)]) {
    await create()
    for (const write of writers) {
      await assert.rejects(write())
      assert.equal(await readFile(join(f.project, 'AGENTS.md'), 'utf8'), original)
      assert.equal(await readFile(join(f.project, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n')
    }
    await rm(f.local, { recursive: true, force: true })
  }
  assert.equal(await readFile(target, 'utf8'), 'SYNTHETIC OUTSIDE')
})
