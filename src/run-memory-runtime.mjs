// The fixed seat entry drops identity and environment before this selected code runs.
import { isAbsolute } from 'node:path'
import { createMemoryDispatcher, MEMORY_STATE_COMPATIBILITY } from './memory/dispatcher.mjs'

try {
  if (process.argv.length !== 2 || [process.getuid(), process.geteuid(), process.getgid(), process.getegid()].some(id => id !== 1000))
    throw new Error('MEMORY_RUNTIME_IDENTITY')
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const request = JSON.parse(Buffer.concat(chunks).toString())
  if (!request || Object.keys(request).sort().join(',') !== 'generation,method,params,root'
    || !isAbsolute(request.root) || request.root !== process.cwd()
    || typeof request.generation !== 'string' || !/^[^\s\0]{1,128}$/u.test(request.generation)) throw new Error('MEMORY_RUNTIME_INPUT')
  const dispatcher = createMemoryDispatcher({ root: request.root })
  await dispatcher.control('initialize', {})
  let response
  try {
    if (request.method === null && request.params === null) response = { result: { restored: true } }
    else {
      await dispatcher.control('resume', {})
      dispatcher.validateRequest(request.method, request.params)
      response = { result: await dispatcher.dispatch(request.method, request.params) ?? null }
    }
  } catch (error) {
    response = { error: Object.fromEntries(['name', 'message', 'code', 'status'].filter(key => error[key] !== undefined).map(key => [key, error[key]])) }
  }
  await dispatcher.control('quiesce', {})
  await dispatcher.control('exit', {})
  process.stdout.write(JSON.stringify({ protocolVersion: 1, generation: request.generation,
    stateCompatibility: MEMORY_STATE_COMPATIBILITY, ...response }))
} catch {
  process.stderr.write('BELLTEAM_MEMORY_RUNTIME_FAILED\n')
  process.exitCode = 1
}
