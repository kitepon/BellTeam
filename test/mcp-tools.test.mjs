import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { callBellTeamTool, bellTeamTools, resolveBotImagePath } from '../src/mcp-tools.mjs'

test('Grokが返す相対画像パスを現在のprojectに対応する最新sessionから解決する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-grok-image-'))
  const home = join(root, 'home')
  const project = join(root, 'bots/bot-a')
  const older = join(home, '.grok', 'sessions', encodeURIComponent(project), 'session-old', 'images')
  const newer = join(home, '.grok', 'sessions', encodeURIComponent(project), 'session-new', 'images')
  await mkdir(older, { recursive: true })
  await writeFile(join(older, '1.jpg'), 'old')
  await new Promise(resolve => setTimeout(resolve, 5))
  await mkdir(newer, { recursive: true })
  await writeFile(join(newer, '1.jpg'), 'new')

  assert.equal(await resolveBotImagePath({ id: 'bot-a', harness: 'grok', project }, 'images/1.jpg', { home }), join(newer, '1.jpg'))
  await mkdir(join(project, 'images'), { recursive: true })
  await writeFile(join(project, 'images/1.jpg'), 'project')
  assert.equal(await resolveBotImagePath({ id: 'bot-a', harness: 'grok', project }, 'images/1.jpg', { home }), join(project, 'images/1.jpg'))
  await assert.rejects(resolveBotImagePath({ id: 'bot-a', harness: 'grok', project }, '../secret.png', { home }), /IMAGE_PATH_INVALID/u)
})

test('get_owner_profileは全Botへ共通のオーナー正本を返す', async () => {
  const registry = new Map([['bot-a', { id: 'bot-a' }]])
  registry.refresh = async () => registry
  const profile = { schema: 'bellteam.owner-profile.v1', name: '利用者', profile: 'オーナー', avatar: '', xUrl: '', githubUrl: '', links: [] }

  assert.deepEqual(await callBellTeamTool({
    name: 'get_owner_profile', from: 'bot-a', registry, rooms: null,
    ownerProfile: { async get() { return profile } },
  }), { owner: { schema: 'bellteam.owner-profile.v1', name: '利用者', profile: 'オーナー', hasAvatar: false, xUrl: '', githubUrl: '', links: [] } })
  assert.ok(bellTeamTools.some(tool => tool.name === 'get_owner_profile'))
})

test('道具の返事は画像本体を外し、有無と取得先だけを返す', async () => {
  const body = `data:image/png;base64,${'A'.repeat(120000)}`
  const registry = new Map([
    ['bot-a', { id: 'bot-a', name: 'あ', avatar: body }],
    ['bot-b', { id: 'bot-b', name: 'い', avatar: '' }],
  ])
  registry.refresh = async () => registry
  registry.update = async (id, changes) => ({ ...registry.get(id), ...changes })
  const room = { id: 'room-1', name: '部屋', memberIds: ['bot-a'], avatar: body }
  const rooms = new Map([['room-1', room]])
  rooms.refresh = async () => rooms
  const context = {
    from: 'bot-a', registry, rooms, internalUrl: 'http://127.0.0.1:4181',
    ownerProfile: { async get() { return { name: '利用者', avatar: body } } },
  }
  const call = (name, args = {}) => callBellTeamTool({ ...context, name, arguments: args })

  assert.deepEqual(await call('get_self'), { bot: { id: 'bot-a', name: 'あ', hasAvatar: true, avatarUrl: 'http://127.0.0.1:4181/api/bots/bot-a/avatar' } })
  assert.deepEqual(await call('get_bot', { botId: 'bot-b' }), { bot: { id: 'bot-b', name: 'い', hasAvatar: false } })
  assert.deepEqual(await call('update_self', { role: '整備' }), { bot: { id: 'bot-a', name: 'あ', role: '整備', hasAvatar: true, avatarUrl: 'http://127.0.0.1:4181/api/bots/bot-a/avatar' } })
  assert.deepEqual(await call('get_owner_profile'), { owner: { name: '利用者', hasAvatar: true, avatarUrl: 'http://127.0.0.1:4181/api/owner/avatar' } })
  assert.deepEqual(await call('get_room', { roomId: 'room-1' }), { room: { id: 'room-1', name: '部屋', memberIds: ['bot-a'], hasAvatar: true } })
  assert.deepEqual(await call('list_rooms'), { rooms: [{ id: 'room-1', name: '部屋', memberIds: ['bot-a'], hasAvatar: true }] })
  // 台帳の値は変えない。
  assert.equal(registry.get('bot-a').avatar, body)
  assert.equal(room.avatar, body)
})

