import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runtimeHome, runtimeEnvironment } from '../src/runtime-home.mjs'
import { completedThroughlineTurns, latestThroughlineHandoffContext } from '../src/aiterm-transport.mjs'

const root = new URL('../', import.meta.url)

test('未指定の実行ホームは製品内で完結し、相対指定を拒否する', () => {
  assert.equal(runtimeHome({ HOME: '/host-home' }), new URL('../runtime/home', import.meta.url).pathname)
  assert.throws(() => runtimeHome({ BELLTEAM_HOME: 'relative' }), /BELLTEAM_HOME_ABSOLUTE_REQUIRED/u)
  const env = runtimeEnvironment({ HOME: '/host', BELLTEAM_HOME: '/runtime', CLAUDE_CONFIG_DIR: '/host-claude', CODEX_HOME: '/host-codex', GROK_HOME: '/host-grok', MARKER: 'kept' })
  assert.equal(env.HOME, '/runtime')
  assert.equal(env.CODEX_HOME, '/runtime/.codex')
  assert.equal(env.GROK_HOME, '/runtime/.grok')
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined)
  assert.equal(env.XDG_CONFIG_HOME, '/runtime/.config')
  assert.equal(env.XDG_STATE_HOME, '/runtime/.local/state')
  assert.equal(env.MARKER, 'kept')
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
  for (const name of ['.claude', '.codex', '.grok', '.cursor']) {
    await mkdir(join(host, name), { recursive: true })
    await symlink(sentinel, join(host, name, 'AGENTS.md'))
  }
  await symlink(sentinel, join(host, '.claude/CLAUDE.md'))
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import {writeHarnessConfig} from './src/harness-config.mjs';
    import {createGlobalInstructionsRefresher} from './src/global-instructions.mjs';
    await writeHarnessConfig(new Map());
    await createGlobalInstructionsRefresher({ownerProfile:{get:async()=>({name:'test',bio:'',x:'',github:'',links:[]})},userRules:{get:async()=>''}})();
  `], { cwd: root, env: { ...process.env, HOME: host, BELLTEAM_HOME: runtime }, stdio: 'pipe' })
  assert.equal(await readFile(sentinel, 'utf8'), '工場の正本\n')
  assert.match(await readFile(join(runtime, '.codex/AGENTS.md'), 'utf8'), /BellTeam/u)
  assert.equal(await readFile(join(runtime, '.claude/CLAUDE.md'), 'utf8'), '@AGENTS.md\n')
  assert.match(await readFile(join(runtime, '.codex/config.toml'), 'utf8'), /mcp_servers\.bellteam/u)
})
