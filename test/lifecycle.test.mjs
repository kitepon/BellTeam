import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'

test('停止シグナルを受けるまでsupervisorの待機処理が生存する', async (t) => {
  const script = 'import("./src/lifecycle.mjs").then(m => { const waiting = m.waitForShutdown(); process.stdout.write("ready\\n"); return waiting })'
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url).pathname,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  t.after(() => child.kill('SIGKILL'))
  const [ready] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) })
  assert.equal(ready.toString(), 'ready\n')
  assert.equal(child.exitCode, null)
  child.kill('SIGTERM')
  const [code, signal] = await once(child, 'exit')
  assert.equal(signal, null)
  assert.equal(code, 0)
})
