import assert from 'node:assert/strict'
import test from 'node:test'
import { CLI_HARNESSES, createCliEffects } from '../src/usage-cli-effects.mjs'

const place = '/home/bell/.local'
const fake = replies => {
  const calls = []
  const run = async (command, args, options) => {
    calls.push({ command, args, options })
    const reply = replies.shift()
    if (reply instanceof Error) throw reply
    return reply
  }
  return { run, calls }
}
const found = (path, version) => ({ stdout: `${path}\n${version}\n`, stderr: '', code: 0, signal: null })

test('the vendor table is closed: only the four harnesses, unknown names are refused before any process starts', async () => {
  assert.deepEqual([...CLI_HARNESSES], ['claude', 'codex', 'grok', 'cursor'])
  const { run, calls } = fake([])
  const cli = createCliEffects({ run, place })
  for (const name of ['sh', '../x', 'claude; id', undefined, 'retired']) {
    await assert.rejects(cli.install(name), { code: 'CLI_INSTALL_UNSUPPORTED' })
    await assert.rejects(cli.probe(name), { code: 'CLI_INSTALL_UNSUPPORTED' })
  }
  assert.equal(calls.length, 0)
})

test('probe: user when the CLI resolves under the user place, image elsewhere; never a path or raw output', async () => {
  const { run, calls } = fake([found(`${place}/bin/claude`, 'claude 2.1.330 (Claude Code)'), found('/usr/local/bin/codex', 'codex-cli 0.130.2'),
    { stdout: '', stderr: '', code: 3, signal: null }, found('/usr/local/bin/grok', 'no version here')])
  const cli = createCliEffects({ run, place })
  assert.deepEqual(await cli.probe('claude'), { installed: true, version: '2.1.330', source: 'user' })
  assert.deepEqual(await cli.probe('codex'), { installed: true, version: '0.130.2', source: 'image' })
  assert.deepEqual(await cli.probe('cursor'), { installed: false, version: null, source: null })
  assert.deepEqual(await cli.probe('grok'), { installed: false, version: null, source: null })
  assert.deepEqual(calls[0].args.slice(-1), ['claude'])
  assert.deepEqual(calls[2].args.slice(-1), ['cursor-agent'])
  assert.ok(calls.every(call => call.options.acceptNonzero === true && call.options.signal instanceof AbortSignal && call.options.env === undefined))
})

test('install: the fixed vendor command runs, the answer is only the re-probed version from the user place', async () => {
  const { run, calls } = fake([{ stdout: 'lots of npm output', stderr: '', code: 0, signal: null }, found(`${place}/bin/codex`, 'codex-cli 0.131.0')])
  const cli = createCliEffects({ run, place })
  assert.deepEqual(await cli.install('codex'), { version: '0.131.0' })
  assert.equal(calls[0].command, 'npm')
  assert.deepEqual(calls[0].args, ['install', '--global', '--prefix', place, '@openai/codex@latest'])
})

test('install: grok and cursor use the vendors\' own install scripts; nothing the child sent reaches the command', async () => {
  const { run, calls } = fake([{ stdout: '', stderr: '', code: 0, signal: null }, found(`${place}/bin/grok`, 'grok 0.1.200'),
    { stdout: '', stderr: '', code: 0, signal: null }, found(`${place}/bin/cursor-agent`, '2026.11.18')])
  const cli = createCliEffects({ run, place })
  assert.deepEqual(await cli.install('grok'), { version: '0.1.200' })
  assert.deepEqual(await cli.install('cursor'), { version: '2026.11.18' })
  assert.match(calls[0].args[1], /curl -fsSL https:\/\/x\.ai\/cli\/install\.sh \| bash/u)
  assert.match(calls[0].args[1], /install -m 0755 "\$HOME\/\.grok\/bin\/grok" "\$HOME\/\.local\/bin\/grok"/u)
  assert.match(calls[2].args[1], /curl -fsSL https:\/\/cursor\.com\/install \| bash/u)
})

test('install errors: network, other failure, timeout, and an image copy that did not become a user copy', async () => {
  const bad = (stderr, code = 1) => ({ stdout: '', stderr, code, signal: null })
  const abort = Object.assign(new Error('ABORT_ERR'), { code: 'ABORT_ERR' })
  const { run } = fake([bad('npm error code ENOTFOUND registry.npmjs.org'), bad('npm error EACCES'), abort,
    { stdout: '', stderr: '', code: 0, signal: null }, found('/usr/local/bin/codex', 'codex-cli 0.130.2')])
  const cli = createCliEffects({ run, place })
  await assert.rejects(cli.install('claude'), { code: 'CLI_INSTALL_NETWORK' })
  await assert.rejects(cli.install('claude'), { code: 'CLI_INSTALL_FAILED' })
  await assert.rejects(cli.install('claude'), { code: 'CLI_INSTALL_TIMEOUT' })
  await assert.rejects(cli.install('codex'), { code: 'CLI_INSTALL_FAILED' })
})

test('claude install allows the claude-code install script (npm 12 skips unlisted scripts)', async () => {
  const { run, calls } = fake([{ stdout: '', stderr: '', code: 0, signal: null }, found(`${place}/bin/claude`, 'claude 2.1.328 (Claude Code)')])
  assert.deepEqual(await createCliEffects({ run, place }).install('claude'), { version: '2.1.328' })
  assert.deepEqual(calls[0].args, ['install', '--global', '--prefix', place, '--allow-scripts=@anthropic-ai/claude-code', '@anthropic-ai/claude-code@latest'])
})

test('an install that exits 0 but does not run is removed from the user place, so it cannot shadow a working image CLI', async () => {
  for (const name of ['claude', 'codex', 'grok', 'cursor']) {
    const bin = name === 'cursor' ? 'cursor-agent' : name
    const { run, calls } = fake([{ stdout: '', stderr: '', code: 0, signal: null }, { stdout: '', stderr: 'native binary not installed', code: 3, signal: null }, { stdout: '', stderr: '', code: 0, signal: null }])
    await assert.rejects(createCliEffects({ run, place }).install(name), { code: 'CLI_INSTALL_FAILED' })
    assert.equal(calls[2].command, 'rm')
    assert.deepEqual(calls[2].args, ['-f', `${place}/bin/${bin}`])
  }
})

test('installs run one at a time even when the child asks for two', async () => {
  const order = []
  let release
  const gate = new Promise(resolve => { release = resolve })
  const run = async (command, args) => {
    if (command === 'npm') { order.push(`start ${args.at(-1)}`); if (order.length === 1) await gate; order.push(`end ${args.at(-1)}`); return { stdout: '', stderr: '', code: 0, signal: null } }
    return found(`${place}/bin/x`, 'x 1.2.3')
  }
  const cli = createCliEffects({ run, place })
  const first = cli.install('claude'), second = cli.install('codex')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(order, ['start @anthropic-ai/claude-code@latest'])
  release()
  await Promise.all([first, second])
  assert.deepEqual(order, ['start @anthropic-ai/claude-code@latest', 'end @anthropic-ai/claude-code@latest', 'start @openai/codex@latest', 'end @openai/codex@latest'])
})
