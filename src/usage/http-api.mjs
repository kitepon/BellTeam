import { json, readJson } from '../http-response.mjs'
import { SubscriptionAccessError } from '../subscriptions.mjs'
import { webPushError, webPushFields, validateWebPushOrigin } from './web-push-schema.mjs'

export function createUsageApi({ onboarding, internal, notify, harnessAuth, settings, secretRequests, subscriptions, bots, transport, notifications, ownerQuestions, authMode, assertWebPushOrigin }) {
  const webOrigin = request => {
    if (!assertWebPushOrigin) throw webPushError('WEB_PUSH_ORIGIN_UNAVAILABLE', 503)
    return validateWebPushOrigin(assertWebPushOrigin(request))
  }
  const webJson = request => {
    if (!/^application\/json(?:\s*;|$)/iu.test(request.headers['content-type'] ?? '')) throw webPushError('WEB_PUSH_INPUT_INVALID')
  }
  return async (request, response, url) => {
    if (url.pathname === '/api/setup' && request.method === 'GET') return json(response, 200, onboarding ? await onboarding.status() : { phase: 'ready', harness: null, harnesses: [], guideBotId: null, complete: true, auth: null })
    if (url.pathname.startsWith('/api/setup/') && request.method === 'POST') {
      if (!onboarding) return json(response, 404, { error: 'NOT_FOUND' })
      if (internal && ['/api/setup/harness', '/api/setup/auth/input'].includes(url.pathname)) return json(response, 403, { error: 'HARNESS_AUTH_OWNER_REQUIRED' })
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
      if (internal && request.method !== 'GET') return json(response, 403, { error: 'HARNESS_AUTH_OWNER_REQUIRED' })
      if (request.method === 'GET' && !action) return json(response, 200, harness ? await harnessAuth.status(harness) : harnessAuth.list())
      if (request.method === 'POST' && action === 'input') return json(response, 200, await harnessAuth.input(harness, await readJson(request, 8192)))
      if (request.method === 'POST' && action) return json(response, 200, await harnessAuth[action](harness))
      return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
    }
    if (url.pathname === '/api/settings' && request.method === 'GET') return json(response, 200, { settings: settings?.list() ?? [] })
    const settingsMatch = url.pathname.match(/^\/api\/settings\/([A-Za-z]+)$/u)
    if (settingsMatch && request.method === 'PATCH') {
      if (!settings) return json(response, 404, { error: 'NOT_FOUND' })
      if (settingsMatch[1] === 'webPush') {
        if (internal) return json(response, 403, { error: 'WEB_PUSH_OWNER_REQUIRED' })
        webOrigin(request)
        webJson(request)
      }
      const body = await readJson(request, settingsMatch[1] === 'webPush' ? 16384 : 32768)
      const botId = internal ? body.botId : undefined
      if (internal) delete body.botId
      const setting = await settings.update(settingsMatch[1], body, { secretRequests, botId, allowSecretValues: !internal })
      return json(response, 200, { setting })
    }
    if (url.pathname.startsWith('/api/web-push/')) {
      if (internal) return json(response, 403, { error: 'WEB_PUSH_OWNER_REQUIRED' })
      if (!['/api/web-push/status', '/api/web-push/subscriptions', '/api/web-push/unregister'].includes(url.pathname)) return json(response, 404, { error: 'NOT_FOUND' })
      if (url.search) throw webPushError('WEB_PUSH_INPUT_INVALID')
      if (request.method !== 'POST' && !(request.method === 'GET' && url.pathname === '/api/web-push/status')) return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
      const origin = request.method === 'POST' ? webOrigin(request) : null
      if (!notifications?.webStatus) throw webPushError('WEB_PUSH_UNAVAILABLE', 503)
      if (request.method === 'GET') return json(response, 200, await notifications.webStatus())
      webJson(request)
      const body = await readJson(request, 16384)
      if (url.pathname === '/api/web-push/subscriptions') {
        webPushFields(body, ['subscription', 'applicationServerKey'], ['previousEndpoint'])
        return json(response, 200, await notifications.webRegister(body, origin))
      }
      webPushFields(body, ['endpoint'])
      return json(response, 200, url.pathname === '/api/web-push/status'
        ? await notifications.webStatus(body.endpoint, origin) : await notifications.webUnregister(body, origin))
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
      if (request.method === 'GET' && url.pathname === '/api/notifications') return json(response, 200, await notifications.status())
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
    return false
  }
}
