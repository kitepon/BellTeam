import { readdir, readFile, readlink } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const botIdPattern = /^bot-[a-zA-Z0-9_-]+$/u

// processは席を見つけるためだけに使う。待機CLIを作業中とはしない。
export async function readDeploySeats({ proc = '/proc', root = '/srv/bellteam/bots', except } = {}) {
  const ids = new Set()
  let unknown = 0
  for (const pid of (await readdir(proc)).filter(pid => /^\d+$/u.test(pid))) {
    try {
      const cwd = await readlink(`${proc}/${pid}/cwd`)
      if (!cwd.startsWith(`${root}/`)) continue
      const botId = cwd.slice(root.length + 1).split('/')[0]
      if (!botIdPattern.test(botId) || botId === except) continue
      const command = (await readFile(`${proc}/${pid}/cmdline`)).toString().split('\0').slice(0, 2).join(' ')
      const exe = await readlink(`${proc}/${pid}/exe`)
      if (/codex|claude|grok|cursor-agent/u.test(`${exe} ${command}`)) ids.add(botId)
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') unknown += 1
    }
  }
  const seats = []
  for (const botId of ids) {
    try {
      const profile = JSON.parse(await readFile(`${root}/${botId}/bot.json`, 'utf8'))
      if (profile.id !== botId || typeof profile.session !== 'string' || !profile.session.trim()) throw new Error('INVALID_SEAT')
      seats.push({ botId, session: profile.session })
    } catch {
      seats.push({ botId, session: null })
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
export async function collectDeployTurns(transport, seats, { signal } = {}) {
  const turns = await transport.seatTurns() ?? new Map()
  for (const { session } of seats) {
    if (signal?.aborted) throw new Error('DEPLOY_QUIET_TURNS_UNAVAILABLE')
    if (!session || ['idle', 'running'].includes(turns.get(session)?.state)) continue
    try {
      const observed = await transport.observe({ session })
      if (observed?.exists === true && observed.state === 'idle' && observed.reason === 'composer_ready'
        && observed.activity?.post_startup_process_count === 0 && observed.pending_child_deliveries === 0)
        turns.set(session, { state: 'idle' })
      else if (observed?.exists === true && observed.state === 'busy') turns.set(session, { state: 'running' })
      else turns.set(session, null)
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
  const after = await fetchQueue()
  if (!Array.isArray(before) || !Array.isArray(after)) throw new Error('DEPLOY_QUIET_QUEUE_INVALID')
  return assessDeployQuiet({ except, items: [...before, ...after], seats, turns, unknown })
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
