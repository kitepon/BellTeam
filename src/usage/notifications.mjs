import { validateNotificationRequest } from './notifications-dispatcher.mjs'
import { webPushError } from './web-push-schema.mjs'

const unavailable = () => Object.assign(new Error('PUSH_UNAVAILABLE'), { code: 'PUSH_UNAVAILABLE', status: 503, outcome: 'not_accepted', publicMessage: '通知を利用できません。' })

export function createNotifications({ root, bots, diagnostics, configuration, prepareRelease, createProcess, onState = () => {} }) {
  let state = { phase: 'unavailable', exchanging: false, available: false }, closed = false
  let buffer = [], bufferedBytes = 0, flushing = false
  const report = code => {
    const safe = /^[A-Z_0-9]+$/u.test(code ?? '') ? code : 'PUSH_SEND_FAILED'
    void Promise.resolve().then(() => diagnostics.record({ code: 'SERVER_PUSH_SEND_FAILED', module: 'notifications', diagnostic_log: safe }))
      .catch(() => process.stderr.write('BellTeam: 通知の診断を保存できませんでした (PUSH_DIAGNOSTIC_FAILED)\n'))
  }
  const send = async event => {
    try { await controller.request('publish', event) }
    catch (error) { report(error.code) }
  }
  const flush = async () => {
    if (flushing) return
    flushing = true
    try {
      while (!closed && !state.exchanging && state.phase === 'running' && state.available && buffer.length) {
        const event = buffer.shift()
        bufferedBytes -= Buffer.byteLength(JSON.stringify(event))
        await send(event)
      }
    } finally { flushing = false }
  }
  const controller = createProcess({ root, configuration, prepareRelease,
    onDiagnostic: report => diagnostics.record(report),
    onState: next => {
      state = next
      if (!closed && !next.exchanging && next.phase === 'running' && next.available) {
        void flush().catch(() => report('PUSH_BUFFER_FLUSH_FAILED'))
      } else if (!next.exchanging && !next.available && buffer.length) {
        buffer = []; bufferedBytes = 0
        report('PUSH_UNAVAILABLE')
      }
      try { onState(next) } catch { report('PUSH_STATE_CALLBACK_FAILED') }
    },
  })
  const publish = event => {
    validateNotificationRequest('publish', event)
    if (closed) { report('PUSH_UNAVAILABLE'); return }
    if (state.exchanging) {
      const bytes = Buffer.byteLength(JSON.stringify(event))
      if (buffer.length >= 256 || bufferedBytes + bytes > 1048576) { report('PUSH_UPDATE_BUFFER_FULL'); return }
      buffer.push(event); bufferedBytes += bytes
    } else if (state.available) void send(event)
    else report('PUSH_UNAVAILABLE')
  }
  const callback = project => record => {
    try { const event = project(record); if (event) publish(event) }
    catch (error) { report(error.code ?? 'PUSH_INPUT_INVALID') }
  }
  const senderName = botId => bots.get(botId)?.name ?? 'メンバー'
  const request = async (method, params) => {
    try { return await controller.request(method, params) }
    catch (error) {
      // Keep the existing HTTP status/body mapping for these public device errors.
      if (['PUSH_DEVICE_INVALID', 'PUSH_NOT_CONFIGURED', 'PUSH_ENVIRONMENT_UNAVAILABLE'].includes(error.code)) {
        throw Object.assign(new Error(error.code), { code: error.code, outcome: error.outcome })
      }
      if (params.provider === 'webPush' && /^WEB_PUSH_/u.test(error.code ?? '')) {
        const status = ['WEB_PUSH_DISABLED', 'WEB_PUSH_KEY_MISMATCH', 'WEB_PUSH_SUBSCRIPTION_EXPIRED', 'WEB_PUSH_SUBSCRIPTION_CONFLICT'].includes(error.code) ? 409
          : ['WEB_PUSH_INPUT_INVALID', 'WEB_PUSH_SERVICE_UNSUPPORTED', 'WEB_PUSH_DESTINATION_FORBIDDEN'].includes(error.code) ? 400 : 503
        throw webPushError(error.code, status, error.outcome)
      }
      throw error
    }
  }
  const apns = (method, value) => {
    if (value && Object.hasOwn(value, 'provider')) return Promise.reject(Object.assign(new Error('PUSH_INPUT_INVALID'), {
      code: 'PUSH_INPUT_INVALID', status: 503, outcome: 'not_accepted',
    }))
    return request(method, { ...value, provider: 'apns' })
  }
  return {
    controller,
    initialize: () => controller.start(),
    close: () => { closed = true; buffer = []; bufferedBytes = 0; return controller.close() },
    initialStatus: async () => {
      if (!state.available) throw unavailable()
      if (state.applyError?.apns) throw Object.assign(new Error(state.applyError.apns), { code: state.applyError.apns })
      return state.status.apns
    },
    initialWebStatus: async () => {
      if (!state.available) throw unavailable()
      if (state.applyError?.webPush) throw webPushError(state.applyError.webPush, 503)
      return state.status.webPush
    },
    status: () => request('status', { provider: 'apns' }),
    configure: value => apns('configure', value),
    register: value => apns('register', value),
    unregister: value => apns('unregister', value),
    webStatus: (endpoint, origin) => request('status', endpoint === undefined ? { provider: 'webPush' } : { provider: 'webPush', origin, endpoint }),
    configureWebPush: value => request('configure', { ...value, provider: 'webPush' }),
    webRegister: (value, origin) => request('register', { ...value, origin, provider: 'webPush' }),
    webUnregister: (value, origin) => request('unregister', { ...value, origin, provider: 'webPush' }),
    direct: callback(record => record?.schema === 'bellteam.direct-message.v1' && record.target === 'user' && !['user', 'scheduler'].includes(record.from)
      ? { type: 'direct', id: record.delivery_id, botId: record.from, senderName: senderName(record.from) } : null),
    room: callback(record => !['user', 'scheduler'].includes(record.sender.id)
      ? { type: 'room', id: record.id, botId: record.sender.id, senderName: record.sender.name, roomId: record.room.id, roomName: record.room.name } : null),
    secret: callback(item => ({ type: 'secret', id: item.id, botId: item.botId, senderName: senderName(item.botId), roomId: item.roomId ?? null })),
    question: callback(item => ({ type: 'question', id: item.id, botId: item.botId, senderName: senderName(item.botId) })),
  }
}
