import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { migrateThroughlineStorage, runtimeHome, runtimeEnvironment } from '../src/runtime-home.mjs'
import { completedThroughlineTurns, latestThroughlineHandoffContext } from '../src/aiterm-transport.mjs'

const root = new URL('../', import.meta.url)

test('未指定の実行ホームは製品内で完結し、相対指定を拒否する', () => {
  assert.equal(runtimeHome({ HOME: '/host-home' }), new URL('../runtime/home', import.meta.url).pathname)
  assert.throws(() => runtimeHome({ BELLTEAM_HOME: 'relative' }), /BELLTEAM_HOME_ABSOLUTE_REQUIRED/u)
  const env = runtimeEnvironment({ HOME: '/host', BELLTEAM_HOME: '/runtime', CLAUDE_CONFIG_DIR: '/host-claude', CODEX_HOME: '/host-codex', GROK_HOME: '/host-grok', THROUGHLINE_HOME: '/shared/throughline', MARKER: 'kept' })
  assert.equal(env.HOME, '/runtime')
  assert.equal(env.CODEX_HOME, '/runtime/.codex')
  assert.equal(env.GROK_HOME, '/runtime/.grok')
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined)
  assert.equal(env.XDG_CONFIG_HOME, '/runtime/.config')
  assert.equal(env.XDG_STATE_HOME, '/runtime/.local/state')
  assert.equal(env.THROUGHLINE_HOME, '/shared/throughline')
  assert.equal(env.MARKER, 'kept')
})

test('本体だけが使う合鍵は、本体が起こす道具と席の環境へ渡さない', () => {
  const inherited = { BELLTEAM_HOME: '/runtime', BELLTEAM_BUGHUB_KEY: 'diagnostic-secret', MARKER: 'kept' }
  const env = runtimeEnvironment(inherited)
  assert.equal(Object.hasOwn(env, 'BELLTEAM_BUGHUB_KEY'), false)
  assert.equal(JSON.stringify(env).includes('diagnostic-secret'), false)
  assert.equal(env.MARKER, 'kept')
  // 本体が自分で読む元の環境は変えない。
  assert.equal(inherited.BELLTEAM_BUGHUB_KEY, 'diagnostic-secret')
})

test('Throughlineの読み取りにも設定生成と同じホームを渡す', async () => {
  const calls = []
  const run = async (command, args, options) => {
    calls.push(options.env)
    return { stdout: JSON.stringify(args[0] === 'observer-read'
      ? { schema: 'throughline.observer_read.v1', turns: [] }
      : { schema: 'throughline.handoff_context.v1', status: 'empty', sessionId: null, context: '' }) }
  }
  await completedThroughlineTurns('/project', { run })
  await latestThroughlineHandoffContext('/project', { run })
  for (const env of calls) assert.equal(env.HOME, runtimeHome())
})

