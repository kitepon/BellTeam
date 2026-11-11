// 会話画像・Mac添付の有限fixture。実Bot・購読・資格情報へは接続しない。
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../../ios/BellBot/BellBot/Core/PreviewFixtures.swift', import.meta.url), 'utf8')
const preview = JSON.parse(source.match(/let source = """\n([\s\S]*?)\n\s*"""/u)[1])
// BellPortraitから縮小した48×32のPNG/JPEG。外部画像・変換コマンドへの実行時依存を持たない。
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAADAAAAAgCAIAAADbtmxLAAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAARGVYSWZNTQAqAAAACAABh2kABAAAAAEAAAAaAAAAAAADoAEAAwAAAAEAAQAAoAIABAAAAAEAAAAwoAMABAAAAAEAAAAgAAAAALvX+44AAAHLaVRYdFhNTDpjb20uYWRvYmUueG1wAAAAAAA8eDp4bXBtZXRhIHhtbG5zOng9ImFkb2JlOm5zOm1ldGEvIiB4OnhtcHRrPSJYTVAgQ29yZSA2LjAuMCI+CiAgIDxyZGY6UkRGIHhtbG5zOnJkZj0iaHR0cDovL3d3dy53My5vcmcvMTk5OS8wMi8yMi1yZGYtc3ludGF4LW5zIyI+CiAgICAgIDxyZGY6RGVzY3JpcHRpb24gcmRmOmFib3V0PSIiCiAgICAgICAgICAgIHhtbG5zOmV4aWY9Imh0dHA6Ly9ucy5hZG9iZS5jb20vZXhpZi8xLjAvIj4KICAgICAgICAgPGV4aWY6Q29sb3JTcGFjZT4xPC9leGlmOkNvbG9yU3BhY2U+CiAgICAgICAgIDxleGlmOlBpeGVsWERpbWVuc2lvbj41MTI8L2V4aWY6UGl4ZWxYRGltZW5zaW9uPgogICAgICAgICA8ZXhpZjpQaXhlbFlEaW1lbnNpb24+NTEyPC9leGlmOlBpeGVsWURpbWVuc2lvbj4KICAgICAgPC9yZGY6RGVzY3JpcHRpb24+CiAgIDwvcmRmOlJERj4KPC94OnhtcG1ldGE+CgCF4JgAAA+JSURBVFgJJVhZjFvneb37vvBy34ec4eyjkTSSbFmLZcV2YjeJ44c2gFMUKAq0aB0gKNCnog3Qp74W6FuBIg9F2qJF2jgonBauEu+WLdkaSbNryOEMh8Pl8pK8vJd33/qPShAELpf/fv//nXO+cwgfKMe2OQ0DCIaQKAq8wCdJctjpea5rjHRZR/fi5XqgoN/asAM3uP/E2W0iDB3wFFubJXZOOSlpjAehOfVHevLaDTzBWqfHkNwtXb09POm0nx3rsRLNMpOv76FQWLj5jqFbg49+eXW+dImHtXBIsuKL37pGMazvu0gUohgCy62twPcjCIqiyPd8z/E0Vfd9X1XGtmlMp3YEF8iZlB0f3EdTT2QLebpXZVma42bmy8n+KOFEeJIzxiNLsyGCJ+lQYtAgwA2fUNqjbt8eY4Wd0Y7rtBF46fWrUomI9IMxFhqqf7RyeXVhdd6YmpPhGEMxPsZLSQmDYTgCxUBQGAbg4doOHIW+7ZhTQz6TOVS5dQtiEwHS+yyt3y0ROT4hlUSKY9GYOxRqEsXRCIoEvnC4tW8ZvUwyKyREVuDAYu4iaaiWNjTqDXqgXsCkS6+Q/1q9kgxuzu5+ddS3yzRNbz98SpFkvlpKZpMkTUAQhJE05wUqAkUoRhAkyXAMOKfpxDB0E0VRDNQpP3jv3/ZwikoVy+uiTsVRLkYKiRjNsRiBwxAU+MHUMG036JwNNN0qVYo5HMcpAmfppMCLGZuJw616x1O/aLVbm5v/PVvNZIuV1oif6h2aZVlRcB3n+OAoDEMIhrEIgh3LnYxVCyw6tTCc4HiahIaLF4u1tTJFBfbBLyFU0tD5dFqqrc3RLA2jCIzAYRCBosGvhr3BeKROxprtOKRPdVrdyUQr12YESQiRECPJdLmQLOYs3Xj0qdxrm2nbExZfvL1RMyeu2js+3NlD6TgnsHxMpBgS/b3vvuHYNgojCIJGMGTZ1nikW+2HObKeqWRCtZGjT0MsFcWvzK3OczEBfA+01TZs27QDz7dMcOHqqp6fKVTnq65lr11ZdyxHUzUABhzHwiDEcCwKI9d03RDslv/OCxEeaXy2QBs7dnfTISq52dl0PpPKp+KZBKz2n/U7/dPm6Ugegu36fmCatjnuvbKu4Rz64MPdYl5MpZNn6I3K0ko8EXNsCyMJcJDgfuPBOAgDkiSiMEzmUuCdp19uZkqFTCHne96z7X2KIkChYRjBMAJgqul27/GvRfvx/uGIEamrG4V7960xskRRGMPQJE7gNI7evrTx5OFjdaB6jqvrutztkngoZUvTifz4/qGDSDZRYmeurVy9CrYLBVAsmUAwFNzbNAwAuHhKIiiC4dgQAs2HcJwgKRIncRiBwKf7T/cBcrPFvO+FjmXG4jyM08f9SB6Fvc6439PxzEIYUcP2iW0HYE3P8dFbFy9RFAmIpchKELLzucVXXxi9+ObtJ599Phzqy3f+YH79Wm39MmgNRXPl+UUUxz3PcSyL5XgUBww/XwhIxjlTwdo0DQNBw4CmhARF+n7YqrdSuWy+UjF1w3PtVLHECqVkeUXVzMb2/TvfffPV2xlvYPnR7EhVPMcAGHoTrK+qHnTphnrjuq27WePJ1sN7nfaYT1VzlRVeYOV2jwHCszAfnkunNxwMMBwXYnEAPAzDfC8I/YDASQAviuXAQQF60gwHnqlcvt1ourYlpVKJTMazXWtq9FvdbDV31ji1p/2z+iZhn+nhwva1l61YjDICDNwgYPLj3PIupVkplCoR5qNiNX5t+XpJVTs0SY+6Ez7BJHIpXRu5tq2OhhhKoAhOczwDCWHgd463SrVZlmEBzmmGAYgWpcQ5yJBzhUNJXOkPmgf7lfkqxVKtRpMWKQyFODE7N/+nDm59cnYgF9gt/pQtly6vrmC8uN6YX9yS5X7zGCpgaFG8py3dKcxVbBaWuxASKt1+7dL1MPTMqaVrOobi2ljjRdH3XBzDm8+egU0DoACGAmnV1cngrBdPp0ETbcNwHHvQ7gES7D3ZBcQGqEoXU+CAR32FY7hhgLQ48jf0OppPSEKuOnOlzGHo4p/8JLmYWZ3LPzrreHhEJmOONhIVJTX2osGESRNSTsrNFIBwO5ZNkdRpoxVPJYDu+a49lOXWYbNcK5+rPCjQtpq7dQS0jETAfHQdu99sQSdDIAxT1wVimc6nQYtVRTUME7VJW4cOYf0Infgcm0rWNBh7Bnso8/L1PdVpQpLpYsV8psaTlZVr6FlM6J0Jrqc7w5UX1oGoAAYB1O4/2UvnMpzIAx4Zuv704ZPq0hzDM6Agy5h22z1VHmUq2TAKgXQCvPe/3nnhe6+JDHt0cGiFfnW+AiQAnO5kNDGbjh9ijSzX5yPDGyMZwfWV0BghLXmonHZjMSydLXHsXJQvYzScvCTBAgWhaDybch0PFNM5bm/efyRKIozCQOJ79db99z4UJQHIMZDHoTzotrut3cNsNQ/OAwE6Hoaj+knl4looMJkLC8VsRgEOAgipYYJu8izru37I0qaqIDjE5Yrzi6tphncO6ugrf/vTsWakCymxErXa/bbcmqFo4elh2Xcp3iY47KzZah0eg/FCMbSjm75maWf9k+16slaKZzPGaHJy2HQMxzxsp/JZhKFIghwq497xiRBPiKU8gWFsXErE41tfP5pdX/Ed13XcZCFtueZA9zcpS8HC4vJaPJuDIMT2QnTm7bcsS/GdKVMr5CSsYFh+KoaR7IxBFpKIrPSAgoPNTIdjxnDPduvQcGJCwak+jFGMPVDVVk8QhFwiHSAQxDHWVJdbHZGkctlct9fvNptqp3u4tSslU+ZYS5QygJW2ASYmhpIRAfuREaJhpI4UMF9GB0ekPIR/9vBrl4Ys30LiyYwoPRj1SDR50+LSnR0pHgK9Zxjm6KD5/j/9AjIdtpDOVxd2mwqMhFH/7PJM/rU//KGYTz/44KNBfyAmpUQiMbe+0vj86/f+5+MpyaoD++JaEbKG4JgpivrOj95CUMi1vHy50N1qGrA4saYnNFln8oxGJo2jG5KAfHa492qh8ucXb72bmzMc71TIADrjzWYqjtZ36hiMYQRGUTgLI5Xa7E/++q9OOs72bqPfVeoqGtCZWCYJiLN4YeXmKzdvv35347WXwdCuH8kHHUsfWfVnZ99sdt9598c3b7/smx4vSVEIZUo5oBCOEzQL1Y/jsQ/b7eRIfdmRfwgz5bGDzeJgensnhmV7Rg0lir6R0sMCYQ3ag0FbXltfg0MEwPYHv/sW4nmUGFtafxn3cnKnjQrOnd9/mxJ5yA+yc5XnNAxD10VQ9O47b39Zj1zFfuOla8WL81w8XY4n+R98W0yIk4ESi0vDZsd00W1jsNuXlxz6DQ8pO35T09y0BP/0/V8BxUkx6SPYBBN7nmbj2/JLSLjfbsMEtHh5luTpg60d3vaXVxY0y/GZrK2SRgRzOWKmTECeC2weeJyPMzDGzv0nmGXoeAT1WjYX+RhlU54yVhQolwRwxDEiW8juPGp0KotfidBof/9HKrmI8vcJv5fEinqARnO3XF/YNQ07TjX7Y/K49xrEkRMXpVOhM42Lgm95rulozeNcpQAcIhHonOBkS4SUxKEgjBAghHDkepEXgBkLoQDbMBxGNO7FWYNEJlRoIjgaEdy4PdR743Kx4vTN3tDXZ6pjFptFmSunxm9nhF8JKh9Flc+bWOHOCoOkVAlDS2lBV2P7bazntodaAxtxrr5q4fJgRBBMz0V6sjKzOBcA0SNJ5Lnngp5XA8pyNR3l+Sg4p8z5CAPGFpQFPLEoBEHk9Gxl50jtDqqLS+GJqarq6WhMfXx/mUAzCG62BuxMbJ5gF9pmbgpjGjx91thjSwWKQbMoVsRJY9j3EkRqoTD+ZAsae6jm4zSqEtmvdnu5pTk6mQTOBwJsQVHQJpjAwSXKc8Fz4wbT1Hn7XB9C4YhADFWdNgb97bo+MFdXNvTTCZhrh+NJYrZAMyACGINWl9L02vuPq+Uc4kcE8AnM+pUg8qzW8UuFWGw05A6HoePSAs4WEt2ToaR6LEw4+nSCQQMPkxvNylweF4VzxDwHzqNf3+s2jiPPQ3B8Op7sf/rF9ucPSgs1hMC0nqJ3FYyOvBO1lluVW2c0RJy6WlcgSJaWMowg8R6Gd7VJyoGwnkJMpud7++Mf/xlsmOlYbbvVSRjujIvzpawmD3CCzdcKcuNklkl2T89AB3SeMjyisbmdjjN8NnUOYBTpHJ1uf/U0/Ozzyebj0cNvjnpjcWZm9sIS8EY0MPmhO35wkvRz3XabhBCQxyYL0vLVJTiEpiMLmJN4StBML7y1FrtQNFJCWMzAQ9/54rj5s836SG3dqCwv19XK8kwEu7VSMV8ttPaPp7/Y9OGwpQ3cYiq5OtvvDLXT02o2ePH1O2wmDfbUO2hoe/voQPY5Xrywnl2oQjhmjiZ7Hz1QdhU64umRI3KCIkLsncXaxgJQNRAo9Im5/fQQJOb607p+Z11ZSRCe95pLoNqtqw8OD2QOTt5dvZDOU/sDICScRCfTCZZhxFRMi9xwXw5mE1iMdsMwVZBixeL9D98//uw/CQejeTFRLQjpFF0qxRfnYtUiyFKP/uuDj//95/X2KF69gJwMKIya1sT8WxsLlxdwFIALoCwEaUJWhiNFcww3WCw9oDERpb7Pi6ixtqY0e3Oa+Ufx8g2LxNRh47jHxhJuYOvjqTW1KpfnLQq2npzN3lxb2FgAcULTp0KqMlR2p73He7/9YtpXCSFGSYI5mW5/8OFvfv6Pz/bu6a4ax9bjOpRem4l/7+LctzeEGB/5IL2jw96w3ZIH40m/q3X2j2YlSoqw3MBgXaQBKPrmX/7NBi78zvULq0sVRmSQ0Pvmq4PdusqnE2KGoylyY2MZvE5ltbd/LM5mGVGYjPXWsWwZ1snBJ4PGR7gzriaXUDttQsrR8KlLsExyYzZ9LZGIz15fLCyUgQgAA3dOTSDnUPR482A0ntqWN2y2Z1PI9bsbGMtNlclBo18PKfhf/uGf715fyS4WIfCPAximCAgNsCoPv/xoaxgQQloq5jKlcnqqm6LE8xwDQINhSBBFwCeNNb2x3/j0P/5+o2ZPjhKB2DmUoZe+/xfLl9bEGM/QFJAkED9ALLEMu9sZMCytjqbt3kDpDgRXe/FaLVUtgeh0/h0gaVE4HWmw1dyjsikwj8CdgKCd+3LwiqKO45w0esPD9tE4ws8jBIER6Mp6OZfLAM6fp3rkPP64rr+3c7T/v38X6HWpMB9ff3fj2jIYtyCXAXN4HkiiwDLN7UcNExzJQAOakiK84gowDUWWZ/5f30GOfH5258Pn/wAJzsEY0cWVLwAAAABJRU5ErkJggg==', 'base64')
const jpeg = Buffer.from('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', 'base64')
const assets = new Map([
  ['/api/images/pr3-one.png', { data: png, type: 'image/png' }],
  ['/api/images/pr3-two.jpg', { data: jpeg, type: 'image/jpeg' }],
  ['/api/images/pr3-three.png', { data: png, type: 'image/png' }],
])
const paths = [...assets.keys()]
const message = (id, fields) => ({ id, kind: 'message', direction: 'outgoing',
  sender: { id: 'user', name: '利用者' }, at: '2026-11-03T00:00:00Z', delivery: 'delivered', ...fields })
