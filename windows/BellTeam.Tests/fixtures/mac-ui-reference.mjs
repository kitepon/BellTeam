import { createServer } from 'node:http'
import { readFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { spawn } from 'node:child_process'
const source = readFileSync('ios/BellBot/BellBot/Core/PreviewFixtures.swift', 'utf8')
const matched = source.match(/let source = """([\s\S]*?)"""/); if (!matched) throw new Error("MAC_PREVIEW_FIXTURE_MISSING"); const fixture = JSON.parse(matched[1])
const messages = [
  { id: 'p1', kind: 'message', direction: 'incoming', at: '2026-10-13T09:00:00Z', message: 'おはようございます。今日の準備ができました。', delivery: 'delivered' },
  { id: 'p2', kind: 'message', direction: 'outgoing', at: '2026-10-13T09:01:00Z', message: '予定と資料を確認しよう。', delivery: 'delivered' },
  { id: 'p3', kind: 'message', direction: 'incoming', at: '2026-10-13T09:02:00Z', message: '午前の打ち合わせは10時です。午後にアプリの表示を確認します。', delivery: 'delivered' }
]
const models = { claude: { defaultModel: 'opus', models: [{ id: 'opus', efforts: ['high'], fast: true }], efforts: ['high'], fastUnavailable: null }, codex: { defaultModel: 'gpt-6.1-sol', models: [{ id: 'gpt-6.1-sol', efforts: ['high'], fast: true }], efforts: ['high'], fastUnavailable: null }, grok: { defaultModel: 'grok-4.7', models: [{ id: 'grok-4.7', efforts: [], fast: true }], efforts: [], fastUnavailable: null } }
// Conversation scenes (PR 4). Everything is served by GET; a POST would count as a write and fail the run.
const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString()
const yesterday = ago(24 * 60 + 5), longAgo = '2026-09-26T03:00:00Z'
const user = { id: 'user', name: 'あなた', displayName: 'あなた' }
const bots = { 'bot-one': { id: 'bot-one', name: 'ユキ', displayName: 'ユキ' }, 'bot-two': { id: 'bot-two', name: 'ハル', displayName: 'ハル' }, 'bot-three': { id: 'bot-three', name: 'ナギ', displayName: 'ナギ' } }
const incoming = (id, at, message, extra = {}) => ({ id, kind: 'message', direction: 'incoming', at, message, ...extra })
const outgoing = (id, at, message, extra = {}) => ({ id, kind: 'message', direction: 'outgoing', sender: user, at, message, ...extra })
const memberScene = [
  incoming('c1', longAgo, 'おはようございます。今朝の準備を整えました。'),
  outgoing('c2', longAgo, 'ありがとう。今日の予定を教えて。', { delivery: 'delivered' }),
  incoming('c3', longAgo, '午前は打ち合わせ、午後はBellTeamの確認です。[資料](https://example.com/doc) と https://example.com を見てください。'),
  outgoing('c4', yesterday, 'この内容を全員へ共有して。', { delivery: 'failed' }),
  incoming('c5', ago(20), '**画像・カードの表示確認です。**\n\n- 箇条書きの一行目\n- 二行目 `code`\n\n> 引用の一行'),
  outgoing('c6', ago(3), '了解。続けてください。', { delivery: 'delivered' })
]
const statesScene = [
  incoming('s0', yesterday, '送信の状態を順に確認します。'),
  outgoing('s1', ago(70), '受付確認中の例', { delivery: 'submitting' }),
  outgoing('s2', ago(60), '受付済み・反映待ちの例', { delivery: 'accepted' }),
  outgoing('s3', ago(50), '送信待ちの例', { delivery: 'queued' }),
  outgoing('s4', ago(40), '処理中の例', { delivery: 'running' }),
  outgoing('s5', ago(30), '中断の例', { delivery: 'stopped' }),
  outgoing('s6', ago(20), '配達済みの例', { delivery: 'delivered' }),
  outgoing('s7', ago(15), '配達失敗の例', { delivery: 'failed' }),
  outgoing('s8', ago(10), '受付済み・完了未確認の例', { delivery: 'failed', deliveryTracking: { schema: 'bellteam.delivery-tracking.v1', admission: 'accepted', completion: 'unknown' } }),
  { id: 'q1', kind: 'message', direction: 'incoming', sender: bots['bot-three'], at: ago(6), owner_question: { id: 'oq1', botId: 'bot-three', question: '資料の公開範囲を決めてほしいです。', options: ['チームだけ', '全員に公開'], allowOther: true, status: 'open' } },
  { id: 'q2', kind: 'message', direction: 'incoming', sender: bots['bot-three'], at: ago(5), owner_question: { id: 'oq2', botId: 'bot-three', question: '次の作業はどちらを先にしますか。', options: ['画面', 'サーバー'], allowOther: false, status: 'answered', answer: '画面' } },
  { id: 'q3', kind: 'message', direction: 'incoming', sender: bots['bot-one'], at: ago(2), secret_request: { id: 'sr1', botId: 'bot-one', toolId: 'fixture', label: '試験用キー', message: '試験用の秘密入力です。', status: 'pending' } }
]
const routing = (status, responders = []) => ({ status, responders })
const roomScene = [
  incoming('r1', yesterday, '計画室の今日の進め方をまとめました。午前に設計、午後に実装の順です。', { sender: bots['bot-one'], routing: routing('ready') }),
  outgoing('r2', ago(50), '設計から始めよう。二人とも確認して。', { routing: routing('ready', ['bot-one', 'bot-three']), deliveries: [{ target: 'bot-one', delivery: 'delivered' }, { target: 'bot-three', delivery: 'delivered' }] }),
  incoming('r3', ago(40), '設計の草案を出します。**要点**は三つです。\n\n1. 画面\n2. 通信\n3. 試験', { sender: bots['bot-one'], routing: routing('ready') }),
  incoming('r4', ago(35), '私は試験の観点を足します。', { sender: bots['bot-three'], routing: routing('ready') }),
  outgoing('r5', ago(12), '次は実装の分担を決めたい。', { routing: routing('pending'), deliveries: [{ target: 'bot-one', delivery: 'running' }, { target: 'bot-three', delivery: 'queued' }] }),
  outgoing('r6', ago(4), '判定の失敗の例', { routing: routing('failed'), deliveries: [] })
]
const stackScene = [
  incoming('i1', longAgo, '写真を三枚まとめて送ります。', { image: true, image_count: 3, image_urls: ['/api/message-images/demo/one.png', '/api/message-images/demo/two.png', '/api/message-images/demo/three.png'] }),
  outgoing('i2', yesterday, '二枚を返します。', { delivery: 'delivered', image: true, image_count: 2, image_urls: ['/api/message-images/demo/one.png', '/api/message-images/demo/two.png'] }),
  incoming('i3', ago(30), '一枚の画像です。', { image: true, image_count: 1, image_urls: ['/api/message-images/demo/one.png'] }),
  incoming('i4', ago(10), '', { image: true, image_count: 3 }),
  outgoing('i5', ago(2), '', { delivery: 'delivered', image: true, image_count: 1 })
]
const peerScene = [
  incoming('p1', longAgo, '今日のメンバー間の連絡をまとめます。'),
  { id: 'peer1', kind: 'peer', direction: 'incoming', peerName: 'ハル', sender: bots['bot-two'], at: ago(90), message: 'ユキさんへ。資料の草稿を共有しました。**明日の確認**でお願いします。\n\n- 概要\n- 日程\n- 担当', image: true, image_urls: ['/api/message-images/demo/one.png'] },
  incoming('p2', ago(30), '連絡を受け取りました。確認します。'),
  outgoing('p3', ago(5), 'よろしく。', { delivery: 'delivered' })
]
let conversationScene = 'default'
const sceneMessages = { member: { 'bot-one': memberScene }, states: { 'bot-one': statesScene }, room: { planning: roomScene }, stack: { 'bot-two': stackScene }, 'peer-sheet': { 'bot-one': peerScene }, draft: { 'bot-two': memberScene.slice(0, 3) }, stop: { planning: roomScene.slice(0, 3) }, 'stop-notice': { planning: roomScene.slice(0, 3) }, 'stop-member': { 'bot-one': memberScene.slice(0, 3) }, empty: {} }
const sceneQueues = { stop: [{ id: 'q-run', botId: 'bot-one', botName: 'ユキ', status: 'running', context: 'room', contextId: 'planning' }, { id: 'q-wait', botId: 'bot-three', botName: 'ナギ', status: 'queued', context: 'room', contextId: 'planning' }], 'stop-notice': [{ id: 'q-run', botId: 'bot-one', botName: 'ユキ', status: 'running', context: 'room', contextId: 'planning' }], 'stop-member': [{ id: 'q-run', botId: 'bot-one', botName: 'ユキ', status: 'running', context: 'direct', contextId: 'bot-one' }] }
const schedules = {
  'bot-one': [{ id: 'morning', name: '朝の確認', prompt: '今日の予定と優先事項を整理する', kind: 'cron', expression: '0 9 * * *', timezone: 'Asia/Tokyo', nextRunAt: '2026-10-14T00:00:00Z', enabled: true }],
  planning: [{ id: 'weekly', name: '週のふり返り', prompt: '進んだ仕事をまとめる', kind: 'cron', expression: '0 19 * * 5', timezone: 'Asia/Tokyo', nextRunAt: '2026-10-16T10:00:00Z', enabled: true }]
}
const feature = (id, title) => ({ id, title, enabled: true, status: 'enabled', fields: [] })
const routes = { '/api/session': { authenticated: true, authMode: 'local' }, '/api/bots': { bots: fixture.bots }, '/api/rooms': { rooms: fixture.rooms }, '/api/models': { models }, '/api/owner': { owner: fixture.owner }, '/api/user-rules': { text: 'チーム全員へ共有する指示。' }, '/api/settings': { settings: [feature('routing','AIによるルーム応答の振り分け'),feature('callBridge','メンバー間の連携'),feature('notifications','通知')], backgroundAgent: { revision: '6f1c1f0e-5d1b-4f43-9a54-0d3a4c2e8b11', selection: { harness: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high' } } }, '/api/queue': { items: Array.from({ length: 12 }, (_, index) => ({ id: `job-${index}`, botId: 'bot-one', botName: 'ユキ', status: 'running', context: 'direct', contextId: 'bot-one' })) } }
routes['/api/updates'] = JSON.parse(readFileSync('windows/BellTeam.Tests/fixtures/update-center.json', 'utf8'))
const updateFixture = name => JSON.parse(readFileSync(`windows/BellTeam.Tests/fixtures/${name}.json`, 'utf8'))
// Inspector scene (PR 5): bot-one has an independent large image, bot-three shows its small image in the large slot, bot-two has no image.
const portrait = readFileSync('ios/BellBot/BellBot/Assets.xcassets/BellPortrait.imageset/bell-portrait.png'), icon = readFileSync('ios/BellBot/BellBot/Assets.xcassets/AppIcon.appiconset/bellbot-icon.png')
const dataUrl = bytes => `data:image/png;base64,${bytes.toString('base64')}`
const inspectorExtras = { 'bot-one': { position: '相談役', profileText: '落ち着いた相談役。BellTeamの毎日の仕事を一緒に整える。\n朝は予定を、夜はふり返りを手伝う。', personality: '丁寧で慎重。迷った時は理由を添えて選ぶ。', speechStyle: 'やわらかい敬体。', role: '予定の整理と資料の下書き', model: 'opus', reasoningEffort: 'high', avatarVersion: 'v1', avatarLargeVersion: 'L1' }, 'bot-two': { position: '', model: '', reasoningEffort: '' }, 'bot-three': { position: '調査担当', role: '資料集め', avatarVersion: 'v3', avatarLargeVersion: 'v3' } }
const inspectorBots = () => fixture.bots.map(bot => { const merged = { ...bot, ...(inspectorExtras[bot.id] ?? {}) }; return { ...merged, displayName: merged.position ? `${merged.name} ${merged.position}` : merged.name } })
const inspectorImages = { '/api/bots/bot-one/avatar': icon, '/api/bots/bot-one/avatar-large': portrait, '/api/bots/bot-three/avatar': portrait }
// Bot screen scene (PR 6): the screen, the approval answer and the failure each scene needs; every one is a GET.
const terminalText = ['bell@bellteam:/srv/bellteam$ codex', '', '> 画面の確認を続けます。', '', '  Called belltea.remember', '  └ {"id":"memory-1","kind":"episode"}', '', '• 変更を3つのファイルへ入れました。試験は38件成功です。', '', '  Worked for 2m 24s', '', '> Ask Codex to do anything', '', '  GPT-6.1-Sol high · /srv/bellteam/bots/bot-one', '  ? for shortcuts'].join('\n')
const approvalNone = { status: 'none' }
const approvalRequired = { status: 'approval_required', promptDigest: 'sha256:' + 'a'.repeat(64), choices: [{ decision: 'approve_once', label: '今回だけ許可' }, { decision: 'deny', label: '拒否' }] }
const screenScenes = {
  keys: { screen: { online: true, screen: terminalText }, approval: approvalNone }, sent: { screen: { online: true, screen: terminalText }, approval: approvalNone },
  approval: { screen: { online: true, screen: terminalText.split('\n').slice(0, 9).join('\n') + '\n\nAllow this command? 1. Yes  2. No' }, approval: approvalRequired },
  digits: { screen: { online: true, screen: terminalText.split('\n').slice(0, 9).join('\n') + '\n\nAllow this command? 1. Yes  2. No' }, approval: approvalNone },
  empty: { screen: { online: true, screen: '' }, approval: approvalNone }, offline: { screen: { online: false, screen: '' }, approval: { httpStatus: 409, error: 'SCREEN_SEAT_ABSENT' } },
  failed: { screen: { httpStatus: 500, error: 'TEMPORARY_FAILURE' }, approval: approvalNone }
}
// Goal scenes (PR 7): bot-one is Claude, bot-two Codex, bot-three Grok. Every route is a GET; the goal POST is never served.
const goalFields = (objective, tokenBudget, combined) => ({ objective, tokenBudget, combined })
const goalNone = goalFields(false, false, false)
const goalSnapshot = (botId, { availability = 'available', capabilities = {}, create = goalNone, edit = goalNone, goal, nativeHistory, message = null } = {}) => ({
  botId, availability, capabilities: { inspect: true, create: false, edit: false, pause: false, resume: false, clear: false, ...capabilities },
  fieldCapabilities: { create, edit }, binding: availability === 'available' ? { sessionId: `seat-${botId}`, launchId: 'a'.repeat(32), threadId: `thread-${botId}` } : null,
  ...(goal === undefined ? {} : { goal }), ...(nativeHistory ? { nativeHistory } : {}), observedAt: '2026-11-08T03:00:00Z', message })
const codexGoal = (botId, status, objective, tokenBudget, tokensUsed, timeUsedSeconds) => ({ kind: 'codex-cli', native: { threadId: `thread-${botId}`, objective, status, tokenBudget, tokensUsed, timeUsedSeconds, createdAt: 1, updatedAt: 2 } })
const claudeNative = (condition, met, extra = {}) => ({ type: 'goal_status', condition, met, ...extra })
const goalScenes = {
  empty: () => [
    goalSnapshot('bot-one', { capabilities: { create: true }, create: goalFields(true, false, false), goal: null }),
    goalSnapshot('bot-two', { capabilities: { create: true }, create: goalFields(true, true, true), goal: null }),
    goalSnapshot('bot-three', { availability: 'unsupported', message: 'このメンバーではゴール機能をまだ利用できません。' })
  ],
  cards: () => [
    goalSnapshot('bot-one', { capabilities: { edit: true, pause: true, clear: true }, edit: goalFields(true, false, false),
      goal: { kind: 'claude-code', phase: 'active', native: claudeNative('設計図と画面の仕様を揃え、試験を通す', false, { tokens: 48210, durationMs: 183000, iterations: 6 }), reported_turns: 6 },
      nativeHistory: { kind: 'claude-code', terminal: 'achieved', native: claudeNative('前回の移行作業を終える', true) } }),
    goalSnapshot('bot-two', { capabilities: { edit: true, clear: true }, edit: goalFields(true, true, true), goal: codexGoal('bot-two', 'budgetLimited', '配布の手順書を最新にする', 200000, 200412, 5231.5) }),
    goalSnapshot('bot-three', { capabilities: { resume: true, clear: true }, goal: { kind: 'grok-cli', native: { objective: '画面の文言を見直す' }, current_status: { source: '/goal status', status: 'UserPaused', phase: 'Idle', tokens_used: 12034, elapsed_display: '4m12s' } } })
  ],
  'cards-codex': () => [
    goalSnapshot('bot-one', { capabilities: { edit: true, pause: true, clear: true }, edit: goalFields(true, true, false), goal: codexGoal('bot-one', 'active', '通知の表示を直して配布する', 500000, 120345, 842) }),
    goalSnapshot('bot-two', { capabilities: { edit: true, resume: true, clear: true }, edit: goalFields(true, true, true), goal: codexGoal('bot-two', 'paused', '予定画面の調整を進める', null, 9800, 61) }),
    goalSnapshot('bot-three', { capabilities: { clear: true }, goal: codexGoal('bot-three', 'usageLimited', '長い調査を続ける', 1000000, 430000, 7200) })
  ]
}
for (const scene of Object.keys(goalScenes)) sceneMessages[`goals-${scene}`] = { 'bot-one': memberScene, 'bot-two': memberScene, 'bot-three': memberScene }
let writes = 0
let gallery = false
const galleryAssets = { '/api/message-images/demo/one.png': 'ios/BellBot/BellBot/Assets.xcassets/AppIcon.appiconset/bellbot-icon.png', '/api/message-images/demo/two.png': 'docs/assets/mac-ui-reference-48/01-workspace.png', '/api/message-images/demo/three.png': 'docs/assets/conversation-images/iphone-stack.png' }
routes['/api/harness-auth'] = { harnesses: [{ id: 'codex', name: 'Codex', members: 2, startWarning: 'Codexは、認証し直しを始めた時点で今の認証が消えます。' }, { id: 'claude', name: 'Claude', members: 1, startWarning: null }] }
routes['/api/harness-auth/codex'] = { harness: 'codex', auth: { status: 'waiting', url: 'https://example.com/login', user_code: 'TEST-CODE', input_required: false, message: '公式サイトで認証してください。' } }
routes['/api/harness-auth/claude'] = { harness: 'claude', auth: { status: 'authenticated', input_required: false } }
routes['/api/ai-control'] = { control: { paused: false, state: 'enabled', updatedAt: null, unconfirmedBotIds: [], commandsConfirmed: null, error: null } }
routes['/api/setup'] = { phase: 'select_harness', harness: null, harnesses: [{ id: 'codex', name: 'Codex' }, { id: 'claude', name: 'Claude' }, { id: 'grok', name: 'Grok' }, { id: 'cursor', name: 'Cursor' }], guideBotId: null, complete: false, auth: null }
const server = createServer((request, response) => {
  if (request.method !== 'GET') { writes++; response.writeHead(405); response.end(); return }
  const path = new URL(request.url, 'http://localhost').pathname
  if (galleryAssets[path]) { response.writeHead(200, { 'content-type': 'image/png' }); response.end(readFileSync(galleryAssets[path])); return }
  if (conversationScene.startsWith('inspector') && inspectorImages[path]) { response.writeHead(200, { 'content-type': 'image/png' }); response.end(inspectorImages[path]); return }
  const goalRoute = path.match(/^\/api\/(?:goals|bots\/([^/]+)\/goal)$/)
  if (goalRoute && conversationScene.startsWith('goals-')) {
    const snapshots = goalScenes[conversationScene.slice(6)]?.() ?? []
    const answer = goalRoute[1] ? { snapshot: snapshots.find(item => item.botId === goalRoute[1]) } : { goals: snapshots }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(answer)); return
  }
  const screenRoute = path.match(/^\/api\/bots\/[^/]+\/screen(\/approval)?$/)
  if (screenRoute && conversationScene.startsWith('screen-')) {
    const answer = screenScenes[conversationScene.slice(7)]?.[screenRoute[1] ? 'approval' : 'screen'] ?? { httpStatus: 404, error: 'NOT_FOUND' }
    response.writeHead(answer.httpStatus ?? 200, { 'content-type': 'application/json' }); response.end(JSON.stringify(answer)); return
  }
  let value = path === '/api/queue' && conversationScene !== 'default' ? { items: sceneQueues[conversationScene] ?? [] } : routes[path]
  const chat = path.match(/^\/api\/(bots|rooms)\/([^/]+)(?:\/(messages|schedules))?$/)
  if (chat) { const [, kind, id, action] = chat; if (conversationScene === 'failed' && action === 'messages') { response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'TEMPORARY_FAILURE' })); return }; value = action === 'messages' ? conversationScene !== 'default' ? { items: sceneMessages[conversationScene]?.[id] ?? [], has_more: false } : { items: gallery ? [...messages, { id: 'gallery', at: '2026-10-13T09:03:00Z', direction: 'incoming', kind: 'message', image: true, image_urls: Object.keys(galleryAssets) }] : messages, has_more: false } : action === 'schedules' ? { schedules: schedules[id] ?? [] } : kind === 'bots' ? { bot: fixture.bots.find(bot => bot.id === id) } : { room: fixture.rooms.find(room => room.id === id) } }
  if (conversationScene.startsWith('inspector')) {
    const botId = path.match(/^\/api\/bots\/([^/]+)$/)?.[1]
    if (path === '/api/bots') value = { bots: inspectorBots() }
    else if (botId) { const bot = inspectorBots().find(item => item.id === botId); value = { bot: botId === 'bot-one' ? { ...bot, avatar: dataUrl(icon), avatarLarge: dataUrl(portrait), avatarSource: dataUrl(portrait), avatarLargeSource: dataUrl(portrait), avatarCrop: { x: 0, y: 0, width: 1, height: 1 }, avatarLargeCrop: { x: 0, y: 0, width: 1, height: 1 } } : bot } }
  }
  response.writeHead(value ? 200 : 404, { 'content-type': 'application/json' }); response.end(JSON.stringify(value ?? { error: 'NOT_FOUND' }))
})
server.listen(0, '127.0.0.1', async () => {
  const origin = `http://127.0.0.1:${server.address().port}`
  if (!process.argv[2]) { process.stdout.write(`mock_url=${origin}\n`); return }
  try {
    const executable = resolve(process.argv[2]); const destination = resolve(process.argv[3] ?? 'windows/artifacts/mac-reference')
    mkdirSync(destination, { recursive: true })
    const frames = [
      ['01-workspace.png', ['--render-url', origin, 'bot-one']],
      ['02-member-editor.png', ['--render-editor', 'member', origin, 'bot-one']],
      ['03-schedules.png', ['--render-page', 'schedules', origin]],
      ['04-settings.png', ['--render-page', 'settings', origin]],
      ['05-setup.png', ['--render-editor', 'setup', origin, '-']],
      ['06-authentication.png', ['--render-editor', 'authentication', origin, 'codex']],
      ['07-settings-cloudflare.png', ['--render-page', 'settings-connection', origin]],
      ['08-settings-lower.png', ['--render-page', 'settings-lower', origin]],
      ['09-gallery.png', ['--render-gallery', origin, 'bot-one']]
    ]
    const settingsPages = ['profile', 'ai', 'features', 'notifications', 'connection', 'display', 'billing', 'update', 'about', 'stop']
    if (process.argv[4] && !['gallery', 'updates', 'settings', 'summary', 'conversation', 'inspector', 'screen', 'goals'].includes(process.argv[4])) throw new Error('WINDOWS_RENDER_SCENE_UNKNOWN')
    // Same three summaries as ios/BellBot/BellBotTests/SummaryLayoutTests.swift.
    if (process.argv[4] === 'summary') ['認証まわりの再試行処理を見直し、通知の表示崩れと画像の読み込み失敗も合わせて直す', 'ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴ', 'abcdefghij'.repeat(8)].forEach((summary, index) => { if (fixture.bots[index]) fixture.bots[index].currentWork = { state: 'working', summary, summaryStatus: 'current' } })
    // [file, scene, conversation id]: each renders the conversation in one named state.
    const conversationFrames = [['conversation-member.png', 'member', 'bot-one'], ['conversation-room.png', 'room', 'planning'], ['conversation-states.png', 'states', 'bot-one'], ['conversation-stop-room.png', 'stop', 'planning'], ['conversation-stop-notice.png', 'stop-notice', 'planning'], ['conversation-stop-member.png', 'stop-member', 'bot-one'], ['conversation-draft.png', 'draft', 'bot-two'], ['conversation-peer-sheet.png', 'peer-sheet', 'bot-one'], ['conversation-stack.png', 'stack', 'bot-two'], ['conversation-empty.png', 'empty', 'bot-three'], ['conversation-failed.png', 'failed', 'bot-three']]
    // [file, scene, conversation id]: the inspector in each state; every scene name starts with "inspector" for the mock.
    const inspectorFrames = [['inspector-member-large.png', 'member', 'bot-one'], ['inspector-member-small-only.png', 'member', 'bot-three'], ['inspector-member-no-image.png', 'member', 'bot-two'], ['inspector-room.png', 'room', 'planning'], ['inspector-sheet-small.png', 'sheet-small', 'bot-one'], ['inspector-sheet-large.png', 'sheet-large', 'bot-one'], ['inspector-sheet-unsupported.png', 'sheet-unsupported', 'bot-three'], ['inspector-pending.png', 'pending', 'bot-one'], ['inspector-pending-sheet.png', 'pending-sheet', 'bot-one']]
    // [file, scene]: the Bot screen of bot-one; every scene name starts with "screen-" for the mock.
    const screenFrames = [['screen-keys.png', 'keys'], ['screen-approval.png', 'approval'], ['screen-digits-error.png', 'digits'], ['screen-sent.png', 'sent'], ['screen-empty.png', 'empty'], ['screen-offline.png', 'offline'], ['screen-read-failed.png', 'failed']]
    // [file, render kind, scene, conversation id or null]: goals; every scene name starts with "goals-" for the mock.
    const goalFrames = [['goals-empty.png', 'page', 'empty'], ['goals-cards.png', 'page', 'cards'], ['goals-cards-codex.png', 'page', 'cards-codex'],
      ['goals-pill.png', 'pill', 'empty', 'bot-one'], ['goals-pill-open-unset.png', 'pill-open', 'empty', 'bot-one'], ['goals-pill-open-active.png', 'pill-open', 'cards', 'bot-one'],
      ['goals-editor-create-error.png', 'editor-create', 'empty', 'bot-two'], ['goals-editor-edit-separate.png', 'editor-edit', 'cards-codex', 'bot-one']]
    const selectedFrames = process.argv[4] === 'goals' ? goalFrames.map(([name, kind, scene, id]) => [name, kind === 'page' ? ['--render-page', 'goals', origin] : ['--render-goals', kind, origin, id], `goals-${scene}`]) : process.argv[4] === 'screen' ? screenFrames.map(([name, scene]) => [name, ['--render-screen', scene, origin, 'bot-one'], `screen-${scene}`]) : process.argv[4] === 'inspector' ? inspectorFrames.map(([name, scene, id]) => [name, ['--render-inspector', scene, origin, id], `inspector-${scene}`]) : process.argv[4] === 'conversation' ?conversationFrames.map(([name, scene, id]) => [name, ['--render-conversation', scene, origin, id], scene]) : process.argv[4] === 'summary' ? [['summary.png', ['--render-url', origin, 'bot-one']]] : process.argv[4] === 'settings' ? settingsPages.map(page => [`settings-${page}.png`, ['--render-page', `settings-${page}`, origin]]) : process.argv[4] === 'gallery' ? frames.filter(([name]) => name === '09-gallery.png') : process.argv[4] === 'updates' ? [['update.png', ['--render-page', 'updates', origin]], ['update-current.png', ['--render-page', 'updates-current', origin]], ['update-narrow.png', ['--render-page', 'updates-narrow', origin]], ['update-detail-narrow.png', ['--render-page', 'updates-detail-narrow', origin]], ['update-sheet.png', ['--render-page', 'update-sheet', origin]]] : frames
    for (const [name, args, scene] of selectedFrames) {
      conversationScene = scene ?? 'default'
      if (name === '07-settings-cloudflare.png') routes['/api/session'].authMode = 'cloudflare'
      if (name === '09-gallery.png') gallery = true
      if (name.startsWith('update')) routes['/api/updates'] = updateFixture(name === 'update-current.png' ? 'update-center-current' : 'update-center-mixed')
      if (name === 'update-detail-narrow.png') routes['/api/updates'].components[0].current.version = 'a'.repeat(180)
      const output = join(destination, name)
      await new Promise((success, failure) => {
        const child = spawn(executable, [...args, output], { windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] })
        child.once('error', failure); child.once('exit', code => code === 0 ? success() : failure(new Error(`WINDOWS_RENDER_FAILED: ${name} (${code})`)))
      })
      if (!existsSync(output) || !readFileSync(output).subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error(`WINDOWS_RENDER_PNG_MISSING: ${name}`)
      process.stdout.write(`描画成功: ${name}\n`)
    }
    if (writes !== 0) throw new Error('WINDOWS_RENDER_SENT_WRITE_REQUEST')
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
  finally { server.close(() => process.exit(process.exitCode ?? 0)) }
})
function close() { server.close(() => { process.stdout.write(`closed writes=${writes}\n`); process.exit(0) }) }
process.stdin.on('data', data => { if (data.toString().includes('stop')) close() }); process.stdin.resume(); setTimeout(close, 180000).unref()
