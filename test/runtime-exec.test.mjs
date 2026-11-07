import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import test from 'node:test'

const script = new URL('../scripts/runtime-exec.mjs', import.meta.url).pathname
const run = (args, generation) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8',
  env: { PATH: process.env.PATH, ...(generation === undefined ? {} : { BELLTEAM_RUNTIME_GENERATION: generation }) } })

test('--resolve prints the inherited generation path; failures are nonzero with a fixed code', () => {
  const builtin = run(['--resolve', 'runtime-aiterm-mcp', 'dist'], '')
  assert.deepEqual([builtin.status, builtin.stdout], [0, '/usr/local/lib/node_modules/aiterm-mcp/dist\n'])
  assert.equal(run(['--resolve', 'runtime-codex', 'codex'], '').stdout, '/usr/local/bin/codex\n')
  for (const [args, generation, code] of [
    [['--resolve', 'runtime-aiterm-mcp', 'dist'], 'f'.repeat(64), 'RUNTIME_BINDING_UNAVAILABLE'],
    [['--resolve', 'runtime-npm', 'x'], '', 'RUNTIME_COMPONENT_INVALID'],
    [['--resolve', 'runtime-codex', '../../etc/passwd'], '', 'RUNTIME_ENTRY_INVALID'],
    [['--resolve', 'runtime-codex', 'dist'], '', 'RUNTIME_ENTRY_INVALID'],
    [['runtime-aiterm-mcp', 'dist'], '', 'RUNTIME_ENTRY_INVALID'],
  ]) {
    const result = run(args, generation)
    assert.deepEqual([result.status, result.stdout, result.stderr], [1, '', `${code}\n`])
  }
})

test('exec mode runs the bin with the original args and propagates its exit code', { skip: !existsSync('/usr/local/bin/throughline') }, () => {
  const result = run(['runtime-throughline', 'throughline', '--version'], '')
  assert.equal(result.status, 0)
  assert.match(result.stdout, /\d+\.\d+\.\d+/u)
})
