import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { configureHarnesses, writeHarnessConfig } from '../src/harness-config.mjs'

test('通話OFFでは四つのCLIから管理登録を外し、他のMCPを保持する', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bellteam-call-disabled-'))
  const bots = new Map()
  await writeHarnessConfig(bots, home, { callBridge: { enabled: true, url: 'http://localhost:18910/mcp' } })
  const claudePath = join(home, '.claude.json')
  const claude = JSON.parse(await readFile(claudePath, 'utf8'))
  claude.mcpServers.other = { command: 'other' }
  await writeFile(claudePath, JSON.stringify(claude))
  await writeHarnessConfig(bots, home, { callBridge: { enabled: false } })
  for (const path of ['.codex/config.toml', '.grok/config.toml', '.claude.json', '.cursor/mcp.json'])
    assert.doesNotMatch(await readFile(join(home, path), 'utf8'), /call-bridge/u)
  assert.equal(JSON.parse(await readFile(claudePath, 'utf8')).mcpServers.other.command, 'other')
})

test('四つのハーネスへBellTeam設定を反映する', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bellteam-harness-config-'))
  const bots = new Map([['bot-new', { project: '/srv/bellteam/bots/bot-new' }]])

  await writeHarnessConfig(bots, home)

  const config = await readFile(join(home, '.codex/config.toml'), 'utf8')
  assert.match(config, /\[projects\."\/srv\/bellteam\/bots\/bot-new"\]\ntrust_level = "trusted"/u)
  // 席ごとのnodeを起こさず、supervisorの内部入口へHTTPで直結する。席の名札は各CLIの書き方で環境変数から写す。
  assert.match(config, /\[mcp_servers\.bellteam\]\nurl = "http:\/\/127\.0\.0\.1:4181\/mcp"\nenv_http_headers = \{ "X-Bellteam-Seat" = "AITERM_SESSION_ID" \}\nstartup_timeout_sec = 30\ntool_timeout_sec = 120\n/u)
  assert.match(config, /\[mcp_servers\.call-bridge\]\nurl = "http:\/\/127\.0\.0\.1:4181\/mcp\/call-bridge"\nenv_http_headers = /u)
  const grok = await readFile(join(home, '.grok/config.toml'), 'utf8')
  assert.match(grok, /\[mcp_servers\.bellteam\]\nurl = "http:\/\/127\.0\.0\.1:4181\/mcp"\nheaders = \{ "X-Bellteam-Seat" = "\$\{AITERM_SESSION_ID\}" \}\nstartup_timeout_sec = 30\ntool_timeout_sec = 120\nenabled = true\n/u)
  assert.match(grok, /\[mcp_servers\.call-bridge\]\nurl = "http:\/\/127\.0\.0\.1:4181\/mcp\/call-bridge"\nheaders = [^\n]+\nstartup_timeout_sec = 30\ntool_timeout_sec = 120\nenabled = true\n/u)
  const claude = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8'))
  const cursor = JSON.parse(await readFile(join(home, '.cursor/mcp.json'), 'utf8'))
  for (const value of [claude, cursor]) assert.deepEqual(Object.keys(value.mcpServers).sort(), ['aiterm', 'bellteam', 'call-bridge'])
  assert.deepEqual(claude.mcpServers.bellteam, { type: 'http', url: 'http://127.0.0.1:4181/mcp', headers: { 'X-Bellteam-Seat': '${AITERM_SESSION_ID}' } })
  assert.deepEqual(claude.mcpServers['call-bridge'], { type: 'http', url: 'http://127.0.0.1:4181/mcp/call-bridge', headers: { 'X-Bellteam-Seat': '${AITERM_SESSION_ID}' } })
  assert.deepEqual(cursor.mcpServers.bellteam, { url: 'http://127.0.0.1:4181/mcp', headers: { 'X-Bellteam-Seat': '${env:AITERM_SESSION_ID}' } })
  assert.deepEqual(cursor.mcpServers['call-bridge'], { url: 'http://127.0.0.1:4181/mcp/call-bridge', headers: { 'X-Bellteam-Seat': '${env:AITERM_SESSION_ID}' } })
  // 合言葉と通話ブリッジの接続先は、席のCLIの設定へ書かない。
  for (const path of ['.codex/config.toml', '.grok/config.toml', '.claude.json', '.cursor/mcp.json'])
    assert.doesNotMatch(await readFile(join(home, path), 'utf8'), /Bearer |18910|header-file|mcp-remote/u)
})