test('get_user_rulesは呼出元を問わずユーザー規範の本文を返す', async () => {
  const registry = new Map([['bot-a', { id: 'bot-a', position: '' }]])
  registry.refresh = async () => registry

  assert.deepEqual(await callBellTeamTool({
    name: 'get_user_rules', from: 'bot-a', registry, rooms: null,
    userRules: { async get() { return '- 規範\n' } },
  }), { text: '- 規範\n' })
  assert.ok(bellTeamTools.some(tool => tool.name === 'get_user_rules'))
  assert.ok(!bellTeamTools.some(tool => tool.name === 'update_user_rules'), '書き換えは共通MCPに置かない')
})

test('MCPから自分のプロフィールと予定を変更できる', async () => {
  const calls = []
  const registry = {
    get(id) { return id === 'bot-a' ? { id, displayName: 'Bot A' } : null },
    async refresh() {},
    async update(id, changes) { calls.push(['update', id, changes]); return { id, ...changes } },
    async setSchedule(id, schedule) { calls.push(['schedule', id, schedule]); return { id: 's-1', ...schedule } },
    async listSchedules() { return [] },
    async removeSchedule(id, scheduleId) { calls.push(['remove', id, scheduleId]); return true },
    async create(profile) { calls.push(['create', profile]); return profile },
  }
  const messenger = { async sendmessage(value) { calls.push(['message', value]); return { delivery: 'delivered' } } }
  await callBellTeamTool({ name: 'update_self', arguments: { name: '新しい名前', profileText: '調査チームの一員', personality: '好奇心旺盛', speechStyle: '一人称は私', position: '主任', role: '調査' }, from: 'bot-a', registry, messenger })
  await callBellTeamTool({ name: 'set_schedule', arguments: { kind: 'cron', expression: '0 * * * *', prompt: '確認して' }, from: 'bot-a', registry, messenger })

  assert.deepEqual(calls[0], ['update', 'bot-a', { name: '新しい名前', profileText: '調査チームの一員', personality: '好奇心旺盛', speechStyle: '一人称は私', position: '主任', role: '調査' }])
  assert.equal(calls[1][0], 'schedule')
  assert.ok(bellTeamTools.some(tool => tool.name === 'create_bot'))
  assert.ok(bellTeamTools.some(tool => tool.name === 'list_schedules'))
  assert.equal('id' in bellTeamTools.find(tool => tool.name === 'create_bot').inputSchema.properties, false)
  assert.deepEqual(
    bellTeamTools.find(tool => tool.name === 'create_bot').inputSchema.properties.harness.enum,
    ['claude', 'codex', 'grok', 'cursor'],
  )
  assert.equal(bellTeamTools.find(tool => tool.name === 'create_bot').inputSchema.properties.position.maxLength, 100)
  assert.equal('title' in bellTeamTools.find(tool => tool.name === 'create_bot').inputSchema.properties, false)
})

test('create_botはBot情報と記憶領域だけを作り、偽の会話を始めない', async () => {
  const calls = []
  const registry = {
    async refresh() {},
    get(id) { return id === 'bot-a' ? { id } : null },
    async create(profile) { return { ...profile, id: 'bot-new', personality: '', role: '' } },
  }
  const memory = { async ensureScope(id, scope) { calls.push(`${id}:${scope}`) } }

  const result = await callBellTeamTool({
    name: 'create_bot',
    arguments: { name: '新しいBot', harness: 'grok' },
    from: 'bot-a', registry, messenger: {}, memory,
  })

  assert.equal(result.bot.id, 'bot-new')
  assert.deepEqual(calls, ['bot-new:personal'])
})

