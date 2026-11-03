import { posix } from 'node:path'
import { AitermClient } from './aiterm-client.mjs'

const invalid = () => new Error('OLRW_RABBIT_ARGUMENTS_INVALID')
const pathValid = value => typeof value === 'string' && /^\/[A-Za-z0-9_./-]+$/.test(value)
  && posix.normalize(value) === value && !value.split('/').includes('..')

export function fixedRabbitClientOptions({ nodePath, entryPath }) {
  if (!pathValid(nodePath) || !pathValid(entryPath)) throw invalid()
  return { command: '/usr/bin/ssh', args: ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-l', 'kite', 'rabbit', nodePath, entryPath] }
}

// Assembly supplies only a root-managed profile; there is no caller-selected remote or shell.
export function createOlrwRabbitAuth({ nodePath, entryPath, version, sessionId, protectedHosted,
  assertBeforeIssue = () => {},
  client = new AitermClient(fixedRabbitClientOptions({ nodePath, entryPath })) }) {
  fixedRabbitClientOptions({ nodePath, entryPath })
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)
    || typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)
    || typeof protectedHosted !== 'string' || sessionId === protectedHosted) throw invalid()
  let preparing = null, closed = false, halted = false
  const prepare = () => {
    if (closed || halted) return Promise.reject(new Error('OLRW_RABBIT_CONNECTION_CLOSED'))
    preparing ??= (async () => {
      await client.connect()
      if (closed) { await client.close(); throw new Error('OLRW_RABBIT_CONNECTION_CLOSED') }
      const connection = client.client
      const info = connection?.getServerVersion()
      if (info?.name !== 'aiterm' || info.version !== version) {
        halted = true
        await client.close()
        throw new Error('OLRW_RABBIT_VERSION_UNCONFIRMED')
      }
      return connection
    })()
    return preparing
  }
  const invoke = async (action, options = {}) => {
    try {
      const connection = await prepare()
      if (closed || halted) throw new Error('OLRW_RABBIT_CONNECTION_CLOSED')
      if (assertBeforeIssue() !== undefined) throw invalid()
      const result = await client.call('agent_auth', { action, harness: 'claude-code', session_id: sessionId, ...options },
        { expectedAuthConnection: connection, expectedAuthServerVersion: version })
      if (result?.isError) halted = true
      return result
    } catch (error) { halted = true; throw error }
  }
  const binding = input => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || input.session_id !== sessionId) throw invalid()
    return structuredClone(input)
  }
  return {
    prepare,
    start: () => invoke('start', { cwd: '/home/kite', env_vars: ['HOME'], relogin: true }),
    status: ({ binding: expected }) => invoke('status', { expected_binding: binding(expected) }),
    cleanup: ({ binding: expected }) => invoke('cancel', { expected_binding: binding(expected) }),
    respond: ({ binding: expected, prompt_digest, response }) => {
      if (typeof prompt_digest !== 'string' || !/^[a-f0-9]{64}$/.test(prompt_digest)
        || !response || Object.keys(response).sort().join(',') !== 'kind,value'
        || response.kind !== 'authorization_code' || typeof response.value !== 'string'
        || !/^[!-~]{1,8192}$/.test(response.value)) throw invalid()
      return invoke('respond', { expected_binding: binding(expected), expected_prompt_digest: prompt_digest,
        response: { kind: 'authorization_code', value: response.value } })
    },
    async close() { closed = true; await client.close() },
  }
}