test('BellTeam設定の後に公式Throughline installを実行する', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bellteam-throughline-config-'))
  const calls = []
  await configureHarnesses(new Map(), home, {
    run: async (command, args, options) => { calls.push([command, args, options.env.HOME]) },
    rtk: async (value, { run }) => { calls.push(['rtk', value, typeof run]) },
    aitermHooks: async value => { calls.push(['aiterm', value]) },
  })
  assert.deepEqual(calls, [['throughline', ['install'], home], ['rtk', home, 'function'], ['aiterm', home]])
  assert.match(await readFile(join(home, '.codex/config.toml'), 'utf8'), /mcp_servers\.bellteam/u)
})

test('RTKのhookを登録できなくても設定の反映は止めず、理由を記録する', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bellteam-rtk-failure-'))
  const reported = []
  await configureHarnesses(new Map(), home, {
    run: async () => {},
    rtk: async () => { throw new Error('RTK_CODEX_HOOK_NOT_TRUSTED') },
    aitermHooks: async () => {},
    report: message => reported.push(message),
  })
  assert.deepEqual(reported, ['BellTeam RTK: hookを登録できませんでした（RTK_CODEX_HOOK_NOT_TRUSTED）'])
})

test('Codex設定更新はhookの信頼記録と他プロジェクトを保持する', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bellteam-codex-trust-'))
  await mkdir(join(home, '.codex'), { recursive: true })
  await writeFile(join(home, '.codex/config.toml'), `approval_policy = "never"

[mcp_servers.bellteam]
command = "old"

[mcp_servers.call-bridge]
command = "old-call-bridge"

[projects."/srv/bellteam/bots/old-bot"]
trust_level = "trusted"

[projects."/work/unrelated"]
trust_level = "trusted"

[features]
codex_hooks = true

[hooks.state."/home/bell/.codex/hooks.json:Stop:0:0"]
trusted_hash = "sha256:kept"
`, 'utf8')

  await writeHarnessConfig(new Map([['bot-new', { project: '/srv/bellteam/bots/bot-new' }]]), home)

  const config = await readFile(join(home, '.codex/config.toml'), 'utf8')
  assert.match(config, /\[hooks\.state\."\/home\/bell\/\.codex\/hooks\.json:Stop:0:0"\]\ntrusted_hash = "sha256:kept"/u)
  assert.match(config, /\[features\]\ncodex_hooks = true/u)
  assert.match(config, /\[projects\."\/work\/unrelated"\]/u)
  assert.match(config, /\[projects\."\/srv\/bellteam\/bots\/bot-new"\]/u)
  assert.doesNotMatch(config, /\[projects\."\/srv\/bellteam\/bots\/old-bot"\]/u)
  assert.equal(config.match(/\[mcp_servers\.bellteam\]/gu)?.length, 1)
  assert.equal(config.match(/\[mcp_servers\.call-bridge\]/gu)?.length, 1)
  assert.match(config, /\[mcp_servers\.call-bridge\]\nurl = "http:/u)
  assert.doesNotMatch(config, /command = "old"/u)
  assert.doesNotMatch(config, /old-call-bridge/u)
})

