import { json, readJson } from './http-response.mjs'
import { listAvatar, sendAvatar } from './http-assets.mjs'

export function createControlApi({ aiControl, onboarding, internal, notify, harnessAuth, settings, secretRequests, subscriptions, bots, transport, notifications, ownerQuestions, authMode, diagnostics, models }) {
  return async (request, response, url) => {
    if (url.pathname === '/api/ai-control') {
      if (!aiControl) return json(response, 404, { error: 'NOT_FOUND' })
      if (request.method === 'GET') return json(response, 200, { control: aiControl.snapshot() })
      if (request.method !== 'PATCH') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
      const body = await readJson(request, 8192)
      if (!body || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.paused !== 'boolean')
        return json(response, 400, { error: 'AI_CONTROL_INVALID' })
      const result = await aiControl.update(body.paused)
      return json(response, result.status, { control: result.control, ...(result.error ? { error: result.error } : {}) })
    }
    if (url.pathname === '/api/setup' && request.method === 'GET') return json(response, 200, onboarding ? await onboarding.status() : { phase: 'ready', harness: null, harnesses: [], guideBotId: null, complete: true, auth: null })
    if (url.pathname.startsWith('/api/setup/') && request.method === 'POST') {
      if (!onboarding) return json(response, 404, { error: 'NOT_FOUND' })
      const body = await readJson(request, 8192)
      const actions = {
        '/api/setup/harness': () => onboarding.select(body.harness),
        '/api/setup/auth/input': () => onboarding.input(body),
        '/api/setup/start': () => onboarding.start(),
        '/api/setup/complete': () => onboarding.complete(internal ? body.botId : undefined),
      }
      if (!actions[url.pathname]) return json(response, 404, { error: 'NOT_FOUND' })
      const setup = await actions[url.pathname]()
      notify({ type: 'setup' })
      return json(response, 200, setup)
    }
    // 初期設定の後に、AIの公式認証をやり直す入口。認証が切れて全員が止まった時も、利用者がここから戻せる。
    const harnessAuthMatch = url.pathname.match(/^\/api\/harness-auth(?:\/([a-z]+)(?:\/(start|input|cancel))?)?$/u)
    if (harnessAuthMatch) {
      if (!harnessAuth) return json(response, 404, { error: 'NOT_FOUND' })
      const [, harness, action] = harnessAuthMatch
      if (request.method === 'GET' && !action) return json(response, 200, harness ? await harnessAuth.status(harness) : harnessAuth.list())
      if (request.method === 'POST' && action === 'input') return json(response, 200, await harnessAuth.input(harness, await readJson(request, 8192)))
      if (request.method === 'POST' && action) return json(response, 200, await harnessAuth[action](harness))
      return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
    }
    if (url.pathname === '/api/settings' && request.method === 'GET') return json(response, 200, { settings: settings?.list() ?? [] })
    const settingsMatch = url.pathname.match(/^\/api\/settings\/([A-Za-z]+)$/u)
    if (settingsMatch && request.method === 'PATCH') {
      if (!settings) return json(response, 404, { error: 'NOT_FOUND' })
      const body = await readJson(request, 32768)
      const botId = internal ? body.botId : undefined
      if (internal) delete body.botId
      const setting = await settings.update(settingsMatch[1], body, { secretRequests, botId, allowSecretValues: !internal })
      return json(response, 200, { setting })
    }
    if (url.pathname.startsWith('/api/subscription')) {
      if (!subscriptions) return json(response, 503, { error: 'SUBSCRIPTION_NOT_CONFIGURED' })
      if (request.method === 'GET' && url.pathname === '/api/subscription') return json(response, 200, { subscription: await subscriptions.current() })
      if (request.method === 'POST' && url.pathname === '/api/subscription/verify')
        return json(response, 200, { subscription: await subscriptions.install((await readJson(request, 32768)).signedTransaction) })
      if (request.method === 'POST' && url.pathname === '/api/subscription/refresh')
        return json(response, 200, { subscription: await subscriptions.refresh({ force: true }) })
      if (request.method === 'POST' && url.pathname === '/api/subscription/setup-test') {
        if (onboarding && !onboarding.snapshot().complete) return json(response, 409, { error: 'SETUP_GUIDE_REQUIRED', message: '案内役との会話で初期設定を進めてください。' })
        const { botId } = await readJson(request, 4096)
        await bots.refresh?.()
        const bot = bots.get(botId)
        if (!bot) return json(response, 404, { error: 'BOT_NOT_FOUND' })
        if (!transport.isIdle(bot.id)) throw new SubscriptionAccessError('SETUP_BOT_BUSY', 409, 'メンバーが作業中です。完了してから動作確認してください。')
        return json(response, 200, await subscriptions.runSetupTest(bot.id, () => transport.setupTest(bot)))
      }
      return json(response, 404, { error: 'NOT_FOUND' })
    }
    if (url.pathname.startsWith('/api/notifications')) {
      if (!notifications) return json(response, 404, { error: 'NOT_FOUND' })
      if (request.method === 'GET' && url.pathname === '/api/notifications') return json(response, 200, notifications.status())
      if (request.method === 'POST' && url.pathname === '/api/notifications/devices')
        return json(response, 200, await notifications.register(await readJson(request, 32768)))
      if (request.method === 'POST' && url.pathname === '/api/notifications/unregister')
        return json(response, 200, await notifications.unregister(await readJson(request, 4096)))
      return json(response, 404, { error: 'NOT_FOUND' })
    }
    if (url.pathname.startsWith('/api/secret-requests')) {
      if (!secretRequests) return json(response, 404, { error: 'NOT_FOUND' })
      if (request.method === 'POST' && url.pathname === '/api/secret-requests' && internal) {
        return json(response, 201, { request: await secretRequests.create(await readJson(request, 8192)) })
      }
      const match = url.pathname.match(/^\/api\/secret-requests\/([a-f0-9-]+)(?:\/(submit|cancel))?$/u)
      if (!match) return json(response, 404, { error: 'NOT_FOUND' })
      const [, id, action] = match
      if (request.method === 'GET' && !action) return json(response, 200, { request: secretRequests.get(id) })
      // 席（内側）から出来るのは、依頼したBotが自分の未入力の依頼を取り下げる事だけ。値の登録は、オーナーの画面の専用経路だけが受ける。
      if (internal && request.method === 'POST' && action === 'cancel') {
        const body = await readJson(request, 8192)
        return json(response, 200, { request: await secretRequests.withdraw(id, body?.botId) })
      }
      if (request.method !== 'POST' || !action || internal) return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
      if (authMode(request) !== 'local' && !request.socket.encrypted && request.headers['x-forwarded-proto'] !== 'https') {
        return json(response, 426, { error: 'SECRET_HTTPS_REQUIRED' })
      }
      if (!request.headers['content-type']?.startsWith('application/json')
        || request.headers['sec-fetch-site'] === 'cross-site') {
        return json(response, 400, { error: 'SECRET_REQUEST_INVALID' })
      }
      const body = await readJson(request, 131072)
      const result = action === 'submit'
        ? await secretRequests.submit(id, body?.value)
        : await secretRequests.cancel(id)
      return json(response, 200, { request: result })
    }
    if (url.pathname.startsWith('/api/owner-questions')) {
      if (!ownerQuestions) return json(response, 404, { error: 'NOT_FOUND' })
      if (request.method === 'POST' && url.pathname === '/api/owner-questions' && internal) {
        return json(response, 201, { question: await ownerQuestions.create(await readJson(request, 65536)) })
      }
      const match = url.pathname.match(/^\/api\/owner-questions\/([a-f0-9-]+)(?:\/(answer))?$/u)
      if (!match) return json(response, 404, { error: 'NOT_FOUND' })
      const [, id, action] = match
      if (request.method === 'GET' && !action) return json(response, 200, { question: ownerQuestions.get(id) })
      if (request.method !== 'POST' || !action || internal) return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
      return json(response, 200, { question: await ownerQuestions.answer(id, await readJson(request, 65536)) })
    }
    if (request.method === 'POST' && url.pathname === '/api/diagnostics') {
      if (!diagnostics) return json(response, 404, { error: 'NOT_FOUND' })
      const report = await readJson(request, 65536)
      if (typeof report?.code !== 'string' || !report.code.startsWith('IOS_')) return json(response, 400, { error: 'DIAGNOSTIC_INVALID' })
      await diagnostics.record(report)
      return json(response, 202, { accepted: true })
    }
    if (request.method === 'GET' && url.pathname === '/api/models')
      return json(response, 200, { models: await models.list(url.searchParams.get('harness') || undefined) })
    return false
  }
}

