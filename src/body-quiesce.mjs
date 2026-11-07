import { createServer } from 'node:net'
import { lstat, mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

// /run/bellteam-server is the parent's UID1001-only 0700 tmpfs; seats (UID1000) cannot traverse it.
export const BODY_QUIESCE_SOCKET = '/run/bellteam-server/quiesce/quiesce.sock'
export const QUIESCE_DRAIN_MS = 300_000
export const QUIESCE_RESULTS = ['drained', 'deadline', 'unsupported']
const LINE_LIMIT = 4096, SKEW_MS = 5_000

export function parseQuiesceRequest(line, now = Date.now()) {
  let value
  try { value = JSON.parse(line) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'containerId,deadline,requestId'
    || typeof value.requestId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(value.requestId)
    || typeof value.containerId !== 'string' || !/^[a-f0-9]{64}$/.test(value.containerId)
    || !Number.isSafeInteger(value.deadline) || value.deadline > now + QUIESCE_DRAIN_MS + SKEW_MS) return null
  return value
}

export async function listenBodyQuiesce({ path = BODY_QUIESCE_SOCKET, quiesce = async () => ({ result: 'unsupported' }) } = {}) {
  const directory = dirname(path)
  await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  const info = await lstat(directory)
  // The directory is the only authority (no peer credentials in Node); refuse anything a seat could reach.
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0)
    throw Object.assign(new Error('BODY_QUIESCE_DIRECTORY_UNSAFE'), { code: 'BODY_QUIESCE_DIRECTORY_UNSAFE' })
  await rm(path, { force: true })
  const server = createServer(socket => {
    let buffer = '', accepted = false, answered = false
    const answer = value => {
      if (answered) return
      answered = true
      socket.end(JSON.stringify(value) + '\n')
    }
    socket.setEncoding('utf8')
    socket.setTimeout(5_000, () => { answer({ error: 'QUIESCE_REQUEST_INVALID' }) })
    socket.on('error', () => {})
    socket.on('data', async chunk => {
      if (accepted || answered) return
      buffer += chunk
      const end = buffer.indexOf('\n')
      if (end < 0) { if (buffer.length > LINE_LIMIT) answer({ error: 'QUIESCE_REQUEST_INVALID' }); return }
      const request = end <= LINE_LIMIT ? parseQuiesceRequest(buffer.slice(0, end)) : null
      if (!request) return answer({ error: 'QUIESCE_REQUEST_INVALID' })
      accepted = true
      socket.setTimeout(0)
      try {
        const outcome = await quiesce({ requestId: request.requestId, deadline: request.deadline })
        if (!QUIESCE_RESULTS.includes(outcome?.result)) throw new Error('result')
        answer({ ...outcome, requestId: request.requestId })
      } catch { answer({ error: 'QUIESCE_FAILED', requestId: request.requestId }) }
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => { server.removeListener('error', reject); resolve() })
  })
  return {
    path,
    // Stop accepting at once; an in-flight request must not hold shutdown inside the 30 s stop grace.
    close: () => { server.close(); return rm(path, { force: true }) },
  }
}