test('Grok設定更新はbellteam/aiterm以外のMCPを保持する', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bellteam-grok-mcp-'))
  await mkdir(join(home, '.grok'), { recursive: true })
  await writeFile(join(home, '.grok/config.toml'), `[ui]
permission_mode = "always-approve"

[mcp_servers.bellteam]
command = "old"
enabled = true

[mcp_servers.aiterm]
command = "old-aiterm"
enabled = true

[mcp_servers.call-bridge]
command = "old-call-bridge"

[mcp_servers.call-bridge.headers]
Authorization = "Bearer stale"

[mcp_servers.x-article]
url = "http://192.168.1.2:39210/mcp"

[mcp_servers.x-article.headers]
Authorization = "Bearer keep-me"

[marketplace]
default_skills_installs_purged = true
`, 'utf8')

  // 同梱のaiterm-mcpを読めない環境。Aitermの起動先はPATH上の aiterm-mcp になる。
  await writeHarnessConfig(new Map(), home, { aiterm: async () => { throw new Error('ERR_MODULE_NOT_FOUND') } })

  const config = await readFile(join(home, '.grok/config.toml'), 'utf8')
  assert.match(config, /\[mcp_servers\.x-article\]\nurl = "http:\/\/192\.168\.1\.2:39210\/mcp"/u)
  assert.match(config, /\[mcp_servers\.x-article\.headers\]\nAuthorization = "Bearer keep-me"/u)
  assert.match(config, /\[marketplace\]\ndefault_skills_installs_purged = true/u)
  assert.equal(config.match(/\[mcp_servers\.bellteam\]/gu)?.length, 1)
  assert.equal(config.match(/\[mcp_servers\.call-bridge\]/gu)?.length, 1)
  assert.match(config, /\[mcp_servers\.call-bridge\]\nurl = "http:/u)
  assert.equal(config.match(/\[ui\]/gu)?.length, 1)
  assert.doesNotMatch(config, /command = "old"/u)
  assert.doesNotMatch(config, /Bearer stale|old-call-bridge/u)
  assert.match(config, /\[mcp_servers\.aiterm\]\ncommand = "aiterm-mcp"\nargs = \[\]\nstartup_timeout_sec = 30\ntool_timeout_sec = 120\nenabled = true/u)
})

test('ほかの道具が管理節の下へ書き分けた表を残さず、GrokとCodexの設定を読める形に保つ', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bellteam-managed-subtables-'))
  await mkdir(join(home, '.grok'), { recursive: true })
  await mkdir(join(home, '.codex'), { recursive: true })
  // Approval Boxのsetupは設定を書き直す時、行内の表（headers = { … }）を下の表へ書き分ける。
  const rewritten = `[mcp_servers.bellteam]
url = "http://127.0.0.1:4181/mcp"
enabled = true

[mcp_servers.bellteam.headers]
X-Bellteam-Seat = "\${AITERM_SESSION_ID}"

[mcp_servers.aiterm]
command = "/usr/local/bin/node"

[mcp_servers.aiterm.env]
STALE = "1"

[mcp_servers.call-bridge]
url = "http://127.0.0.1:4181/mcp/call-bridge"

[mcp_servers.call-bridge.headers]
X-Bellteam-Seat = "\${AITERM_SESSION_ID}"

[mcp_servers.approval-box]
command = "/usr/local/bin/node"

[mcp_servers.approval-box.env]
KEEP = "1"
`
  await writeFile(join(home, '.grok/config.toml'), rewritten, 'utf8')
  await writeFile(join(home, '.codex/config.toml'), rewritten, 'utf8')

  await writeHarnessConfig(new Map(), home)

  for (const path of ['.grok/config.toml', '.codex/config.toml']) {
    const config = await readFile(join(home, path), 'utf8')
    const headers = [...config.matchAll(/^\[([^\n]+)\]$/gmu)].map(match => match[1])
    assert.equal(new Set(headers).size, headers.length, `${path} に同じ節が二重にある`)
    assert.deepEqual(headers.filter(header => /^mcp_servers\.(bellteam|aiterm|call-bridge)\./u.test(header)), [], `${path} に管理節の下の表が残っている`)
    assert.doesNotMatch(config, /STALE/u)
    assert.match(config, /\[mcp_servers\.approval-box\.env\]\nKEEP = "1"/u)
  }
  // 行内のheadersと下の表のheadersが両方あると、Grokは設定全体を読めず、MCPが1つも無い状態になる。
  const grok = await readFile(join(home, '.grok/config.toml'), 'utf8')
  assert.equal(grok.match(/X-Bellteam-Seat/gu)?.length, 2)
})

