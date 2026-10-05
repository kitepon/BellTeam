import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { runtimeEnvironment, runtimeHome } from './runtime-home.mjs'
import { defaultCallBridgeMcpUrl } from './distribution-profile.mjs'
import { BELLTEAM_MCP_PATH, CALL_BRIDGE_MCP_PATH, SEAT_HEADER, SEAT_VARIABLE } from './seat-mcp.mjs'
import { configureRtk } from './rtk-hooks.mjs'
import { aitermRegistration, aitermRelay, configureAitermHooks } from './aiterm-hooks.mjs'
import { configureCursorInstructions } from './cursor-instructions.mjs'

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const execFileAsync = promisify(execFile)

export async function configureHarnesses(bots, home = runtimeHome(), { run = execFileAsync, rtk = configureRtk, aitermHooks = configureAitermHooks, cursorInstructions = configureCursorInstructions, callBridge, report = message => process.stderr.write(`${message}\n`) } = {}) {
  await writeHarnessConfig(bots, home, { callBridge })
  await run('throughline', ['install'], { env: runtimeEnvironment(process.env, home) })
  // Cursor CLIは ~/.cursor/AGENTS.md を読まないので、起動時指示はsessionStartのhookで渡す。
  try {
    await cursorInstructions(home)
  } catch (error) {
    report(`BellTeam Cursor: 起動時指示のhookを登録できませんでした（${error.message}）`)
  }
  // RTKはオーナーの指示で標準搭載する（インフラ整備の部屋 2026-09-27）。登録できなくてもBotは動かし、理由を記録する。
  try {
    await rtk(home, { run })
  } catch (error) {
    report(`BellTeam RTK: hookを登録できませんでした（${error.message}）`)
  }
  // AitermのMCPはBellTeamが登録するので、親配送のhookも同じ場所で登録する。登録できなくてもBotは動かし、理由を記録する。
  try {
    await aitermHooks(home)
  } catch (error) {
    report(`BellTeam Aiterm: 親配送のhookを登録できませんでした（${error.message}）`)
  }
}

// CodexとCursorはMCPプロセスへ HOME・PATH・SHELL・TERM しか渡さない。Aitermは自分の環境を、開く端末へ受け継ぐ。
// この2つの席が開く端末でも git・gh・npm などの設定が効くように、席の環境から渡す変数を名前で挙げる。
// 本体専用の変数（合鍵など）は挙げない。
// BellTeamがどの席にも必ず付ける変数（bot-environment.mjs・runtime-home.mjs）。
const AITERM_SEAT_ENV_VARS = [
  'BELLTEAM_HOME', 'BELLTEAM_PROJECT', 'CODEX_HOME', 'GROK_HOME',
  'GH_CONFIG_DIR', 'GIT_CONFIG_GLOBAL', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME',
  'npm_config_cache', 'npm_config_prefix', 'PIP_CACHE_DIR',
]
// 本体の環境にある時だけ席へ受け継がれる変数。
const AITERM_INHERITED_ENV_VARS = ['BELLTEAM_ROOT', 'PLAYWRIGHT_BROWSERS_PATH', 'RTK_TELEMETRY_DISABLED', 'LC_CTYPE']
const UNUSABLE_CODEX_MCPS = ['[mcp_servers.xcodebuildmcp]', '[mcp_servers.openai-api-key-local-confirmation]']

