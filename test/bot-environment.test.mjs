import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { loadBotEnvironment, removeSeatClaudeCopies, restoreBotEnvironments } from '../src/bot-environment.mjs'
import { AitermClient, AitermTransport } from '../src/aiterm-transport.mjs'
import { runShellCommand } from '../src/scheduler.mjs'
import { runtimeEnvironment, runtimeEnvironmentKeys, runtimeHome } from '../src/runtime-home.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bellteam environment-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bots = new Map()
  for (const id of ['bot-a', 'bot-b']) {
    const project = join(root, id)
    await mkdir(join(project, 'environment'), { recursive: true })
    bots.set(id, { id, project, harness: 'grok' })
  }
  return { root, bots, a: bots.get('bot-a').project, b: bots.get('bot-b').project }
}

test('Bot別のPATH・npm導入先・複雑な環境変数を子プロセスへ渡し、親と他Botへ混ぜない', async t => {
  const { a, b } = await fixture(t)
  await writeFile(join(a, 'environment/env.sh'), 'CUSTOM_VALUE=\'line one\n$literal "quote"\'\nPATH="$BELLTEAM_PROJECT/custom bin:$PATH"\necho harmless-output\n')
  const originalPath = process.env.PATH
  const [envA, envB] = await Promise.all([loadBotEnvironment(a), loadBotEnvironment(b)])
  assert.equal(envA.CUSTOM_VALUE, 'line one\n$literal "quote"')
  assert.equal(envB.CUSTOM_VALUE, undefined)
  assert.equal(process.env.CUSTOM_VALUE, undefined)
  assert.equal(process.env.PATH, originalPath)
  assert.equal(envA.npm_config_prefix, join(a, '.local'))
  assert.equal(envB.npm_config_prefix, join(b, '.local'))
  assert.equal(envA.npm_config_cache, join(a, '.cache/npm'))
  assert.equal(envB.PIP_CACHE_DIR, join(b, '.cache/pip'))
  for (const env of [envA, envB]) {
    assert.equal(env.GH_CONFIG_DIR, '/srv/bellteam/shared/tools/github/gh')
    assert.equal(env.GIT_CONFIG_GLOBAL, '/srv/bellteam/shared/tools/github/gitconfig')
  }
  assert.ok(envA.PATH.startsWith(`${a}/custom bin:${a}/.local/bin:`))
  assert.ok(!envB.PATH.includes(a))
  const result = await runShellCommand({ cwd: a, command: 'printf "%s" "$CUSTOM_VALUE"' })
  assert.equal(result.code, 0)
  assert.equal(result.stdout, envA.CUSTOM_VALUE)
})

test('席ではClaude Codeを自動更新させない', async t => {
  const { a } = await fixture(t)
  assert.equal((await loadBotEnvironment(a)).DISABLE_AUTOUPDATER, '1')
  const result = await runShellCommand({ cwd: a, command: 'printf "%s" "$DISABLE_AUTOUPDATER"' })
  assert.equal(result.stdout, '1')
})

test('席に出来たClaude Codeの写しとその入口だけを片付け、席のほかの物を残す', async t => {
  const { bots, a, b } = await fixture(t)
  const present = async path => access(path).then(() => true, () => false)
  // bot-a：自動更新で出来た写しと入口。同じ置き場に、席が入れた別の道具と、同じscopeの別のパッケージがある。
  await mkdir(join(a, '.local/lib/node_modules/@anthropic-ai/claude-code/bin'), { recursive: true })
  await writeFile(join(a, '.local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe'), 'copy')
  await mkdir(join(a, '.local/lib/node_modules/@anthropic-ai/sdk'), { recursive: true })
  await writeFile(join(a, '.local/lib/node_modules/@anthropic-ai/sdk/index.js'), 'sdk')
  await mkdir(join(a, '.local/lib/node_modules/mcp-remote'), { recursive: true })
  await writeFile(join(a, '.local/lib/node_modules/mcp-remote/proxy.js'), 'tool')
  await mkdir(join(a, '.local/bin'), { recursive: true })
  await symlink('../lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe', join(a, '.local/bin/claude'))
  await symlink('../lib/node_modules/mcp-remote/proxy.js', join(a, '.local/bin/mcp-remote'))
  // bot-b：写しは無く、席が自分で置いた `claude` という名前の入口だけがある。
  await mkdir(join(b, '.local/bin'), { recursive: true })
  await writeFile(join(b, '.local/bin/claude'), '#!/bin/sh\n')
  const reports = []

  assert.deepEqual(await removeSeatClaudeCopies(bots, { report: message => reports.push(message) }), ['bot-a'])

  assert.equal(await present(join(a, '.local/lib/node_modules/@anthropic-ai/claude-code')), false)
  assert.equal(await present(join(a, '.local/bin/claude')), false)
  assert.equal(await readFile(join(a, '.local/lib/node_modules/@anthropic-ai/sdk/index.js'), 'utf8'), 'sdk')
  assert.equal(await readFile(join(a, '.local/bin/mcp-remote'), 'utf8'), 'tool')
  assert.equal(await readFile(join(b, '.local/bin/claude'), 'utf8'), '#!/bin/sh\n')
  assert.equal(reports.length, 1)
  // 2回目は何もしない。
  assert.deepEqual(await removeSeatClaudeCopies(bots, { report: message => reports.push(message) }), [])
  assert.equal(reports.length, 1)
})