test('MCPの長期記憶とRAGは呼出元BotをBellTeam側で確定する', async () => {
  const calls = []
  const registry = new Map([['bot-a', { id: 'bot-a' }]])
  registry.refresh = async () => registry
  const memory = {
    async remember(value) { calls.push(['remember', value]); return { id: 'memory-1' } },
    async recallMemory(value) { calls.push(['recall', value]); return { items: [] } },
    async listMemoryCandidates(value) { calls.push(['candidates', value]); return { items: [] } },
    async organizeMemoryCandidate(value) { calls.push(['organize', value]); return { status: 'organized' } },
    async dismissMemoryCandidate(value) { calls.push(['dismiss', value]); return { status: 'dismissed' } },
    async reviseMemory(value) { calls.push(['revise', value]); return { id: 'memory-2' } },
    async pinMemory(value) { calls.push(['pin', value]); return { id: value.id } },
    async consolidateGrowth(value) { calls.push(['consolidate', value]); return { id: 'memory-3' } },
    async recordKnowledge(value) { calls.push(['record', value]); return { id: 'knowledge-1' } },
    async searchKnowledge(value) { calls.push(['search', value]); return { items: [] } },
  }
  const context = { from: 'bot-a', registry, memory, messenger: {} }

  await callBellTeamTool({ ...context, name: 'remember', arguments: { content: '大切な思い出', kind: 'episode' } })
  await callBellTeamTool({ ...context, name: 'recall_memory', arguments: { query: '思い出' } })
  await callBellTeamTool({ ...context, name: 'list_memory_candidates', arguments: { limit: 5 } })
  await callBellTeamTool({ ...context, name: 'organize_memory_candidate', arguments: {
    candidateId: 'turn-1', memories: [{ content: '会話から得た記憶', kind: 'fact' }],
  } })
  await callBellTeamTool({ ...context, name: 'dismiss_memory_candidate', arguments: { candidateId: 'turn-2' } })
  await callBellTeamTool({ ...context, name: 'revise_memory', arguments: { id: 'memory-1', content: '更新後' } })
  await callBellTeamTool({ ...context, name: 'pin_memory', arguments: { id: 'memory-2' } })
  await callBellTeamTool({ ...context, name: 'consolidate_growth', arguments: {
    memoryIds: ['memory-1', 'memory-2'], content: '成長した',
  } })
  await callBellTeamTool({ ...context, name: 'record_knowledge', arguments: { title: '設計', content: '個人RAG' } })
  await callBellTeamTool({ ...context, name: 'search_knowledge', arguments: { query: '設計', scope: 'shared' } })

  assert.deepEqual(calls, [
    ['remember', { botId: 'bot-a', content: '大切な思い出', kind: 'episode', sourceRef: 'mcp' }],
    ['recall', { botId: 'bot-a', query: '思い出' }],
    ['candidates', { botId: 'bot-a', limit: 5 }],
    ['organize', { botId: 'bot-a', candidateId: 'turn-1', memories: [{ content: '会話から得た記憶', kind: 'fact' }] }],
    ['dismiss', { botId: 'bot-a', candidateId: 'turn-2' }],
    ['revise', { botId: 'bot-a', id: 'memory-1', content: '更新後' }],
    ['pin', { botId: 'bot-a', id: 'memory-2' }],
    ['consolidate', { botId: 'bot-a', memoryIds: ['memory-1', 'memory-2'], content: '成長した' }],
    ['record', { botId: 'bot-a', title: '設計', content: '個人RAG' }],
    ['search', { botId: 'bot-a', query: '設計', scope: 'shared' }],
  ])
  for (const name of [
    'remember', 'recall_memory', 'list_memory_candidates', 'organize_memory_candidate',
    'dismiss_memory_candidate', 'revise_memory', 'pin_memory', 'consolidate_growth',
    'record_knowledge', 'search_knowledge',
  ])
    assert.ok(bellTeamTools.some(tool => tool.name === name), `${name}がない`)
})

test('update_selfは呼出元以外のBot IDを受け付けない', async () => {
  await assert.rejects(
    callBellTeamTool({
      name: 'update_self', arguments: { id: 'bot-b', role: '変更' }, from: 'bot-a',
      registry: { async refresh() {}, get() { return { id: 'bot-a' } } }, messenger: {},
    }),
    /TOOL_ARGUMENT_INVALID/u,
  )
})

