import { createConnection } from 'node:net'
const socketPath = '/run/bellteam-updater/update.sock'
const failure = (code, outcome = 'unknown', status = 503) => Object.assign(new Error(code), { code, outcome, status })

export function createContainerUpdateClient() {
  const call = (operation, params) => new Promise((resolve, reject) => {
    const raw = Buffer.from(JSON.stringify({ operation, params }) + '\n')
    if (raw.length > 65536) return reject(failure('HOST_UPDATE_MESSAGE_LIMIT', 'not_accepted', 400))
    let attempted = false, settled = false, response = Buffer.alloc(0)
    const socket = createConnection({ path: socketPath })
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
    catalog: componentId => call('catalog', { componentId }),
    plan: params => call('plan', params),
    start: params => call('start', params),
    operation: requestId => call('get', { requestId }),
  }
}
