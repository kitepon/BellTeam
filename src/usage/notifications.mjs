import { validateNotificationRequest } from './notifications-dispatcher.mjs'

const unavailable = () => Object.assign(new Error('PUSH_UNAVAILABLE'), { code: 'PUSH_UNAVAILABLE', status: 503, outcome: 'not_accepted', publicMessage: '通知を利用できません。' })

export function createNotifications({ root, bots, diagnostics, configuration, prepareRelease, createProcess, onState = () => {} }) {
  let state = { phase: 'unavailable', exchanging: false, available: false }, closed = false
  let buffer = [], bufferedBytes = 0
  const report = code => {
    const safe = /^[A-Z_0-9]+$/u.test(code ?? '') ? code : 'PUSH_SEND_FAILED'
    void Promise.resolve().then(() => diagnostics.record({ code: 'SERVER_PUSH_SEND_FAILED', module: 'notifications', diagnostic_log: safe }))
      .catch(() => process.stderr.write('BellTeam: 通知の診断を保存できませんでした (PUSH_DIAGNOSTIC_FAILED)\n'))
  }
  const send = event => {
    try { Promise.resolve(controller.request('publish', event)).catch(error => report(error.code)) }
    catch (error) { report(error.code) }
  }
  const controller = createProcess({ root, configuration, prepareRelease,
    onDiagnostic: report => diagnostics.record(report),
    onState: next => {
      state = next
      if (!closed && !next.exchanging && next.phase === 'running' && next.available) {
        const unsent = buffer
        buffer = []; bufferedBytes = 0
        for (const event of unsent) send(event)
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
    } else if (state.available) send(event)
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
      throw error
    }
  }
  return {
    controller,
    initialize: () => controller.start(),
    close: () => { closed = true; buffer = []; bufferedBytes = 0; return controller.close() },
    initialStatus: async () => {
      if (!state.available) throw unavailable()
      if (state.applyError) throw Object.assign(new Error(state.applyError), { code: state.applyError })
      return state.status
    },
    status: () => request('status', {}),
    configure: value => request('configure', value),
    register: value => request('register', value),
    unregister: value => request('unregister', value),
    direct: callback(record => record?.schema === 'bellteam.direct-message.v1' && record.target === 'user' && !['user', 'scheduler'].includes(record.from)
      ? { type: 'direct', id: record.delivery_id, botId: record.from, senderName: senderName(record.from) } : null),
    room: callback(record => !['user', 'scheduler'].includes(record.sender.id)
      ? { type: 'room', id: record.id, botId: record.sender.id, senderName: record.sender.name, roomId: record.room.id, roomName: record.room.name } : null),
    secret: callback(item => ({ type: 'secret', id: item.id, botId: item.botId, senderName: senderName(item.botId), roomId: item.roomId ?? null })),
    question: callback(item => ({ type: 'question', id: item.id, botId: item.botId, senderName: senderName(item.botId) })),
  }
}
