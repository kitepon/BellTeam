import test from 'node:test'
import assert from 'node:assert/strict'
import { createModuleChildExitReporter } from '../src/module-child-exit-reporter.mjs'
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
test('restart evidence waits for diagnostics and latest clear uses the same intake', async () => {
  const reporter = createModuleChildExitReporter(), seen = []
  reporter.observeRestartLimit({ kind: 'module_restart_limit', moduleId: 'memory', count: 5, windowSeconds: 1800,
    lastExit: { code: null, signal: null }, lastReason: 'recovery_failed' })
  reporter.observeRestartLimit({ kind: 'module_restart_limit', moduleId: 'memory', cleared: true })
  reporter.attach({ recordModuleRestartLimit: async dto => seen.push(dto) }, true)
  await settle(); assert.deepEqual(seen, [{ kind: 'module_restart_limit', moduleId: 'memory', cleared: true }])
  await reporter.close()
})