export async function writeHarnessConfig(bots, home = runtimeHome(), { callBridge, aiterm = aitermRegistration, relay = aitermRelay, platform = process.platform, internalPort = Number(process.env.BELLTEAM_INTERNAL_PORT ?? 4181), environment = process.env } = {}) {
  await Promise.all([
    mkdir(join(home, '.claude'), { recursive: true }),
    mkdir(join(home, '.codex'), { recursive: true }),
    mkdir(join(home, '.grok'), { recursive: true }),
    mkdir(join(home, '.cursor'), { recursive: true }),
  ])

  // bellteamと通話MCPは、supervisorの内部入口へHTTPで直結する（席ごとのnodeを起こさない）。
  // 席の名札は、席のCLIが持つ環境変数を各CLIの書き方でヘッダへ写す。CLIごとの書き方の差はここだけに置く。
  const callBridgeEnabled = callBridge === undefined ? Boolean(process.env.BELLTEAM_CALL_BRIDGE_MCP_URL || defaultCallBridgeMcpUrl) : Boolean(callBridge.enabled)
  const seatUrl = path => `http://127.0.0.1:${internalPort}${path}`
  const seatServers = [['bellteam', BELLTEAM_MCP_PATH], ...(callBridgeEnabled ? [['call-bridge', CALL_BRIDGE_MCP_PATH]] : [])]
  const tomlSeat = (header, tail = '') => seatServers.map(([id, path]) =>
    `[mcp_servers.${id}]\nurl = "${seatUrl(path)}"\n${header}\nstartup_timeout_sec = 30\ntool_timeout_sec = 120\n${tail}`).join('\n')
  const jsonSeat = entry => Object.fromEntries(seatServers.map(([id, path]) => [id, entry(seatUrl(path))]))
  // Aitermの本体は `aiterm-setup` が書くものと同じ形（nodeの絶対path＋index.js）で起こす。同梱のaiterm-mcpを読めない環境では、PATH上の aiterm-mcp を起動先にする。
  // 中継（mcp-lazy）がある環境では、その本体を中継ごしに登録する。本体は席がAitermの道具を呼ぶまで起きない。
  const bundledAiterm = await aiterm().catch(() => null)
  const relayPath = bundledAiterm ? await relay() : null
  const aitermFor = harness => relayPath ? relayedAiterm(relayPath, bundledAiterm, harness, home) : bundledAiterm ?? { command: 'aiterm-mcp', args: [] }
  const aitermToml = harness => {
    const server = aitermFor(harness)
    const env = server.env ? `env = { ${Object.entries(server.env).map(([name, value]) => `${name} = ${JSON.stringify(value)}`).join(', ')} }\n` : ''
    return `[mcp_servers.aiterm]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\n${env}startup_timeout_sec = 30\ntool_timeout_sec = 120\n`
  }
  // Codexは、挙げた名前が席の環境に無ければ渡さないだけなので、全部挙げる。
  const codexMcp = `${tomlSeat(`env_http_headers = { "${SEAT_HEADER}" = "${SEAT_VARIABLE}" }`)}\n${aitermToml('codex')}env_vars = ${JSON.stringify([...AITERM_SEAT_ENV_VARS, ...AITERM_INHERITED_ENV_VARS])}\n`
  // Cursorは \${env:名前} を席の環境の値へ置き換える。環境に無い名前は置き換えず、その文字列のまま渡してしまう。
  // 受け継ぐだけの変数は、本体の環境にある時だけ挙げる。
  const cursorAitermEnv = Object.fromEntries([...AITERM_SEAT_ENV_VARS, ...AITERM_INHERITED_ENV_VARS.filter(name => environment[name])]
    .map(name => [name, `\${env:${name}}`]))
  const grokMcp = `${tomlSeat(`headers = { "${SEAT_HEADER}" = "\${${SEAT_VARIABLE}}" }`, 'enabled = true\n')}\n${aitermToml('grok')}enabled = true\n`
  const claudeMcp = { ...jsonSeat(url => ({ type: 'http', url, headers: { [SEAT_HEADER]: `\${${SEAT_VARIABLE}}` } })), aiterm: aitermFor('claude') }
  const cursorAiterm = aitermFor('cursor')
  const cursorMcp = { ...jsonSeat(url => ({ url, headers: { [SEAT_HEADER]: `\${env:${SEAT_VARIABLE}}` } })), aiterm: { ...cursorAiterm, env: { ...cursorAitermEnv, ...cursorAiterm.env } } }
  // Codexのアカウントに入っているプラグインは、席ごとにMCPを起こす。
  // build-ios-apps の `npx xcodebuildmcp` はXcodeの無い環境では使えない。
  // openai-developers の `openai-api-key-local-confirmation` はAPIキー設定の確認フォームで、人のいない席では答えられない。
  // 同じ名前の無効なMCPをこの設定に置いて起動させない。
  // アカウントのプラグインは外さない（外すと、同じアカウントのMacからも消える）。
  const codexUnusableMcp = platform === 'darwin' ? '' : UNUSABLE_CODEX_MCPS.map(header => `\n${header}\ncommand = "true"\nenabled = false\n`).join('')
  const codexProjects = [...bots.values()].map(bot => `\n[projects."${bot.project}"]\ntrust_level = "trusted"\n`).join('')
  await Promise.all([
    writeCodexConfig(join(home, '.codex/config.toml'), bots, `approval_policy = "never"\nsandbox_mode = "danger-full-access"\n\n${codexMcp}${codexUnusableMcp}${codexProjects}`),
    writeGrokConfig(join(home, '.grok/config.toml'), `[ui]\npermission_mode = "always-approve"\n\n${grokMcp}`),
    mergeMcpConfig(join(home, '.claude.json'), claudeMcp, [...bots.values()].map(bot => bot.project)),
    mergeMcpConfig(join(home, '.cursor/mcp.json'), cursorMcp),
  ])
}

// 親配送を引き取る判定（aiterm-delivery-wake）がある親の種類。Grokの親には親配送が無い。
const AITERM_WAKE_PARENTS = ['codex', 'claude', 'cursor']