test('Bot内MCPのメッセージ配送はメインサーバーへ集約する', async () => {
  const calls = []
  const registry = new Map([
    ['bot-a', { id: 'bot-a', project: '/bots/bot-a' }],
    ['bot-b', { id: 'bot-b', name: 'ベル', project: '/bots/bot-b' }],
  ])
  registry.refresh = async () => registry
  const context = {
    from: 'bot-a', registry, messenger: {}, roomMessenger: {},
    deliverMessage: async value => { calls.push(['direct', value]); return { delivery: 'queued' } },
    deliverRoomMessage: async value => { calls.push(['room', value]); return { delivery: 'queued' } },
    listQueued: async botId => { calls.push(['list-queued', botId]); return { items: [{ id: 'queue-1' }] } },
  }

  await callBellTeamTool({ ...context, name: 'sendmessage', arguments: { target: 'bot-b', message: '確認して' } })
  await callBellTeamTool({ ...context, name: 'sendroommessage', arguments: { room: 'room-a', message: '共有' } })
  await callBellTeamTool({ ...context, name: 'list_queued_messages', arguments: { botId: 'bot-b' } })

  assert.deepEqual(calls, [
    ['direct', { from: 'bot-a', target: 'bot-b', message: '確認して', image: null }],
    ['room', { from: 'bot-a', room: 'room-a', message: '共有', image: null }],
    ['list-queued', 'bot-b'],
  ])
})

test('MCPから全Botの管理、画像設定、会話取得、ユーザー送信ができる', async () => {
  const calls = []
  const registry = new Map([
    ['bot-a', { id: 'bot-a', name: 'あかり', position: '調査主任', displayName: 'あかり 調査主任', harness: 'grok', personality: '慎重', role: '調査', project: '/bots/bot-a' }],
    ['bot-b', { id: 'bot-b', name: 'ゆず', position: '開発主任', displayName: 'ゆず 開発主任', harness: 'codex', personality: '率直', role: '開発', project: '/bots/bot-b' }],
  ])
  registry.refresh = async () => registry
  registry.update = async (id, changes) => {
    calls.push(['update', id, changes])
    const updated = { ...registry.get(id), ...changes }
    registry.set(id, updated)
    return updated
  }
  registry.setSchedule = async (id, schedule) => {
    calls.push(['schedule', id, schedule])
    return { id: 's-1', ...schedule }
  }
  registry.listSchedules = async id => {
    calls.push(['list-schedules', id])
    return []
  }
  registry.removeSchedule = async (id, scheduleId) => {
    calls.push(['remove-schedule', id, scheduleId])
    return true
  }
  const messenger = {
    async sendmessage(value) {
      calls.push(['message', value])
      return { delivery: 'delivered' }
    },
  }
  const store = {
    async timeline(id) {
      calls.push(['timeline', id])
      return [{ id: 'm-1', message: 'こんにちは' }]
    },
  }
  const context = {
    from: 'bot-a', registry, messenger, store,
    restart: async id => ({ restarting: id }), remove: async id => ({ deleting: id }),
  }
  const avatarPath = join(await mkdtemp(join(tmpdir(), 'bellteam-avatar-')), 'avatar.png')
  await writeFile(avatarPath, Buffer.from('iVBORw0KGgo=', 'base64'))

  assert.deepEqual((await callBellTeamTool({ ...context, name: 'list_bots' })).bots[1], {
    id: 'bot-b', name: 'ゆず', position: '開発主任', cli: 'codex', profileText: '', personality: '率直', speechStyle: '', role: '開発',
  })
  assert.equal((await callBellTeamTool({ ...context, name: 'get_bot', arguments: { botId: 'bot-b' } })).bot.displayName, 'ゆず 開発主任')
  assert.deepEqual(await callBellTeamTool({ ...context, name: 'restart_session' }), { restarting: 'bot-a' })
  assert.deepEqual(await callBellTeamTool({ ...context, name: 'restart_session', arguments: { botId: 'bot-b' } }), { restarting: 'bot-b' })
  await callBellTeamTool({ ...context, name: 'update_bot', arguments: { botId: 'bot-b', role: '設計' } })
  await callBellTeamTool({ ...context, name: 'set_avatar', arguments: { botId: 'bot-b', path: avatarPath } })
  await callBellTeamTool({ ...context, name: 'set_schedule', arguments: { botId: 'bot-b', kind: 'cron', expression: '0 * * * *', prompt: '確認' } })
  await callBellTeamTool({ ...context, name: 'list_schedules', arguments: { botId: 'bot-b' } })
  await callBellTeamTool({ ...context, name: 'remove_schedule', arguments: { botId: 'bot-b', id: 's-1' } })
  assert.equal((await callBellTeamTool({ ...context, name: 'list_messages', arguments: { botId: 'bot-b' } })).items[0].message, 'こんにちは')
  await callBellTeamTool({ ...context, name: 'send_user_message', arguments: { target: 'bot-b', message: '状況を教えて' } })
  assert.deepEqual(await callBellTeamTool({ ...context, name: 'delete_bot', arguments: { botId: 'bot-b' } }), { deleting: 'bot-b' })

  assert.deepEqual(calls[0], ['update', 'bot-b', { role: '設計' }])
  assert.ok(calls.some(call => call[0] === 'update' && call[2].avatar === 'data:image/png;base64,iVBORw0KGgo='))
  assert.ok(calls.some(call => call[0] === 'schedule' && call[1] === 'bot-b'))
  assert.ok(calls.some(call => call[0] === 'message' && call[1].from === 'user'))
  for (const name of ['list_bots', 'get_bot', 'restart_session', 'delete_bot', 'update_bot', 'set_avatar', 'list_messages', 'send_user_message'])
    assert.ok(bellTeamTools.some(tool => tool.name === name), `${name}がない`)
})

