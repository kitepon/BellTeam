import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConversationServices } from '../src/conversation-services.mjs'
import { Diagnostics } from '../src/diagnostics.mjs'

test('parent writer separates crash tail and Store reports it while returning preserved records', async t => {
  const root = await mkdtemp(join(tmpdir(), 'conversation-log-joint-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'logs'))
  const logPath = join(root, 'logs/direct-messages.jsonl')
  const record = id => ({ schema: 'bellteam.direct-message.v1', delivery_id: id, from: 'user', target: 'bot-test', message: 'sensitive-body', at: '2026-11-04T00:00:00Z' })
  const prefix = Buffer.concat([Buffer.from(JSON.stringify(record('old')) + '\n'), Buffer.alloc(147)])
  await writeFile(logPath, prefix)
  const diagnostics = new Diagnostics(join(root, 'logs/diagnostics.json'))
  await diagnostics.initialize()
  const reports = [], pending = []
  const services = createConversationServices({ root, bots: { readRemovalStates: async () => ({ removals: [] }) }, transport: {},
    notifications: { direct() {} }, aiControl: {}, settings: {},
    onLogCorruption: report => { reports.push(report); const result = diagnostics.record({ code: report.code, module: 'conversation', diagnostic_log: JSON.stringify(report) }); pending.push(result); return result },
  })
  await services.assets.initialize()
  await services.messenger.append(record('new'))
  assert.deepEqual((await services.store.records()).map(row => row.delivery_id), ['old', 'new'])
  await Promise.all(pending)
  assert.deepEqual((await readFile(logPath)).subarray(0, prefix.length), prefix)
  assert.equal(reports.length, 1)
  assert.equal(reports[0].reason, 'nul')
  assert.equal(reports[0].length, 147)
  const saved = await readFile(join(root, 'logs/diagnostics.json'), 'utf8')
  assert.match(saved, /MESSAGE_LOG_INVALID/)
  assert.doesNotMatch(saved, /sensitive-body/)
  await services.store.records()
  assert.equal(reports.length, 1)
})
