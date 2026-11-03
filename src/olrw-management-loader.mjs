import { constants } from 'node:fs'
import { lstat, open, readFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, parse } from 'node:path'
import { isDeepStrictEqual as equal } from 'node:util'
import { writeAtomic } from './json-file.mjs'
import { createOlrwAuthorization } from './olrw-management-caller.mjs'
import { createOlrwRabbitAuth, fixedRabbitClientOptions } from './olrw-rabbit-auth.mjs'
import { createOlrwAuthConsumer } from './usage/olrw-auth-consumer.mjs'

const control = '/run/bellteam-maintenance/olrw-auth'
export const OLRW_MANAGEMENT_PATHS = Object.freeze({ plan: control + '/plan.json', token: control + '/connection-token', evidence: control + '/target-evidence.json' })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const denied = () => new Error('OLRW_MANAGEMENT_UNAVAILABLE')
const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === names

export async function readOlrwManagedFile(path, limit) {
  for (let parent = dirname(path);; parent = dirname(parent)) {
    const info = await lstat(parent)
    if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o7022)) throw denied()
    if (parent === parse(parent).root) break
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.uid !== 0 || info.gid !== 1001 || info.nlink !== 1
      || (info.mode & 0o7777) !== 0o440 || info.size < 1 || info.size > limit) throw denied()
    const bytes = Buffer.alloc(info.size + 1)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    const after = await file.stat()
    if (bytesRead !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw denied()
    return bytes.subarray(0, bytesRead)
  } finally { await file.close() }
}

async function processBirth(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw denied()
  const value = await readFile(`/proc/${pid}/stat`, 'utf8')
  const birth = value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
  if (!/^\d+$/.test(birth ?? '')) throw denied()
  return birth
}
async function connectionMetadata(connection) {
  if (process.getuid() !== 1001 || process.getgid() !== 1001) throw denied()
  const sshPid = connection.transport?.pid
  return { parentPid: process.pid, parentStarted: await processBirth(process.pid), sshPid, sshStarted: await processBirth(sshPid) }
}

// This is a single root-provisioned run, not a caller-supplied permission document.
export async function prepareOlrwManagement({ root, ownerQuestions, readManaged = readOlrwManagedFile,
  makeAuth = createOlrwRabbitAuth, metadata = connectionMetadata, fetchImpl = fetch }) {
  let raw
  try { raw = await readManaged(OLRW_MANAGEMENT_PATHS.plan, 32768) }
  catch (error) { if (error.code === 'ENOENT') return null; throw denied() }
  let auth = null
  try {
    const document = JSON.parse(raw)
    if (!keys(document, 'approval,context,question,schema,target') || document.schema !== 'bellteam.olrw-auth.management.v1'
      || !keys(document.target, 'entryPath,nodePath,profileSha256,version') || !/^[a-f0-9]{64}$/.test(document.target.profileSha256)
      || typeof document.target.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(document.target.version)
      || !keys(document.context, 'expiresAt,protectedHosted,requesterBotId,roomId,runId,sessionId,toolId')
      || !keys(document.question, 'answer,options,question,questionId,requesterBotId')
      || !keys(document.approval, 'connectionId,contextSha256,decisionId,optionId,optionsSha256,requester,userId,version')
      || !/^[A-Za-z0-9_-]{1,64}$/.test(document.context.runId) || !/^[A-Za-z0-9_-]{1,64}$/.test(document.context.sessionId)
      || !/^[A-Za-z0-9_-]{1,64}$/.test(document.context.protectedHosted) || document.context.sessionId === document.context.protectedHosted
      || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(document.context.toolId)
      || !/^[A-Za-z0-9_-]{1,64}$/.test(document.context.requesterBotId)
      || document.context.roomId !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(document.context.roomId)
      || !Number.isFinite(Date.parse(document.context.expiresAt))
      || document.question.requesterBotId !== document.context.requesterBotId) throw denied()
    fixedRabbitClientOptions(document.target)
    const question = ownerQuestions.get(document.question.questionId)
    if (question.botId !== document.context.requesterBotId || question.question !== document.question.question
      || !equal(question.options, document.question.options) || question.allowOther !== false
      || !question.options.includes(document.question.answer)) throw denied()
    const base = { plan: structuredClone(document.question), context: structuredClone(document.context), createConsumer: createOlrwAuthConsumer }
    if (question.status === 'answered') return { ...base, auth: null, assertAuthorized: async () => { throw denied() } }
    if (question.status !== 'open') throw denied()
    const planHash = hash(raw)
    const token = (await readManaged(OLRW_MANAGEMENT_PATHS.token, 4096)).toString('utf8').replace(/\n$/, '')
    const authorize = createOlrwAuthorization({ plan: { ...document.approval, expiresAt: document.context.expiresAt,
      actions: ['initialize', 'start', 'status', 'respond', 'cancel'] }, readBearer: async () => token, fetchImpl })
    const unchanged = async () => {
      if (hash(await readManaged(OLRW_MANAGEMENT_PATHS.plan, 32768)) !== planHash) throw denied()
    }
    await unchanged(); await authorize('initialize')
    auth = makeAuth({ ...document.target, sessionId: document.context.sessionId, protectedHosted: document.context.protectedHosted })
    let timer
    let connection
    try {
      connection = await Promise.race([auth.prepare(), new Promise((_, reject) => { timer = setTimeout(() => reject(denied()), 10000) })])
    } finally { clearTimeout(timer) }
    const bound = await metadata(connection)
    const expected = { schema: 'bellteam.olrw-auth.target-evidence.v1', runId: document.context.runId,
      profileSha256: document.target.profileSha256, ...bound }
    await mkdir(join(root, 'logs'), { recursive: true, mode: 0o700 })
    await writeAtomic(join(root, 'logs/olrw-client-preflight.json'), { ...expected, target: document.target,
      scope: 'connection identity only; independently measured SSH/Node/artifact/environment profile is still required' })
    const targetUnchanged = async () => {
      if (!equal(await metadata(connection), bound)) throw denied()
      const evidence = JSON.parse(await readManaged(OLRW_MANAGEMENT_PATHS.evidence, 16384))
      if (!equal(evidence, expected)) throw denied()
    }
    const assertAuthorized = async action => {
      try {
        if (!['start', 'status', 'respond', 'cancel'].includes(action)) throw denied()
        await unchanged()
        await targetUnchanged()
        await authorize(action)
        await unchanged()
        await targetUnchanged()
      } catch { throw denied() }
    }
    return { ...base, auth, assertAuthorized }
  } catch {
    try { await auth?.close() } catch {}
    throw denied()
  }
}