test('update_botのCLI・モデル・エフォート変更は設定画面と同じ適用経路へ渡す', async () => {
  const calls = []
  const registry = new Map([
    ['bot-a', { id: 'bot-a', name: 'あかり' }],
    ['bot-b', { id: 'bot-b', name: 'ゆず', harness: 'claude', model: 'opus', reasoningEffort: 'high' }],
  ])
  registry.refresh = async () => registry
  registry.update = async (id, changes) => { calls.push(['update', id, changes]); return { ...registry.get(id), ...changes } }
  const configure = async (botId, changes) => { calls.push(['configure', botId, changes]); return { bot: { ...registry.get(botId), ...changes }, applying: true } }
  const context = { from: 'bot-a', registry, configure }

  const result = await callBellTeamTool({ ...context, name: 'update_bot', arguments: { botId: 'bot-b', harness: 'grok', model: 'grok-4.6', reasoningEffort: 'medium' } })
  assert.equal(result.bot.harness, 'grok')
  assert.equal(result.applying, true)
  await callBellTeamTool({ ...context, name: 'update_bot', arguments: { botId: 'bot-b', model: '', reasoningEffort: '' } })
  await callBellTeamTool({ ...context, name: 'update_bot', arguments: { botId: 'bot-b', role: '設計' } })
  assert.deepEqual(calls, [
    ['configure', 'bot-b', { harness: 'grok', model: 'grok-4.6', reasoningEffort: 'medium' }],
    ['configure', 'bot-b', { model: '', reasoningEffort: '' }],
    ['update', 'bot-b', { role: '設計' }],
  ])
  const schema = bellTeamTools.find(tool => tool.name === 'update_bot').inputSchema.properties
  assert.deepEqual(schema.harness.enum, ['claude', 'codex', 'grok', 'cursor'])
  assert.equal(schema.reasoningEffort.type, 'string')
  assert.equal(schema.reasoningEffort.enum, undefined, '動的な候補をMCP起動時のenumに固定しない')
})

test('MCPのモデル一覧は画面と同じAPIへCLIを渡す', async () => {
  const registry = new Map([['bot-a', { id: 'bot-a' }]])
  registry.refresh = async () => {}
  const calls = []
  const getModels = async harness => { calls.push(harness); return { models: { codex: { models: [{ id: 'gpt-6.1-sol', efforts: ['high'] }], efforts: ['high'] } } } }
  const result = await callBellTeamTool({ from: 'bot-a', registry, getModels, name: 'list_models', arguments: { harness: 'codex' } })
  assert.equal(result.models.codex.models[0].id, 'gpt-6.1-sol')
  assert.deepEqual(calls, ['codex'])
})

