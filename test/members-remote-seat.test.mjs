// Remote seat C1/C6 members contracts (docs/architecture/modules/members/remote-seat.md).
import assert from 'node:assert/strict'
import test from 'node:test'
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotRegistry } from '../src/bot-registry.mjs'
import { OwnerProfile } from '../src/owner-profile.mjs'
import { UserRules } from '../src/user-rules.mjs'
import { createMembersDispatcher } from '../src/members/dispatcher.mjs'
import { operateMembersProject } from '../src/members-project-files.mjs'
import { listMemberDocs, readMemberDoc, writeMemberDoc } from '../src/members/project-docs.mjs'

const context = Object.freeze({ generation: 'test', leaseId: 'lease', rootId: 'root', ownerWrite: false, continuation: false })
const binding = { terminalId: 'mac-owner', projectRoot: '/Users/quo/work/app' }

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'members-remote-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const seedPath = join(root, 'seed.json')
  await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [{ id: 'bot-a', displayName: 'Synthetic', harness: 'claude', session: 'bot-a', project: '/unused' }] }))
  await mkdir(join(root, 'state'))
  await new BotRegistry({ seedPath, botsRoot: join(root, 'bots'), stateRoot: join(root, 'state/bots') }).initialize()
  await new OwnerProfile({ root }).initialize(); await new UserRules({ root }).initialize()
  const effects = [], records = []
  const effect = async (method, params) => {
    effects.push(method)
    if (method === 'project.readPreviousSession') return ''
    if (method === 'project.composeInstructions') return `${params.body}LOCAL-RULES\n`
    if (method === 'project.docs.list') return []
  }
  const dispatcher = createMembersDispatcher({ root, effect, projection: async record => { records.push(record) } })
  await dispatcher.control('initialize', { generation: 'test' }, { ...context, leaseId: null })
  await dispatcher.control('resume', {})
  const request = (method, params) => { dispatcher.validateRequest(method, params, context); return dispatcher.dispatch(method, params, context) }
  return { request, effects, records, root }
}

test('binding fields save, project and persist; pair rule and path validation reject bad input', async t => {
  const f = await fixture(t)
  const { bot } = await f.request('profile.update', { botId: 'bot-a', changes: binding })
  assert.equal(bot.terminalId, binding.terminalId)
  assert.equal(f.records.at(-2).bot.projectRoot, binding.projectRoot)
  const saved = JSON.parse(await readFile(join(f.root, 'state/bots/bot-a/bot.json'), 'utf8'))
  assert.deepEqual([saved.schema, saved.terminalId, saved.projectRoot], ['bellteam.bot.v8', binding.terminalId, binding.projectRoot])
  await assert.rejects(f.request('profile.update', { botId: 'bot-a', changes: { terminalId: '' } }), { code: 'BOT_REMOTE_BINDING_INVALID', status: 400 })
  for (const projectRoot of ['relative/app', '/Users/quo/../etc', '/Users//quo', '/Users/quo/'])
    await assert.rejects(f.request('profile.update', { botId: 'bot-a', changes: { projectRoot } }), { code: 'BOT_PROJECT_ROOT_INVALID', status: 400 })
  await assert.rejects(f.request('profile.update', { botId: 'bot-a', changes: { terminalId: 'bad id' } }), { code: 'BOT_TERMINAL_ID_INVALID', status: 400 })
  const local = await f.request('profile.update', { botId: 'bot-a', changes: { terminalId: '', projectRoot: '' } })
  assert.deepEqual([local.bot.terminalId, local.bot.projectRoot], ['', ''])
})

