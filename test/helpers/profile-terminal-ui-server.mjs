import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

const previewSource = await readFile(new URL('../../ios/BellBot/BellBot/Core/PreviewFixtures.swift', import.meta.url), 'utf8')
const preview = JSON.parse(previewSource.match(/let source = """\n([\s\S]*?)\n\s*"""/u)[1])
const portrait = await readFile(new URL('../../ios/BellBot/BellBot/Assets.xcassets/BellPortrait.imageset/bell-portrait.png', import.meta.url))
const portraitURL = `data:image/png;base64,${portrait.toString('base64')}`
const version = image => image ? createHash('sha256').update(image).digest('hex').slice(0, 16) : ''
const initialProfile = () => ({
  ...preview.bots[0], avatar: portraitURL, avatarLarge: portraitURL,
  avatarSource: portraitURL, avatarCrop: { x: 0, y: 0, width: 1, height: 1 },
  avatarLargeSource: portraitURL, avatarLargeCrop: { x: 0, y: 0.25, width: 1, height: 0.5 },
  profileText: '人工プロフィールの本文', position: '設計担当', role: 'UIを確認する',
})
let profile = initialProfile()
let screen = '履歴の最初の行\n履歴の次の行'
let reads = []
let writes = []
let legacyProfile = false
let profileDelayMs = 0
const json = (response, value, status = 200) => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}
const listBot = () => ({
  ...profile, avatar: '', avatarVersion: version(profile.avatar),
  avatarLarge: '', avatarLargeVersion: version(profile.avatarLarge || profile.avatar),
  avatarSource: '', avatarSourceVersion: version(profile.avatarSource || ''),
  avatarLargeSource: '', avatarLargeSourceVersion: version(profile.avatarLargeSource || ''),
})
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  if (url.pathname === '/test/reset') {
    profile = initialProfile(); screen = '履歴の最初の行\n履歴の次の行'; reads = []; writes = []
    legacyProfile = false; profileDelayMs = 0
    return json(response, { ok: true })
  }
  if (url.pathname === '/test/long-history') {
    screen = Array.from({ length: 10_000 }, (_, index) => `保持行${index + 1}`).join('\n')
    return json(response, { ok: true })
  }
  if (url.pathname === '/test/legacy-profile') { legacyProfile = true; return json(response, { ok: true }) }
  if (url.pathname === '/test/delay-profile') {
    profileDelayMs = Number(url.searchParams.get('ms') || 0)
    return json(response, { ok: true })
  }
  if (url.pathname === '/test/proof') return json(response, { reads, writes, screen })
  if (url.pathname === '/test/screen') {
    screen = url.searchParams.get('value') ?? screen
    return json(response, { ok: true })
  }
  if (url.pathname === '/test/append-screen') {
    screen += '\n追加された一行'
    return json(response, { ok: true })
  }
  if (url.pathname === '/api/models') return json(response, { models: {
    claude: { efforts: ['high'], models: [{ id: 'opus', efforts: ['high'], fast: true }], defaultModel: 'opus' },
    codex: { efforts: ['high'], models: [], defaultModel: null },
  } })
  if (url.pathname === '/api/bots') {
    const bot = listBot()
    if (legacyProfile) {
      for (const key of ['avatarLarge', 'avatarLargeVersion', 'avatarSource', 'avatarSourceVersion',
        'avatarCrop', 'avatarLargeSource', 'avatarLargeSourceVersion', 'avatarLargeCrop']) delete bot[key]
    }
    return json(response, { bots: [bot, ...preview.bots.slice(1)] })
  }
  if (url.pathname === '/api/rooms') return json(response, { rooms: preview.rooms })
  if (url.pathname === '/api/owner') return json(response, { owner: preview.owner })
  if (url.pathname === '/api/queue' || url.pathname.endsWith('/queue')) return json(response, { items: [] })
  if (url.pathname.endsWith('/messages') || url.pathname.endsWith('/timeline'))
    return json(response, { messages: [], items: [], hasMore: false })
  if (url.pathname === '/api/bots/bot-one/screen') {
    reads.push({ path: url.pathname, history: url.searchParams.get('history'), at: Date.now() })
    return json(response, { online: true, screen })
  }
  const imageField = new Map([
    ['/api/bots/bot-one/avatar', 'avatar'],
    ['/api/bots/bot-one/avatar-large', 'avatarLarge'],
    ['/api/bots/bot-one/avatar-source', 'avatarSource'],
    ['/api/bots/bot-one/avatar-large-source', 'avatarLargeSource'],
  ]).get(url.pathname)
  if (imageField && request.method === 'GET') {
    reads.push({ path: url.pathname, at: Date.now() })
    const image = profile[imageField] || (imageField === 'avatarLarge' ? profile.avatar : '')
    if (!image) return json(response, { error: 'AVATAR_NOT_FOUND' }, 404)
    const [, type, base64] = image.match(/^data:(image\/(?:png|jpeg));base64,(.+)$/u)
    const body = Buffer.from(base64, 'base64')
    response.writeHead(200, { 'content-type': type, 'content-length': body.length })
    return response.end(body)
  }
  if (url.pathname === '/api/bots/bot-one' && request.method === 'GET') {
    reads.push({ path: url.pathname, at: Date.now() })
    if (profileDelayMs) await new Promise(resolve => setTimeout(resolve, profileDelayMs))
    const bot = { ...profile }
    if (legacyProfile) {
      for (const key of ['avatarLarge', 'avatarSource', 'avatarCrop', 'avatarLargeSource', 'avatarLargeCrop']) delete bot[key]
    }
    return json(response, { bot })
  }
  if (url.pathname === '/api/bots/bot-one' && request.method === 'PATCH') {
    let body = ''
    for await (const part of request) body += part
    const changes = JSON.parse(body)
    writes.push({ keys: Object.keys(changes).sort(), small: Object.hasOwn(changes, 'avatar'),
      large: Object.hasOwn(changes, 'avatarLarge'), smallCrop: changes.avatarCrop,
      largeCrop: changes.avatarLargeCrop })
    profile = { ...profile, ...changes }
    return json(response, { ok: true })
  }
  return json(response, { error: 'NOT_FOUND' }, 404)
})
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` })))
