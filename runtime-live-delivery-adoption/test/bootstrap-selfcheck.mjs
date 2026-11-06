import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { connectInspector } from '../src/client.mjs'

const started = performance.now()
const directory = await mkdtemp(join(import.meta.dirname, '.bootstrap-fixture-'))
let child, socket
try {
  const original = `export class Transport {
    #call(value) { return this.submit(value) }
    constructor() { this.jobs = new Map([['old-job', {}]]); this.callbacks = new Map() }
    submit(value) { return { version: 'old', value } }
    notify(value) { return this.#call(value) }
  }\n`
  const fixed = `const version = 'fixed'; export class Transport {
    submit(value) { return { version, value } }
  }\n`
  await writeFile(join(directory, 'old.mjs'), original)
  await writeFile(join(directory, 'fixed.mjs'), fixed)
  await writeFile(join(directory, 'child.mjs'), `import { Transport } from './old.mjs'
    const transport = new Transport(), jobs = transport.jobs, callbacks = transport.callbacks;
    let resolveOld, oldDone = false, callbackCount = 0;
    const oldPromise = new Promise(resolve => { resolveOld = resolve });
    const oldCallback = () => { callbackCount++; oldDone = true; return 'old-completed' };
    callbacks.set('old-job', oldCallback);
    const completion = oldPromise.then(oldCallback);
    globalThis.probe = { transport, jobs, callbacks, oldPromise, oldCallback, completion, ticks: 0,
      inspect() { return { sameJobs: transport.jobs === jobs, sameCallbacks: transport.callbacks === callbacks,
        sameOldCallback: callbacks.get('old-job') === oldCallback, oldDone, callbackCount, ticks: this.ticks,
        result: transport.notify('new-message') } } };
    const heartbeat = setInterval(() => probe.ticks++, 5);
    process.on('message', async message => {
      if (message === 'finish') { resolveOld(); await completion; process.send(probe.inspect()); clearInterval(heartbeat); process.disconnect() }
    });
    process.send({ ready: true, pid: process.pid });
  `)
  child = fork(join(directory, 'child.mjs'), [], {
    execArgv: ['--inspect-port=127.0.0.1:0'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  child.stdout.resume()
  const [ready] = await once(child, 'message')
  assert.equal(ready.ready, true)
  const inspectorURL = new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('INSPECTOR_START_TIMEOUT')), 5000)
    child.stderr.on('data', chunk => {
      output += chunk.toString()
      const match = output.match(/ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+/)
      if (match) { clearTimeout(timer); resolve(match[0]) }
    })
  })
  process.kill(child.pid, 'SIGUSR1')
  socket = await connectInspector(await inspectorURL)
  const evaluate = expression => socket.evaluate(expression)
  const oldURL = pathToFileURL(join(directory, 'old.mjs')).href
  const newURL = pathToFileURL(join(directory, 'fixed.mjs')).href
  const hash = createHash('sha256').update(original).digest('hex')
  const before = await evaluate('probe.inspect()')
  assert.equal(before.result.version, 'old')
  const adopt = async expected => evaluate(`(async () => {
    const { readFileSync } = process.getBuiltinModule('fs');
    const { createHash } = process.getBuiltinModule('crypto');
    const require = process.getBuiltinModule('module').createRequire(${JSON.stringify(oldURL)});
    const { fileURLToPath } = process.getBuiltinModule('url');
    const oldURL = ${JSON.stringify(oldURL)}, newURL = ${JSON.stringify(newURL)};
    if (createHash('sha256').update(readFileSync(new URL(oldURL))).digest('hex') !== ${JSON.stringify(expected)}) throw Error('OLD_SOURCE_MISMATCH');
    const old = require(fileURLToPath(oldURL)), fixed = require(fileURLToPath(newURL));
    const descriptor = Object.getOwnPropertyDescriptor(fixed.Transport.prototype, 'submit');
    Object.defineProperty(old.Transport.prototype, 'submit', descriptor);
    return probe.inspect();
  })()`)
  await assert.rejects(adopt('0'.repeat(64)), { code: 'LIVE_INSPECTOR_EVALUATION_FAILED' })
  assert.equal((await evaluate('probe.inspect()')).result.version, 'old')
  const adopted = await adopt(hash)
  assert.equal(adopted.result.version, 'fixed')
  assert.equal(adopted.sameJobs && adopted.sameCallbacks && adopted.sameOldCallback, true)
  assert.equal(adopted.oldDone, false)
  assert.equal(adopted.callbackCount, 0)
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.ok((await evaluate('probe.inspect()')).ticks > before.ticks)
  const finished = once(child, 'message')
  const exited = once(child, 'exit')
  await evaluate("setImmediate(() => process.getBuiltinModule('inspector').close()); true")
  socket.close()
  child.send('finish')
  const [final] = await finished
  assert.equal(final.oldDone, true)
  assert.equal(final.callbackCount, 1)
  assert.equal(final.result.version, 'fixed')
  const [code] = await exited
  assert.equal(code, 0)
  console.log(JSON.stringify({ node: process.version, childPid: ready.pid,
    SIGUSR1OpenedExistingProcess: true, inspectorLoopbackOnly: true,
    debuggerPauseCommands: 0, heapQueries: 0, sourceMismatchPreservedOriginal: true,
    privateBrandPreserved: true, oldJobMapCallbackIdentityPreserved: true,
    oldPendingNotReplayed: true, oldActualCompletionCallbackCount: 1,
    heartbeatAdvanced: true, ownInspectorShutdownScheduled: true, childExit: code, milliseconds: performance.now() - started }))
} finally {
  socket?.close()
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  await rm(directory, { recursive: true, force: true })
}
