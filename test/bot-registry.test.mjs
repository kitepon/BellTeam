import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { BotRegistry } from '../src/bot-registry.mjs'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-bots-'))
  const seedPath = join(root, 'seed.json')
  await writeFile(seedPath, JSON.stringify({
    schema: 'bellteam.bots.v1',
    bots: [{
      id: 'bot-a', displayName: '調査担当', harness: 'grok', color: 'rose',
      session: 'bot-a', project: '/old/path',
    }],
  }))
  const registry = new BotRegistry({
    seedPath,
    botsRoot: join(root, 'bots'),
    now: () => new Date('2026-08-31T00:00:00.000Z'),
    id: () => 'schedule-1',
    botId: () => 'bot-b',
    models: { forHarness: async harness => ({ efforts: {
      claude: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
      codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      grok: ['low', 'medium', 'high', 'xhigh'], cursor: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    }[harness] }) },
  })
  await registry.initialize()
  return { root, seedPath, registry }
}

test('seedからBot別プロジェクトを作り、プロフィール変更を永続化する', async () => {
  const { root, registry } = await fixture()
  const seeded = registry.get('bot-a')
  assert.equal(seeded.project, join(root, 'bots/bot-a'))
  assert.equal(seeded.personality, '')

  const created = await registry.create({
    name: 'ゆず', harness: 'grok', color: 'indigo',
    profileText: '調査チームの一員', personality: '明るく率直に話す', speechStyle: '一人称は私', position: 'チームリード', role: '開発担当',
    avatar: 'data:image/png;base64,iVBORw0KGgo=',
  })
  assert.equal(created.project, join(root, 'bots/bot-b'))

  await registry.update('bot-b', { name: 'ゆず改', position: '設計者', role: '実装担当' })
  await registry.refresh()
  assert.equal(registry.get('bot-b').displayName, 'ゆず改 設計者')
  assert.equal(registry.get('bot-b').position, '設計者')
  assert.equal(registry.get('bot-b').personality, '明るく率直に話す')

  const profile = JSON.parse(await readFile(join(root, 'bots/bot-b/bot.json'), 'utf8'))
  assert.equal(profile.schema, 'bellteam.bot.v7')
  assert.equal(profile.profileText, '調査チームの一員')
  assert.equal(profile.speechStyle, '一人称は私')
  assert.equal(profile.session, 'bot-b')
  assert.equal(profile.name, 'ゆず改')
  assert.equal(profile.position, '設計者')
  assert.equal(Object.hasOwn(profile, 'title'), false)
  assert.equal(profile.role, '実装担当')
  const instructions = await readFile(join(root, 'bots/bot-b/AGENTS.md'), 'utf8')
  assert.match(instructions, /明るく率直に話す/u)
  assert.match(instructions, /## プロフィール\n\n「調査チームの一員」/u)
  assert.match(instructions, /## 性格（考え方）\n\n「明るく率直に話す」/u)
  assert.match(instructions, /## 口調\n\n「一人称は私」/u)
  assert.match(instructions, /設計者/u)
  assert.match(instructions, /実装担当/u)
  assert.equal(await readFile(join(root, 'bots/bot-b/CLAUDE.md'), 'utf8'), '@AGENTS.md\n')
  assert.ok((await import('node:fs')).existsSync(join(root, 'bots/bot-b/docs')), 'Bot作成時にdocs/を作る')
  assert.ok((await import('node:fs')).existsSync(join(root, 'bots/bot-b/assets/character-sheet')), 'Bot作成時にassets/character-sheet/を作る')
})

test('起動前に前セッションの短期記憶をBot情報の後へ置く', async () => {
  const { root, registry } = await fixture()
  await registry.prepareStartupContext('bot-a', '直前の会話を続ける。')

  const instructions = await readFile(join(root, 'bots/bot-a/AGENTS.md'), 'utf8')
  assert.ok(instructions.indexOf('# 自分のBot情報') < instructions.indexOf('# 前セッションの短期記憶'))
  assert.match(instructions, /直前の会話を続ける。/u)
  assert.equal(await readFile(join(root, 'bots/bot-a/CLAUDE.md'), 'utf8'), '@AGENTS.md\n')
})

test('作成後のCLI変更はBot固有データを残してプロフィールへ永続化する', async () => {
  const { root, registry } = await fixture()
  const project = registry.get('bot-a').project
  const memoryPath = join(project, 'memory-marker.txt')
  await writeFile(memoryPath, '長期記憶は同じBotプロジェクトに残る')

  const updated = await registry.update('bot-a', { harness: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'high' })
  await registry.refresh()

  assert.equal(updated.harness, 'codex')
  assert.equal(updated.model, 'gpt-5.6-sol')
  assert.equal(updated.reasoningEffort, 'high')
  assert.equal(registry.get('bot-a').harness, 'codex')
  const profile = JSON.parse(await readFile(join(project, 'bot.json'), 'utf8'))
  assert.equal(profile.harness, 'codex')
  assert.equal(profile.model, 'gpt-5.6-sol')
  assert.equal(profile.reasoningEffort, 'high')
  assert.equal(await readFile(memoryPath, 'utf8'), '長期記憶は同じBotプロジェクトに残る')
})

test('Aitermが返した最新セッションIDを再起動後も引き継ぐ', async () => {
  const { root, seedPath, registry } = await fixture()

  await registry.updateSession('bot-a', 'grok-new-session')

  const restarted = new BotRegistry({ seedPath, botsRoot: join(root, 'bots') })
  await restarted.initialize()
  assert.equal(restarted.get('bot-a').session, 'grok-new-session')
  const profile = JSON.parse(await readFile(join(root, 'bots/bot-a/bot.json'), 'utf8'))
  assert.equal(profile.session, 'grok-new-session')
})

test('旧肩書きは役職へ移さず、プロフィールから除去する', async () => {
  const { root, seedPath } = await fixture()
  const profilePath = join(root, 'bots/bot-a/bot.json')
  await writeFile(profilePath, JSON.stringify({
    schema: 'bellteam.bot.v3', id: 'bot-a', name: 'あかり', title: '旧肩書き', role: '調査',
    personality: '率直', avatar: '', color: 'rose', harness: 'grok',
  }))

  const registry = new BotRegistry({ seedPath, botsRoot: join(root, 'bots') })
  await registry.initialize()

  assert.equal(registry.get('bot-a').position, '')
  assert.equal(registry.get('bot-a').displayName, 'あかり')
  const migrated = JSON.parse(await readFile(profilePath, 'utf8'))
  assert.equal(migrated.schema, 'bellteam.bot.v7')
  assert.equal(migrated.personality, '率直')
  assert.equal(migrated.profileText, '')
  assert.equal(migrated.speechStyle, '')
  assert.equal(migrated.session, 'bot-a')
  assert.equal(Object.hasOwn(migrated, 'title'), false)
  assert.equal(migrated.position, '')
  assert.equal(migrated.model, '')
  assert.equal(migrated.reasoningEffort, '')
  assert.doesNotMatch(await readFile(join(root, 'bots/bot-a/AGENTS.md'), 'utf8'), /肩書き/u)
  await assert.rejects(registry.update('bot-a', { title: '残骸' }), /BOT_UPDATE_FIELD_INVALID: title/u)
})

test('旧人格を失わずに移行し、3欄の編集と再起動で内容を保持する', async () => {
  const { root, seedPath, registry } = await fixture()
  const path = join(root, 'bots/bot-a/bot.json')
  const original = JSON.parse(await readFile(path, 'utf8'))
  delete original.profileText
  delete original.speechStyle
  await writeFile(path, JSON.stringify({ ...original, schema: 'bellteam.bot.v6', personality: '調査チームの一員。好奇心旺盛。一人称は私。' }))
  await registry.initialize()
  assert.equal(registry.get('bot-a').personality, '調査チームの一員。好奇心旺盛。一人称は私。')
  await registry.update('bot-a', { profileText: '調査チームの一員。', personality: '好奇心旺盛。', speechStyle: '一人称は私。' })
  await registry.update('bot-a', { speechStyle: '一人称は僕。' })
  const restarted = new BotRegistry({ seedPath, botsRoot: join(root, 'bots') })
  await restarted.initialize()
  assert.equal(restarted.get('bot-a').profileText, '調査チームの一員。')
  assert.equal(restarted.get('bot-a').personality, '好奇心旺盛。')
  assert.equal(restarted.get('bot-a').speechStyle, '一人称は僕。')
})

test('予定はBotごとのschedule.json一ファイルへ保存する', async () => {
  const { root, registry } = await fixture()
  const once = await registry.setSchedule('bot-a', {
    kind: 'once', name: '朝会', at: '2026-09-01T00:30:00.000Z', prompt: '朝会を始めて', enabled: true,
  })
  assert.equal(once.id, 'schedule-1')
  assert.equal(once.nextRunAt, '2026-09-01T00:30:00.000Z')

  const recurring = await registry.setSchedule('bot-a', {
    id: once.id, kind: 'cron', name: '毎時確認', expression: '15 * * * *',
    timezone: 'Asia/Tokyo', prompt: '進捗を確認して', enabled: true,
  })
  assert.equal(recurring.expression, '15 * * * *')
  assert.equal((await registry.listSchedules('bot-a')).length, 1)

  const persisted = JSON.parse(await readFile(join(root, 'bots/bot-a/schedule.json'), 'utf8'))
  assert.equal(persisted.schema, 'bellteam.schedule.v1')
  assert.equal(persisted.schedules[0].id, once.id)
})

test('予定はpromptかcommandのどちらか一方だけを持つ', async () => {
  const { registry } = await fixture()
  const command = await registry.setSchedule('bot-a', {
    kind: 'cron', name: '収集', expression: '20 * * * *', command: ' python3 -m news.ingest ',
  })
  assert.equal(command.command, 'python3 -m news.ingest')
  assert.equal('prompt' in command, false)
  await assert.rejects(
    registry.setSchedule('bot-a', { kind: 'cron', expression: '20 * * * *', prompt: '集めて', command: 'python3 -m news.ingest' }),
    /SCHEDULE_ACTION_INVALID/u,
  )
  await assert.rejects(
    registry.setSchedule('bot-a', { kind: 'cron', expression: '20 * * * *' }),
    /SCHEDULE_ACTION_INVALID/u,
  )
})

test('不正なavatarとcron式は保存しない', async () => {
  const { registry } = await fixture()
  await assert.rejects(
    registry.update('bot-a', { avatar: 'https://example.com/avatar.webp' }),
    /BOT_AVATAR_INVALID/u,
  )
  await assert.rejects(
    registry.setSchedule('bot-a', { kind: 'cron', expression: 'bad cron', prompt: '実行して' }),
    /SCHEDULE_EXPRESSION_INVALID/u,
  )
  await assert.rejects(registry.update('bot-a', { model: 'invalid model' }), /BOT_MODEL_INVALID/u)
  await assert.rejects(registry.update('bot-a', { reasoningEffort: 'ultra' }), /BOT_REASONING_EFFORT_INVALID/u)
  await assert.rejects(
    registry.update('bot-a', { harness: 'cursor', reasoningEffort: 'high' }),
    /BOT_CURSOR_MODEL_REQUIRED_FOR_EFFORT/u,
  )
})

test('Botプロジェクトを削除し、再起動後もseedから復活させない', async () => {
  const { root, seedPath, registry } = await fixture()
  const project = registry.get('bot-a').project

  assert.deepEqual(await registry.remove('bot-a'), { id: 'bot-a' })
  await assert.rejects(access(project), /ENOENT/u)

  const restarted = new BotRegistry({ seedPath, botsRoot: join(root, 'bots') })
  await restarted.initialize()
  assert.equal(restarted.has('bot-a'), false)
})

test('Bot作成後に共通設定を同期する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-bots-'))
  const seedPath = join(root, 'bots.json')
  await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [] }))
  const changes = []
  const registry = new BotRegistry({
    seedPath,
    botsRoot: join(root, 'bots'),
    botId: () => 'bot-new',
    onChange: bots => changes.push([...bots.keys()]),
  })
  await registry.initialize()

  await registry.create({ name: '新規Bot', harness: 'codex' })

  assert.deepEqual(changes, [['bot-new']])
})

