import { join } from 'node:path'
import { resolveSeatBotId } from './seat-mcp.mjs'

export const SUBMITTED_SECRET = Object.freeze({
  requestId: '009fedc7-410a-4b15-ae0b-3d44ba510515',
  requesterBotId: 'bot-8bc1fb5d', toolId: 'claude-rabbit9-auth-20261105', roomId: null,
})
const denied = () => Object.assign(new Error('SECRET_CONSUMER_FORBIDDEN'), { code: 'SECRET_CONSUMER_FORBIDDEN', status: 403 })
const completed = async result => {
  try { return await result }
  finally { await (result?.completion ?? result) }
}

// Management supplies the existing Owner authorization and fixed consumer, never HTTP data.
export function createSubmittedSecretCaller({ root, secretRequests, usageAssembly, aiControl, bots,
  assertOwnerAuthorized, createConsumer, consume }) {
  if (typeof assertOwnerAuthorized !== 'function' || typeof createConsumer !== 'function' || typeof consume !== 'function'
    || !(typeof secretRequests?.read === 'function' && usageAssembly || typeof secretRequests?.get === 'function') || typeof aiControl?.admit !== 'function') throw denied()
  const grants = new WeakMap()
  let closed = false
  const readMetadata = (id, actor) => secretRequests.read
    ? secretRequests.read(id, actor === 'bot' ? usageAssembly.capture('secrets.get', { kind: 'bot', botId: SUBMITTED_SECRET.requesterBotId }) : usageAssembly.systemContext('secrets.get'))
    : secretRequests.get(id)
  const owned = item => {
    if (item?.id !== SUBMITTED_SECRET.requestId || item.botId !== SUBMITTED_SECRET.requesterBotId
      || item.toolId !== SUBMITTED_SECRET.toolId || item.roomId !== null || item.status !== 'submitted') throw denied()
    return item
  }
  const readForCaller = request => {
    return (async () => {
      if (await resolveSeatBotId(request, bots) !== SUBMITTED_SECRET.requesterBotId) throw denied()
      return owned(await completed(readMetadata(SUBMITTED_SECRET.requestId, 'bot')))
    })()
  }
  const assertAuthorized = async admission => {
    const grant = admission && grants.get(admission)
    if (!grant || closed) throw denied()
    grant.check()
    await readForCaller(grant.request)
    grant.check()
    if (await assertOwnerAuthorized(SUBMITTED_SECRET) !== undefined) throw denied()
    grant.check()
  }
  const consumer = createConsumer({
    secretRequests: { toolsDirectory: secretRequests.toolsDirectory,
      read: id => completed(readMetadata(id, 'system')) },
    runDirectory: join(root, 'state/submitted-secret-consumption'), context: SUBMITTED_SECRET,
    assertAuthorized, consume,
  })
  return {
    consumer,
    async capture(request, requestId) {
      if (closed || requestId !== SUBMITTED_SECRET.requestId) throw denied()
      const check = aiControl.admit()
      await readForCaller(request)
      check()
      if (await assertOwnerAuthorized(SUBMITTED_SECRET) !== undefined) throw denied()
      check()
      const admission = Object.freeze({})
      grants.set(admission, { request, check })
      return admission
    },
    close() { closed = true; return consumer.close() },
  }
}
