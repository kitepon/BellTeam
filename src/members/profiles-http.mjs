import { readCurrentWork } from '../current-work-contract.mjs'
import { json, readJson } from '../http-response.mjs'
import { recentTimeline } from '../timeline-index.mjs'
import { avatarVersion, sendAvatar } from '../http-assets.mjs'

export function createMemberProfileApi({ bots, transport, administration, memory, characterSheets, sources, store }) {
  const readMember = id => bots.readMember ? bots.readMember(id) : bots.get(id)
  return async (request, response, url) => {
    if (request.method === 'GET' && url.pathname === '/api/bots') {
      const omitAvatars = url.searchParams.get('avatar') === 'omit'
      const all = bots.listForClient ? await bots.listForClient({ omitAvatars }) : [...bots.values()]
      const listingState = id => bots.clientListingState?.(id)
        ?? (bots.isDeleting?.(id) ? 'pending' : bots.has(id) ? 'active' : 'absent')
      const deleting = bot => bot.deleting || listingState(bot.id) === 'pending'
      const [running, views] = await Promise.all([
        transport.runningBots(all.filter(bot => !deleting(bot) && listingState(bot.id) === 'active')),
        store.recentViews ? store.recentViews(all.map(bot => bot.id)) : store.timelineViews?.(all.map(bot => bot.id)),
      ])
      const list = await Promise.all(all.map(async bot => {
        const last = recentTimeline(await sources('bots', bot.id, views?.get(bot.id)))
        const view = administration.view?.(bot)
        const application = view?.configurationApplication
        const avatars = {}
        for (const field of ['avatar', 'avatarLarge', 'avatarSource', 'avatarLargeSource']) {
          avatars[field] = omitAvatars ? '' : bot[field] ?? ''
          avatars[`${field}Version`] = omitAvatars && bot[`${field}Version`] !== undefined ? bot[`${field}Version`]
            : avatarVersion(field === 'avatarLarge' ? bot[field] || bot.avatar : bot[field])
        }
        return {
          id: bot.id,
          name: bot.name ?? bot.displayName ?? bot.id,
          displayName: bot.displayName ?? bot.id,
          harness: bot.harness,
          model: bot.model ?? '',
          reasoningEffort: bot.reasoningEffort ?? '',
          fastMode: bot.fastMode === true,
          color: bot.color ?? 'violet',
          profileText: bot.profileText ?? '',
          personality: bot.personality ?? '',
          speechStyle: bot.speechStyle ?? '',
          position: bot.position ?? '',
          role: bot.role ?? '',
          ...avatars,
          avatarCrop: bot.avatarCrop ?? null,
          avatarLargeCrop: bot.avatarLargeCrop ?? null,
          online: !deleting(bot) && running.has(bot.id),
          ...(deleting(bot) ? { deleting: true } : {}),
          recent: last && { id: last.id, kind: last.kind, direction: last.direction, message: last.message, image: last.image, at: last.at },
          ...(application ? { configurationApplication: application } : {}),
          ...(view?.automaticConfigurationApplication ? { automaticConfigurationApplication: view.automaticConfigurationApplication } : {}),
        }
      }))
      // Serialize only the current listing state after all asynchronous timeline reads.
      const current = []
      for (const item of list) {
        const state = listingState(item.id)
        if (state === 'absent') continue
        if (state === 'pending') { item.deleting = true; item.online = false }
        item.currentWork = readCurrentWork(transport, state === 'active' ? bots.get(item.id) : null)
        current.push(item)
      }
      return json(response, 200, { bots: current })
    }
    if (request.method === 'POST' && url.pathname === '/api/bots') {
      const bot = await bots.create(await readJson(request))
      await memory?.ensureScope(bot.id, 'personal')
      return json(response, 201, { bot })
    }
    const sheetListMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/character-sheet$/u)
    if (request.method === 'GET' && sheetListMatch) {
      const botId = sheetListMatch[1]
      if (!await readMember(botId)) return json(response, 404, { error: 'BOT_NOT_FOUND' })
      const sheets = await characterSheets.list(botId)
      return json(response, 200, { sheets: sheets.map(sheet => ({ ...sheet, url: `/api/bots/${botId}/character-sheet/${encodeURIComponent(sheet.file)}` })) })
    }
    const sheetFileMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/character-sheet\/([^/]+)$/u)
    if (request.method === 'GET' && sheetFileMatch) {
      const botId = sheetFileMatch[1]
      if (!await readMember(botId)) return json(response, 404, { error: 'BOT_NOT_FOUND' })
      const controller = new AbortController()
      const cancel = () => controller.abort()
      response.once('close', cancel)
      if (response.destroyed) cancel()
      let sheet
      try { sheet = await characterSheets.open(botId, decodeURIComponent(sheetFileMatch[2]), { signal: controller.signal }) }
      catch (error) {
        response.off('close', cancel)
        if (controller.signal.aborted) return
        throw error
      }
      if (controller.signal.aborted) { sheet.stream.destroy(); return }
      response.writeHead(200, {
        'content-type': sheet.mime,
        'content-length': sheet.size,
        'cache-control': 'private, no-cache',
        'x-content-type-options': 'nosniff',
      })
      // The seat reader must stop when its HTTP consumer disconnects; a read
      // failure after headers aborts this response instead of crashing HTTP.
      sheet.stream.once('error', error => response.destroy(error))
      response.once('close', () => sheet.stream.destroy())
      return sheet.stream.pipe(response)
    }

    const botAvatarMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/(avatar(?:-large)?(?:-source)?)$/u)
    if (request.method === 'GET' && botAvatarMatch) {
      const bot = await readMember(botAvatarMatch[1])
      if (!bot) return json(response, 404, { error: 'BOT_NOT_FOUND' })
      const field = { avatar: 'avatar', 'avatar-large': 'avatarLarge', 'avatar-source': 'avatarSource', 'avatar-large-source': 'avatarLargeSource' }[botAvatarMatch[2]]
      return sendAvatar(request, response, field === 'avatarLarge' ? bot[field] || bot.avatar : bot[field], url)
    }
    const profileMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)$/u)
    if (profileMatch) {
      const botId = profileMatch[1]
      const bot = await readMember(botId)
      if (!bot) return json(response, 404, { error: 'BOT_NOT_FOUND' })
      if (request.method === 'GET') return json(response, 200, { bot: administration.view?.(bot) ?? bot })
      if (request.method === 'PATCH') return json(response, 200, await administration.update(botId, await readJson(request)))
    }

    return false
  }
}
