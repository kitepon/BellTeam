import { readdir, readFile, readlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const botIdPattern = /^bot-[a-zA-Z0-9_-]+$/u
const exec = promisify(execFile)
const nodeExe = '/usr/local/bin/node'
const relayExe = '/usr/local/bin/mcp-lazy'
const aitermScript = '/usr/local/lib/node_modules/aiterm-mcp/dist/index.js'
const approvalRoot = '/home/bell/.approval-box/runtime/0.1.26/'
const codexExe = '/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex'
const codexHelperExe = `${codexExe}-code-mode-host`
const mcpCommands = [[nodeExe, aitermScript], [nodeExe, `${approvalRoot}cli.mjs`, 'mcp']]

// 全PIDの親と開始tickだけを読む。argv/environ/画面/認証fileは一覧に含めない。
export async function readProcTable(proc = '/proc') {
  const rows = new Map()
  for (const pid of (await readdir(proc)).filter(pid => /^\d+$/u.test(pid))) {
    const stat = await readFile(`${proc}/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u)
    if (fields.length < 20 || !/^\d+$/u.test(fields[19])) throw new Error('DEPLOY_PROCESS_UNKNOWN')
    rows.set(Number(pid), { pid: Number(pid), ppid: Number(fields[1]), pgid: Number(fields[2]),
      start: fields[19], state: fields[0] })
  }
  return rows
}

export function processDescendants(table, pid) {
  if (!table.has(pid)) throw new Error('DEPLOY_PROCESS_UNKNOWN')
  const ids = new Set([pid])
  for (let changed = true; changed;) {
    changed = false
    for (const row of table.values()) if (!ids.has(row.pid) && ids.has(row.ppid)) {
      ids.add(row.pid)
      changed = true
    }
  }
  return [...ids].sort((a, b) => a - b).map(id => table.get(id))
}

export async function readProcTree(table, pid, proc = '/proc') {
  return Promise.all(processDescendants(table, pid).map(async row => {
    const exe = await readlink(`${proc}/${row.pid}/exe`)
    // CLI本体のargv（初手を含み得る）は読まない。未知exeのargvも不要。
    const argv = row.pid !== pid && [nodeExe, relayExe, codexHelperExe].includes(exe)
      ? (await readFile(`${proc}/${row.pid}/cmdline`)).toString().split('\0') : null
    if (argv?.at(-1) === '') argv.pop()
    return { ...row, exe, argv, ...(row.pid === pid ? { cwd: await readlink(`${proc}/${pid}/cwd`) } : {}) }
  }))
}

const sameArgs = (a, b) => Array.isArray(a) && a.length === b.length && a.every((value, i) => value === b[i])

export function trustedIdleTree(rows, pid, harness, botId, project = `/srv/bellteam/bots/${botId}`) {
  const byPid = new Map(rows.map(row => [row.pid, row]))
  const root = byPid.get(pid)
  const rootExe = harness === 'claude-code' ? '/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
    : harness === 'grok-cli' ? '/usr/local/bin/grok' : harness === 'codex-cli' ? nodeExe : null
  if (!rootExe || root?.exe !== rootExe || root.cwd !== project) return false
  // 孤立行、重複PID、cycleを許さず、渡された全行がrootの子孫であることを確認する。
  if (byPid.size !== rows.length || byPid.has(root.ppid) || processDescendants(byPid, pid).length !== rows.length) return false
  // Codexの登録identityはnode入口。実CLIはその唯一の固定native子で、MCPの直接親はこちら。
  const nativeCli = harness === 'codex-cli' ? rows.filter(row => row.ppid === pid && row.exe === codexExe) : []
  if (harness === 'codex-cli' && nativeCli.length !== 1) return false
  const cliPid = nativeCli[0]?.pid ?? pid
  const relays = new Map()
  for (const row of rows) {
    if (!Number.isSafeInteger(row.pid) || !Number.isSafeInteger(row.ppid) || !/^\d+$/u.test(row.start)
      || !/^[RSDI]$/u.test(row.state)) return false
    if (row.pid === pid) continue
    const parent = byPid.get(row.ppid)
    if (!parent || !/^\d+$/u.test(parent.start) || BigInt(parent.start) > BigInt(row.start)) return false
    if (row.exe === relayExe && row.ppid === cliPid && mcpCommands.some(args => sameArgs(row.argv, [relayExe, ...args])))
      relays.set(row.pid, row.argv.slice(1))
  }
  for (const row of rows) {
    if (row.pid === pid || row.pid === cliPid || relays.has(row.pid)) continue
    // Aiterm既存定義でもCLI本体に含む固定補助。子作業はこの後の全行検査へ残す。
    if (harness === 'codex-cli' && row.ppid === cliPid && row.exe === codexHelperExe && sameArgs(row.argv, [codexHelperExe])) continue
    if (row.exe === nodeExe && relays.has(row.ppid) && sameArgs(row.argv, relays.get(row.ppid))) continue
    if (harness === 'claude-code' && row.ppid === pid && row.exe === nodeExe
      && sameArgs(row.argv, [nodeExe, `${approvalRoot}approval-box-claude-hook.mjs`])) continue
    return false
  }
  return true
}

const idleObservation = value => value?.exists === true && value.state === 'idle'
  && value.reason === 'composer_ready' && value.pending_child_deliveries === 0
const observationIdentity = value => JSON.stringify([value.launch_id, value.harness, value.harness_process])
// stateは単なるS/R遷移で変わるため同一性から除く。停止/ZはtrustedIdleTreeで止める。
const treeIdentity = rows => JSON.stringify(rows.map(({ state, ...row }) => row))

async function readStartIdentity(pid) {
  const { stdout } = await exec('/bin/ps', ['-o', 'pid=,lstart=', '-p', String(pid)], {
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' }, timeout: 2000,
  })
  const match = /^\s*(\d+)\s+(.+?)\s*$/u.exec(stdout)
  if (Number(match?.[1]) !== pid) throw new Error('DEPLOY_PROCESS_UNKNOWN')
  return match[2]
}

// B案：計数値に依存せず、全子孫と親を調べる。前後の別観測を同一receiptとは呼ばない。
export async function confirmDeployIdle(transport, seat, { signal, readTable = readProcTable,
  readTree = readProcTree, readStart = readStartIdentity } = {}) {
  const check = () => { if (signal?.aborted) throw new Error('DEPLOY_QUIET_TURNS_UNAVAILABLE') }
  check()
  const before = await readTable()
  check()
  const observed = await transport.observe({ session: seat.session })
  if (observed?.exists === true && observed.state === 'busy') return { state: 'running' }
  if (!idleObservation(observed)) return null
  const native = observed.harness_process
  if (!Number.isSafeInteger(native?.pid) || native.pid < 1 || typeof native.started_identity !== 'string'
    || !native.started_identity || !/^[a-f0-9]{64}$/u.test(native.argv_digest ?? '')
    || typeof observed.launch_id !== 'string' || !observed.launch_id) return null
  const initial = before.get(native.pid)
  if (!initial || initial.pgid !== native.process_group_id) return null
  check()
  if (await readStart(native.pid) !== native.started_identity) return null
  check()
  const first = await readTree(before, native.pid)
  if (!trustedIdleTree(first, native.pid, observed.harness, seat.botId, seat.project)) return null
  // 同じBotフォルダの別CLI/別nodeを登録rootへ勝手に畳まない。
  if (!Array.isArray(seat.candidates) || seat.candidates.some(candidate => !first.some(row =>
    row.pid === candidate.pid && row.ppid === candidate.ppid && row.start === candidate.start && row.exe === candidate.exe))) return null
  check()
  const second = await readTree(await readTable(), native.pid)
  if (!trustedIdleTree(second, native.pid, observed.harness, seat.botId, seat.project) || treeIdentity(first) !== treeIdentity(second)) return null
  check()
  const after = await transport.observe({ session: seat.session })
  if (after?.exists === true && after.state === 'busy') return { state: 'running' }
  if (!idleObservation(after) || observationIdentity(observed) !== observationIdentity(after)) return null
  check()
  const final = await readTree(await readTable(), native.pid)
  if (!trustedIdleTree(final, native.pid, observed.harness, seat.botId, seat.project) || treeIdentity(first) !== treeIdentity(final)) return null
  return { state: 'idle' }
}

// processは席を見つけるためだけに使う。待機CLIを作業中とはしない。
export async function readDeploySeats({ proc = '/proc', root = '/srv/bellteam/bots', except } = {}) {
  const candidates = new Map()
  let unknown = 0
  for (const pid of (await readdir(proc)).filter(pid => /^\d+$/u.test(pid))) {
    try {
      const cwd = await readlink(`${proc}/${pid}/cwd`)
      if (!cwd.startsWith(`${root}/`)) continue
      const botId = cwd.slice(root.length + 1).split('/')[0]
      if (!botIdPattern.test(botId) || botId === except) continue
      const exe = await readlink(`${proc}/${pid}/exe`)
      // argvを読まず、既知CLI名とnode/MCPを候補として保持する。未知の別rootは保留する。
      if (/codex|claude|grok|cursor-agent|mcp-lazy/u.test(exe) || exe === nodeExe) {
        const stat = await readFile(`${proc}/${pid}/stat`, 'utf8')
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u)
        if (fields.length < 20 || !/^\d+$/u.test(fields[19]) || !/^\d+$/u.test(fields[1])) throw new Error('INVALID_PROCESS')
        if (!candidates.has(botId)) candidates.set(botId, [])
        candidates.get(botId).push({ pid: Number(pid), ppid: Number(fields[1]), start: fields[19], exe })
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') unknown += 1
    }
  }
  const seats = []
  for (const [botId, processes] of candidates) {
    try {
      const profile = JSON.parse(await readFile(`${root}/${botId}/bot.json`, 'utf8'))
      if (profile.id !== botId || typeof profile.session !== 'string' || !profile.session.trim()) throw new Error('INVALID_SEAT')
      seats.push({ botId, session: profile.session, project: `${root}/${botId}`, candidates: processes })
    } catch {
      seats.push({ botId, session: null, project: `${root}/${botId}`, candidates: processes })
    }
  }
  return { seats, unknown }
}

export function assessDeployQuiet({ except, items, seats, turns, unknown = 0 }) {
  if (!botIdPattern.test(except ?? '')) throw new Error('DEPLOY_QUIET_BOT_REQUIRED')
  if (!Array.isArray(items)) throw new Error('DEPLOY_QUIET_QUEUE_INVALID')
  const queued = new Set(), running = new Set(), unclassified = new Set()
  for (const item of items) {
    if (!item || !botIdPattern.test(item.botId ?? '')) { unknown += 1; continue }
    if (item.botId !== except) queued.add(item.botId)
  }
  for (const { botId, session } of seats) {
    if (botId === except) continue
    const turn = session && turns instanceof Map ? turns.get(session) : null
    if (turn?.state === 'running') running.add(botId)
    else if (turn?.state !== 'idle') unclassified.add(botId)
  }
  const blocked = [...new Set([...queued, ...running, ...unclassified])].sort()
  return { except, otherBotCliOrQueued: blocked, queuedBots: [...queued].sort(),
    runningBots: [...running].sort(), unclassifiedBots: [...unclassified].sort(),
    unknown, quiet: blocked.length === 0 && unknown === 0 }
}

// seatTurns未対応のハーネスは、本体がidle観測にも使う構造化observeで確かめる。
export async function collectDeployTurns(transport, seats, { signal, confirmIdle = confirmDeployIdle } = {}) {
  const turns = await transport.seatTurns() ?? new Map()
  for (const { session } of seats) {
    if (signal?.aborted) throw new Error('DEPLOY_QUIET_TURNS_UNAVAILABLE')
    if (!session || turns.get(session)?.state === 'running') continue
    try {
      turns.set(session, await confirmIdle(transport, seats.find(seat => seat.session === session), { signal }))
    } catch { turns.set(session, null) }
  }
  return turns
}

// 本体の既存読取経路。起動/送信/終了は行わず、画面本文を取得/出力しない。
async function readTurns(seats) {
  const { AitermClient, AitermTransport } = await import('/app/src/aiterm-transport.mjs')
  const transport = new AitermTransport({ client: new AitermClient({ env: {
    HOME: '/home/bell', BELLTEAM_HOME: '/home/bell',
    PATH: '/home/bell/.local/bin:/usr/local/bin:/usr/bin:/bin',
  } }) })
  const stop = new AbortController()
  let timer
  try {
    return await Promise.race([collectDeployTurns(transport, seats, { signal: stop.signal }), new Promise((_, reject) => {
      timer = setTimeout(() => { stop.abort(); reject(new Error('DEPLOY_QUIET_TURNS_UNAVAILABLE')) }, 10000)
    })])
  } finally {
    stop.abort()
    clearTimeout(timer)
    await transport.close()
  }
}

export async function checkDeployQuiet({ except, fetchQueue, readSeats = readDeploySeats, readSeatTurns = readTurns }) {
  if (!botIdPattern.test(except ?? '')) throw new Error('DEPLOY_QUIET_BOT_REQUIRED')
  const before = await fetchQueue()
  const { seats, unknown } = await readSeats({ except })
  let turns = null
  // 読取失敗/未対応の席は保留する。queueの空だけではidleと決めない。
  if (seats.length) try { turns = await readSeatTurns(seats) } catch { /* 未分類として保留 */ }
  const final = await readSeats({ except })
  // 観測中に現れた別rootやPID再利用も、最後の候補探索で止める。
  const candidateKey = seat => JSON.stringify([seat.session, [...(seat.candidates ?? [])].sort((a, b) => a.pid - b.pid)])
  const byBot = new Map(final.seats.map(seat => [seat.botId, seat]))
  for (const seat of seats) {
    const after = byBot.get(seat.botId)
    if (!after || candidateKey(seat) !== candidateKey(after)) turns?.set(seat.session, null)
    byBot.delete(seat.botId)
  }
  seats.push(...byBot.values())
  for (const seat of byBot.values()) turns?.set(seat.session, null)
  const after = await fetchQueue()
  if (!Array.isArray(before) || !Array.isArray(after)) throw new Error('DEPLOY_QUIET_QUEUE_INVALID')
  return assessDeployQuiet({ except, items: [...before, ...after], seats, turns, unknown: unknown + final.unknown })
}

async function main() {
  try {
    const result = await checkDeployQuiet({ except: process.argv[2], fetchQueue: async () => {
      const response = await fetch('http://127.0.0.1:4181/api/queue', { signal: AbortSignal.timeout(5000) })
      if (!response.ok) throw new Error('DEPLOY_QUIET_QUEUE_UNAVAILABLE')
      return (await response.json()).items
    } })
    console.log(JSON.stringify({ at: new Date().toISOString(), ...result }))
    if (!result.quiet) process.exitCode = 2
  } catch {
    // 例外本文/環境/プロフィールは出さず、読取失敗は止める。
    console.error('DEPLOY_QUIET_UNAVAILABLE')
    process.exitCode = 2
  }
}

if (process.argv[1] === '-' || (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) await main()