test('復元はenv.shより先に実行でき、失敗したBotのログを残して次のBotへ進む', async t => {
  const { bots, a, b } = await fixture(t)
  await writeFile(join(a, 'environment/env.sh'), '. ./not-created-yet\n')
  await writeFile(join(a, 'environment/setup.sh'), 'echo install-failed\nexit 7\n')
  await writeFile(join(b, 'environment/setup.sh'), 'echo restored > restored.txt\n')
  const results = await restoreBotEnvironments(bots, { report() {} })
  assert.deepEqual(results, [{ botId: 'bot-a', code: 7 }, { botId: 'bot-b', code: 0 }])
  assert.match(await readFile(join(a, 'environment/setup.log'), 'utf8'), /install-failed[\s\S]*終了コード: 7/u)
  assert.equal(await readFile(join(b, 'restored.txt'), 'utf8'), 'restored\n')
  await assert.rejects(loadBotEnvironment(a), /not-created-yet/u)
})

test('生成物を消した次の起動で構築手順から復元でき、既存スクリプトを上書きしない', async t => {
  const { bots, a } = await fixture(t)
  const script = 'mkdir -p output\nprintf "%s" "$BELLTEAM_PROJECT" > output/result\n'
  await writeFile(join(a, 'environment/setup.sh'), script)
  await restoreBotEnvironments(bots, { report() {} })
  await rm(join(a, 'output'), { recursive: true })
  await restoreBotEnvironments(bots, { report() {} })
  assert.equal(await readFile(join(a, 'output/result'), 'utf8'), a)
  assert.equal(await readFile(join(a, 'environment/setup.sh'), 'utf8'), script)
})

test('4種のCLI起動へBotの環境を値の混在なしで渡す', async t => {
  const { a } = await fixture(t)
  await writeFile(join(a, 'environment/env.sh'), 'LAUNCH_MARKER=own-tool\nCLAUDE_CONFIG_DIR=/wrong-claude\n' + runtimeEnvironmentKeys.map(key => `${key}=/wrong-home\n`).join(''))
  const calls = []
  const client = { async call(name, args, options) {
    calls.push({ name, args, options })
    return { structuredContent: { session_id: args.session_name } }
  } }
  const transport = new AitermTransport({ client, handoffContext: async () => '' })
  for (const harness of ['grok', 'claude', 'codex', 'cursor']) {
    await transport.wake({ id: harness, harness, project: a })
    assert.equal(calls.at(-1).name, 'agent_launch')
    assert.equal(calls.at(-1).options.env.LAUNCH_MARKER, 'own-tool')
    assert.equal(calls.at(-1).options.env.BELLTEAM_PROJECT, a)
    assert.equal(calls.at(-1).options.env.HOME, runtimeHome())
    assert.equal(calls.at(-1).options.env.CODEX_HOME, join(runtimeHome(), '.codex'))
    assert.equal(calls.at(-1).options.env.GROK_HOME, join(runtimeHome(), '.grok'))
    for (const key of runtimeEnvironmentKeys) assert.equal(calls.at(-1).options.env[key], runtimeEnvironment()[key])
    assert.equal(calls.at(-1).options.env.CLAUDE_CONFIG_DIR, undefined)
    assert.equal(JSON.stringify(calls.at(-1).args).includes('own-tool'), false)
  }
})

test('Aitermの短命MCP接続は環境値を個別に持ち、ツール引数へ変数名だけを渡す', async t => {
  const { root } = await fixture(t)
  const previousHome = process.env.BELLTEAM_HOME
  process.env.BELLTEAM_HOME = join(root, 'runtime')
  t.after(() => {
    if (previousHome === undefined) delete process.env.BELLTEAM_HOME
    else process.env.BELLTEAM_HOME = previousHome
  })
  const command = join(root, 'fake-aiterm')
  const sdk = new URL('../node_modules/@modelcontextprotocol/sdk/dist/esm/', import.meta.url)
  await writeFile(command, `#!${process.execPath}\n(async () => {
    const { Server } = await import(${JSON.stringify(new URL('server/index.js', sdk).href)});
    const { StdioServerTransport } = await import(${JSON.stringify(new URL('server/stdio.js', sdk).href)});
    const { CallToolRequestSchema } = await import(${JSON.stringify(new URL('types.js', sdk).href)});
    const server = new Server({name:'test',version:'1'}, {capabilities:{tools:{}}});
    server.setRequestHandler(CallToolRequestSchema, async request => ({content:[{type:'text',text:JSON.stringify({marker:process.env.ENV_TEST_MARKER,home:process.env.HOME,codexHome:process.env.CODEX_HOME,args:request.params.arguments})}]}));
    await server.connect(new StdioServerTransport());
  })();\n`, { mode: 0o755 })
  const client = new AitermClient({ command })
  const normal = JSON.parse((await client.call('diagnostics')).content[0].text)
  assert.equal(normal.home, runtimeHome())
  assert.equal(normal.codexHome, join(runtimeHome(), '.codex'))
  await client.close()
  const results = await Promise.all(['first value', 'second value'].map(marker => client.call(
    'agent_launch', { harness: 'grok-cli' }, { env: { ...runtimeEnvironment(), ENV_TEST_MARKER: marker } },
  )))
  for (const [i, marker] of ['first value', 'second value'].entries()) {
    const data = JSON.parse(results[i].content[0].text)
    assert.equal(data.marker, marker)
    assert.equal(data.home, runtimeHome())
    assert.equal(data.codexHome, join(runtimeHome(), '.codex'))
    assert.ok(data.args.env_vars.includes('ENV_TEST_MARKER'))
    for (const key of runtimeEnvironmentKeys) assert.ok(data.args.env_vars.includes(key), key)
    assert.equal(JSON.stringify(data.args).includes(marker), false)
  }
  assert.equal(client.client, null)
})
