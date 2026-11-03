import { PushNotifications, validatePushDevice } from '../push-notifications.mjs'

const methods = new Set(['status', 'configure', 'register', 'unregister', 'publish'])
const printable = value => typeof value === 'string' && Boolean(value.trim()) && !/[\u0000-\u001f\u007f]/u.test(value)
const failure = (code, outcome = 'not_accepted') => Object.assign(new Error(code), { code, outcome })

function object(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw failure('PUSH_INPUT_INVALID')
}

export function validateNotificationRequest(method, params) {
  if (!methods.has(method)) throw failure('PUSH_INPUT_INVALID')
  if (Buffer.byteLength(JSON.stringify(params) ?? '') > 65536) throw failure('PUSH_INPUT_INVALID')
  if (method === 'status') object(params, [])
  if (method === 'configure') {
    object(params, ['enabled', 'relayUrl'])
    if (typeof params.enabled !== 'boolean' || typeof params.relayUrl !== 'string' || params.relayUrl.includes('\0')) throw failure('PUSH_INPUT_INVALID')
  }
  if (method === 'register') {
    object(params, ['token', 'environment', 'server'], ['previousToken', 'signedTransaction'])
    try { validatePushDevice(params) } catch { throw failure('PUSH_DEVICE_INVALID') }
    if (params.previousToken !== undefined && (typeof params.previousToken !== 'string' || !/^[a-f0-9]{32,512}$/u.test(params.previousToken))) throw failure('PUSH_DEVICE_INVALID')
  }
  if (method === 'unregister') {
    object(params, ['token'])
    if (typeof params.token !== 'string' || !/^[a-f0-9]{32,512}$/u.test(params.token)) throw failure('PUSH_DEVICE_INVALID')
  }
  if (method === 'publish') {
    const fields = ['type', 'id', 'botId', 'senderName']
    if (params?.type === 'room') fields.push('roomId', 'roomName')
    if (params?.type === 'secret') fields.push('roomId')
    object(params, fields)
    if (!['direct', 'room', 'secret', 'question'].includes(params.type)
      || !['id', 'botId', 'senderName'].every(key => printable(params[key]))
      || (params.type === 'room' && (!printable(params.roomId) || !printable(params.roomName)))
      || (params.type === 'secret' && params.roomId !== null && !printable(params.roomId))) throw failure('PUSH_INPUT_INVALID')
  }
}

function notificationEvent(event) {
  const { id, botId, senderName, roomId, roomName } = event
  return { id, botId, sender: { id: botId, name: senderName },
    kind: event.type === 'secret' ? 'secret_request' : event.type === 'question' ? 'owner_question' : 'reply',
    ...(event.type === 'room' || event.type === 'secret' ? { roomId } : {}),
    ...(event.type === 'room' ? { roomName } : {}),
    title: event.type === 'room' ? `${senderName} · ${roomName}` : senderName,
    body: event.type === 'secret' ? '秘密情報の入力が必要です。'
      : event.type === 'question' ? '選んでほしいことがあります。'
        : event.type === 'room' ? 'ルームに新しいメッセージが届きました。' : '返信が届きました。' }
}

export function createNotificationsDispatcher({ root, diagnostic, provider }) {
  const service = new PushNotifications({ root, provider, diagnostics: { async record(report) {
    try { await diagnostic(report) }
    catch { process.stderr.write('BellTeam: 通知の診断を保存できませんでした (PUSH_DIAGNOSTIC_FAILED)\n') }
  } } })
  let initialized = false, initializationStarted = false, accepting = false, quiesced = false, exiting = false, epoch = 0
  const active = new Set()
  const drain = async () => {
    do {
      await Promise.allSettled([...active, ...service.inflight])
      await service.saving
    } while (active.size || service.inflight.size)
  }
  const validateRequest = (method, params) => {
    validateNotificationRequest(method, params)
    if (!initialized || !accepting || exiting) throw failure('PUSH_UNAVAILABLE')
  }
  const dispatch = (method, params) => {
    // The channel has already accepted this operation, even if quiesce now closes its gate.
    validateNotificationRequest(method, params)
    const task = Promise.resolve().then(() => {
      if (method === 'publish') { service.publish(notificationEvent(params)); return { accepted: true } }
      return service[method](params)
    })
    active.add(task)
    void task.then(() => active.delete(task), () => active.delete(task))
    return task
  }
  const executeControl = async (method, params) => {
    if (method === 'initialize') {
      object(params, ['configuration'])
      if (initialized || exiting) throw failure('PUSH_CONTROL_INVALID')
      validateNotificationRequest('configure', params.configuration)
      await service.initialize()
      initialized = true
      let applyError = null
      try { await service.configure(params.configuration) }
      catch (error) { applyError = /^[A-Z_0-9]+$/u.test(error.code ?? '') ? error.code : 'PUSH_CONFIGURATION_FAILED' }
      return { status: service.status(), applyError }
    }
    object(params, [])
    if (!initialized || exiting) throw failure('PUSH_CONTROL_INVALID')
    if (method === 'resume') {
      epoch++
      quiesced = false
      accepting = true
      return { resumed: true }
    }
    if (method === 'quiesce') {
      accepting = false
      const current = ++epoch
      await drain()
      quiesced = current === epoch && !accepting
      return { quiesced }
    }
    if (method === 'exit') {
      if (!quiesced) throw failure('PUSH_NOT_QUIESCED')
      exiting = true
      await service.close()
      return { closed: true }
    }
    throw failure('PUSH_CONTROL_INVALID')
  }
  const control = (method, params) => {
    if (method !== 'initialize') return executeControl(method, params)
    if (initializationStarted) return Promise.reject(failure('PUSH_CONTROL_INVALID'))
    initializationStarted = true
    const task = executeControl(method, params)
    active.add(task)
    void task.then(() => active.delete(task), () => active.delete(task))
    return task
  }
  const disconnect = async () => {
    accepting = false
    exiting = true
    epoch++
    await drain()
    await service.close()
  }
  return { validateRequest, dispatch, control, disconnect }
}