test('MCPのルーム設定は代表だけが行い、発言者は呼出元から決まる', async () => {
  const registry = new Map([
    ['bot-a', { id: 'bot-a', name: 'あかり', role: '調査', project: '/bots/bot-a' }],
    ['bot-b', { id: 'bot-b', name: 'ゆず', role: '開発', project: '/bots/bot-b' }],
  ])
  registry.refresh = async () => registry
  const rooms = new Map()
  rooms.refresh = async () => rooms
  rooms.create = async input => { const room = { id: 'room-1', ...input }; rooms.set(room.id, room); return room }
  rooms.update = async (id, changes) => { const room = { ...rooms.get(id), ...changes }; rooms.set(id, room); return room }
  rooms.remove = async id => rooms.delete(id)
  rooms.setSchedule = async (_id, schedule) => ({ id: 's-1', ...schedule })
  rooms.listSchedules = async () => []
  rooms.messages = async () => [
    ...['room-message-1', 'room-message-2', 'room-message-3'].map(id => ({
      id, sender: { id: 'bot-b' },
      deliveries: [{ target: 'bot-a', delivery: 'delivered' }],
      routing: { status: 'ready', responders: ['bot-a'] },
    })),
    { id: 'room-message-silent', routing: { status: 'ready', responders: ['bot-b'] } },
  ]
  const sent = []
  const roomMessenger = { async sendroommessage(value) { sent.push(value); return { id: 'm-1', delivery: 'posted' } } }
  const listQueued = async () => ({ items: [{ status: 'running', context: 'room', contextId: 'room-1', groupId: 'room-message-1', from: 'bot-b' }] })
  const context = { from: 'bot-a', registry, messenger: {}, store: {}, rooms, roomMessenger, listQueued }

  const created = await callBellTeamTool({
    ...context, name: 'create_room', arguments: { name: '開発室', purpose: '連携', memberIds: ['bot-b'] },
  })
  assert.equal(created.room.representativeId, 'bot-a')
  assert.deepEqual(created.room.memberIds, ['bot-b', 'bot-a'])
  await callBellTeamTool({ ...context, name: 'update_room', arguments: { roomId: 'room-1', purpose: '共同開発' } })
  await callBellTeamTool({ ...context, name: 'sendroommessage', arguments: { room: 'room-1', message: '始めよう', targets: ['bot-b'] } })
  assert.deepEqual(sent[0], { from: 'bot-a', room: 'room-1', message: '始めよう', targets: ['bot-b'], image: null })

  const silentContext = { ...context, listQueued: async () => ({ items: [
    { status: 'running', context: 'room', contextId: 'room-1', groupId: 'room-message-silent', from: 'bot-b' },
  ] }) }
  const silent = await callBellTeamTool({
    ...silentContext, name: 'respond_to_room',
    arguments: { action: 'silent' },
  })
  assert.deepEqual(silent, { delivery: 'suppressed' })
  assert.equal(sent.length, 1)

  const reply = await callBellTeamTool({
    ...context, name: 'respond_to_room',
    arguments: { action: 'reply', message: '進めます' },
  })
  assert.deepEqual(sent[1], { from: 'bot-a', room: 'room-1', responseTo: 'room-message-1', message: '進めます', image: null })
  assert.deepEqual(reply, { id: 'm-1', delivery: 'posted' })

  const simultaneous = { ...context, listQueued: async () => ({ items: [
    { status: 'running', context: 'room', contextId: 'room-1', groupId: 'room-message-1', from: 'bot-b' },
    { status: 'running', context: 'room', contextId: 'room-1', groupId: 'room-message-2', from: 'bot-b' },
  ] }) }
  await assert.rejects(callBellTeamTool({ ...simultaneous, name: 'respond_to_room',
    arguments: { action: 'reply', message: '二件目に返答' },
  }), /ROOM_RESPONSE_CONTEXT_AMBIGUOUS/u)
  await callBellTeamTool({ ...simultaneous, name: 'respond_to_room',
    arguments: { action: 'reply', messageId: 'room-message-2', message: '二件目に返答' },
  })
  assert.deepEqual(sent[2], { from: 'bot-a', room: 'room-1', responseTo: 'room-message-2', message: '二件目に返答', image: null })

  const completed = { ...context, listQueued: async () => ({ items: [] }) }
  await callBellTeamTool({ ...completed, name: 'respond_to_room',
    arguments: { action: 'reply', messageId: 'room-message-3', message: 'あとから返信' },
  })
  assert.deepEqual(sent[3], { from: 'bot-a', room: 'room-1', responseTo: 'room-message-3', message: 'あとから返信', image: null })
  await assert.rejects(callBellTeamTool({ ...completed, name: 'respond_to_room',
    arguments: { action: 'reply', messageId: '別の発言', message: '返信' },
  }), /ROOM_RESPONSE_CONTEXT_MISSING/u)

  await assert.rejects(
    callBellTeamTool({
      ...context, name: 'respond_to_room',
      arguments: { action: 'silent', message: '黙ります' },
    }),
    /ROOM_SILENT_ARGUMENT_INVALID/u,
  )

  await assert.rejects(
    callBellTeamTool({ ...context, from: 'bot-b', name: 'update_room', arguments: { roomId: 'room-1', purpose: '変更' } }),
    /ROOM_REPRESENTATIVE_REQUIRED/u,
  )
  await assert.rejects(
    callBellTeamTool({ ...context, from: 'bot-b', name: 'delete_room', arguments: { roomId: 'room-1' } }),
    /ROOM_REPRESENTATIVE_REQUIRED/u,
  )
  assert.deepEqual(await callBellTeamTool({ ...context, name: 'delete_room', arguments: { roomId: 'room-1' } }), { removed: 'room-1' })
  assert.equal(rooms.has('room-1'), false)
  for (const name of ['list_rooms', 'create_room', 'update_room', 'delete_room', 'sendroommessage', 'respond_to_room', 'set_room_schedule'])
    assert.ok(bellTeamTools.some(tool => tool.name === name), `${name}がない`)
})

