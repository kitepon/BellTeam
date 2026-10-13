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
const schedules = {
  'bot-one': [{ id: 'morning', name: '朝の確認', prompt: '今日の予定と優先事項を整理する', kind: 'cron', expression: '0 9 * * *', timezone: 'Asia/Tokyo', nextRunAt: '2026-10-14T00:00:00Z', enabled: true }],
  planning: [{ id: 'weekly', name: '週のふり返り', prompt: '進んだ仕事をまとめる', kind: 'cron', expression: '0 19 * * 5', timezone: 'Asia/Tokyo', nextRunAt: '2026-10-16T10:00:00Z', enabled: true }]
}
const feature = (id, title) => ({ id, title, enabled: true, status: 'enabled', fields: [] })
const routes = { '/api/session': { authenticated: true, authMode: 'local' }, '/api/bots': { bots: fixture.bots }, '/api/rooms': { rooms: fixture.rooms }, '/api/models': { models }, '/api/owner': { owner: fixture.owner }, '/api/user-rules': { text: 'チーム全員へ共有する指示。' }, '/api/settings': { settings: [feature('routing','AIによるルーム応答の振り分け'),feature('callBridge','メンバー間の連携'),feature('notifications','通知')] }, '/api/queue': { items: Array.from({ length: 12 }, (_, index) => ({ id: `job-${index}`, botId: 'bot-one', botName: 'ユキ', status: 'running', context: 'direct', contextId: 'bot-one' })) } }
let writes = 0
let gallery = false
const galleryAssets = { '/api/message-images/demo/one.png': 'ios/BellBot/BellBot/Assets.xcassets/AppIcon.appiconset/bellbot-icon.png', '/api/message-images/demo/two.png': 'docs/assets/mac-ui-reference-48/01-workspace.png' }
routes['/api/harness-auth'] = { harnesses: [{ id: 'codex', name: 'Codex', members: 2, startWarning: 'Codexは、認証し直しを始めた時点で今の認証が消えます。' }, { id: 'claude', name: 'Claude', members: 1, startWarning: null }] }
routes['/api/harness-auth/codex'] = { harness: 'codex', auth: { status: 'waiting', url: 'https://example.com/login', user_code: 'TEST-CODE', input_required: false, message: '公式サイトで認証してください。' } }
routes['/api/setup'] = { phase: 'select_harness', harness: null, harnesses: [{ id: 'codex', name: 'Codex' }, { id: 'claude', name: 'Claude' }, { id: 'grok', name: 'Grok' }, { id: 'cursor', name: 'Cursor' }], guideBotId: null, complete: false, auth: null }
const server = createServer((request, response) => {
  if (request.method !== 'GET') { writes++; response.writeHead(405); response.end(); return }
  const path = new URL(request.url, 'http://localhost').pathname
  if (galleryAssets[path]) { response.writeHead(200, { 'content-type': 'image/png' }); response.end(readFileSync(galleryAssets[path])); return }
  let value = routes[path]
  const chat = path.match(/^\/api\/(bots|rooms)\/([^/]+)(?:\/(messages|schedules))?$/)
  if (chat) { const [, kind, id, action] = chat; value = action === 'messages' ? { items: gallery ? [...messages, { id: 'gallery', at: '2026-10-13T09:03:00Z', direction: 'incoming', kind: 'message', image: true, image_urls: Object.keys(galleryAssets) }] : messages, has_more: false } : action === 'schedules' ? { schedules: schedules[id] ?? [] } : kind === 'bots' ? { bot: fixture.bots.find(bot => bot.id === id) } : { room: fixture.rooms.find(room => room.id === id) } }
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
      ['07-settings-cloudflare.png', ['--render-page', 'settings', origin]],
      ['08-settings-lower.png', ['--render-page', 'settings-lower', origin]],
      ['09-gallery.png', ['--render-gallery', origin, 'bot-one']]
    ]
    if (process.argv[4] && process.argv[4] !== 'gallery') throw new Error('WINDOWS_RENDER_SCENE_UNKNOWN')
    const selectedFrames = process.argv[4] === 'gallery' ? frames.filter(([name]) => name === '09-gallery.png') : frames
    for (const [name, args] of selectedFrames) {
      if (name === '07-settings-cloudflare.png') routes['/api/session'].authMode = 'cloudflare'
      if (name === '09-gallery.png') gallery = true
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
