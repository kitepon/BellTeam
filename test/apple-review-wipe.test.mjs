import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import test from 'node:test'
import {check, wipe} from '../scripts/apple-review-wipe.mjs'

async function tree(files) {
  const root = await mkdtemp(join(tmpdir(), 'review-wipe-'))
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), {recursive: true})
    await writeFile(join(root, path), body)
  }
  return root
}
const exists = (root, path) => stat(join(root, path)).then(() => true, () => false)

const files = {
  'data/state/push-devices.json': 'TOKEN-SECRET',
  'data/shared/subscription.json': JSON.stringify({schema: 'v1', setupComplete: true, signedTransaction: 'JWS-SECRET', verification: {entitled: true}, error: null, setup: {botId: 'bot-guide'}}),
  'data/logs/direct-messages.jsonl': 'VALUE',
  'data/bots/bot-guide/memory/memory.db': 'VALUE',
  'data/bots/bot-guide/bot.json': '{}',
  'data/bots/bot-guide/AGENTS.md': 'setup',
  'data/owner/profile.json': '{}',
  'data/shared/onboarding.json': '{}',
  'data/shared/unknown-store/x': 'new store',
  'home/.codex/auth.json': 'LOGIN',
  'home/.codex/history.jsonl': 'VALUE',
  'home/.codex/sessions/2026/a.jsonl': 'VALUE',
  'home/.throughline/throughline.db': 'VALUE',
  'home/.claude.json': 'LOGIN',
  'home/.local/bin/tool': 'tool',
}

test('check counts reviewer content without printing values', async t => {
  const root = await tree(files)
  t.after(() => rm(root, {recursive: true, force: true}))
  const result = await check(root)
  assert.equal(result.categories['push-devices'].files, 1)
  assert.equal(result.categories['purchase-records'].entries, 1)
  assert.match(result.categories['push-devices'].oldest, /^20\d\d-/)
  assert.equal(result.categories['cli-transcripts'].files, 3)
  assert.deepEqual(result.unclassified, ['data/shared/unknown-store'])
  assert.doesNotMatch(JSON.stringify(result), /SECRET|VALUE|LOGIN/)
})

test('wipe removes reviewer content, keeps the demo setup and login, and is idempotent', async t => {
  const root = await tree(files)
  t.after(() => rm(root, {recursive: true, force: true}))
  const {after} = await wipe(root)
  assert.deepEqual(after.categories, {})
  for (const gone of ['data/state/push-devices.json', 'data/logs', 'data/bots/bot-guide/memory', 'home/.codex/history.jsonl',
    'home/.codex/sessions', 'home/.throughline']) assert.equal(await exists(root, gone), false, gone)
  for (const kept of ['data/bots/bot-guide/bot.json', 'data/bots/bot-guide/AGENTS.md', 'data/owner/profile.json',
    'data/shared/onboarding.json', 'home/.codex/auth.json', 'home/.claude.json', 'home/.local/bin/tool',
    'data/shared/unknown-store/x']) assert.equal(await exists(root, kept), true, kept)
  assert.deepEqual(JSON.parse(await readFile(join(root, 'data/shared/subscription.json'), 'utf8')),
    {schema: 'v1', setupComplete: true, signedTransaction: null, verification: null, error: null, setup: {botId: 'bot-guide'}})
  assert.deepEqual((await wipe(root)).after.categories, {})
})
