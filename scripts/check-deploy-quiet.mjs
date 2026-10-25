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
  const pids = (await readdir(proc)).filter(pid => /^\d+$/u.test(pid))
  // 採取の競合時間を短くする。欠測は飛ばさず、同じbatchの読取完了後に保留する。
  for (let offset = 0; offset < pids.length; offset += 32) {
    const batch = await Promise.allSettled(pids.slice(offset, offset + 32).map(async pid => {
      const stat = await readFile(`${proc}/${pid}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u)
      if (fields.length < 20 || !/^\d+$/u.test(fields[19])) throw new Error('DEPLOY_PROCESS_UNKNOWN')
      return { pid: Number(pid), ppid: Number(fields[1]), pgid: Number(fields[2]),
        start: fields[19], state: fields[0] }
    }))
    for (const result of batch) {
      if (result.status === 'rejected') throw result.reason
      rows.set(result.value.pid, result.value)
    }
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

export function trustedIdleTree(rows, pid, harness, botId, project = `/srv/bellteam/bots/${botId}`, nativeRegistration) {
  const byPid = new Map(rows.map(row => [row.pid, row]))
  const root = byPid.get(pid)
  // Bot環境で選ばれたNode wrapperも、唯一の公式native子を後段で検証する。
  const projectNode = root?.exe === `${project}/environment/node_modules/node/bin/node`
    || root?.exe?.startsWith(`${project}/environment/`)
      && /^node-v\d+\.\d+\.\d+\/bin\/node$/u.test(root.exe.slice(`${project}/environment/`.length))
  const rootExe = harness === 'claude-code' ? '/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
    : harness === 'grok-cli' ? '/usr/local/bin/grok' : harness === 'codex-cli'
      ? ([nodeExe, codexExe].includes(root?.exe) || projectNode) ? root.exe : null : null
  if (!rootExe || root?.exe !== rootExe || root.cwd !== project) return false
  // 孤立行、重複PID、cycleを許さず、渡された全行がrootの子孫であることを確認する。
  if (byPid.size !== rows.length || byPid.has(root.ppid) || processDescendants(byPid, pid).length !== rows.length) return false
  // 観測identityがnode入口なら唯一のnative子、native直起動ならそのrootがMCPの親になる。
  const wrapper = harness === 'codex-cli' && root.exe !== codexExe
  const nativeCli = wrapper ? rows.filter(row => row.ppid === pid && row.exe === codexExe) : []
  if (wrapper && nativeCli.length !== 1) return false
  const cliPid = nativeCli[0]?.pid ?? pid
  // 登録元が解決した同scopeの正規native入口だけを既存MCP一覧へ加える。
  const commands = nativeRegistration ? [...mcpCommands, [nativeRegistration.command, ...nativeRegistration.args]] : mcpCommands
  const relays = new Map()
  for (const row of rows) {
    if (!Number.isSafeInteger(row.pid) || !Number.isSafeInteger(row.ppid) || !/^\d+$/u.test(row.start)
      || !/^[RSDI]$/u.test(row.state)) return false
    if (row.pid === pid) continue
    const parent = byPid.get(row.ppid)
    if (!parent || !/^\d+$/u.test(parent.start) || BigInt(parent.start) > BigInt(row.start)) return false
    if (row.exe === relayExe && row.ppid === cliPid && commands.some(args => sameArgs(row.argv, [relayExe, ...args])))
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
  if (!trustedIdleTree(first, native.pid, observed.harness, seat.botId, seat.project, seat.nativeRegistration)) return null
  // 同じBotフォルダの別CLI/別nodeを登録rootへ勝手に畳まない。
  if (!Array.isArray(seat.candidates) || seat.candidates.some(candidate => !first.some(row =>
    row.pid === candidate.pid && row.ppid === candidate.ppid && row.start === candidate.start && row.exe === candidate.exe))) return null
  check()
  const second = await readTree(await readTable(), native.pid)
  if (!trustedIdleTree(second, native.pid, observed.harness, seat.botId, seat.project, seat.nativeRegistration) || treeIdentity(first) !== treeIdentity(second)) return null
  check()
  const after = await transport.observe({ session: seat.session })
  if (after?.exists === true && after.state === 'busy') return { state: 'running' }
  if (!idleObservation(after) || observationIdentity(observed) !== observationIdentity(after)) return null
  check()
  const final = await readTree(await readTable(), native.pid)
  if (!trustedIdleTree(final, native.pid, observed.harness, seat.botId, seat.project, seat.nativeRegistration) || treeIdentity(first) !== treeIdentity(final)) return null
  return { state: 'idle' }
}

// 診断は既に読んだ固定metadataだけから作る。診断先の失敗で判定を変えない。
function emitDeployTrace(emit, event) {
  if (typeof emit === 'function') try { emit(event) } catch { /* admission stays unchanged */ }
}
const identity = treeIdentity
const hooks = (rows, pid) => rows.filter(row => row.ppid === pid && row.exe === nodeExe
  && sameArgs(row.argv, [nodeExe, `${approvalRoot}approval-box-claude-hook.mjs`]))
const hookKey = (rows, pid) => JSON.stringify(hooks(rows, pid).map(row => [row.pid, row.start]).sort())
const idle = idleObservation
const validNative = o => Number.isSafeInteger(o?.harness_process?.pid) && o.harness_process.pid > 0
  && typeof o.harness_process.started_identity === 'string' && !!o.harness_process.started_identity
  && /^[a-f0-9]{64}$/u.test(o.harness_process.argv_digest ?? '') && typeof o.launch_id === 'string' && !!o.launch_id
const observationKey = observationIdentity

export function createTracedConfirm(api, emit, dependencies = {}) {
  const tableReader = dependencies.readTable ?? api.readProcTable
  const treeReader = dependencies.readTree ?? api.readProcTree
  const startReader = dependencies.readStart ?? readStartIdentity
  return async (transport, seat, {signal} = {}) => {
    const started = performance.now()
    let stage = 'BEGIN', tableIndex = 0, treeIndex = 0, observeIndex = 0
    let beforeTable, firstTree, firstObservation
    const stages = new Map()
    const log = (code, fields = {}) => {
      let reason
      if (code === 'READ_ERROR') reason = fields.stage.startsWith('TABLE_') && fields.proc_part === 'STAT'
        && ['ENOENT','ESRCH'].includes(fields.error_code) ? 'table_stat_missing'
        : fields.stage.startsWith('TREE_') && fields.proc_part === 'EXE'
          && ['ENOENT','ESRCH'].includes(fields.error_code) ? 'tree_exe_missing' : 'read_unavailable'
      if (code === 'RESULT' && fields.unclassified) {
        const last = stages.get(fields.stage) ?? {}
        reason = fields.stage.startsWith('TREE_') ? last.hook_identity_changed ? 'hook_changed'
          : !last.trusted ? 'tree_untrusted' : !last.candidates_covered ? 'candidate_coverage_missing' : 'tree_changed'
          : fields.stage === 'START_IDENTITY' ? 'start_identity_changed'
          : fields.stage.startsWith('OBSERVE_') ? !last.idle ? 'observe_not_idle'
            : !last.native_valid ? 'identity_unavailable' : !last.root_in_initial_table || !last.initial_group_matches
              ? 'root_identity_changed' : 'observation_changed' : 'unclassified'
      }
      stages.set(code, fields)
      emitDeployTrace(emit, {botId:seat.botId, name:seat.name ?? seat.botId, code,
        ms:Math.round(performance.now()-started), ...fields, ...(reason ? {reason} : {})})
    }
    const errorFields = error => {
      const allowed = ['ENOENT','ESRCH','EACCES','EPERM','IDENTITY_UNAVAILABLE']
      const match = /^\/proc\/(\d+)\/(stat|exe|cmdline|cwd)$/u.exec(error?.path ?? '')
      return {error_code:allowed.includes(error?.code) ? error.code : 'OTHER',
        proc_part:match ? match[2].toUpperCase() : 'UNKNOWN',
        missing_initial_candidate:!!match && (seat.candidates ?? []).some(row => row.pid === Number(match[1])),
        observed_root_known:!!firstObservation?.harness_process,
        missing_observed_root:!!match && firstObservation?.harness_process?.pid === Number(match[1])}
    }
    const observedTransport = {observe:async value => {
      stage = 'OBSERVE_' + (++observeIndex)
      const readAt = performance.now()
      try {
        const o = await transport.observe(value)
        if (observeIndex === 1) firstObservation = o
        const native = o?.harness_process
        log(stage, {read_ms:performance.now()-readAt, idle:idle(o), busy:o?.exists === true && o.state === 'busy',
          native_valid:validNative(o), root_in_initial_table:beforeTable?.has(native?.pid) ?? false,
          initial_group_matches:!!native && beforeTable?.get(native.pid)?.pgid === native.process_group_id,
          same_observation_as_first:observationKey(o ?? {}) === observationKey(firstObservation ?? {})})
        return o
      } catch (error) {log('READ_ERROR', {stage, read_ms:performance.now()-readAt, ...errorFields(error)}); throw error}
    }}
    const readTable = async () => {
      stage = 'TABLE_' + (++tableIndex)
      const readAt = performance.now()
      try {
        const value = await tableReader()
        if (tableIndex === 1) beforeTable = value
        log(stage, {read_ms:performance.now()-readAt, rows:value.size})
        return value
      } catch (error) {log('READ_ERROR', {stage, read_ms:performance.now()-readAt, ...errorFields(error)}); throw error}
    }
    const readStart = async pid => {
      stage = 'START_IDENTITY'
      const readAt = performance.now()
      try {
        const value = await startReader(pid)
        log(stage, {read_ms:performance.now()-readAt, matches_observation:value === firstObservation?.harness_process?.started_identity})
        return value
      } catch (error) {log('READ_ERROR', {stage, read_ms:performance.now()-readAt, ...errorFields(error)}); throw error}
    }
    const readTree = async (table, pid) => {
      stage = 'TREE_' + (++treeIndex)
      const readAt = performance.now()
      try {
        const rows = await treeReader(table, pid)
        if (treeIndex === 1) firstTree = rows
        log(stage, {read_ms:performance.now()-readAt, rows:rows.length,
          trusted:api.trustedIdleTree(rows,pid,firstObservation?.harness,seat.botId,seat.project,seat.nativeRegistration),
          candidates_covered:Array.isArray(seat.candidates) && seat.candidates.every(c => rows.some(r =>
            r.pid === c.pid && r.ppid === c.ppid && r.start === c.start && r.exe === c.exe)),
          tree_same_as_first:identity(rows) === identity(firstTree),
          hook_count:hooks(rows,pid).length,
          hook_identity_changed:hookKey(rows,pid) !== hookKey(firstTree,pid),
          direct_node_count:rows.filter(row => row.ppid === pid && row.exe === nodeExe).length})
        return rows
      } catch (error) {log('READ_ERROR', {stage, read_ms:performance.now()-readAt, ...errorFields(error)}); throw error}
    }
    try {
      const value = await api.confirmDeployIdle(observedTransport,seat,{signal,readTable,readTree,readStart})
      log('RESULT', {stage, idle:value?.state === 'idle', running:value?.state === 'running', unclassified:value === null})
      return value
    } catch (error) {
      log('THROWN', {stage, ...errorFields(error), aborted:signal?.aborted === true})
      throw error
    }
  }
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
      seats.push({ botId, ...(typeof profile.name === 'string' ? { name: profile.name } : {}), session: profile.session, project: `${root}/${botId}`, candidates: processes })
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
export async function collectDeployTurns(transport, seats, { signal, confirmIdle = confirmDeployIdle, trace } = {}) {
  const turns = await transport.seatTurns() ?? new Map()
  for (const { session } of seats) {
    if (signal?.aborted) throw new Error('DEPLOY_QUIET_TURNS_UNAVAILABLE')
    if (!session) continue
    const seat = seats.find(seat => seat.session === session)
    const reportRunning = () => emitDeployTrace(trace, {code:'ACTUAL_TURN', reason:'actual_turn', botId:seat.botId, name:seat.name ?? seat.botId})
    if (turns.get(session)?.state === 'running') { reportRunning(); continue }
    try {
      turns.set(session, await confirmIdle(transport, seat, { signal }))
      if (turns.get(session)?.state === 'running') reportRunning()
    } catch { turns.set(session, null); emitDeployTrace(trace, {code:'TURN_UNCLASSIFIED',botId:seat.botId,name:seat.name ?? seat.botId}) }
  }
  return turns
}

// 本体の既存読取経路。起動/送信/終了は行わず、画面本文を取得/出力しない。
async function readTurns(seats, { trace } = {}) {
  const { AitermClient, AitermTransport } = await import('/app/src/aiterm-transport.mjs')
  const { aitermExecutionRegistration } = await import('/app/src/aiterm-hooks.mjs')
  // descriptorの取得だけで、hook登録・manager作成・端末作用は行わない。
  const nativeRegistration = await aitermExecutionRegistration()
  const scopedSeats = seats.map(seat => ({ ...seat, nativeRegistration }))
  const transport = new AitermTransport({ client: new AitermClient({ env: {
    HOME: '/home/bell', BELLTEAM_HOME: '/home/bell',
    PATH: '/home/bell/.local/bin:/usr/local/bin:/usr/bin:/bin',
  } }) })
  const stop = new AbortController()
  let timer
  try {
    return await Promise.race([collectDeployTurns(transport, scopedSeats, { signal: stop.signal, trace,
      confirmIdle: typeof trace === 'function' ? createTracedConfirm({readProcTable,readProcTree,trustedIdleTree,confirmDeployIdle},trace) : confirmDeployIdle }), new Promise((_, reject) => {
      timer = setTimeout(() => { stop.abort(); emitDeployTrace(trace, {code:'TIMEOUT',reason:'timeout'}); reject(new Error('DEPLOY_QUIET_TURNS_UNAVAILABLE')) }, 10000)
    })])
  } finally {
    stop.abort()
    clearTimeout(timer)
    await transport.close()
  }
}

export async function checkDeployQuiet({ except, fetchQueue, trace, readSeats = readDeploySeats,
  readSeatTurns = seats => readTurns(seats, {trace}) }) {
  if (!botIdPattern.test(except ?? '')) throw new Error('DEPLOY_QUIET_BOT_REQUIRED')
  const before = await fetchQueue()
  const { seats, unknown } = await readSeats({ except })
  let turns = null
  // 読取失敗/未対応の席は保留する。queueの空だけではidleと決めない。
  if (seats.length) try { turns = await readSeatTurns(seats) } catch { emitDeployTrace(trace,{code:'TURNS_UNAVAILABLE',reason:'turns_unavailable'}) }
  const final = await readSeats({ except })
  // 観測中に現れた別rootやPID再利用も、最後の候補探索で止める。
  const candidateKey = seat => JSON.stringify([seat.session, [...(seat.candidates ?? [])].sort((a, b) => a.pid - b.pid)])
  const byBot = new Map(final.seats.map(seat => [seat.botId, seat]))
  for (const seat of seats) {
    const after = byBot.get(seat.botId)
    if (!after || candidateKey(seat) !== candidateKey(after)) {
      turns?.set(seat.session, null)
      emitDeployTrace(trace,{code:'CANDIDATES_CHANGED',reason:'candidate_changed',botId:seat.botId,name:seat.name ?? seat.botId})
    }
    byBot.delete(seat.botId)
  }
  seats.push(...byBot.values())
  for (const seat of byBot.values()) {
    turns?.set(seat.session, null)
    emitDeployTrace(trace,{code:'CANDIDATES_CHANGED',reason:'candidate_changed',botId:seat.botId,name:seat.name ?? seat.botId})
  }
  const after = await fetchQueue()
  if (!Array.isArray(before) || !Array.isArray(after)) throw new Error('DEPLOY_QUIET_QUEUE_INVALID')
  for (const [stage, items] of [['BEFORE',before],['AFTER',after]]) for (const item of items) {
    if (botIdPattern.test(item?.botId ?? '') && item.botId !== except) {
      const seat = seats.find(seat => seat.botId === item.botId)
      emitDeployTrace(trace,{code:'QUEUE',reason:'queue',stage,botId:item.botId,
        name:seat?.name ?? (typeof item.botName === 'string' ? item.botName : item.botId)})
    }
  }
  if (unknown + final.unknown) emitDeployTrace(trace,{code:'UNKNOWN_CANDIDATES',reason:'unknown_candidates',count:unknown + final.unknown})
  return assessDeployQuiet({ except, items: [...before, ...after], seats, turns, unknown: unknown + final.unknown })
}

async function main() {
  const diagnostics = []
  try {
    const result = await checkDeployQuiet({ except: process.argv[2], trace:event=>diagnostics.push(event), fetchQueue: async () => {
      const response = await fetch('http://127.0.0.1:4181/api/queue', { signal: AbortSignal.timeout(5000) })
      if (!response.ok) throw new Error('DEPLOY_QUIET_QUEUE_UNAVAILABLE')
      return (await response.json()).items
    } })
    console.log(JSON.stringify({ at: new Date().toISOString(), ...result, diagnostics }))
    if (!result.quiet) process.exitCode = 2
  } catch {
    // 例外本文/環境/プロフィールは出さず、読取失敗は止める。
    if (diagnostics.length) console.log(JSON.stringify({at:new Date().toISOString(),diagnostics}))
    console.error('DEPLOY_QUIET_UNAVAILABLE')
    process.exitCode = 2
  }
}

if (process.argv[1] === '-' || (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) await main()
