import { once } from 'node:events'
import { get } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { loadOperation, nonceDirectory, runtimeIdentity, saveExclusive, trustedFile, fail } from './adopter.mjs'

function inspectorTargets() {
  return new Promise((resolve, reject) => {
    const request = get('http://127.0.0.1:9229/json/list', { timeout: 1000 }, response => {
      let bytes = ''
      response.setEncoding('utf8')
      response.on('data', chunk => {
        bytes += chunk
        if (Buffer.byteLength(bytes) > 16384) request.destroy(new Error('LIVE_INSPECTOR_RESPONSE_SIZE'))
      })
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) fail('LIVE_INSPECTOR_RESPONSE_INVALID')
          const value = JSON.parse(bytes)
          if (!Array.isArray(value) || value.length !== 1) fail('LIVE_INSPECTOR_RESPONSE_INVALID')
          const url = new URL(value[0].webSocketDebuggerUrl)
          if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.port !== '9229'
            || !/^\/[a-f0-9-]{36}$/.test(url.pathname) || url.username || url.password || url.search || url.hash)
            fail('LIVE_INSPECTOR_RESPONSE_INVALID')
          resolve(url.href)
        } catch (error) { reject(error) }
      })
    })
    request.on('timeout', () => request.destroy(Object.assign(new Error('LIVE_INSPECTOR_TIMEOUT'), { code: 'LIVE_INSPECTOR_TIMEOUT' })))
    request.on('error', reject)
  })
}

export async function connectInspector(url) {
  const parsed = new URL(url)
  if (parsed.protocol !== 'ws:' || parsed.hostname !== '127.0.0.1') fail('LIVE_INSPECTOR_ADDRESS_INVALID')
  const socket = new WebSocket(url)
  const opened = once(socket, 'open')
  let timer
  try {
    await Promise.race([opened, new Promise((_, reject) => {
      timer = setTimeout(() => { socket.close(); reject(Object.assign(new Error('LIVE_INSPECTOR_TIMEOUT'), { code: 'LIVE_INSPECTOR_TIMEOUT' })) }, 5000)
    })])
  } finally { clearTimeout(timer) }
  let sequence = 0
  const pending = new Map()
  const end = () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(Object.assign(new Error('LIVE_INSPECTOR_DISCONNECTED'), { code: 'LIVE_INSPECTOR_DISCONNECTED' })) }
    pending.clear()
  }
  socket.addEventListener('close', end)
  socket.addEventListener('error', end)
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (!message.id) return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id); clearTimeout(request.timer)
    if (message.error || message.result?.exceptionDetails) request.reject(Object.assign(new Error('LIVE_INSPECTOR_EVALUATION_FAILED'), { code: 'LIVE_INSPECTOR_EVALUATION_FAILED' }))
    else request.resolve(message.result)
  })
  const evaluate = (expression, timeout = 15000) => new Promise((resolve, reject) => {
    const id = ++sequence
    const deadline = setTimeout(() => {
      pending.delete(id)
      reject(Object.assign(new Error('LIVE_INSPECTOR_ACK_UNKNOWN'), { code: 'LIVE_INSPECTOR_ACK_UNKNOWN' }))
    }, timeout)
    pending.set(id, { resolve, reject, timer: deadline })
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: {
      expression, awaitPromise: true, returnByValue: true,
    } }))
  })
  return { async evaluate(expression) { return (await evaluate(expression)).result.value },
    close() { socket.close(); end() } }
}

async function matchingTarget(target) {
  const actual = await runtimeIdentity(target.pid)
  for (const key of ['pid', 'startTicks', 'bootId', 'pidNamespace', 'networkNamespace'])
    if (actual[key] !== target[key]) fail('LIVE_PARENT_IDENTITY_CHANGED')
  const caller = await runtimeIdentity()
  if (caller.pidNamespace !== target.pidNamespace || caller.networkNamespace !== target.networkNamespace)
    fail('LIVE_CLIENT_NAMESPACE_CHANGED')
  const status = await readFile(`/proc/${target.pid}/status`, 'utf8')
  if (!/^Uid:\s+1001\s+1001\s+1001\s+1001\s*$/m.test(status)) fail('LIVE_PARENT_IDENTITY_CHANGED')
}

