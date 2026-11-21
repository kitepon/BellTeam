// execution/seat-oom-bias: a seat that is in a turn is a later memory-pressure victim than a quiet one (a472m). Best effort only.
// seat-exec starts every seat-side process at oom_score_adj 1000; while a turn runs this lowers the seat's process tree to 500
// and puts it back to 1000 when the seat is quiet. The body stays at 0. See docs/architecture/modules/runtime/execution.md.

export const IDLE_ADJ = 1000
export const WORKING_ADJ = 500
export const REFRESH_MS = 60_000

// Runs as the seat user through the parent's seat runner (`node -e`: the module payload is not readable by seat UID 1000).
// argv: session, value. A process belongs to the seat when its command line has `<session>` as a whole argument (aiterm-wait-cli
// --session) or `/<session>.` inside a path (claude-machine-host --stream-file); its descendants follow. Only values this feature
// owns (500/1000) are rewritten, so the body-side Aiterm server (0) and anything else is never touched. Prints one JSON line.
export const OOM_BIAS_SCRIPT = `
const fs = require('fs'), [session, value] = process.argv.slice(1), mine = new Set(['500', '1000'])
if (!/^[A-Za-z0-9._-]+$/.test(session) || !mine.has(value)) { console.log(JSON.stringify({ set: 0, error: 'argument' })); process.exit(0) }
const info = new Map()
for (const name of fs.readdirSync('/proc')) {
  if (!/^\\d+$/.test(name)) continue
  try {
    const command = fs.readFileSync('/proc/' + name + '/cmdline', 'latin1'), stat = fs.readFileSync('/proc/' + name + '/stat', 'latin1')
    info.set(Number(name), { ppid: Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]),
      hit: command.includes('\\0' + session + '\\0') || command.includes('/' + session + '.') })
  } catch {}
}
const seat = new Set([...info].filter(([, item]) => item.hit).map(([pid]) => pid))
for (let grew = true; grew;) { grew = false; for (const [pid, item] of info) if (!seat.has(pid) && seat.has(item.ppid)) { seat.add(pid); grew = true } }
let set = 0
for (const pid of seat) {
  try {
    const file = '/proc/' + pid + '/oom_score_adj', current = fs.readFileSync(file, 'utf8').trim()
    if (mine.has(current) && current !== value) { fs.writeFileSync(file, value + '\\n'); set++ }
  } catch {}
}
console.log(JSON.stringify({ set }))
`

export class SeatOomBias {
  // activity: SeatActivity (idle(botId), watch(listener)); run: ({ executable, args }) => Promise, the parent's seat runner.
  constructor({ activity, bots, session, run, now = () => Date.now(), refreshMs = REFRESH_MS, report = () => {} }) {
    Object.assign(this, { activity, bots, session, run, now, refreshMs, report })
    this.states = new Map()
    this.unwatch = null
  }

  start() {
    this.unwatch = this.activity.watch(change => this.sync(change))
    return () => { this.unwatch?.(); this.unwatch = null }
  }

  sync(change) {
    // The registry is only guaranteed to list its Bots (values()), like IdleSessions and SeatTurns use it.
    const ids = change?.all ? null : new Set(change?.botIds ?? [])
    for (const bot of [...this.bots.values()]) if (!ids || ids.has(bot.id)) this.update(bot)
  }

  // Acts on a change of the seat's state, and again at most every refreshMs while it works (a relaunched seat starts at 1000).
  update(bot) {
    const state = this.states.get(bot.id) ?? { adj: IDLE_ADJ, at: 0, running: false, want: IDLE_ADJ }
    this.states.set(bot.id, state)
    state.want = this.activity.idle(bot.id) ? IDLE_ADJ : WORKING_ADJ
    if (state.want === state.adj && !(state.want === WORKING_ADJ && this.now() - state.at >= this.refreshMs)) return
    if (!state.running) void this.apply(bot, state)
  }

  async apply(bot, state) {
    state.running = true
    try {
      while (state.want !== state.adj || state.want === WORKING_ADJ && this.now() - state.at >= this.refreshMs) {
        const value = state.want
        try { await this.run({ executable: process.execPath, args: ['-e', OOM_BIAS_SCRIPT, this.session(bot), String(value)] }, null) }
        catch (error) { this.report(`BellTeam seat oom bias: ${bot.id} ${error?.code ?? error?.message ?? 'failed'}`); return }
        state.adj = value
        state.at = this.now()
      }
    } finally { state.running = false }
  }
}
