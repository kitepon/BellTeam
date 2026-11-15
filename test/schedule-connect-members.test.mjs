import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BotRegistry } from '../src/bot-registry.mjs'
import { normalizeSchedule } from '../src/schedule-definition.mjs'
import { scheduleToolHandlers } from '../src/members/schedules-mcp.mjs'
import { validateMembersEffect, validateMembersRequest } from '../src/members/protocol.mjs'
import { expandTemplate } from '../src/schedule-templates.mjs'

const connect = { project: 'bellteam', plan: 'p1', task: 't1' }
const check = { kind: 'interval_hours', intervalHours: 1, startHour: 0, endHour: 23, command: 'check-it', name: 'ci' }
const until = '2099-01-01T00:00:00.000Z'
const context = { generation: 'g', leaseId: 'l', rootId: 'r', ownerWrite: false, continuation: false }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-connect-'))
  const seedPath = join(root, 'seed.json')
  await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [{ id: 'bot-a', displayName: 'a', harness: 'grok', color: 'rose', session: 'bot-a', project: '/old' }] }))
  const registry = new BotRegistry({ seedPath, botsRoot: join(root, 'bots'), now: () => new Date('2026-11-15T00:00:00.000Z'), id: () => 's-1' })
  await registry.initialize()
  return { root, registry }
}

test('connect needs a command, not after_turn, not notify=result, and a valid target', () => {
  const now = new Date('2026-11-15T00:00:00.000Z')
  assert.deepEqual(normalizeSchedule({ ...check, id: 'x', connect }, now).connect, connect)
  for (const bad of [{ prompt: 'p', command: undefined }, { notify: 'result' }, { connect: { ...connect, extra: 1 } }, { connect: { ...connect, project: 'Bad Id' } }, { kind: 'after_turn', command: undefined, prompt: 'p' }])
    assert.throws(() => normalizeSchedule({ ...check, id: 'x', connect, ...bad }, now), /SCHEDULE_(CONNECT|NOTIFY|AFTER_TURN)_INVALID/u)
})

test('update keeps connect; a changed, dropped or non-command update is refused; template survives only with its command', async () => {
  const { registry } = await fixture()
  const template = { kind: 'pr-merged', params: { repo: 'o/r', number: '5' }, until }
  const first = await registry.setSchedule('bot-a', { ...check, command: expandTemplate(template), template, connect })
  assert.deepEqual(first.connect, connect)
  const renamed = await registry.setSchedule('bot-a', { ...check, id: first.id, command: first.command, name: 'edited' })
  assert.deepEqual([renamed.connect, renamed.template], [connect, template])
  const edited = await registry.setSchedule('bot-a', { ...check, id: first.id, command: 'by-hand' })
  assert.deepEqual([edited.connect, edited.template], [connect, undefined])
  await assert.rejects(registry.setSchedule('bot-a', { ...check, id: first.id, connect: { ...connect, task: 't2' } }), /SCHEDULE_CONNECT_CHANGE_REFUSED/u)
  await assert.rejects(registry.setSchedule('bot-a', { id: first.id, kind: 'after_turn', prompt: 'p' }), /SCHEDULE_CONNECT_CHANGE_REFUSED/u)
})

test('set_schedule expands a template once and refuses template plus command', async () => {
  const { registry } = await fixture()
  const template = { kind: 'url', params: { url: 'https://example.com/x' }, until }
  const saved = (await scheduleToolHandlers.set_schedule({ registry, from: 'bot-a', args: { ...check, command: undefined, template, connect } })).schedule
  assert.equal(saved.command, expandTemplate(template))
  await assert.rejects(scheduleToolHandlers.set_schedule({ registry, from: 'bot-a', args: { ...check, template } }), /SCHEDULE_ACTION_INVALID/u)
})

test('a template rejects params that are not exact or not safe, and an unknown kind', () => {
  for (const bad of [
    { kind: 'ci', params: { repo: "o/r'; rm -rf /", run: '1' }, until }, { kind: 'ci', params: { repo: 'o/r', run: '1; id' }, until },
    { kind: 'ci', params: { repo: 'o/r', run: '1', extra: 'x' }, until }, { kind: 'npm', params: { package: '$(id)', version: '1' }, until },
    { kind: 'url', params: { url: 'file:///etc/passwd' }, until }, { kind: 'url', params: { url: 'https://a b' }, until },
    { kind: 'ci', params: { repo: 'o/r', run: '1' }, until: 'soon' }, { kind: 'constructor', params: {}, until }, { kind: 'ci', params: { repo: 'o/r', run: '1' } },
  ]) assert.throws(() => expandTemplate(bad), /SCHEDULE_TEMPLATE_INVALID/u)
})

// Run the expanded command with a stub `gh`/`npm`/`curl` in front of PATH: exit 0 done, 75 not yet, 1 failed.
async function run(template, stubs) {
  const dir = await mkdtemp(join(tmpdir(), 'bellteam-stub-'))
  for (const [name, body] of Object.entries(stubs)) { await writeFile(join(dir, name), `#!/bin/sh\n${body}\n`); await chmod(join(dir, name), 0o755) }
  return spawnSync('sh', ['-c', expandTemplate(template)], { env: { PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8' }).status
}

test('expanded templates exit 0 / 75 / 1 as designed, and the deadline fails first', async () => {
  const ci = { kind: 'ci', params: { repo: 'o/r', run: '9' }, until }
  assert.equal(await run(ci, { gh: 'echo "completed success"' }), 0)
  assert.equal(await run(ci, { gh: 'echo "in_progress "' }), 75)
  assert.equal(await run(ci, { gh: 'echo "completed failure"' }), 1)
  assert.equal(await run(ci, { gh: 'exit 4' }), 1)
  assert.equal(await run({ ...ci, until: '2000-01-01T00:00:00.000Z' }, { gh: 'echo "completed success"' }), 1)
  const pr = { kind: 'pr-merged', params: { repo: 'o/r', number: '5' }, until }
  assert.deepEqual(await Promise.all(['MERGED', 'OPEN', 'CLOSED'].map(state => run(pr, { gh: `echo ${state}` }))), [0, 75, 1])
  const npm = { kind: 'npm', params: { package: '@a/b', version: '1.0.0' }, until }
  assert.deepEqual(await Promise.all([run(npm, { npm: 'echo 1.0.0' }), run(npm, { npm: 'echo "npm ERR! code E404" >&2; exit 1' }), run(npm, { npm: 'echo boom >&2; exit 1' })]), [0, 75, 1])
  const url = { kind: 'url', params: { url: 'https://example.com/x' }, until }
  assert.deepEqual(await Promise.all([200, 404, 500].map(code => run(url, { curl: `echo ${code}` }))), [0, 75, 1])
})

test('the protocol carries connect/template and the connectionRemoved effect', () => {
  validateMembersRequest('schedules.set', { ownerKind: 'bot', ownerId: 'bot-a', input: { ...check, connect } }, context)
  validateMembersEffect('schedules.connectionRemoved', { botId: 'bot-a', schedule: { id: 's-1', name: '', command: 'c', connect } }, context)
  assert.throws(() => validateMembersEffect('schedules.connectionRemoved', { botId: 'bot-a', schedule: { id: 's-1', connect: { project: 'x' } } }, context))
  assert.throws(() => validateMembersRequest('schedules.set', { ownerKind: 'bot', ownerId: 'bot-a', input: { ...check, connect, notify: 'result' } }, context))
})