test('起動ユーザーのHOMEにあるsymlinkを触らず専用homeへ規範と設定を生成する', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'bellteam-home-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const host = join(temp, 'host'), runtime = join(temp, 'runtime')
  const sentinel = join(temp, 'factory-instructions.md')
  await writeFile(sentinel, '工場の正本\n')
  for (const name of ['.claude', '.codex', '.grok', '.cursor', '.gemini']) {
    await mkdir(join(host, name), { recursive: true })
    await symlink(sentinel, join(host, name, 'AGENTS.md'))
  }
  await symlink(sentinel, join(host, '.claude/CLAUDE.md'))
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import {writeHarnessConfig} from './src/harness-config.mjs';
    await writeHarnessConfig(new Map());
  `], { cwd: root, env: { ...process.env, HOME: host, BELLTEAM_HOME: runtime }, stdio: 'pipe' })
  assert.equal(await readFile(sentinel, 'utf8'), '工場の正本\n')
  assert.match(await readFile(join(runtime, '.codex/config.toml'), 'utf8'), /mcp_servers\.bellteam/u)
})

test('Throughlineの旧既定rootをTHROUGHLINE_HOMEへ一度だけ移し、既存の移動先を上書きしない', async () => {
  const base = await mkdtemp(join(tmpdir(), 'bellteam-throughline-migrate-'))
  const env = { HOME: join(base, 'home'), XDG_STATE_HOME: join(base, 'home/.local/state'), XDG_CONFIG_HOME: join(base, 'home/.config'), THROUGHLINE_HOME: join(base, 'shared/throughline') }
  try {
    await mkdir(join(env.THROUGHLINE_HOME), { recursive: true })
    await writeFile(join(env.THROUGHLINE_HOME, 'throughline.db'), 'db')
    await mkdir(join(env.HOME, '.throughline'), { recursive: true })
    await writeFile(join(env.HOME, '.throughline/stale'), 'stale')
    await mkdir(join(env.XDG_STATE_HOME, 'throughline/completed-turn-receipts'), { recursive: true })
    await writeFile(join(env.XDG_STATE_HOME, 'throughline/runtime-errors.json'), '{"v":1}')
    await writeFile(join(env.XDG_STATE_HOME, 'throughline/completed-turn-receipts/a.json'), '{}')
    await mkdir(join(env.XDG_CONFIG_HOME, 'throughline'), { recursive: true })
    await writeFile(join(env.XDG_CONFIG_HOME, 'throughline/settings.json'), '{"c":1}')
    // Different filesystem: the first rename of each source answers EXDEV, the staging rename succeeds.
    const { rename } = await import('node:fs/promises')
    const move = async (from, to) => { if (!from.includes('.migrating-')) throw Object.assign(new Error('cross'), { code: 'EXDEV' }); return rename(from, to) }
    const results = await migrateThroughlineStorage(env, { move })
    assert.deepEqual(results.map(row => row.status), ['kept', 'copied', 'copied'])
    assert.equal(await readFile(join(env.THROUGHLINE_HOME, 'throughline.db'), 'utf8'), 'db')
    assert.equal(await readFile(join(env.HOME, '.throughline/stale'), 'utf8'), 'stale')
    assert.equal(await readFile(join(env.THROUGHLINE_HOME, 'app-state/runtime-errors.json'), 'utf8'), '{"v":1}')
    assert.equal(await readFile(join(env.THROUGHLINE_HOME, 'app-state/completed-turn-receipts/a.json'), 'utf8'), '{}')
    assert.equal(await readFile(join(env.THROUGHLINE_HOME, 'app-config/settings.json'), 'utf8'), '{"c":1}')
    await assert.rejects(readFile(join(env.XDG_STATE_HOME, 'throughline/runtime-errors.json')), { code: 'ENOENT' })
    // Idempotent: nothing left to move; a new source never overwrites the existing destination.
    await mkdir(join(env.XDG_STATE_HOME, 'throughline'), { recursive: true })
    await writeFile(join(env.XDG_STATE_HOME, 'throughline/runtime-errors.json'), '{"v":2}')
    assert.deepEqual((await migrateThroughlineStorage(env)).map(row => row.status), ['kept', 'kept', 'nothing'])
    assert.equal(await readFile(join(env.THROUGHLINE_HOME, 'app-state/runtime-errors.json'), 'utf8'), '{"v":1}')
    // A failure leaves the source and no partial destination, so the next boot retries.
    await rm(join(env.THROUGHLINE_HOME, 'app-state'), { recursive: true })
    const failed = await migrateThroughlineStorage(env, { move: async () => { throw Object.assign(new Error('cross'), { code: 'EXDEV' }) } })
    assert.equal(failed[1].status, 'failed')
    assert.equal(await readFile(join(env.XDG_STATE_HOME, 'throughline/runtime-errors.json'), 'utf8'), '{"v":2}')
    await assert.rejects(readFile(join(env.THROUGHLINE_HOME, 'app-state/runtime-errors.json')), { code: 'ENOENT' })
    assert.deepEqual((await migrateThroughlineStorage(env)).map(row => row.status), ['kept', 'moved', 'nothing'])
    assert.deepEqual(await migrateThroughlineStorage({ ...env, THROUGHLINE_HOME: undefined }), [])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
