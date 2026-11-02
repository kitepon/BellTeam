import { createHash } from 'node:crypto'

const origin = 'https://approval-box.kitepon.dev/connector/v1'
const hash = value => createHash('sha256').update(value).digest('hex')
const denied = () => new Error('OLRW_AUTHORIZATION_UNAVAILABLE')

// plan and readBearer are supplied only by the management assembly, never an HTTP/MCP body.
export function createOlrwAuthorization({ plan, readBearer, fetchImpl = fetch, now = Date.now }) {
  const expected = structuredClone(plan)
  if (!/^K-[A-Z0-9]{6,12}$/.test(expected.decisionId ?? '')
    || !Number.isSafeInteger(expected.version) || expected.version < 1
    || !['connectionId', 'userId', 'optionId', 'requester', 'contextSha256', 'optionsSha256'].every(key => typeof expected[key] === 'string' && expected[key])
    || !Number.isFinite(Date.parse(expected.expiresAt)) || !Array.isArray(expected.actions)) throw denied()
  return async action => {
    if (!expected.actions.includes(action) || now() >= Date.parse(expected.expiresAt)) throw denied()
    try {
      const token = await readBearer()
      if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw denied()
      const get = async path => {
        const response = await fetchImpl(origin + path, { method: 'GET', redirect: 'error',
          headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) })
        if (!response.ok || !response.body) throw denied()
        let bytes = 0
        const chunks = []
        for await (const chunk of response.body) {
          bytes += chunk.length
          if (bytes > 65536) throw denied()
          chunks.push(chunk)
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }
      const connection = await get('/connection')
      if (connection.connection_id !== expected.connectionId || connection.me?.user_id !== expected.userId) throw denied()
      const decision = await get('/decisions/' + encodeURIComponent(expected.decisionId))
      if (decision.decision_id !== expected.decisionId || decision.version !== expected.version
        || decision.status !== 'answered' || decision.test || decision.cancel_reason
        || decision.answer?.option_id !== expected.optionId || decision.answer?.text
        || !Number.isFinite(Date.parse(decision.answer?.answered_at))
        || decision.requester !== expected.requester || typeof decision.context !== 'string'
        || hash(decision.context) !== expected.contextSha256
        || hash(JSON.stringify(decision.options)) !== expected.optionsSha256
        || now() >= Date.parse(expected.expiresAt)) throw denied()
    } catch { throw denied() }
  }
}

// The usage consumer owns durable one-time claims and native effects.
export function attachOlrwOwnerQuestion({ plan, ownerQuestions, aiControl, assertAuthorized, createConsumer, reportFailure }) {
  plan = structuredClone(plan)
  const question = ownerQuestions.get(plan.questionId)
  if (question.status !== 'open' || question.botId !== plan.requesterBotId
    || question.question !== plan.question || JSON.stringify(question.options) !== JSON.stringify(plan.options)
    || question.allowOther !== false || !plan.options.includes(plan.answer)) throw denied()
  const controller = new AbortController()
  let invoked = false, pending = null, admission = null
  const consumer = createConsumer({ assertAuthorized: async action => {
    controller.signal.throwIfAborted()
    admission()
    await assertAuthorized(action)
    controller.signal.throwIfAborted()
    admission()
  } })
  const unwatch = ownerQuestions.watch(() => {
    if (invoked || controller.signal.aborted) return
    const current = ownerQuestions.get(plan.questionId)
    if (current.status !== 'answered') return
    invoked = true
    unwatch()
    if (current.other || current.answer !== plan.answer) return
    pending = (async () => {
      admission = aiControl.admit()
      await assertAuthorized('start')
      controller.signal.throwIfAborted()
      admission()
      return consumer.execute({ signal: controller.signal })
    })().catch(async () => { try { await reportFailure('OLRW_MANAGEMENT_EXECUTION_UNCONFIRMED') } catch {} })
  })
  return { get result() { return pending }, async close() { controller.abort(); unwatch(); await consumer.close() } }
}