test('ClaudeとCursorをBotのハーネスに選べる', async () => {
  const { registry } = await fixture()
  await registry.create({ name: 'Claude Bot', harness: 'claude' })
  assert.equal(registry.get('bot-b').harness, 'claude')

  await registry.remove('bot-b')
  await registry.create({ name: 'Cursor Bot', harness: 'cursor' })
  assert.equal(registry.get('bot-b').harness, 'cursor')
})

test('エフォートはCLIごとの候補で検証する', async () => {
  const { registry } = await fixture()
  const claude = await registry.update('bot-a', { harness: 'claude', model: 'opus', reasoningEffort: 'ultracode' })
  assert.equal(claude.reasoningEffort, 'ultracode')
  await assert.rejects(registry.update('bot-a', { harness: 'grok', model: 'grok-4.6', reasoningEffort: 'max' }), /BOT_REASONING_EFFORT_INVALID/u)
  const codex = await registry.update('bot-a', { harness: 'codex', model: 'gpt-6-astra', reasoningEffort: 'ultra' })
  assert.equal(codex.reasoningEffort, 'ultra')
})

test('新しいエフォートは最新のCLI一覧から受け入れ、取得不能では設定を保存しない', async () => {
  const { registry } = await fixture()
  let efforts = ['new-effort']
  registry.models = { forHarness: async () => ({ efforts }) }
  await registry.update('bot-a', { reasoningEffort: 'new-effort' })
  assert.equal(registry.get('bot-a').reasoningEffort, 'new-effort')
  efforts = ['next-effort']
  await registry.update('bot-a', { reasoningEffort: 'next-effort' })
  registry.models = { forHarness: async () => { throw new Error('MODEL_CATALOG_UNAVAILABLE') } }
  await assert.rejects(registry.update('bot-a', { reasoningEffort: 'high' }), /MODEL_CATALOG_UNAVAILABLE/u)
  await registry.refresh()
  assert.equal(registry.get('bot-a').reasoningEffort, 'next-effort')
  await registry.update('bot-a', { role: 'プロフィールだけを変更' })
  assert.equal(registry.get('bot-a').reasoningEffort, 'next-effort')
})
