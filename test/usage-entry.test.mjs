import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('thin entry rejects missing fixed C/IPC/locks and malformed selection with only a fixed safe error', () => {
  for (const selection of ['builtin', 'a'.repeat(64), '/tmp/arbitrary-entry']) {
    const child = spawnSync(process.execPath, ['src/usage-entry.mjs', selection], { encoding: 'utf8', timeout: 5000 })
    assert.equal(child.status, 1); assert.equal(child.stdout, ''); assert.equal(child.stderr, 'USAGE_START_FAILED\n')
  }
})