test('Aitermの登録はaiterm-setupが書くものと同じ形にし、timeoutを付ける', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bellteam-aiterm-registration-'))
  const registration = { command: '/usr/local/bin/node', args: ['/aiterm/dist/index.js'] }

  await writeHarnessConfig(new Map(), home, { aiterm: async () => registration })

  const section = '[mcp_servers.aiterm]\ncommand = "/usr/local/bin/node"\nargs = ["/aiterm/dist/index.js"]\nstartup_timeout_sec = 30\ntool_timeout_sec = 120\n'
  assert.ok((await readFile(join(home, '.codex/config.toml'), 'utf8')).includes(section))
  assert.ok((await readFile(join(home, '.grok/config.toml'), 'utf8')).includes(`${section}enabled = true\n`))
  assert.deepEqual(JSON.parse(await readFile(join(home, '.claude.json'), 'utf8')).mcpServers.aiterm, registration)
  const cursor = JSON.parse(await readFile(join(home, '.cursor/mcp.json'), 'utf8')).mcpServers.aiterm
  assert.deepEqual({ command: cursor.command, args: cursor.args }, registration)
})

test('CodexのAiterm登録にだけ、席の環境から渡す変数名を挙げ、本体専用の変数は挙げない', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bellteam-aiterm-env-'))

  await writeHarnessConfig(new Map(), home, { aiterm: async () => ({ command: '/usr/local/bin/node', args: ['/aiterm/dist/index.js'] }) })

  const codex = await readFile(join(home, '.codex/config.toml'), 'utf8')
  const names = JSON.parse(codex.match(/\[mcp_servers\.aiterm\]\n(?:[^\[\n][^\n]*\n)*?env_vars = (\[[^\n]+\])\n/u)[1])
  for (const name of ['BELLTEAM_PROJECT', 'GH_CONFIG_DIR', 'GIT_CONFIG_GLOBAL', 'XDG_CONFIG_HOME', 'npm_config_prefix'])
    assert.ok(names.includes(name), name)
  assert.deepEqual(names.filter(name => /KEY|TOKEN|SECRET|_CF_/u.test(name)), [])
  assert.doesNotMatch(await readFile(join(home, '.grok/config.toml'), 'utf8'), /env_vars/u)
})

test('CursorのAiterm登録は、席の環境にある変数だけを名前で渡し、Claudeの登録には足さない', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bellteam-aiterm-cursor-env-'))
  const aiterm = async () => ({ command: '/usr/local/bin/node', args: ['/aiterm/dist/index.js'] })

  await writeHarnessConfig(new Map(), home, { aiterm, environment: { RTK_TELEMETRY_DISABLED: '1', BELLTEAM_BUGHUB_KEY: 'secret' } })

  const env = JSON.parse(await readFile(join(home, '.cursor/mcp.json'), 'utf8')).mcpServers.aiterm.env
  assert.equal(env.BELLTEAM_PROJECT, '${env:BELLTEAM_PROJECT}')
  assert.equal(env.GH_CONFIG_DIR, '${env:GH_CONFIG_DIR}')
  assert.equal(env.RTK_TELEMETRY_DISABLED, '${env:RTK_TELEMETRY_DISABLED}')
  // 本体の環境に無い変数を挙げると、Cursorは「${env:…}」という文字列をそのまま値にしてしまう。
  for (const name of ['PLAYWRIGHT_BROWSERS_PATH', 'LC_CTYPE', 'BELLTEAM_ROOT', 'BELLTEAM_BUGHUB_KEY']) assert.equal(Object.hasOwn(env, name), false, name)
  assert.deepEqual(Object.keys(env).filter(name => /KEY|TOKEN|SECRET|_CF_/u.test(name)), [])
  assert.equal(Object.hasOwn(JSON.parse(await readFile(join(home, '.claude.json'), 'utf8')).mcpServers.aiterm, 'env'), false)
})

