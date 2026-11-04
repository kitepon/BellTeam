import { createConnection } from 'node:net'
import { lstat, readFile } from 'node:fs/promises'
const socketPath = '/run/bellteam-updater/update.sock'
const failure = (code, outcome = 'unknown', status = 503) => Object.assign(new Error(code), { code, outcome, status })

export async function createUpdateClients() {
  const module = createContainerUpdateClient()
  try {
    const directory = await lstat('/run/bellteam-container-updater')
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw failure('HOST_UPDATE_SOCKET_INVALID', 'not_accepted')
  } catch (error) {
    if (error.code === 'ENOENT') return { container: module, module }
    throw error
  }
  return { container: createContainerUpdateClient('/run/bellteam-container-updater/update.sock'), module }
}

export function createContainerUpdateClient(path = socketPath) {
  const call = (operation, params) => new Promise((resolve, reject) => {
    const raw = Buffer.from(JSON.stringify({ operation, params }) + '\n')
    if (raw.length > 65536) return reject(failure('HOST_UPDATE_MESSAGE_LIMIT', 'not_accepted', 400))
    let attempted = false, settled = false, response = Buffer.alloc(0)
    const socket = createConnection({ path })
    const finish = (error, value) => {
      if (settled) return
      settled = true; socket.destroy()
      error ? reject(error) : resolve(value)
    }
    const unavailable = () => finish(failure('HOST_UPDATE_UNAVAILABLE', attempted ? 'unknown' : 'not_accepted'))
    socket.setTimeout(5000, unavailable)
    socket.once('error', unavailable)
    socket.once('connect', () => { attempted = true; socket.write(raw, error => { if (error) unavailable() }) })
    socket.on('data', chunk => {
      response = Buffer.concat([response, chunk])
      if (response.length > 65536) return finish(failure('HOST_UPDATE_RESPONSE_LIMIT'))
      const end = response.indexOf(10)
      if (end < 0) return
      try {
        if (end !== response.length - 1) throw new Error()
        const value = JSON.parse(response.subarray(0, end).toString('utf8'))
        if (value?.ok === true && Object.keys(value).sort().join(',') === 'ok,value') return finish(null, value.value)
        const error = value?.error
        if (value?.ok !== false || Object.keys(value).sort().join(',') !== 'error,ok'
          || !error || Object.keys(error).sort().join(',') !== 'code,outcome,status'
          || !/^[A-Z_0-9]{1,100}$/.test(error.code) || !['not_accepted','unknown'].includes(error.outcome)
          || ![400,403,404,409,503].includes(error.status)) throw new Error()
        finish(failure(error.code, error.outcome, error.status))
      } catch { finish(failure('HOST_UPDATE_RESPONSE_INVALID')) }
    })
    socket.once('end', () => { if (!settled) unavailable() })
    socket.once('close', () => { if (!settled) unavailable() })
  })
  return {
    capabilities: async () => { try { return await call('capabilities', {}) }
      catch { return { supported: false, reason: 'HOST_UPDATE_UNAVAILABLE', currentRequestId: null, previousRequestId: null } } },
    moduleInstallCapabilities: async () => {
      try {
        const value = await call('capabilities', {})
        if (value?.moduleInstallerSource !== undefined) {
          const distribution = JSON.parse(await readFile('/app/distribution.json', 'utf8'))
          if (!/^[a-f0-9]{40}$/.test(value.moduleInstallerSource) || distribution.sourceCommit !== value.moduleInstallerSource)
            return { supported: false, reason: 'HOST_MODULE_SOURCE_CHANGED' }
        }
        const supported = typeof value?.moduleInstallSupported === 'boolean' ? value.moduleInstallSupported : value?.supported
        return supported === true && value.moduleInstallProtocol === 1 ? { supported: true, reason: null }
          : { supported: false, reason: /^[A-Z_0-9]{1,100}$/.test(value?.moduleInstallReason ?? value?.reason ?? '') ? (value.moduleInstallReason ?? value.reason) : 'HOST_MODULE_INSTALL_UNAVAILABLE' }
      } catch { return { supported: false, reason: 'HOST_MODULE_INSTALL_UNAVAILABLE' } }
    },
    catalog: componentId => call('catalog', { componentId }),
    plan: params => call('plan', params),
    planModuleInstall: params => call('plan', params),
    startModuleInstall: ({ requestId, planId }) => call('start', { requestId, planId, confirmContainerRestart: false }),
    start: params => call('start', params),
    operation: requestId => call('get', { requestId }),
  }
}
