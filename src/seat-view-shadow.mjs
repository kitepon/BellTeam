// a532b2 stage 3 (docs/architecture/modules/execution/seat-view-shadow.md): the generic turn / own_work of `pty_list` rows
// (Aiterm >= 0.70.108, argument `include`) compared with Aiterm's seat_turns rows from the same call. Read-only: no
// state, no delivery and no Owner message depends on it; a failure here only counts as unavailable.
const FIELDS = ['turn', 'own_work', 'unread']
const SAME_TURN = ['state', 'turn_id', 'started_at', 'interim_from']
const SAME_OWN = ['processes', 'excluded', 'child_results', 'tasks', 'exclusions_digest', 'oldest', 'task']
const EVERY_MS = 60_000
const SUMMARY_MS = 600_000

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const pick = (value, names) => value && typeof value === 'object' ? Object.fromEntries(names.map(name => [name, value[name] ?? null])) : null

// rows: seat_turns rows, unread: its unread session list, sessions: `sessions[]` of the same pty_list call.
// Returns [{session, harness, field}] for every field that differs; a seat missing from sessions[] is not compared.
export function seatViewDifferences({ rows, unread = [], sessions }) {
  const generic = new Map(sessions.filter(row => row?.session_id).map(row => [row.session_id, row]))
  const unreadSet = new Set(unread), found = []
  for (const row of rows) {
    const other = generic.get(row?.session_id)
    if (!other || !Object.hasOwn(other, 'turn')) continue
    const harness = row.harness ?? other.harness ?? null
    const miss = field => found.push({ session: row.session_id, harness, field })
    // unread = Aiterm did not read the seat; the generic read says so with turn null.
    if (unreadSet.has(row.session_id)) { if (other.turn !== null) miss('unread'); continue }
    if (!same(pick(row.turn, SAME_TURN), pick(other.turn, SAME_TURN))) miss('turn')
    if (Object.hasOwn(other, 'own_work') && !same(pick(row.own_work, SAME_OWN), pick(other.own_work, SAME_OWN))) miss('own_work')
  }
  return found
}

export class SeatViewShadow {
  constructor({ report = message => process.stderr.write(`${message}\n`), now = Date.now } = {}) {
    this.report = report
    this.now = now
    this.counts = Object.fromEntries(FIELDS.map(field => [field, { compared: 0, differed: 0 }]))
    this.unavailable = 0
    this.reported = new Map()
    this.summarized = -Infinity
  }

  // data = result._meta['aiterm/seat_turns'], result = the pty_list result of the same call.
  compare(data, result) {
    const sessions = result?.structuredContent?.sessions
    if (!Array.isArray(sessions) || !Array.isArray(data?.seats) || !sessions.some(row => row && Object.hasOwn(row, 'turn'))) { this.unavailable++; this.summary(); return }
    const rows = data.seats.filter(row => row?.session_id)
    const unread = Array.isArray(data.unread) ? data.unread : []
    this.counts.turn.compared += rows.length
    this.counts.own_work.compared += rows.length
    this.counts.unread.compared += unread.length
    for (const { session, harness, field } of seatViewDifferences({ rows, unread, sessions })) {
      this.counts[field].differed++
      const key = `${session}:${field}`, last = this.reported.get(key) ?? -Infinity
      if (this.now() - last < EVERY_MS) continue
      this.reported.set(key, this.now())
      this.report(`BellTeam seat view shadow: SEAT_VIEW_SHADOW_DIFF field=${field} harness=${harness} session=${session}`)
    }
    this.summary()
  }

  // The body log is the only sink (diagnostics has no code for this): a day without difference lines is only evidence if the
  // summary lines show the compared counts, so one line every ten minutes carries the running totals.
  summary() {
    if (this.now() - this.summarized < SUMMARY_MS) return
    this.summarized = this.now()
    const c = this.counts
    this.report(`BellTeam seat view shadow: SEAT_VIEW_SHADOW_SUMMARY turn=${c.turn.differed}/${c.turn.compared} own_work=${c.own_work.differed}/${c.own_work.compared} unread=${c.unread.differed}/${c.unread.compared} unavailable=${this.unavailable} (differed/compared)`)
  }
}