test('MCPから既存Botと自分をルームへ招待・退出できる', async () => {
  const registry = new Map([
    ['bot-a', { id: 'bot-a' }],
    ['bot-b', { id: 'bot-b' }],
  ])
  registry.refresh = async () => registry
  const rooms = new Map([['room-1', {
    id: 'room-1', name: '開発室', purpose: '', representativeId: 'bot-a', memberIds: ['bot-a'],
  }]])
  rooms.refresh = async () => rooms
  rooms.update = async (id, changes) => {
    const room = { ...rooms.get(id), ...changes }
    rooms.set(id, room)
    return room
  }
  const context = { from: 'bot-b', registry, messenger: {}, store: {}, rooms, roomMessenger: {} }

  const joined = await callBellTeamTool({ ...context, name: 'invite_to_room', arguments: { roomId: 'room-1' } })
  assert.deepEqual(joined.room.memberIds, ['bot-a', 'bot-b'])
  const removed = await callBellTeamTool({ ...context, from: 'bot-a', name: 'leave_room', arguments: { roomId: 'room-1', botId: 'bot-b' } })
  assert.deepEqual(removed.room.memberIds, ['bot-a'])
  const left = await callBellTeamTool({ ...context, from: 'bot-a', name: 'leave_room', arguments: { roomId: 'room-1' } })
  assert.deepEqual(left.room.memberIds, [])
  assert.equal(left.room.representativeId, null)
  for (const name of ['invite_to_room', 'leave_room'])
    assert.ok(bellTeamTools.some(tool => tool.name === name), `${name}がない`)
})

test('ask_ownerは呼び出したBotのIDを付けて選択肢のカードを頼む', async () => {
  const asked = []
  const result = await callBellTeamTool({
    name: 'ask_owner', from: 'bot-d',
    registry: Object.assign(new Map([['bot-d', { id: 'bot-d' }]]), { refresh: async () => {} }),
    arguments: { question: 'CodexにRTKを入れていい？', options: ['入れて', '待って'] },
    askOwner: async value => { asked.push(value); return { question: { id: 'q-1', status: 'open' } } },
  })
  assert.deepEqual(asked, [{ question: 'CodexにRTKを入れていい？', options: ['入れて', '待って'], botId: 'bot-d' }])
  assert.deepEqual(result, { question: { id: 'q-1', status: 'open' } })
  const tool = bellTeamTools.find(item => item.name === 'ask_owner')
  assert.deepEqual(tool.inputSchema.required, ['question', 'options'])
})
