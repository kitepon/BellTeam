import { json, readJson } from '../http-response.mjs'
import { listAvatar, sendAvatar } from '../http-assets.mjs'

export function createOwnerApi({ ownerProfile, refreshGlobalInstructions, userRules }) {
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
    return false
  }
}