// Aitermの本体を、MCPを使う時だけ起こす中継ごしにする登録。使っていない席では本体（実占有 約45MB）が起きず、中継（約4MB）だけが残る。
// - 記録（初期化と道具の一覧の控え）はCLIの種類ごとに分ける。Aitermの一覧は席の環境で変わらないので、同じ種類の席は共有する。
// - 本体は一度起きたら席が終わるまで保つ（開いた端末と配送を持つので、途中で止めない）。
// - 本体が眠っている間は、終了した席の親配送を引き取る者が居ない。Aitermの判定が「引き取る配送がある」と答えた時に、中継が本体を起こす。
// 席を閉じる時の数え方は、Aiterm（0.51.0から）が中継の直接の子を数えない取り決めに依る。
function relayedAiterm(relay, server, harness, home) {
  const wake = AITERM_WAKE_PARENTS.includes(harness)
    ? { MCP_LAZY_WAKE_COMMAND: JSON.stringify([server.command, join(dirname(server.args[0]), 'delivery-wake-cli.js'), '--parent', harness]), MCP_LAZY_WAKE_INTERVAL: '30s' }
    : {}
  return {
    command: relay,
    args: [server.command, ...server.args],
    env: { MCP_LAZY_CACHE_DIR: join(home, '.cache/mcp-lazy', `aiterm-${harness}`), MCP_LAZY_IDLE_STOP: '0', ...wake },
  }
}

async function writeCodexConfig(path, bots, managedConfig) {
  let current = ''
  try {
    current = await readFile(path, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  const projects = [...bots.values()].map(bot => bot.project)
  const projectRoots = new Set(projects.map(project => dirname(project)))
  const { preamble, sections } = splitToml(current)
  const preservedPreamble = preamble.split(/\r?\n/u)
    .filter(line => !/^\s*(approval_policy|sandbox_mode)\s*=/u.test(line))
    .join('\n')
    .trim()
  const preservedSections = sections.filter(section => {
    const header = section.match(/^\s*(\[[^\n]+\])/u)?.[1]
    if (UNUSABLE_CODEX_MCPS.includes(header) || isManagedMcpSection(header)) return false
    const project = header?.match(/^\[projects\."([^"]+)"\]$/u)?.[1]
    return !project || (!projects.includes(project) && !projectRoots.has(dirname(project)))
  }).map(section => section.trim()).filter(Boolean)
  const next = [preservedPreamble, managedConfig.trim(), ...preservedSections].filter(Boolean).join('\n\n') + '\n'
  if (next !== current) await writeFile(path, next, { mode: 0o600 })
}

// GrokはBellTeam管理節だけを書き直し、Botが登録した他のMCPと残りの節を保持する。
async function writeGrokConfig(path, managedConfig) {
  let current = ''
  try {
    current = await readFile(path, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const { sections } = splitToml(current)
  const preservedSections = sections.filter(section => {
    const header = section.match(/^\s*(\[[^\n]+\])/u)?.[1]
    if (header === '[ui]') return false
    return !isManagedMcpSection(header)
  }).map(section => section.trim()).filter(Boolean)
  const next = [managedConfig.trim(), ...preservedSections].filter(Boolean).join('\n\n') + '\n'
  if (next !== current) await writeFile(path, next, { mode: 0o600 })
}

// BellTeamが書き直すMCPの節と、その下の表（headers・envなど）。
// 下の表を残すと、ほかの道具が設定を書き直した後に同じ表が二重になり、CLIが設定全体を読めなくなる。
const MANAGED_MCP_IDS = ['bellteam', 'aiterm', 'call-bridge']
function isManagedMcpSection(header) {
  return MANAGED_MCP_IDS.some(id => header === `[mcp_servers.${id}]` || header?.startsWith(`[mcp_servers.${id}.`))
}

function splitToml(text) {
  const preamble = []
  const sections = []
  let current = null
  for (const line of text.split(/\r?\n/u)) {
    if (/^\s*\[[^\n]+\]\s*$/u.test(line)) {
      current = [line]
      sections.push(current)
    } else if (current) {
      current.push(line)
    } else {
      preamble.push(line)
    }
  }
  return {
    preamble: preamble.join('\n'),
    sections: sections.map(section => section.join('\n')),
  }
}

// Claude Codeは初めて開くフォルダで信頼確認の画面を出し、Botの起動がそこで止まる。
// Codexの[projects]と同じく、BellTeamが所有するBotのフォルダは信頼済みとして書く。
async function mergeMcpConfig(path, servers, trustedProjects = []) {
  let current = {}
  try {
    current = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const projects = { ...(current.projects ?? {}) }
  for (const project of trustedProjects) projects[project] = { ...(projects[project] ?? {}), hasTrustDialogAccepted: true }
  await writeFile(path, `${JSON.stringify({
    ...current,
    mcpServers: { ...Object.fromEntries(Object.entries(current.mcpServers ?? {}).filter(([id]) => !['bellteam', 'aiterm', 'call-bridge'].includes(id))), ...servers },
    ...(trustedProjects.length ? { projects } : {}),
  }, null, 2)}\n`, { mode: 0o600 })
}
