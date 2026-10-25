import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, symlink, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { transferServerState } from '../src/server-state-transfer.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'server-state-transfer-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const put = async (name, value) => { const path = join(root, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)) }
  const get = name => readFile(join(root, name), 'utf8')
  const absent = async name => { await assert.rejects(lstat(join(root, name)), { code: 'ENOENT' }) }
  const profile = name => ({ schema: 'bellteam.bot.v8', id: name, name, session: name, fastMode: false })
  const schedule = { schema: 'bellteam.schedule.v1', schedules: [{ id: 'one', enabled: false, lastRunAt: '2026-10-25T00:00:00Z' }] }
  await put('bots/.initialized', '')
  await put('bots/bot-a/bot.json', profile('bot-a')); await put('bots/bot-a/schedule.json', schedule)
  return { root, put, get, absent, profile, schedule, transfer: direction => transferServerState({ root, direction }) }
}

test('全既知stateと画像を移し、最新の予定・停止状態・Bot増減から逆移行する', async t => {
  const f = await fixture(t)
  const ai = { schema: 'bellteam.ai-control.v1', paused: true, updatedAt: '2026-10-25T00:00:00Z', resumedAt: null }
  await f.put('shared/ai-control.json', ai); await f.put('shared/subscription.json', { current: 'subscription' }); await f.put('shared/onboarding.json', { current: 'onboarding' })
  await f.put('shared/tools/call-bridge/headers', 'Synthetic-Header: test\n')
  await f.put('bots/bot-a/messages/assets/image.png', Buffer.alloc(200000, 7)); await f.put('bots/bot-a/docs/keep.md', 'seat-owned-doc')
  await f.put('state/owner-questions/keep.json', { retained: true })
  assert.deepEqual(await f.transfer('to-server'), { direction: 'to-server', status: 'transferred', bots: 1 })
  for (const name of ['bots/.initialized', 'bots/bot-a/bot.json', 'bots/bot-a/schedule.json', 'shared/ai-control.json', 'shared/subscription.json', 'shared/onboarding.json', 'shared/tools/call-bridge/headers']) await f.absent(name)
  assert.equal(await f.get('bots/bot-a/docs/keep.md'), 'seat-owned-doc')
  assert.equal((await readFile(join(f.root, 'state/bots/bot-a/messages/assets/image.png'))).length, 200000)
  assert.equal((await lstat(join(f.root, 'state/bots/bot-a/bot.json'))).mode & 0o777, 0o600)
  assert.equal((await f.transfer('to-server')).status, 'already-transferred')
  // A deletion and creation under the new server must survive a return.
  await rm(join(f.root, 'state/bots/bot-a'), { recursive: true })
  await f.put('state/bots/bot-b/bot.json', f.profile('bot-b'))
  await f.put('state/bots/bot-b/schedule.json', { ...f.schedule, schedules: [{ id: 'latest', enabled: true }] })
  await f.put('state/ai-control.json', { ...ai, paused: false, updatedAt: '2026-10-25T01:00:00Z' })
  assert.equal((await f.transfer('to-legacy')).bots, 1)
  await f.absent('bots/bot-a/bot.json'); assert.equal(JSON.parse(await f.get('bots/bot-b/schedule.json')).schedules[0].id, 'latest')
  assert.equal(JSON.parse(await f.get('shared/ai-control.json')).paused, false)
  assert.equal(await f.get('shared/tools/call-bridge/headers'), 'Synthetic-Header: test\n')
  assert.equal(JSON.parse(await f.get('state/owner-questions/keep.json')).retained, true)
  await f.absent('state/bots/.initialized'); assert.equal((await f.transfer('to-legacy')).status, 'already-transferred')
})

