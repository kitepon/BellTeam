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
const sceneMessages = { secret: { 'bot-one': [memberScene[5], statesScene[9], statesScene[11]] }, echo: { 'bot-one': memberScene.slice(3) }, member: { 'bot-one': memberScene }, states: { 'bot-one': statesScene }, room: { planning: roomScene }, stack: { 'bot-two': stackScene }, 'peer-sheet': { 'bot-one': peerScene }, draft: { 'bot-two': memberScene.slice(0, 3) }, stop: { planning: roomScene.slice(0, 3) }, 'stop-notice': { planning: roomScene.slice(0, 3) }, 'stop-member': { 'bot-one': memberScene.slice(0, 3) }, empty: {} }
// An owner question with a long choice (Mac PR 1116): choices stack full width and the long one wraps in full.
sceneMessages.scrolled = { 'bot-one': Array.from({ length: 4 }, (_, round) => memberScene.map(item => ({ ...item, id: `${item.id}-${round}` }))).flat() }
sceneMessages['long-choices'] = { 'bot-three': [{ id: 'ql', kind: 'message', direction: 'incoming', sender: bots['bot-three'], at: ago(6), owner_question: { id: 'oql', botId: 'bot-three', question: '資料の公開範囲を決めてほしいです。', options: ['チームだけ', '全員に公開', '社外の協力者にも、確認が終わった章から順に読めるようにして、未確認の章は伏せておく'], allowOther: true, status: 'open' } }] }
const sceneQueues = { stop: [{ id: 'q-run', botId: 'bot-one', botName: 'ユキ', status: 'running', context: 'room', contextId: 'planning' }, { id: 'q-wait', botId: 'bot-three', botName: 'ナギ', status: 'queued', context: 'room', contextId: 'planning' }], 'stop-notice': [{ id: 'q-run', botId: 'bot-one', botName: 'ユキ', status: 'running', context: 'room', contextId: 'planning' }], 'stop-member': [{ id: 'q-run', botId: 'bot-one', botName: 'ユキ', status: 'running', context: 'direct', contextId: 'bot-one' }] }
const schedules = {
  'bot-one': [{ id: 'morning', name: '朝の確認', prompt: '今日の予定と優先事項を整理する', kind: 'cron', expression: '0 9 * * *', timezone: 'Asia/Tokyo', nextRunAt: '2026-10-14T00:00:00Z', enabled: true }],
  planning: [{ id: 'weekly', name: '週のふり返り', prompt: '進んだ仕事をまとめる', kind: 'cron', expression: '0 19 * * 5', timezone: 'Asia/Tokyo', nextRunAt: '2026-10-16T10:00:00Z', enabled: true }]
}
// Schedule scenes (PR 9): one-time and recurring cards for the list, plus the empty and failed reads. Served by GET only.
const scheduleList = {
  'bot-one': [
    { id: 'once-1', name: '資料の提出', prompt: '明日の会議資料を共有フォルダへ置く', kind: 'once', at: '2026-11-12T01:00:00Z', nextRunAt: '2026-11-12T01:00:00Z', enabled: true },
    { id: 'morning', name: '朝の確認', command: 'python3 monitoring/host_health.py', kind: 'cron', expression: '0 9 * * *', timezone: 'Asia/Tokyo', nextRunAt: '2026-11-09T00:00:00Z', enabled: true }
  ],
  'bot-two': [{ id: 'draft', name: '', prompt: '週の終わりに、進んだ仕事と残った仕事を分けてまとめる。長い説明は三行までにして、決めてほしいことは先頭に書く。続きがあれば、その内容も最後に添える。', kind: 'once', enabled: true }],
  'bot-three': [{ id: 'patrol', name: '巡回の確認', prompt: '新しい通知がないか確かめる', kind: 'interval_hours', intervalHours: 3, startHour: 9, endHour: 18, minute: 0, timezone: 'Asia/Tokyo', nextRunAt: '2026-11-08T12:00:00Z', enabled: true }],
  planning: [{ id: 'weekly', name: '週のふり返り', prompt: '進んだ仕事をまとめる', kind: 'cron', expression: '0 19 * * 5', timezone: 'Asia/Tokyo', nextRunAt: '2026-11-13T10:00:00Z', enabled: true, targets: ['bot-one'] }]
}
const feature = (id, title) => ({ id, title, enabled: true, status: 'enabled', fields: [] })
const routes = { '/api/session': { authenticated: true, authMode: 'local' }, '/api/bots': { bots: fixture.bots }, '/api/rooms': { rooms: fixture.rooms }, '/api/models': { models }, '/api/owner': { owner: fixture.owner }, '/api/user-rules': { text: 'チーム全員へ共有する指示。' }, '/api/settings': { settings: [feature('routing','AIによるルーム応答の振り分け'),feature('callBridge','メンバー間の連携'),feature('notifications','通知')], backgroundAgent: { revision: '6f1c1f0e-5d1b-4f43-9a54-0d3a4c2e8b11', selection: { harness: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high' } } }, '/api/queue': { items: Array.from({ length: 12 }, (_, index) => ({ id: `job-${index}`, botId: 'bot-one', botName: 'ユキ', status: 'running', context: 'direct', contextId: 'bot-one' })) } }
routes['/api/updates'] = JSON.parse(readFileSync('windows/BellTeam.Tests/fixtures/update-center.json', 'utf8'))
const updateFixture = name => JSON.parse(readFileSync(`windows/BellTeam.Tests/fixtures/${name}.json`, 'utf8'))
// Inspector scene (PR 5): bot-one has an independent large image, bot-three shows its small image in the large slot, bot-two has no image.
const portrait = readFileSync('ios/BellBot/BellBot/Assets.xcassets/BellPortrait.imageset/bell-portrait.png'), icon = readFileSync('ios/BellBot/BellBot/Assets.xcassets/AppIcon.appiconset/bellbot-icon.png')
const dataUrl = bytes => `data:image/png;base64,${bytes.toString('base64')}`
const inspectorExtras = { 'bot-one': { position: '相談役', profileText: '落ち着いた相談役。BellTeamの毎日の仕事を一緒に整える。\n朝は予定を、夜はふり返りを手伝う。', personality: '丁寧で慎重。迷った時は理由を添えて選ぶ。', speechStyle: 'やわらかい敬体。', role: '予定の整理と資料の下書き', model: 'opus', reasoningEffort: 'high', avatarVersion: 'v1', avatarLargeVersion: 'L1' }, 'bot-two': { position: '', model: '', reasoningEffort: '' }, 'bot-three': { position: '調査担当', role: '資料集め', avatarVersion: 'v3', avatarLargeVersion: 'v3' } }
const seatAccounts = { 'bot-one': { harness: 'claude', slot: '2nd', preferredSlot: '2nd' }, 'bot-two': null }
const inspectorBots = () => fixture.bots.map(bot => { const merged = { ...bot, ...(inspectorExtras[bot.id] ?? {}), ...(conversationScene === 'inspector-account' && bot.id in seatAccounts ? { account: seatAccounts[bot.id] } : {}) }; return { ...merged, displayName: merged.position ? `${merged.name} ${merged.position}` : merged.name } })
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
// Member state scenes (PR 17): the first member carries a configurationApplication record or a seatLaunch notice; the fork scene mixes fork rows with rows that must read as normal.
// Every route is a GET; the restart states are set through a render seam because the POST is never served.
const forkScene = [
  incoming('f1', longAgo, 'いまの進捗を一言で教えて', { seat: { kind: 'fork', fork_id: 'f1' } }),
  incoming('f2', longAgo, '確認しています。', { seat: { kind: 'fork', fork_id: 'f1' } }),
  incoming('f3', longAgo, '実装は7割です。残りはテストです。', { seat: { kind: 'fork', fork_id: 'f1' } }),
  outgoing('f4', longAgo, 'ハルへ: 実装は7割です。', { delivery: 'delivered', seat: { kind: 'fork', fork_id: 'f1' } }),
  incoming('f5', longAgo, '続けます。'),
  incoming('f6', longAgo, 'seatが文字列の行（通常の行として表示）', { seat: 'fork' }),
  incoming('f7', longAgo, '未知のkindの行（通常の行として表示）', { seat: { kind: 'future' } })
]
const memberStateBot = {
  'memberstate-config-pending': { configurationApplication: { state: 'pending' } },
  'memberstate-config-accepted': { configurationApplication: { state: 'accepted' } },
  'memberstate-config-failed': { configurationApplication: { state: 'failed', message: '設定変更は反映されませんでした。席が応答しませんでした。保存した設定は、次に席を起こし直した時に使います。' } },
  'memberstate-seat-launch': { seatLaunch: { code: 'TARGET_MISMATCH', action: 'Macの「システム設定 > 一般 > 共有」で「リモートログイン」をオンにしてください', terminalId: 'owner-macbook', at: '2026-11-10T02:00:00Z' } },
  'memberstate-seat-launch-code': { seatLaunch: { code: 'TARGET_MISMATCH', action: null, terminalId: 'owner-macbook', at: '2026-11-10T02:00:00Z' } }
}
sceneMessages['memberstate-fork'] = { 'bot-one': forkScene }
sceneMessages['memberstate-seat-launch'] = sceneMessages['memberstate-seat-launch-code'] = { 'bot-one': memberScene }
// Secret input card scenes (PR 14): one pending request per scene, and the onepassword-items list that the request's purpose uses. 'old' has the card but no list route (404).
const secretKeys = [{ title: 'Mac mini 本番', vault: 'Infra', reference: 'op://infra/mac-mini/password' }, { title: 'office-imac', vault: 'Infra', reference: 'op://infra/office-imac/password' }, { title: '個人用ノート PC', vault: 'Team', reference: 'op://team/laptop/password' },
  { title: 'スタジオ Mac', vault: 'Team', reference: 'op://team/studio/password' }, { title: 'NAS 管理者', vault: 'Personal', reference: 'op://personal/nas/password' }, { title: 'deploy key', vault: 'Keys', reference: 'op://infra/deploy/private key?ssh-format=openssh' }]
const secretOptions = { preferred: 'onepassword', onePasswordAvailable: true }
const secretRequests = {
  'ssh-search': { purpose: 'terminal.ssh', label: 'owner-macbookのSSH鍵', message: '端末「owner-macbook」で使うSSH鍵を登録してください。', inputOptions: secretOptions },
  'sudo-list': { purpose: 'terminal.sudo', label: 'owner-macbookのsudo鍵', message: '端末「owner-macbook」のsudo認証情報を登録してください。値や1Password参照は、この専用欄へ入力してください。', inputOptions: secretOptions },
  'sudo-vault': { purpose: 'terminal.sudo', label: 'owner-macbookのsudo鍵', message: '端末「owner-macbook」のsudo認証情報を登録してください。値や1Password参照は、この専用欄へ入力してください。', inputOptions: secretOptions },
  reference: { label: 'GitHubトークン', message: 'GitHubに接続するためのトークンを入力してください。', inputOptions: secretOptions },
  onetime: { oneTime: true, label: 'Claudeのログインコード', message: 'Claudeにログインするための確認コードを入力してください。', inputOptions: secretOptions },
  login: { purpose: 'terminal.login', label: 'owner-macbookのログインパスワード', message: 'このMacのログインパスワード（1回だけ使い、保存しません）', inputOptions: secretOptions },
  old: { purpose: 'terminal.ssh', label: 'owner-macbookのSSH鍵', message: '端末「owner-macbook」で使うSSH鍵を登録してください。', inputOptions: secretOptions }
}
for (const [scene, extra] of Object.entries(secretRequests)) sceneMessages[`secret-${scene}`] = { 'bot-one': [{ id: 'sec1', kind: 'message', direction: 'incoming', sender: bots['bot-one'], at: ago(2), secret_request: { id: `sr-${scene}`, botId: 'bot-one', toolId: 'terminal-key', status: 'pending', ...extra } }] }
// 端末 scenes (PR 16a): GET /api/terminals as the registry answers it ('old' has no route, 'unavailable' is the 503 of a body whose terminals feature is not running).
// Checks, key requests and every write are never served; the states that follow them are set through render seams.
const terminalOf = (terminalId, host, user, extra = {}) => ({ terminalId, host, user, port: 22, os: 'macos', accountOwner: 'owner', sshKeyConfigured: true, sudoKeyConfigured: false, hostTrust: { trustRevision: 1 }, keySource: 'secret', sudoKeySource: null, sshKeyPending: false, sudoKeyPending: false, ...extra })
const nativeKey = { keySource: 'terminal-native', maintenance: { observedAt: '2026-11-09T03:00:00Z', before: '2.1.30', after: '2.1.32', outcome: 'updated' } }
const terminalScenes = {
  list: [terminalOf('owner-macbook', '192.168.1.12', 'kite'), terminalOf('sleeping-mini', '192.168.1.20', 'kite'), terminalOf('studio-mac', '192.168.1.30', 'hana', { port: 2222, accountOwner: 'terminal-owner', sudoKeyConfigured: true, sudoKeySource: 'secret' }), terminalOf('office-imac', 'office-imac.local', 'kite')],
  'auth-failed': [terminalOf('sleeping-mini', '192.168.1.40', 'kite')],
  hostkey: [terminalOf('office-imac', 'office-imac.local', 'kite')],
  windows: [terminalOf('fox', '192.168.1.11', 'kite_', { os: 'windows' })],
  // PR 16c: this PC (the render pretends to be "fox" at 192.168.1.11); untrusted, and the same terminal after the server trusted it.
  thispc: [terminalOf('fox', '192.168.1.11', 'kite_', { os: 'windows', hostTrust: undefined, sshKeyConfigured: false, keySource: null })],
  'thispc-trusted': [terminalOf('fox', '192.168.1.11', 'kite_', { os: 'windows', sshKeyConfigured: false, keySource: null })],
  keys: [terminalOf('owner-macbook', '192.168.1.12', 'kite', nativeKey)],
  'keys-pending': [terminalOf('owner-macbook', '192.168.1.12', 'kite', { ...nativeKey, sshKeyPending: true })]
}
// 端末とフォルダ scenes (PR 16b): the terminal list, the folders of each terminal and bot-one's binding, all GET. 'old' has no terminals route, 'unsupported' no folders route,
// 'offline' answers every folder read with UNREACHABLE; 'windows' binds bot-one to the Windows PC. The create POST is never served; the created folder is a render seam (an opened place).
const folderTerminals = [terminalOf('owner-macbook', '192.168.1.12', 'kite'), terminalOf('fox', '192.168.1.11', 'kite_', { os: 'windows' })]
const folderTrees = {
  'owner-macbook': { home: '/Users/kite', separator: '/', root: '/', tree: { '/Users/kite': ['BellTeam', 'Desktop', 'Documents', 'work'], '/Users/kite/work': ['app', 'docs'], '/Users/kite/work/scratch': [] } },
  fox: { home: 'C:\\Users\\kite_', separator: '\\', root: 'C:\\', tree: { 'C:\\Users\\kite_': ['BellTeam', 'Desktop', 'Documents', 'work'], 'C:\\Users\\kite_\\work': ['app', 'docs'] } }
}
const folderParent = (terminal, path) => { if (path === terminal.root) return null; const cut = path.lastIndexOf(terminal.separator); return cut <= terminal.root.length - 1 ? terminal.root : path.slice(0, cut) }
let writes = 0
let gallery = false
const galleryAssets = { '/api/message-images/demo/one.png': 'ios/BellBot/BellBot/Assets.xcassets/AppIcon.appiconset/bellbot-icon.png', '/api/message-images/demo/two.png': 'docs/assets/mac-ui-reference-48/01-workspace.png', '/api/message-images/demo/three.png': 'docs/assets/conversation-images/iphone-stack.png' }
routes['/api/harness-auth'] = { harnesses: [{ id: 'codex', name: 'Codex', members: 2, startWarning: 'Codexは、認証し直しを始めた時点で今の認証が消えます。' }, { id: 'claude', name: 'Claude', members: 1, startWarning: null }] }
routes['/api/harness-auth/codex'] = { harness: 'codex', auth: { status: 'waiting', url: 'https://example.com/login', user_code: 'TEST-CODE', input_required: false, message: '公式サイトで認証してください。' } }
routes['/api/harness-auth/claude'] = { harness: 'claude', auth: { status: 'authenticated', input_required: false } }
routes['/api/ai-control'] = { control: { paused: false, state: 'enabled', updatedAt: null, unconfirmedBotIds: [], commandsConfirmed: null, error: null } }
routes['/api/setup'] = { phase: 'select_harness', harness: null, harnesses: [{ id: 'codex', name: 'Codex' }, { id: 'claude', name: 'Claude' }, { id: 'grok', name: 'Grok' }, { id: 'cursor', name: 'Cursor' }], guideBotId: null, complete: false, auth: null }
// Startup scenes (PR 10): the app's own routing runs against these answers (session, then setup). Every route is a GET.
const startupWaiting = { phase: 'authenticate', harness: 'codex', harnesses: [{ id: 'codex', name: 'Codex' }, { id: 'claude', name: 'Claude' }], guideBotId: 'bot-guide', complete: false, auth: { status: 'waiting', url: 'https://example.com/login', user_code: 'ABCD-1234', input_required: false, message: null, auth_ui: { schema: 'aiterm.auth-ui.v1', stage: 'device_code', title: '公式サイトでコードを入力してください', message: '公式サイトを開き、次の利用者コードを入力すると認証が終わります。', url: 'https://example.com/login', user_code: 'ABCD-1234', input: null, prompt_digest: 'a'.repeat(64), binding: { session_id: 'owned', launch_id: null, metadata_identity: 'meta-1', native_id: 'native-1', pane_id: '%3', server_pid: 4101, server_started: '2026-11-08T09:00:00Z', pane_pid: 4102, pane_started: '2026-11-08T09:00:01Z' }, choices: [] } } }
const startupReady = { phase: 'ready', harness: null, harnesses: [], guideBotId: null, complete: true, auth: null }
// Claude account scenes (PR 12): GET /api/accounts as the execution contract returns it (per-scope limits[], allLimited[], rules). 'old' is a server without the route (404).
// Reset times are relative to now so the card shows them as today (HH:MM) in JST.
const inMinutes = minutes => new Date(Date.now() + minutes * 60000).toISOString()
const accountSlot = (slot, label, { loggedIn = true, limits = [], seats = [], history = 'shared' } = {}) => ({ slot, loggedIn, label, history, limits, seats })
const accountScenes = {
  normal: () => ({ harnesses: [{ harness: 'claude', slots: [accountSlot('1st', 'first@example.com', { seats: ['bot-one', 'bot-two'] }), accountSlot('2nd', 'second@example.com', { seats: ['bot-three'] })], allLimited: [] }], rules: [] }),
  'one-limited': () => ({ harnesses: [{ harness: 'claude', slots: [accountSlot('1st', 'first@example.com', { limits: [{ scope: 'fable', since: inMinutes(-30), resetAt: inMinutes(150), resetSource: 'message' }], seats: ['bot-two'] }), accountSlot('2nd', 'second@example.com', { seats: ['bot-one', 'bot-three'] })], allLimited: [] }], rules: [] }),
  'both-limited': () => ({ harnesses: [{ harness: 'claude', slots: [
    accountSlot('1st', 'first@example.com', { limits: [{ scope: 'all', since: inMinutes(-60), resetAt: inMinutes(180), resetSource: 'usage' }], seats: ['bot-one'] }),
    accountSlot('2nd', 'second@example.com', { limits: [{ scope: 'all', since: inMinutes(-20), resetAt: null, resetSource: null }, { scope: 'fable', since: inMinutes(-20), resetAt: inMinutes(300), resetSource: 'message' }], seats: ['bot-three'], history: 'separate' })],
    allLimited: [{ scope: 'all', earliestResetAt: inMinutes(180) }, { scope: 'fable', earliestResetAt: inMinutes(180) }] }], rules: [] }),
  unlogged: () => ({ harnesses: [{ harness: 'claude', slots: [accountSlot('1st', 'first@example.com', { seats: ['bot-one'] }), accountSlot('2nd', null, { loggedIn: false })], allLimited: [] }], rules: [] })
}
// 相関図 (PR 13b): GET /api/work-graph/events answers one snapshot and stays open, as the real stream does. Every scene name starts with "workgraph-".
const wgNode = (botId, name, color, state = 'working') => ({ botId, name, color, avatarVersion: '', state, activeSince: ago(10) })
const wgEdge = (id, from, to, label, extra = {}) => ({ id, requestId: `r-${id}`, from, to, label, state: 'running', startedAt: ago(8), ...extra })
const crowdedNames = ['トロニー', 'ドリリー', 'キロ', 'ユナ', 'アドミ', 'ルナ', 'トワ', 'ハナ', 'セナ', 'ナユタ', 'マスト', 'ソラ', 'カイ', 'センチ', 'レオナ', 'ケイ', 'ブラック', 'ノア', 'アンカー', 'ヘルム', 'リク', 'モリー', 'エピネル', 'ミオ']
const crowdedPairs = [[0, 2], [14, 20], [1, 2], [1, 6], [20, 21], [4, 5], [12, 17], [14, 21], [9, 10], [2, 18], [19, 22], [11, 12], [3, 0], [10, 9], [13, 6], [12, 16]]
const workGraphScenes = {
  graph: () => ({ nodes: [wgNode('wg-haru', 'ハル', 'violet'), wgNode('wg-yuki', 'ユキ', 'indigo'), wgNode('wg-kiro', 'キロ', 'mint'), wgNode('wg-nagi', 'ナギ', 'rose', 'linked'), wgNode('wg-sora', 'ソラ', 'sky'), wgNode('wg-mio', 'ミオ', 'amber')],
    edges: [wgEdge('e1', 'wg-yuki', 'wg-haru', '比較表を更新'), wgEdge('e2', 'wg-kiro', 'wg-nagi', 'この設計で公開範囲に問題がないか、読み取り専用で見てほしい', { seat: { kind: 'fork', forkId: 'f1' } }),
      wgEdge('e3', 'wg-sora', 'wg-mio', null), wgEdge('e4', 'wg-mio', 'wg-sora', '会話一覧の位置が飛ばないことを確かめて、結果を要約して返してください'), wgEdge('e5', 'wg-haru', 'wg-kiro', '画像の並びと文字の折り返しを見て、直す所があれば教えて')] }),
  crowded: () => ({ nodes: crowdedNames.map((name, index) => wgNode(`wg-${index}`, name, ['violet', 'indigo', 'sky', 'mint', 'amber', 'rose'][index % 6], [3, 5, 18, 21].includes(index) ? 'linked' : 'working')),
    edges: crowdedPairs.map(([from, to], index) => wgEdge(`c${index}`, `wg-${from}`, `wg-${to}`, `依頼${index + 1}の確認`)) }),
  empty: () => ({ nodes: [], edges: [] })
}
const server = createServer((request, response) => {
  if (request.method !== 'GET') { writes++; response.writeHead(405); response.end(); return }
  const path = new URL(request.url, 'http://localhost').pathname
  if (path === '/api/work-graph/events' && conversationScene.startsWith('workgraph-')) {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    response.write(`event: snapshot\ndata: ${JSON.stringify({ epoch: 'e1', version: 1, degraded: [], ...workGraphScenes[conversationScene.slice(10)]() })}\n\n`)
    return
  }
  if (/^\/api\/secret-requests\/[^/]+\/onepassword-items$/.test(path) && conversationScene.startsWith('secret-')) {
    const scene = conversationScene.slice(7), purpose = secretRequests[scene]?.purpose
    const items = scene === 'old' ? null : secretKeys
    response.writeHead(items ? 200 : 404, { 'content-type': 'application/json' }); response.end(JSON.stringify(items ? { items: purpose === 'terminal.ssh' ? items.filter(key => key.title !== 'NAS 管理者') : items } : { error: 'NOT_FOUND' })); return
  }
  if (conversationScene.startsWith('terminals-') && path === '/api/terminals') {
    const kind = conversationScene.slice(10)
    const status = kind === 'old' ? 404 : kind === 'unavailable' ? 503 : 200
    response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(status === 200 ? { terminals: terminalScenes[kind] } : status === 404 ? { error: 'NOT_FOUND' } : { error: 'TERMINALS_UNAVAILABLE', message: 'terminals are not running' })); return
  }
  // a65 稼働中に数えない処理: GET only (外す is a DELETE the mock never serves).
  if (conversationScene.startsWith('exclusions-') && path === '/api/running-exclusions') {
    const kind = conversationScene.slice(11), status = kind === 'old' ? 404 : kind === 'unavailable' ? 503 : 200
    const list = kind === 'empty' ? { entries: [], pending: [] } : {
      entries: [
        { id: 'e1', kind: 'process', exe: 'node', args: ['vite', 'dev'], scope: 'all', decisionId: 'K-1', approvedAt: '2026-11-13T14:10:00Z', reason: '開発サーバーは待機中も動き続けるため' },
        { id: 'e2', kind: 'child', harness: 'codex', session: null, scope: ['bot-one'], decisionId: 'K-2', approvedAt: '2026-11-12T01:00:00Z', reason: '見張り役の子の席は常駐する' }],
      pending: [
        { action: 'add', entry: { id: 'e3', kind: 'process', exe: 'python', args: ['-m', 'http.server'], scope: ['bot-two'], reason: '画面の確かめ用に置いたままにする' }, decisionId: 'K-3', from: 'bot-two', filedAt: '2026-11-13T14:20:00Z' },
        { action: 'remove', id: 'e1', decisionId: 'K-4', from: 'bot-one', filedAt: '2026-11-13T14:30:00Z' }] }
    response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(status === 200 ? list : status === 404 ? { error: 'NOT_FOUND' } : { error: 'RUNNING_EXCLUSIONS_UNAVAILABLE' })); return
  }
  if (conversationScene.startsWith('memberfolder-')) {
    const scene = conversationScene.slice(13), send = (status, answer) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(answer)) }
    if (path === '/api/terminals') return scene === 'old' ? send(404, { error: 'NOT_FOUND' }) : send(200, { terminals: folderTerminals })
    const folders = path.match(/^\/api\/terminals\/([^/]+)\/folders$/), terminal = folders && folderTrees[folders[1]]
    if (folders) {
      if (scene === 'unsupported' || !terminal) return send(404, { error: 'NOT_FOUND' })
      const asked = new URL(request.url, 'http://localhost').searchParams.get('path') ?? terminal.home
      return send(200, { terminalId: folders[1], observedAt: new Date().toISOString(), home: terminal.home, path: asked, parent: folderParent(terminal, asked), truncated: false,
        entries: scene === 'offline' ? [] : (terminal.tree[asked] ?? []).map(name => ({ name, path: `${asked}${terminal.separator}${name}` })),
        ...(scene === 'offline' ? { reason: 'UNREACHABLE', action: 'the terminal did not answer' } : {}) })
    }
    if (path === '/api/bots/bot-one') return send(200, { bot: { ...fixture.bots[0], terminalId: scene === 'windows' ? 'fox' : 'owner-macbook', projectRoot: scene === 'windows' ? 'C:\\Users\\kite_\\work\\app' : '/Users/kite/work/app' } })
  }
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
  if (conversationScene === 'schedules-failed' && /^\/api\/(schedules|(bots|rooms)\/[^/]+\/schedules)$/.test(path)) { response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'TEMPORARY_FAILURE' })); return }
  if (conversationScene.startsWith('accounts-') && path === '/api/accounts') {
    const kind = conversationScene.slice(9)
    const answer = accountScenes[kind]?.()
    response.writeHead(answer ? 200 : 404, { 'content-type': 'application/json' }); response.end(JSON.stringify(answer ?? { error: 'NOT_FOUND' })); return
  }
  if (conversationScene === 'accounts-unlogged' && path === '/api/harness-auth/claude' && new URL(request.url, 'http://localhost').searchParams.get('slot') === '2nd') {
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ harness: 'claude', slot: '2nd', account_label: null, auth: { status: 'blocked', input_required: false } })); return
  }
  if (conversationScene.startsWith('startup-') && (path === '/api/session' || path === '/api/setup')) {
    const kind = conversationScene.slice(8)
    if (path === '/api/session' && kind === 'failure') { response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'TEMPORARY_FAILURE' })); return }
    const answer = path === '/api/session' ? { authenticated: kind !== 'login', authMode: kind === 'login' ? 'cloudflare' : 'local' } : kind === 'onboarding-waiting' ? startupWaiting : kind === 'banner' ? startupReady : routes['/api/setup']
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(answer)); return
  }
  let value = path === '/api/queue' && conversationScene !== 'default' ? { items: sceneQueues[conversationScene] ?? [] } : routes[path]
  const chat = path.match(/^\/api\/(bots|rooms)\/([^/]+)(?:\/(messages|schedules))?$/)
  if (chat) { const [, kind, id, action] = chat; if (conversationScene === 'failed' && action === 'messages') { response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'TEMPORARY_FAILURE' })); return }; value = action === 'messages' ? conversationScene !== 'default' ? { items: sceneMessages[conversationScene]?.[id] ?? [], has_more: false } : { items: gallery ? [...messages, { id: 'gallery', at: '2026-10-13T09:03:00Z', direction: 'incoming', kind: 'message', image: true, image_urls: Object.keys(galleryAssets) }] : messages, has_more: false } : action === 'schedules' ? { schedules: (conversationScene === 'schedules-empty' ? {} : conversationScene === 'schedules-list' ? scheduleList : schedules)[id] ?? [] } : kind === 'bots' ? { bot: fixture.bots.find(bot => bot.id === id) } : { room: fixture.rooms.find(room => room.id === id) } }
  if (conversationScene.startsWith('inspector')) {
    const botId = path.match(/^\/api\/bots\/([^/]+)$/)?.[1]
    if (path === '/api/bots') value = { bots: inspectorBots() }
    else if (botId) { const bot = inspectorBots().find(item => item.id === botId); value = { bot: botId === 'bot-one' ? { ...bot, avatar: dataUrl(icon), avatarLarge: dataUrl(portrait), avatarSource: dataUrl(portrait), avatarLargeSource: dataUrl(portrait), avatarCrop: { x: 0, y: 0, width: 1, height: 1 }, avatarLargeCrop: { x: 0, y: 0, width: 1, height: 1 } } : bot } }
  }
  if (path === '/api/settings' && conversationScene.startsWith('onepassword-')) {
    const scene = conversationScene.slice(12), connected = scene === 'success', failed = scene === 'failure'
    const item = { id: 'onePassword', title: '1Password連携', enabled: connected || failed, status: connected || failed ? 'enabled' : 'unconfigured', fields: [{ key: 'token', label: 'サービスアカウントのトークン', secret: true, value: '', configured: connected || failed }],
      error: failed ? { code: 'ONEPASSWORD_TOKEN_REJECTED', message: '1Passwordがこのトークンを受け付けませんでした。トークンを作り直して貼り直すか、ネットワークを確かめてください。' } : null,
      guide: { steps: ['サービスアカウントは、BellTeamが1Passwordの鍵を読むための専用の鍵束です。', '1Passwordのウェブで「開発者」→「サービスアカウント」から作ります。', '読ませたい保管庫だけを許可します（Personal / Private は共有できません）。', '表示されるトークン（ops_で始まる）を、下の欄へ1回だけ貼ります。'], link: { label: '1Passwordの手順を開く', url: 'https://developer.1password.com/docs/service-accounts/' } },
      ...(connected ? { connection: { vaults: ['Infra', 'Team'], sshKeys: 3 } } : {}) }
    value = { ...routes[path], settings: [...routes[path].settings, item] }
  }
  if (path === '/api/bots' && memberStateBot[conversationScene]) value = { bots: fixture.bots.map((bot, index) => index === 0 ? { ...bot, ...memberStateBot[conversationScene] } : bot) }
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
      ['05-setup.png', ['--render-startup', 'onboarding-choose', origin]],
      ['06-authentication.png', ['--render-editor', 'authentication', origin, 'codex']],
      ['07-settings-cloudflare.png', ['--render-page', 'settings-connection', origin]],
      ['08-settings-lower.png', ['--render-page', 'settings-lower', origin]],
      ['09-gallery.png', ['--render-gallery', origin, 'bot-one']]
    ]
    const settingsPages = ['profile', 'ai', 'summary', 'terminals', 'exclusions', 'onepassword', 'notifications', 'rules', 'features', 'connection', 'display', 'billing', 'update', 'about', 'stop']
    if (process.argv[4] && !['gallery', 'updates', 'settings', 'summary', 'conversation', 'inspector', 'screen', 'goals', 'editors', 'schedules', 'startup', 'polish', 'accounts', 'workgraph', 'memberstate', 'onepassword', 'secret', 'terminals', 'memberfolder', 'thispc', 'exclusions'].includes(process.argv[4])) throw new Error('WINDOWS_RENDER_SCENE_UNKNOWN')
    // Same three summaries as ios/BellBot/BellBotTests/SummaryLayoutTests.swift.
    if (process.argv[4] === 'summary') ['認証まわりの再試行処理を見直し、通知の表示崩れと画像の読み込み失敗も合わせて直す', 'ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴ', 'abcdefghij'.repeat(8)].forEach((summary, index) => { if (fixture.bots[index]) fixture.bots[index].currentWork = { state: 'working', summary, summaryStatus: 'current' } })
    // [file, scene, conversation id]: each renders the conversation in one named state.
    const conversationFrames = [['conversation-member.png', 'member', 'bot-one'], ['conversation-room.png', 'room', 'planning'], ['conversation-states.png', 'states', 'bot-one'], ['conversation-stop-room.png', 'stop', 'planning'], ['conversation-stop-notice.png', 'stop-notice', 'planning'], ['conversation-stop-member.png', 'stop-member', 'bot-one'], ['conversation-draft.png', 'draft', 'bot-two'], ['conversation-peer-sheet.png', 'peer-sheet', 'bot-one'], ['conversation-stack.png', 'stack', 'bot-two'], ['conversation-long-choices.png', 'long-choices', 'bot-three'], ['conversation-scrolled.png', 'scrolled', 'bot-one'], ['conversation-empty.png', 'empty', 'bot-three'], ['conversation-failed.png', 'failed', 'bot-three']]
    // [file, scene, conversation id]: the inspector in each state; every scene name starts with "inspector" for the mock.
    const inspectorFrames = [['inspector-member-large.png', 'member', 'bot-one'], ['inspector-member-small-only.png', 'member', 'bot-three'], ['inspector-member-no-image.png', 'member', 'bot-two'], ['inspector-room.png', 'room', 'planning'], ['inspector-sheet-small.png', 'sheet-small', 'bot-one'], ['inspector-sheet-large.png', 'sheet-large', 'bot-one'], ['inspector-sheet-unsupported.png', 'sheet-unsupported', 'bot-three'], ['inspector-pending.png', 'pending', 'bot-one'], ['inspector-pending-sheet.png', 'pending-sheet', 'bot-one']]
    // [file, scene]: the Bot screen of bot-one; every scene name starts with "screen-" for the mock.
    const screenFrames = [['screen-keys.png', 'keys'], ['screen-approval.png', 'approval'], ['screen-digits-error.png', 'digits'], ['screen-sent.png', 'sent'], ['screen-empty.png', 'empty'], ['screen-offline.png', 'offline'], ['screen-read-failed.png', 'failed']]
    // [file, render kind, scene, conversation id or null]: goals; every scene name starts with "goals-" for the mock.
    const goalFrames = [['goals-empty.png', 'page', 'empty'], ['goals-cards.png', 'page', 'cards'], ['goals-cards-codex.png', 'page', 'cards-codex'],
      ['goals-pill.png', 'pill', 'empty', 'bot-one'], ['goals-pill-open-unset.png', 'pill-open', 'empty', 'bot-one'], ['goals-pill-open-active.png', 'pill-open', 'cards', 'bot-one'],
      ['goals-editor-create-error.png', 'editor-create', 'empty', 'bot-two'], ['goals-editor-edit-separate.png', 'editor-edit', 'cards-codex', 'bot-one']]
    // [file, scene, conversation or member id]: the editors (PR 8). Every request is a GET; delete and save states are set through render seams.
    const editorFrames = [['editors-new-member.png', 'new-member', 'bot-one'], ['editors-member-window.png', 'member', 'bot-one'], ['editors-room.png', 'room', 'planning'], ['editors-new-room.png', 'new-room', 'planning'], ['editors-crop.png', 'crop', 'bot-one'],
      ['editors-member-delete-alert.png', 'member-delete-alert', 'bot-one'], ['editors-member-delete-pending.png', 'member-delete-pending', 'bot-one'], ['editors-member-delete-unconfirmed.png', 'member-delete-unconfirmed', 'bot-one'], ['editors-room-delete-alert.png', 'room-delete-alert', 'planning']]
    // [file, render scene]: the schedule page and sheets (PR 9); every scene name starts with "schedules-" for the mock.
    const scheduleFrames = [['schedules-list.png', 'list'], ['schedules-empty.png', 'empty'], ['schedules-failed.png', 'failed'], ['schedules-editor-member.png', 'editor-member'], ['schedules-editor-room.png', 'editor-room'],
      ['schedules-editor-weekly-error.png', 'editor-weekly-error'], ['schedules-editor-interval.png', 'editor-interval'], ['schedules-editor-command.png', 'editor-command'], ['schedules-editor-command-open.png', 'editor-command-open'], ['schedules-delete.png', 'delete']]
    // [file, scene]: the startup screens (PR 10); every scene name starts with "startup-" for the mock. The first three never connect.
    const startupFrames = [['startup-opening.png', 'opening'], ['startup-failure.png', 'failure'], ['startup-server-setup.png', 'setup'], ['startup-guide.png', 'guide'], ['startup-login.png', 'login'], ['startup-onboarding-choose.png', 'onboarding-choose'], ['startup-onboarding-waiting.png', 'onboarding-waiting'], ['startup-banner.png', 'banner']]
    // [file, render args, mock scene]: the polish items (PR 11a): secret card button, the 受付確認中 echo, member and room with the corner buttons, a sheet with pill buttons, the in-window gallery (last: it turns the gallery message on).
    const polishFrames = [['polish-secret.png', ['--render-conversation', 'secret', origin, 'bot-one'], 'secret'], ['polish-echo.png', ['--render-conversation', 'echo', origin, 'bot-one'], 'echo'], ['polish-member.png', ['--render-conversation', 'member', origin, 'bot-one'], 'member'], ['polish-room.png', ['--render-conversation', 'room', origin, 'planning'], 'room'], ['polish-sheet.png', ['--render-editors', 'new-member', origin, 'bot-one']], ['polish-gallery.png', ['--render-gallery', origin, 'bot-one']]]
    // [file, render args, mock scene]: the Claude accounts (PR 12). Every request is a GET; the switch and the logins are never clicked.
    const accountFrames = [['accounts-normal.png', ['--render-page', 'settings-ai', origin], 'accounts-normal'], ['accounts-one-limited.png', ['--render-page', 'settings-ai', origin], 'accounts-one-limited'],
      ['accounts-both-limited.png', ['--render-page', 'settings-ai', origin], 'accounts-both-limited'], ['accounts-unlogged.png', ['--render-page', 'settings-ai', origin], 'accounts-unlogged'],
      ['accounts-old-server.png', ['--render-page', 'settings-ai', origin], 'accounts-old'], ['accounts-member-card.png', ['--render-inspector', 'member', origin, 'bot-one'], 'inspector-account']]
    // [file, render args, mock scene]: the 相関図 window (PR 13b) in three graphs and the empty state; the main window with its new sidebar entry is the plain workspace render.
    const workGraphFrames = [['workgraph-graph.png', ['--render-workgraph', origin], 'workgraph-graph'], ['workgraph-crowded.png', ['--render-workgraph', origin], 'workgraph-crowded'], ['workgraph-empty.png', ['--render-workgraph', origin], 'workgraph-empty'], ['workgraph-sidebar.png', ['--render-url', origin, 'bot-one']]]
    // [file, render args, mock scene]: the member state lines (PR 17). The restart scenes only set a render seam; no request is sent.
    const memberStateFrames = [['pr17-member-editor-configuration-pending.png', ['--render-editor', 'member', origin, 'bot-one'], 'memberstate-config-pending'], ['pr17-member-editor-configuration-accepted.png', ['--render-editor', 'member', origin, 'bot-one'], 'memberstate-config-accepted'],
      ['pr17-member-editor-configuration-failed.png', ['--render-editor', 'member', origin, 'bot-one'], 'memberstate-config-failed'], ['pr17-restart-in-progress.png', ['--render-inspector', 'restart-busy', origin, 'bot-one'], 'inspector-restart-busy'],
      ['pr17-restart-success.png', ['--render-inspector', 'restart-success', origin, 'bot-one'], 'inspector-restart-success'], ['pr17-fork-badge.png', ['--render-conversation', 'fork', origin, 'bot-one'], 'memberstate-fork'],
      ['pr17-seat-launch.png', ['--render-conversation', 'member', origin, 'bot-one'], 'memberstate-seat-launch'], ['pr17-seat-launch-code.png', ['--render-conversation', 'member', origin, 'bot-one'], 'memberstate-seat-launch-code']]
    // [file, render args, mock scene]: the 1Password連携 page (PR 15). The mock serves only GET; the checking and success states are set through a render seam.
    const onePasswordFrames = ['not-linked', 'checking', 'success', 'failure'].map(scene => [`pr15-1password-${scene}.png`, ['--render-page', `onepassword-${scene}`, origin], `onepassword-${scene}`])
    // [file, render args, mock scene]: the secret input window (PR 14). Nothing is typed or sent; the search box is filled by a render seam.
    const secretFrames = ['ssh-search', 'sudo-list', 'sudo-vault', 'reference', 'onetime', 'login', 'old'].map(scene => [`pr14-secret-${scene}.png`, ['--render-secret', scene, origin], `secret-${scene}`])
    // [file, render args, mock scene]: the 端末 pages (PR 16a). Every request is a GET; the checks, pending keys and the waiting line are set through render seams.
    const terminalFrames = [['pr16a-terminal-list.png', ['--render-page', 'settings-terminals', origin], 'terminals-list'], ['pr16a-terminal-list-old-server.png', ['--render-page', 'settings-terminals', origin], 'terminals-old'], ['pr16a-terminal-list-unavailable.png', ['--render-page', 'settings-terminals', origin], 'terminals-unavailable'],
      ['pr16a-terminal-detail-auth-failed.png', ['--render-terminals', 'detail-auth-failed', origin], 'terminals-auth-failed'], ['pr16a-terminal-detail-authorizing.png', ['--render-terminals', 'detail-authorizing', origin], 'terminals-auth-failed'],
      ['pr16a-terminal-detail-hostkey-other-ways.png', ['--render-terminals', 'detail-hostkey', origin], 'terminals-hostkey'], ['pr16a-hostkey-sheet.png', ['--render-terminals', 'hostkey-sheet', origin], 'terminals-hostkey'],
      ['pr16a-terminal-detail-windows-refused.png', ['--render-terminals', 'detail-windows', origin], 'terminals-windows'], ['pr16a-terminal-keys-set-and-unset.png', ['--render-terminals', 'keys', origin], 'terminals-keys'], ['pr16a-terminal-keys-pending-and-unset.png', ['--render-terminals', 'keys-pending', origin], 'terminals-keys-pending'],
      ...['macos', 'windows', 'linux'].map(os => [`pr16a-terminal-editor-os-${os}.png`, ['--render-terminals', `editor-${os}`, origin], 'terminals-list'])]
    // [file, render args, mock scene]: the member editor's 端末とフォルダ and the folder picker (PR 16b). Every request is a GET; the terminal choice, the picker's place and the refused save are render seams.
    const memberFolderFrames = [['pr16b-member-editor-terminal-folder.png', ['--render-editors', 'folder-new', origin, 'bot-one'], 'memberfolder-ok'], ['pr16b-member-editor-terminal-folder-windows.png', ['--render-editors', 'folder-new-windows', origin, 'bot-one'], 'memberfolder-ok'],
      ['pr16b-member-editor-folder-missing-offer-create.png', ['--render-editors', 'folder-new-missing', origin, 'bot-one'], 'memberfolder-ok'], ['pr16b-member-editor-typed-path.png', ['--render-editors', 'folder-new-typed', origin, 'bot-one'], 'memberfolder-unsupported'],
      ['pr16b-member-editor-old-server.png', ['--render-editors', 'folder-new', origin, 'bot-one'], 'memberfolder-old'],
      ['pr16b-folder-picker-home.png', ['--render-editors', 'folder-picker', origin, 'bot-one'], 'memberfolder-ok'], ['pr16b-folder-picker-subfolder.png', ['--render-editors', 'folder-picker-sub', origin, 'bot-one'], 'memberfolder-ok'],
      ['pr16b-folder-picker-created.png', ['--render-editors', 'folder-picker-created', origin, 'bot-one'], 'memberfolder-ok'], ['pr16b-folder-picker-offline.png', ['--render-editors', 'folder-picker', origin, 'bot-one'], 'memberfolder-offline'],
      ['pr16b-folder-picker-windows.png', ['--render-editors', 'folder-picker', origin, 'bot-one'], 'memberfolder-windows'], ['pr16b-folder-picker-unsupported.png', ['--render-editors', 'folder-picker', origin, 'bot-one'], 'memberfolder-unsupported']]
    // [file, render args, mock scene]: 「このPCを追加」 and 「このPCを確かめる」 (PR 16c). Every request is a GET; the PC's facts are the render's, the fixture PC is marked as tried so no trust request is sent, and the attested screen is the terminal as the server answers after trusting.
    const thisPcFrames = [['pr16c-editor-this-pc.png', ['--render-terminals', 'editor-this-pc', origin], 'terminals-list'], ['pr16c-editor-this-pc-refused.png', ['--render-terminals', 'editor-this-pc-refused', origin], 'terminals-list'],
      ['pr16c-detail-this-pc.png', ['--render-terminals', 'detail-this-pc', origin], 'terminals-thispc'], ['pr16c-detail-this-pc-attested.png', ['--render-terminals', 'detail-this-pc-attested', origin], 'terminals-thispc-trusted'],
      ['pr16c-detail-this-pc-mismatch.png', ['--render-terminals', 'detail-this-pc-mismatch', origin], 'terminals-thispc']]
    // [file, render args, mock scene]: 稼働中に数えない処理 (a65).
    const exclusionFrames = ['list', 'empty', 'old', 'unavailable'].map(kind => [`a65-exclusions-${kind}.png`, ['--render-page', 'settings-exclusions', origin], `exclusions-${kind}`])
    const selectedFrames = process.argv[4] === 'exclusions' ? exclusionFrames : process.argv[4] === 'thispc' ? thisPcFrames : process.argv[4] === 'memberfolder' ? memberFolderFrames : process.argv[4] === 'terminals' ? terminalFrames : process.argv[4] === 'onepassword' ? onePasswordFrames : process.argv[4] === 'secret' ? secretFrames : process.argv[4] === 'memberstate' ? memberStateFrames : process.argv[4] === 'workgraph' ? workGraphFrames : process.argv[4] === 'accounts' ? accountFrames : process.argv[4] === 'polish' ? polishFrames : process.argv[4] === 'startup' ? startupFrames.map(([name, scene]) => [name, ['--render-startup', scene, origin], `startup-${scene}`]) : process.argv[4] === 'schedules' ? scheduleFrames.map(([name, scene]) => [name, ['--render-schedules', scene, origin], ['empty', 'failed'].includes(scene) ? `schedules-${scene}` : 'schedules-list']) : process.argv[4] === 'editors' ? editorFrames.map(([name, scene, id]) => [name, ['--render-editors', scene, origin, id]]) : process.argv[4] === 'goals' ? goalFrames.map(([name, kind, scene, id]) => [name, kind === 'page' ? ['--render-page', 'goals', origin] : ['--render-goals', kind, origin, id], `goals-${scene}`]) : process.argv[4] === 'screen' ? screenFrames.map(([name, scene]) => [name, ['--render-screen', scene, origin, 'bot-one'], `screen-${scene}`]) : process.argv[4] === 'inspector' ? inspectorFrames.map(([name, scene, id]) => [name, ['--render-inspector', scene, origin, id], `inspector-${scene}`]) : process.argv[4] === 'conversation' ?conversationFrames.map(([name, scene, id]) => [name, ['--render-conversation', scene, origin, id], scene]) : process.argv[4] === 'summary' ? [['summary.png', ['--render-url', origin, 'bot-one']]] : process.argv[4] === 'settings' ? settingsPages.map(page => [`settings-${page}.png`, ['--render-page', `settings-${page}`, origin]]) : process.argv[4] === 'gallery' ? frames.filter(([name]) => name === '09-gallery.png') : process.argv[4] === 'updates' ? [['update.png', ['--render-page', 'updates', origin]], ['update-current.png', ['--render-page', 'updates-current', origin]], ['update-narrow.png', ['--render-page', 'updates-narrow', origin]], ['update-detail-narrow.png', ['--render-page', 'updates-detail-narrow', origin]], ['update-sheet.png', ['--render-page', 'update-sheet', origin]], ['update-waiting.png', ['--render-page', 'updates-current', origin]]] : frames
    for (const [name, args, scene] of selectedFrames) {
      conversationScene = scene ?? 'default'
      if (name === '07-settings-cloudflare.png') routes['/api/session'].authMode = 'cloudflare'
      if (name === '09-gallery.png' || name === 'polish-gallery.png') gallery = true
      if (name.startsWith('update')) routes['/api/updates'] = updateFixture(['update-current.png', 'update-waiting.png'].includes(name) ? 'update-center-current' : 'update-center-mixed')
      if (name === 'update-detail-narrow.png') routes['/api/updates'].components[0].current.version = 'a'.repeat(180)
      // W-MAC 18: the rest is current and one part has no version for this body yet (Mac Status.waiting).
      if (name === 'update-waiting.png') { const part = structuredClone(routes['/api/updates'].components[0]); part.id = 'notifications'; part.name = '通知'; part.comparison.state = 'incompatible'; routes['/api/updates'].components.push(part) }
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