export function createApplicationApi({ ownerProfile, refreshGlobalInstructions, userRules, events, assets }) {
  return async (request, response, url) => {
    if (request.method === 'GET' && url.pathname === '/api/owner') {
      const owner = await ownerProfile.get()
      return json(response, 200, { owner: { ...owner, ...listAvatar(owner.avatar, url) } })
    }
    if (request.method === 'GET' && url.pathname === '/api/owner/avatar') return sendAvatar(request, response, (await ownerProfile.get()).avatar, url)
    if (request.method === 'PATCH' && url.pathname === '/api/owner') {
      const owner = await ownerProfile.update(await readJson(request))
      await refreshGlobalInstructions()
      return json(response, 200, { owner })
    }
    if (request.method === 'GET' && url.pathname === '/api/user-rules') return json(response, 200, { text: await userRules.get() })
    if (request.method === 'PUT' && url.pathname === '/api/user-rules') {
      const text = await userRules.update((await readJson(request)).text)
      await refreshGlobalInstructions()
      return json(response, 200, { text })
    }
    if (request.method === 'GET' && url.pathname === '/api/events') {
      return events.connect(request, response)
    }
    const imageAssetMatch = url.pathname.match(/^\/api\/message-images\/([a-z0-9-]+)\/([a-z0-9-]+\.(?:png|jpg|webp|gif))$/u)
    if (request.method === 'GET' && imageAssetMatch) {
      if (!assets) return json(response, 404, { error: 'IMAGE_ASSET_NOT_FOUND' })
      const asset = await assets.open(imageAssetMatch[1], imageAssetMatch[2])
      response.writeHead(200, {
        'content-type': asset.mime,
        'content-length': asset.size,
        'cache-control': 'private, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
      })
      return asset.stream.pipe(response)
    }
    return false
  }
}