test('Claude設定にBotフォルダの信頼済み記録を書き、既存の項目は保持する', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bellteam-claude-trust-'))
  await mkdir(join(home, '.claude'), { recursive: true })
  await writeFile(join(home, '.claude.json'), JSON.stringify({
    numStartups: 3,
    mcpServers: { other: { command: 'keep' } },
    projects: { '/bots/bot-a': { allowedTools: ['Bash'] }, '/elsewhere': { hasTrustDialogAccepted: true } },
  }), 'utf8')
  const bots = new Map([
    ['bot-a', { id: 'bot-a', project: '/bots/bot-a' }],
    ['bot-b', { id: 'bot-b', project: '/bots/bot-b' }],
  ])

  await writeHarnessConfig(bots, home)

  const config = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8'))
  assert.equal(config.numStartups, 3)
  assert.equal(config.mcpServers.other.command, 'keep')
  assert.deepEqual(config.projects['/bots/bot-a'], { allowedTools: ['Bash'], hasTrustDialogAccepted: true })
  assert.deepEqual(config.projects['/bots/bot-b'], { hasTrustDialogAccepted: true })
  assert.deepEqual(config.projects['/elsewhere'], { hasTrustDialogAccepted: true })
})

test('Cursorの起動時指示のhookを登録できなくても設定の反映は止めず、理由を記録する', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bellteam-cursor-instructions-failure-'))
  const reported = []
  await configureHarnesses(new Map(), home, {
    run: async () => {},
    rtk: async () => {},
    aitermHooks: async () => {},
    cursorInstructions: async () => { throw new Error('CURSOR_HOOK_CONFIG_INVALID') },
    report: message => reported.push(message),
  })
  assert.deepEqual(reported, ['BellTeam Cursor: 起動時指示のhookを登録できませんでした（CURSOR_HOOK_CONFIG_INVALID）'])
})

test('Aitermの親配送hookを登録できなくても設定の反映は止めず、理由を記録する', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bellteam-aiterm-hooks-failure-'))
  const reported = []
  await configureHarnesses(new Map(), home, {
    run: async () => {},
    rtk: async () => {},
    aitermHooks: async () => { throw new Error('ERR_MODULE_NOT_FOUND') },
    report: message => reported.push(message),
  })
  assert.deepEqual(reported, ['BellTeam Aiterm: 親配送のhookを登録できませんでした（ERR_MODULE_NOT_FOUND）'])
})

test('Mac以外では、席で使えないCodexプラグインのMCPを起動させない設定を1つずつだけ置く', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bellteam-harness-xcode-'))
  const names = ['xcodebuildmcp', 'openai-api-key-local-confirmation']
  const disabled = name => `[mcp_servers.${name}]\ncommand = "true"\nenabled = false\n`

  await writeHarnessConfig(new Map(), home, { platform: 'linux' })
  await writeHarnessConfig(new Map(), home, { platform: 'linux' })
  const config = await readFile(join(home, '.codex/config.toml'), 'utf8')
  for (const name of names) assert.equal(config.split(disabled(name)).length - 1, 1)
  assert.doesNotMatch(await readFile(join(home, '.grok/config.toml'), 'utf8'), /xcodebuildmcp|openai-api-key-local-confirmation/u)

  await writeHarnessConfig(new Map(), home, { platform: 'darwin' })
  assert.doesNotMatch(await readFile(join(home, '.codex/config.toml'), 'utf8'), /xcodebuildmcp|openai-api-key-local-confirmation/u)
})