test('途中失敗では完了印を付けず、残した正本と既に移したstateから再開する', async t => {
  const f = await fixture(t)
  await f.put('state/bots/bot-a/schedule.json', { ...f.schedule, schedules: [{ id: 'conflict' }] })
  await assert.rejects(f.transfer('to-server'), { code: 'SERVER_STATE_TRANSFER_CONFLICT' })
  await f.absent('state/bots/.initialized'); await f.absent('bots/bot-a/bot.json')
  assert.equal(JSON.parse(await f.get('state/bots/bot-a/bot.json')).id, 'bot-a')
  await rm(join(f.root, 'state/bots/bot-a/schedule.json'))
  assert.equal((await f.transfer('to-server')).status, 'transferred')
  assert.deepEqual(JSON.parse(await f.get('state/bots/bot-a/schedule.json')), f.schedule)
})

test('全Bot文書を先に検証し、壊れた予定と未完削除は元を残して拒否する', async t => {
  const f = await fixture(t)
  await f.put('bots/bot-z/bot.json', f.profile('bot-z')); await f.put('bots/bot-z/schedule.json', 'broken')
  await assert.rejects(f.transfer('to-server'), { code: 'SERVER_STATE_DOCUMENT_INVALID' })
  assert.equal(JSON.parse(await f.get('bots/bot-a/bot.json')).id, 'bot-a'); await f.absent('state/bots/.initialized')
  await rm(join(f.root, 'bots/bot-z'), { recursive: true }); await f.put('state/bots/.deleting/bot-x.json', '{}')
  await assert.rejects(f.transfer('to-server'), { code: 'SERVER_STATE_PENDING_REMOVAL' })
})

test('symlink親・画像symlink・hardlinkを追わず、外側を移動しない', async t => {
  const f = await fixture(t)
  await f.put('outside/keep.png', 'must stay')
  await mkdir(join(f.root, 'bots/bot-a/messages'), { recursive: true })
  await symlink(join(f.root, 'outside'), join(f.root, 'bots/bot-a/messages/assets'))
  await assert.rejects(f.transfer('to-server'), { code: 'SERVER_STATE_DIRECTORY_INVALID' })
  assert.equal(await f.get('outside/keep.png'), 'must stay'); await f.absent('state/bots/.initialized')
  await rm(join(f.root, 'bots/bot-a/messages/assets')); await mkdir(join(f.root, 'bots/bot-a/messages/assets'))
  await link(join(f.root, 'outside/keep.png'), join(f.root, 'bots/bot-a/messages/assets/linked.png'))
  await assert.rejects(f.transfer('to-server'), { code: 'SERVER_STATE_FILE_INVALID' })
  assert.equal(await f.get('outside/keep.png'), 'must stay')
})

test('commit直後の旧marker残留だけを回収し、復活した旧stateは黙って採用しない', async t => {
  const f = await fixture(t)
  await f.transfer('to-server'); await f.put('bots/.initialized', '')
  assert.equal((await f.transfer('to-server')).status, 'already-transferred'); await f.absent('bots/.initialized')
  await f.put('bots/bot-a/bot.json', f.profile('bot-a'))
  await assert.rejects(f.transfer('to-server'), { code: 'SERVER_STATE_TRANSFER_CONFLICT' })
})

test('空設置と壊れた既設置を区別し、AI停止文書を有効既定へ置き換えない', async t => {
  const f = await fixture(t)
  await f.put('shared/ai-control.json', '{}')
  await assert.rejects(f.transfer('to-server'), { code: 'AI_CONTROL_TRANSFER_INVALID' }); await f.absent('state/bots/.initialized')
  assert.equal(await f.get('shared/ai-control.json'), '{}')
  const empty = await mkdtemp(join(tmpdir(), 'server-state-fresh-')); t.after(() => rm(empty, { recursive: true, force: true }))
  assert.equal((await transferServerState({ root: empty, direction: 'to-server' })).status, 'fresh')
  await assert.rejects(transferServerState({ root: 'relative', direction: 'to-server' }), { code: 'SERVER_STATE_TRANSFER_OPTIONS' })
})
