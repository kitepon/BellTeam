import { json, readJson } from './http-response.mjs'

export function createDeliveryApi({ messenger, roomMessenger, transport }) {
  return async (request, response, url) => {
    if (request.method === 'POST' && url.pathname === '/api/deliveries/direct') {
      return json(response, 200, await messenger.sendmessage(await readJson(request)))
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
      return json(response, 200, { items: transport.queueItems() })
    }

    return false
  }
}
