import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const source = process.env.REMINDER_MERGE_SOURCE_ROOT || new URL('..', import.meta.url).pathname
const { createGlobalInstructionsRefresher, taskSettingsReminder, writeGlobalInstructions } =
  await import(pathToFileURL(process.env.REMINDER_MERGE_GLOBAL_MODULE || join(source, 'src/global-instructions.mjs')))

test('main reminder merge: canonical reminder keeps the seat-owned writer and its default file writer', async t => {
  const root = await mkdtemp(join(tmpdir(), 'main-reminder-merge-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'uncreated-seat-home'), writes = []
  await createGlobalInstructionsRefresher({ home,
    ownerProfile: { get: async () => ({ name: 'Synthetic owner', links: [] }) },
    userRules: { get: async () => 'Synthetic user rule' },
    write: async (...args) => writes.push(args),
  })()
  assert.equal(writes.length, 1)
  assert.equal(writes[0][0], home)
  assert.match(writes[0][1], /Synthetic owner[\s\S]*Synthetic user rule/)
  const reminder = await taskSettingsReminder()
  assert.ok(reminder.includes('get_self') && reminder.includes('Terra最新版のHigh'))
  assert.ok(writes[0][1].includes(reminder))
  await assert.rejects(stat(home), { code: 'ENOENT' })
  for (const cli of ['claude', 'codex', 'grok', 'cursor']) await mkdir(join(home, '.' + cli), { recursive: true })
  await writeGlobalInstructions(home, writes[0][1])
  for (const cli of ['claude', 'codex', 'grok', 'cursor']) {
    const file = join(home, '.' + cli, 'AGENTS.md')
    assert.equal(await readFile(file, 'utf8'), writes[0][1])
    assert.equal((await stat(file)).mode & 0o777, 0o600)
  }
  assert.equal(await readFile(join(home, '.claude/CLAUDE.md'), 'utf8'), '@AGENTS.md\n')
})
