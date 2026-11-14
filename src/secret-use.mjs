import { createSeatProcessRunner } from './seat-process.mjs'

const failure = (code, status) => Object.assign(new Error(code), { code, status })
const MAX_OUTPUT = 1024 * 1024
const TIMEOUT_MS = 10 * 60 * 1000

// A Bot uses a value it requested: the value goes from this process's memory only to the stdin of a
// command in that Bot's own seat (seat UID, own project). It never enters MCP arguments or the reply.
// botId is the seat the HTTP ingress resolved, never a body field. With the usage facade, reading the
// request and resolving the value each take a fresh method-limited system capability.
export function createSecretUse({ secretRequests, systemContext = null, projectPath, runner = createSeatProcessRunner }) {
  const read = id => systemContext ? secretRequests.read(id, systemContext('secrets.get')) : secretRequests.get(id)
  const resolveValue = id => secretRequests.resolveValue(id, systemContext?.('secrets.resolveRequest'))
  return async (id, { botId, command, args = [] } = {}) => {
    if (typeof command !== 'string' || !command || command.includes('\0') || !Array.isArray(args) || args.length > 256
      || !args.every(value => typeof value === 'string' && !value.includes('\0'))) throw failure('SECRET_USE_COMMAND_INVALID', 400)
    const item = await read(id)
    if (typeof botId !== 'string' || item?.botId !== botId) throw failure('SECRET_REQUEST_NOT_FOUND', 404)
    if (item.status !== 'submitted') throw failure('SECRET_REQUEST_CLOSED', 409)
    const run = runner(projectPath(botId))
    let value = await resolveValue(id)
    try {
      const result = await run(command, args, { input: value, acceptNonzero: true, maxBuffer: MAX_OUTPUT, signal: AbortSignal.timeout(TIMEOUT_MS) })
      const secret = value.trim()
      const mask = text => secret ? text.split(secret).join('[secret]') : text
      return { exitCode: result.code, signal: result.signal, stdout: mask(result.stdout), stderr: mask(result.stderr), oneTime: Boolean(item.oneTime) }
    } finally { value = null }
  }
}
