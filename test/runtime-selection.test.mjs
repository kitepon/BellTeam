import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { captureRuntime } from '../src/runtime-selection.mjs'

const scripts = new URL('../scripts/', import.meta.url).pathname

// P5 writes with Python; P6 reads with Node. The generation id must agree byte for byte.
function commitWithPython(root, version) {
  return execFileSync('python3', ['-I', '-c', `
import sys, json
sys.path.insert(0, ${JSON.stringify(scripts)})
sys.path.insert(0, ${JSON.stringify(new URL('./', import.meta.url).pathname)})
import importlib.util
spec = importlib.util.spec_from_file_location('t', ${JSON.stringify(new URL('./runtime-update.test.py', import.meta.url).pathname)})
t = importlib.util.module_from_spec(spec); spec.loader.exec_module(t)
import runtime_update as ru
from pathlib import Path
root = Path(sys.argv[1])
current, _ = ru.read_current(root)
closure = ru.stage(root, 'runtime-codex', *t.codex(sys.argv[2].encode())[0:3], t.PLATFORM)
print(ru.commit(root, 'runtime-codex', closure, 'job', current))
`, root, version], { encoding: 'utf8' }).trim()
}

test('builtin until a selection exists, then release paths; an earlier capture keeps its paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-selection-'))
  try {
    const before = await captureRuntime({ root, builtin: '/usr/local' })
    assert.equal(before.generation, null)
    assert.deepEqual(before.components['runtime-codex'], { origin: 'builtin', prefix: '/usr/local', bin: { codex: '/usr/local/bin/codex' } })
    assert.equal(before.components['runtime-aiterm-mcp'].root, '/usr/local/lib/node_modules/aiterm-mcp')

    const first = commitWithPython(root, 'v1')
    const old = await captureRuntime({ root })
    assert.equal(old.generation, first)
    assert.equal(old.components['runtime-codex'].origin, 'release')
    assert.match(old.components['runtime-codex'].bin.codex, /\/packages\/runtime-codex\/[a-f0-9]{64}\/prefix\/bin\/codex$/u)
    assert.equal(old.components['runtime-claude-code'].origin, 'builtin')

    const second = commitWithPython(root, 'v2')
    const next = await captureRuntime({ root })
    assert.equal(next.generation, second)
    // Resume of a recorded launch re-resolves its own generation, not the newer current one; null = builtin.
    const resumed = await captureRuntime({ root, generation: first })
    assert.deepEqual(resumed, old)
    assert.equal((await captureRuntime({ root, generation: null })).components['runtime-codex'].origin, 'builtin')
    await assert.rejects(captureRuntime({ root, generation: 'e'.repeat(64) }), { code: 'RUNTIME_BINDING_UNAVAILABLE' })
    await assert.rejects(captureRuntime({ root, generation: 'not-a-sha' }), { code: 'RUNTIME_BINDING_UNAVAILABLE' })
    assert.notEqual(next.components['runtime-codex'].bin.codex, old.components['runtime-codex'].bin.codex)
    // The old launch's capture still resolves its own immutable closure.
    assert.equal(execFileSync('cat', [old.components['runtime-codex'].bin.codex], { encoding: 'utf8' }), 'v1')
    assert.equal(execFileSync('cat', [next.components['runtime-codex'].bin.codex], { encoding: 'utf8' }), 'v2')

    // A broken established selection never falls back to builtin code.
    await rm(join(root, 'current.json'))
    await writeFile(join(root, 'current.json'), JSON.stringify({ schema: 'bellteam.runtime-selection.v1', generation: 'f'.repeat(64) }))
    await assert.rejects(captureRuntime({ root }), { code: 'RUNTIME_BINDING_UNAVAILABLE' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