const histories = new Map([
  ['/api/bots/bot-one/messages', [message('sent-many', { image: true, imageCount: 3, imageUrls: paths })]],
  ['/api/rooms/planning/messages', [message('sent-many', { image: true, imageCount: 2, imageUrls: paths.slice(0, 2) })]],
  ['/api/bots/bot-two/messages', [
    message('legacy-one', { image: true, imageUrl: paths[1] }),
    message('unsaved-two', { image: true, imageCount: 2 }),
  ]],
])
// fork mode: direct rows of a read-only fork inquiry (conversation fork-inquiry.md "Records and display") among main rows,
// plus a malformed and an unknown-kind seat that must render as main rows.
const incoming = (id, fields) => ({ id, kind: 'message', direction: 'incoming', at: '2026-11-10T00:00:00Z', delivery: 'delivered', ...fields })
const fork = { kind: 'fork', fork_id: 'fork-1' }
const forkHistories = new Map([['/api/bots/bot-one/messages', [
  message('main-q', { message: '今朝の状況を教えて' }),
  incoming('main-a', { message: 'いま実装を進めています。' }),
  incoming('fork-inquiry', { sender: { id: 'bot-two', name: 'ハル' }, seat: fork, message: 'いまの進捗を一言で教えて' }),
  incoming('fork-interim', { seat: fork, message: '確認しています。' }),
  incoming('fork-answer', { seat: fork, message: '実装は7割です。残りはテストです。' }),
  message('fork-relay', { seat: fork, in_reply_to: 'fork-inquiry', message: 'ハルへ: 実装は7割です。' }),
  incoming('main-next', { message: '続けます。' }),
  incoming('bad-seat-type', { seat: 'bogus', message: 'seatが文字列の行（通常の行として表示）' }),
  incoming('unknown-kind', { seat: { kind: 'future' }, message: '未知のkindの行（通常の行として表示）' }),
]]])
let mode = 'images', failImages = false, holdSend = false
let reads = [], sends = [], diagnostics = [], heldSends = []
const subscribers = new Set()
const json = (response, value, status = 200) => {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}
const sendFailure = response => json(response, { error: 'IMAGE_SEND_FIXTURE_FAILED' }, 503)
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  const path = url.pathname
  if (path === '/test/reset') {
    const nextMode = url.searchParams.get('mode') ?? 'images'
    if (!['images', 'attachments', 'fork'].includes(nextMode)) return json(response, { error: 'UNKNOWN_MODE' }, 400)
    for (const held of heldSends) sendFailure(held)
    for (const subscriber of subscribers) subscriber.end()
    subscribers.clear()
    mode = nextMode; failImages = url.searchParams.get('failImages') === '1'
    holdSend = url.searchParams.get('holdSend') === '1'
    reads = []; sends = []; diagnostics = []; heldSends = []
    return json(response, { ok: true })
  }
  if (path === '/test/proof') return json(response, { mode, failImages, reads, sends, diagnostics, heldSends: heldSends.length })
  if (path === '/test/release-send') {
    holdSend = false
    const released = heldSends.length
    for (const held of heldSends) sendFailure(held)
    heldSends = []
    return json(response, { released })
  }
  if (path === '/api/events' && request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    response.write('event: ready\ndata: {}\n\n')
    subscribers.add(response)
    request.on('close', () => subscribers.delete(response))
    return
  }
  if (request.method === 'POST' && (histories.has(path) || path === '/api/diagnostics')) {
    let body = ''
    for await (const chunk of request) body += chunk
    let parsed
    try { parsed = JSON.parse(body) }
    catch { return json(response, { error: 'INVALID_JSON' }, 400) }
    const entry = { method: request.method, path, body: parsed }
    if (path === '/api/diagnostics') {
      diagnostics.push(entry)
      return json(response, { ok: true }, 202)
    }
    sends.push(entry)
    if (holdSend) {
      heldSends.push(response)
      response.on('close', () => { heldSends = heldSends.filter(held => held !== response) })
      return
    }
    return sendFailure(response)
  }
  if (request.method !== 'GET') return json(response, { error: 'METHOD_NOT_ALLOWED' }, 405)
  if (assets.has(path)) {
    const asset = assets.get(path)
    reads.push({ method: 'GET', path, status: failImages ? 503 : 200, contentType: failImages ? 'application/json' : asset.type })
    if (failImages) return json(response, { error: 'IMAGE_GET_FIXTURE_FAILED' }, 503)
    response.writeHead(200, { 'content-type': asset.type, 'content-length': asset.data.length, 'cache-control': 'no-store' })
    return response.end(asset.data)
  }
  if (histories.has(path)) {
    reads.push({ method: 'GET', path, query: url.search })
    const items = mode === 'attachments' ? [] : mode === 'fork' && forkHistories.has(path) ? forkHistories.get(path) : histories.get(path)
    // 全件が初回limit=10以内。before/afterは既に返したID以降/以前だけを返す。
    const before = items.findIndex(item => item.id === url.searchParams.get('before'))
    const after = items.findIndex(item => item.id === url.searchParams.get('after'))
    return json(response, { items: before >= 0 ? items.slice(0, before) : after >= 0 ? items.slice(after + 1) : items,
      has_more: false, remaining_before: 0 })
  }
  if (path === '/api/bots') return json(response, { bots: preview.bots })
  if (path === '/api/rooms') return json(response, { rooms: preview.rooms })
  if (path === '/api/owner') return json(response, { owner: preview.owner })
  if (path === '/api/subscription') return json(response, { subscription: {
    productId: 'dev.kitepon.bellbot.monthly', environment: 'Production', accessMode: 'developer',
    setupComplete: true, entitled: false, state: 'none', autoRenewing: false,
  } })
  if (path === '/api/settings') return json(response, { settings: [] })
  if (path === '/api/harness-auth') return json(response, { harnesses: [] })
  if (path === '/api/goals') return json(response, { goals: [] })
  if (path === '/api/queue' || /^\/api\/(bots|rooms)\/[^/]+\/queue$/u.test(path)) return json(response, { items: [] })
  return json(response, { error: 'NOT_FOUND' }, 404)
})
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` })))
