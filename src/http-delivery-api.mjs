import { json, readJson } from './http-response.mjs'
import { withWorkingWord } from './working-words.mjs'

// Sends are seat-only: the sender is the internal seat (conversation authority), never the Owner listener's body (audit H2).
export function createDeliveryApi({ messenger, roomMessenger, transport, internal = false }) {
  return async (request, response, url) => {
    if (!internal && request.method === 'POST' && ['/api/deliveries/direct', '/api/deliveries/fork', '/api/deliveries/room'].includes(url.pathname)) return false
    if (request.method === 'POST' && url.pathname === '/api/deliveries/direct') {
      return json(response, 200, await messenger.sendmessage(await readJson(request)))
    }
    if (request.method === 'POST' && url.pathname === '/api/deliveries/fork') {
      return json(response, 200, await messenger.askReadonly(await readJson(request)))
    }
    const resumeDeliveryMatch = url.pathname.match(/^\/api\/deliveries\/direct\/([a-f0-9-]+)\/resume$/u)
    if (request.method === 'POST' && resumeDeliveryMatch) {
      const { target } = await readJson(request)
      return json(response, 200, await messenger.resumeDelivery(resumeDeliveryMatch[1], target))
    }
    const closeLaunchMatch = url.pathname.match(/^\/api\/deliveries\/direct\/([a-f0-9-]+)\/close-launch$/u)
    if (request.method === 'POST' && closeLaunchMatch) {
      const { target } = await readJson(request)
      return json(response, 200, await messenger.closeDeliveryLaunch(closeLaunchMatch[1], target))
    }
    if (request.method === 'POST' && url.pathname === '/api/deliveries/room') {
      return json(response, 200, await roomMessenger.sendroommessage(await readJson(request)))
    }
    if (request.method === 'GET' && url.pathname === '/api/queue') {
      return json(response, 200, { items: withWorkingWord(await transport.queueItems()) })
    }

    return false
  }
}
