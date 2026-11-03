import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { runtimeEnvironment } from './runtime-home.mjs'
import { createSeatProcessRunner } from './seat-process.mjs'

const execFileAsync = promisify(execFile)
const REQUEST_SCHEMA = 'throughline.observer_check_request.v1'
const RESULT_SCHEMA = 'throughline.observer_check_result.v1'
const MAX_INPUT_BYTES = 1024 * 1024
const requestFor = projects => ({ schema: REQUEST_SCHEMA, projects })
const bytes = value => Buffer.byteLength(value, 'utf8')
const bounded = (value, max) => typeof value === 'string' && bytes(value) >= 1 && bytes(value) <= max
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const invalid = () => new Error('THROUGHLINE_OBSERVER_CHECK_INVALID')

// execFile ignores an input option; explicitly close stdin and collect close even on abort.
export async function runObserverCommand(command, args, options) {
  const task = execFileAsync(command, args, options)
  const child = task.child
  const closed = new Promise(resolve => child.once('close', resolve))
  let inputError, size = 0, overflow = false
  const capture = chunk => {
    size += Buffer.byteLength(chunk)
    if (size > options.maxBuffer) { overflow = true; child.kill('SIGTERM') }
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  child.stdin.on('error', error => { inputError = error })
  child.stdin.end(options.input)
  try {
    const result = await task
    if (inputError || overflow) throw invalid()
    return result
  } finally { await closed }
}

export function observerCheckRequests(projects) {
  const ids = new Set(), requests = []
  let chunk = []
  for (const item of projects) {
    if (!exact(item, ['id', 'projectPath', 'after']) || !bounded(item.id, 128) || ids.has(item.id)
      || !bounded(item.projectPath, 4096) || !isAbsolute(item.projectPath)
      || !(item.after === null || bounded(item.after, 512))) throw invalid()
    ids.add(item.id)
    if (chunk.length === 256 || bytes(JSON.stringify(requestFor([...chunk, item]))) > MAX_INPUT_BYTES) {
      if (chunk.length) requests.push(requestFor(chunk))
      chunk = []
    }
    if (bytes(JSON.stringify(requestFor([item]))) > MAX_INPUT_BYTES) throw invalid()
    chunk.push({ ...item })
  }
  if (chunk.length) requests.push(requestFor(chunk))
  return requests
}

// Confirmation values are opaque: validate their wire shape, never derive read cursors from them.
export function validateObserverCheckResult(result, request) {
  if (!exact(result, ['schema', 'status', 'results']) || result.schema !== RESULT_SCHEMA
    || result.status !== 'complete' || !Array.isArray(result.results)
    || result.results.length !== request.projects.length) throw invalid()
  for (const [index, item] of result.results.entries()) {
    const prior = request.projects[index]
    if (!exact(item, item?.status === 'error' ? ['id', 'status', 'token', 'code'] : ['id', 'status', 'token'])
      || item.id !== prior.id) throw invalid()
    if (item.status === 'changed' || item.status === 'unchanged') {
      if (!bounded(item.token, 512) || !/^tloc1\.[A-Za-z0-9_-]+$/.test(item.token)) throw invalid()
      if (item.status === 'unchanged' && (prior.after === null || item.token !== prior.after)) throw invalid()
      if (item.status === 'changed' && item.token === prior.after) throw invalid()
    } else if (item.status === 'resync_required') {
      if (item.token !== null) throw invalid()
    } else if (item.status === 'error') {
      if (item.token !== null || item.code !== 'E_OBSERVER_CHECK_SOURCE') throw invalid()
    } else throw invalid()
  }
  return result.results
}

export async function checkObserverProjects(request, { run, seatCommands = false, root, signal } = {}) {
  if (!exact(request, ['schema', 'projects']) || request.schema !== REQUEST_SCHEMA
    || !Array.isArray(request.projects)) throw invalid()
  const chunks = observerCheckRequests(request.projects)
  if (chunks.length !== 1 || chunks[0].projects.length !== request.projects.length) throw invalid()
  signal?.throwIfAborted()
  const execute = run ?? (seatCommands ? createSeatProcessRunner(root, { environment: 'base' }) : runObserverCommand)
  const { stdout, stderr } = await execute('throughline', ['observer-check', '--json'], {
    input: JSON.stringify(chunks[0]), signal, maxBuffer: 16 * 1024 * 1024,
    ...(seatCommands ? {} : { env: runtimeEnvironment() }),
  })
  signal?.throwIfAborted()
  if (stderr) throw invalid()
  let result
  try { result = JSON.parse(stdout) } catch { throw invalid() }
  validateObserverCheckResult(result, chunks[0])
  return result
}
