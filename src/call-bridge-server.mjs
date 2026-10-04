import { createServer } from 'node:http'
import { lstat, mkdir, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

const MAX_BODY = 65536

function json(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(payload)
}

async function bodyJson(request) {
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('BODY_TOO_LARGE')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function createCallBridgeServer({ bots, messenger }) {
  return createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/v0/directory') {
        await bots.refresh?.()
        const members = [...bots.values()].map(bot => ({
          system: 'bellteam', id: bot.id, name: bot.name,
          ...(bot.position ? { title: bot.position } : {}),
          ...(bot.role ? { role: bot.role } : {}),
        }))
        return json(response, 200, { schema: 'bellteam.call-directory.v1', members })
      }
      if (request.method === 'POST' && request.url === '/v0/deliver') {
        let body
        try { body = await bodyJson(request) } catch { return json(response, 400, { error: 'INVALID_JSON' }) }
        if (!body || body.schema !== 'call-bridge.delivery.v1'
          || !['session.message', 'session.reply'].includes(body.event)
          || typeof body.session_id !== 'string' || !body.session_id
          || typeof body.target_id !== 'string' || !body.target_id
          || !['grokbot', 'bellteam', 'local'].includes(body.source_system)
          || typeof body.source_id !== 'string' || !body.source_id
          || typeof body.source_label !== 'string' || !body.source_label
          || typeof body.message !== 'string' || !body.message) {
          return json(response, 400, { error: 'INVALID_DELIVERY' })
        }
        try {
          const result = await messenger.receiveCallBridge(body)
          return json(response, 200, result)
        } catch (error) {
          const code = String(error.message ?? '')
          return json(response, code.startsWith('BOT_NOT_FOUND:') ? 404 : 502, { error: code })
        }
      }
      return json(response, 404, { error: 'NOT_FOUND' })
    } catch (error) {
      return json(response, 500, { error: String(error.message ?? error) })
    }
  })
}

export async function listenCallBridge(server, socketPath) {
  await mkdir(dirname(socketPath), { recursive: true })
  try {
    const entry = await lstat(socketPath)
    if (!entry.isSocket()) throw new Error('CALL_BRIDGE_SOCKET_PATH_OCCUPIED')
    await unlink(socketPath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => { server.off('error', reject); resolve() })
  })
  return async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await unlink(socketPath).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}