function expression(context, method) {
  const module = join(context.directory, 'src/adopter.mjs')
  return `(async () => {
    const fs = process.getBuiltinModule('fs'), crypto = process.getBuiltinModule('crypto');
    const path = ${JSON.stringify(module)};
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.uid !== 0 || st.nlink !== 1 || (st.mode & 0o7022) || st.size > 131072) throw Error('LIVE_ADOPTER_UNTRUSTED');
      if (crypto.createHash('sha256').update(fs.readFileSync(fd)).digest('hex') !== ${JSON.stringify(context.operation.policy.adopterSha256)}) throw Error('LIVE_ADOPTER_CHANGED');
    } finally { fs.closeSync(fd) }
    const require = process.getBuiltinModule('module').createRequire('/app/src/supervisor.mjs');
    return require(path).${method}(${JSON.stringify(context.path)}, ${JSON.stringify(context.operationSha256)});
  })()`
}

async function saved(directory, name) {
  try { return JSON.parse(await trustedFile(join(directory, name), 65536, 1001)) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

export async function runClient(action, path, sha) {
  if (!['apply', 'inspect'].includes(action)) fail('LIVE_CLIENT_ACTION_INVALID')
  if (process.getuid() !== 1001 || process.getgid() !== 1001) fail('LIVE_CLIENT_IDENTITY_INVALID')
  const context = { ...await loadOperation(path, sha), path }
  const directory = await nonceDirectory(context.operation.operationId)
  const previous = await saved(directory, 'client-intent.json'), receipt = await saved(directory, 'receipt.json')
  if (previous && previous.operationSha256 !== sha || receipt && receipt.operationSha256 !== sha) fail('LIVE_OPERATION_CONFLICT')
  if (receipt) return { ...receipt, readOnly: true, historicalReceipt: true }
  if (action === 'apply' && previous) fail('LIVE_CLIENT_ALREADY_ISSUED_USE_INSPECT')
  if (action === 'inspect' && !previous) return { state: 'not_issued', readOnly: true }
  await matchingTarget(context.operation.target)
  let url, session, opened = false
  if (action === 'apply') {
    let absent = false
    try { await inspectorTargets() } catch (error) {
      if (error.code === 'ECONNREFUSED') absent = true
      else throw error
    }
    if (!absent) fail('LIVE_INSPECTOR_ALREADY_ACTIVE')
    await saveExclusive(join(directory, 'client-intent.json'), {
      schema: 'bellteam.live-delivery-client-intent.v1', operationId: context.operation.operationId,
      operationSha256: sha, target: context.operation.target, at: new Date().toISOString(), signalMaximum: 1,
    })
    await matchingTarget(context.operation.target)
    process.kill(context.operation.target.pid, 'SIGUSR1')
    opened = true
    const deadline = performance.now() + 5000
    while (!url) {
      try { url = await inspectorTargets() }
      catch (error) {
        if (error.code !== 'ECONNREFUSED' || performance.now() >= deadline) throw error
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
  } else {
    try { url = await inspectorTargets() }
    catch (error) {
      if (error.code === 'ECONNREFUSED') return { state: 'unconfirmed', operationId: context.operation.operationId, readOnly: true }
      throw error
    }
  }
  try {
    session = await connectInspector(url)
    const target = await session.evaluate('({pid:process.pid})')
    if (target.pid !== context.operation.target.pid) { opened = false; fail('LIVE_INSPECTOR_TARGET_CHANGED') }
    await matchingTarget(context.operation.target)
    const result = await session.evaluate(expression(context, action === 'apply' ? 'applyLiveDeliveryPolicy' : 'inspectLiveDeliveryPolicy'))
    await saveExclusive(join(directory, action === 'apply' ? 'client-result.json' : `inspection-${Date.now()}.json`), result)
    return result
  } finally {
    if (session && opened) {
      // Close the front-end immediately after scheduling shutdown of this newly opened listener.
      try { await session.evaluate("setImmediate(() => process.getBuiltinModule('inspector').close()); true") } catch {}
    }
    session?.close()
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [action, path, sha, ...extra] = process.argv.slice(2)
  try {
    if (extra.length) fail('LIVE_CLIENT_ARGUMENTS_INVALID')
    console.log(JSON.stringify(await runClient(action, path, sha)))
  } catch (error) {
    console.error(JSON.stringify({ code: /^LIVE_[A-Z_]+$/.test(error.code ?? '') ? error.code : 'LIVE_CLIENT_UNCONFIRMED', actionIssuedMayBeUnknown: true }))
    process.exitCode = 1
  }
}