test('launchContext composes global, member, AGENTS.local and remote note in memory, with a binding revision', async t => {
  const f = await fixture(t)
  await assert.rejects(f.request('profile.launchContext', { botId: 'bot-a', sessionName: 'bot-a', shortTermMemory: '' }), { code: 'BOT_REMOTE_BINDING_MISSING' })
  await f.request('profile.update', { botId: 'bot-a', changes: binding })
  f.effects.length = 0
  const { launchContext } = await f.request('profile.launchContext', { botId: 'bot-a', sessionName: 'bot-a-2nd-k1', shortTermMemory: 'HANDOFF-TEXT' })
  const at = marker => launchContext.text.indexOf(marker)
  assert.ok(at('# オーナー情報') === 0 && at('# BellTeam Common Rules') > 0)
  assert.ok(at('# BellTeam Common Rules') < at('# 自分のBot情報') && at('# 自分のBot情報') < at('HANDOFF-TEXT'))
  assert.ok(at('HANDOFF-TEXT') < at('LOCAL-RULES') && at('LOCAL-RULES') < at('# Remote seat'))
  assert.ok(launchContext.text.includes(binding.projectRoot))
  assert.match(launchContext.revision, /^[a-f0-9]{16}$/u)
  assert.deepEqual(f.effects, ['project.composeInstructions'], 'launchContext writes nothing')
  await f.request('profile.update', { botId: 'bot-a', changes: { projectRoot: '/Users/quo/other' } })
  const next = await f.request('profile.launchContext', { botId: 'bot-a', sessionName: 'bot-a', shortTermMemory: '' })
  assert.notEqual(next.launchContext.revision, launchContext.revision)
})

test('runtime compose is read-only and merges AGENTS.local like the local AGENTS.md', async t => {
  const root = await mkdtemp(join(tmpdir(), 'members-compose-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'bots/bot-a'), { recursive: true })
  await writeFile(join(root, 'bots/bot-a/AGENTS.local.md'), 'LOCAL\n')
  const text = await operateMembersProject({ root, home: root }, 'project.composeInstructions', { botId: 'bot-a', body: 'BODY\n# 前セッションの短期記憶\n\nnone\n' })
  assert.ok(text.indexOf('LOCAL') < text.indexOf('# 前セッションの短期記憶'))
  await assert.rejects(lstat(join(root, 'bots/bot-a/AGENTS.md')), { code: 'ENOENT' })
})

test('member docs round-trip and reject paths outside docs/ or AGENTS.local.md', async t => {
  const project = await mkdtemp(join(tmpdir(), 'members-docs-'))
  t.after(() => rm(project, { recursive: true, force: true }))
  assert.deepEqual(await listMemberDocs(project), [])
  await writeMemberDoc(project, 'docs/plan/a.md', 'A')
  await writeMemberDoc(project, 'AGENTS.local.md', 'L')
  assert.equal((await readMemberDoc(project, 'docs/plan/a.md')).content, 'A')
  assert.deepEqual((await listMemberDocs(project)).map(file => file.path), ['AGENTS.local.md', 'docs/plan/a.md'])
  for (const path of ['../x', 'docs/../x', '/etc/passwd', 'docs', 'docs//a', 'AGENTS.md', 'memory/previous-session.md'])
    await assert.rejects(writeMemberDoc(project, path, 'x'), { code: 'MEMBERS_DOC_PATH_INVALID' }, path)
  await mkdir(join(project, 'outside'))
  await symlink(join(project, 'outside'), join(project, 'docs/link'))
  await assert.rejects(writeMemberDoc(project, 'docs/link/a.md', 'x'), { code: 'MEMBERS_DOC_PATH_INVALID' })
  await symlink(join(project, 'docs/plan/a.md'), join(project, 'docs/alias.md'))
  await assert.rejects(readMemberDoc(project, 'docs/alias.md'), { code: 'MEMBERS_DOC_PATH_INVALID' })
  await assert.rejects(writeMemberDoc(project, 'docs/big.md', 'x'.repeat(1024 * 1024 + 1)), { code: 'MEMBERS_DOC_TOO_LARGE' })
  assert.ok((await listMemberDocs(project)).every(file => !file.path.startsWith('docs/link/')), 'nested docs symlink is not descended')
})

test('member docs listing never follows a symlinked top-level docs directory', async t => {
  const project = await mkdtemp(join(tmpdir(), 'members-docs-link-'))
  const outside = await mkdtemp(join(tmpdir(), 'members-docs-outside-'))
  t.after(() => Promise.all([rm(project, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]))
  await writeFile(join(outside, 'secret.md'), 'outside')
  await symlink(outside, join(project, 'docs'))
  await assert.rejects(listMemberDocs(project), { code: 'MEMBERS_DOC_PATH_INVALID' })
})
