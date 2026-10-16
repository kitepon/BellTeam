import { readdir, readFile, readlink } from 'node:fs/promises'

const except = process.argv[2]
if (!/^bot-[a-zA-Z0-9_-]+$/u.test(except ?? '')) throw new Error('DEPLOY_QUIET_BOT_REQUIRED')
const queue = await fetch('http://127.0.0.1:4181/api/queue', { signal: AbortSignal.timeout(5000) })
if (!queue.ok) throw new Error('DEPLOY_QUIET_QUEUE_UNAVAILABLE')
const { items } = await queue.json()
if (!Array.isArray(items)) throw new Error('DEPLOY_QUIET_QUEUE_INVALID')
const blocked = new Set(items.filter(item => item.botId !== except).map(item => item.botId ?? 'unknown'))
let unknown = 0
for (const pid of (await readdir('/proc')).filter(pid => /^\d+$/u.test(pid))) {
  try {
    const cwd = await readlink(`/proc/${pid}/cwd`)
    const botId = cwd.match(/^\/srv\/bellteam\/bots\/(bot-[^/]+)(?:\/|$)/u)?.[1]
    if (!botId || botId === except) continue
    const command = (await readFile(`/proc/${pid}/cmdline`)).toString().split('\0').slice(0, 2).join(' ')
    const exe = await readlink(`/proc/${pid}/exe`)
    if (/codex|claude|grok|cursor-agent/u.test(`${exe} ${command}`)) blocked.add(botId)
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ESRCH') unknown += 1
  }
}
// idleのCLIも保留する保守的な判定。CLIを閉じたり入力したりはしない。
console.log(JSON.stringify({ at: new Date().toISOString(), except, otherBotCliOrQueued: [...blocked].sort(), unknown }))
if (blocked.size || unknown) process.exitCode = 2
