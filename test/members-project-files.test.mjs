import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, link, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { operateMembersProject, validateMembersProjectRequest } from '../src/members-project-files.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(process.cwd(), '.members-files-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'home'); await mkdir(home)
  for (const cli of ['.claude', '.codex', '.grok', '.cursor', '.gemini']) await mkdir(join(home, cli))
  const call = (operation, params = {}) => operateMembersProject({ root, home }, operation, params)
  await call('project.ensureRoot')
  return { root, home, call, project: join(root, 'bots/bot-fixture') }
}

test('fixed writer consumes generated text and preserves previous-session and append semantics', async t => {
  const { call, project, home } = await fixture(t)
  await call('project.claim', { botId: 'bot-fixture' })
  await assert.rejects(call('project.claim', { botId: 'bot-fixture' }), { code: 'BOT_PROJECT_EXISTS' })
  await call('project.initialize', { botId: 'bot-fixture' })
  assert.equal((await stat(join(project, 'docs'))).isDirectory(), true)
  assert.equal(await call('project.readPreviousSession', { botId: 'bot-fixture' }), '')
  await call('project.prepareStartupContext', { botId: 'bot-fixture', body: 'generated A', previousSession: ' memory ' })
  await call('project.writeInstructions', { botId: 'bot-fixture', body: 'generated B' })
  await call('project.appendInstructions', { botId: 'bot-fixture', text: '\nappend' })
  assert.equal(await readFile(join(project, 'AGENTS.md'), 'utf8'), 'generated B\nappend')
  assert.equal(await readFile(join(project, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n')
  assert.equal(await call('project.readPreviousSession', { botId: 'bot-fixture' }), 'memory\n')
  assert.equal((await stat(join(project, 'memory/previous-session.md'))).mode & 0o777, 0o600)
  assert.equal((await stat(join(project, 'AGENTS.md'))).mode & 0o777, 0o644)
  await call('global.writeInstructions', { body: 'global generated' })
  assert.equal(await readFile(join(home, '.codex/AGENTS.md'), 'utf8'), 'global generated')
  assert.equal((await stat(join(home, '.codex/AGENTS.md'))).mode & 0o777, 0o600)
})

test('arbitrary paths and linked destinations cannot replace another file', async t => {
  const { call, project, root } = await fixture(t)
  for (const params of [{ botId: '../elsewhere' }, { botId: 'bot-fixture', path: '/elsewhere' }])
    assert.throws(() => validateMembersProjectRequest('project.remove', params), { code: 'MEMBERS_PROJECT_INVALID' })
  assert.throws(() => validateMembersProjectRequest('project.shell', {}), { code: 'MEMBERS_PROJECT_INVALID' })
  await call('project.claim', { botId: 'bot-fixture' })
  const target = join(root, 'preserved'); await writeFile(target, 'preserved')
  await symlink(target, join(project, 'AGENTS.md'))
  await assert.rejects(call('project.writeInstructions', { botId: 'bot-fixture', body: 'changed' }))
  assert.equal(await readFile(target, 'utf8'), 'preserved')
  await rm(join(project, 'AGENTS.md'))
  await link(target, join(project, 'AGENTS.md'))
  await assert.rejects(call('project.writeInstructions', { botId: 'bot-fixture', body: 'changed' }), { code: 'MEMBERS_PROJECT_INVALID' })
  assert.equal(await readFile(target, 'utf8'), 'preserved')
  await rm(project, { recursive: true })
  await symlink(root, project)
  await assert.rejects(call('project.remove', { botId: 'bot-fixture' }), { code: 'MEMBERS_PROJECT_INVALID' })
  assert.equal(await readFile(target, 'utf8'), 'preserved')
})
