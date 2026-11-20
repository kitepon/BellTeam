// a471 (execution machine-stream.md): ONE reader per machine seat relays Aiterm's stream_read lines to conversation, unchanged.
// Execution routes and interprets nothing; conversation stores the events and owns the cursor.
const WAIT_MS = 30_000, MAX_LINES = 1000, BACKOFF_FIRST_MS = 2000, BACKOFF_MAX_MS = 30_000
const codeOf = error => error?.code ?? error?.aitermErrorCode ?? /^(?:aiterm: )?([A-Z][A-Z0-9_]+):/u.exec(String(error?.message ?? ''))?.[1]

export class MachineStreamReaders {
  // client.call('stream_read', ...); port = { cursor(botId), ingest(envelope) } from conversation (null = no relay, the seat just keeps its stream).
  // current(session): the launch record still names this session as a machine seat. gone(session): Aiterm says the seat does not exist (the reader's self-exit).
  constructor({ client, port = null, current = () => true, gone = async () => false, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    Object.assign(this, { client, port, current, gone, sleep })
    this.readers = new Map()
  }

  start(bot, session) {
    if (!this.port || this.readers.has(session)) return
    const reader = { stopped: false }
    this.readers.set(session, reader)
    this.#run(bot.id, session, reader).catch(error => process.stderr.write(`BellTeam machine stream: ${session}: ${error?.stack ?? error}\n`))
      .finally(() => { if (this.readers.get(session) === reader) this.readers.delete(session) })
  }

  // chat-from-stream: conversation draws this seat's words from the stream, so execution need not relay them (only while a reader runs; a fork or a TUI seat has none).
  displays(session) { return this.port?.displayFromStream === true && this.readers.has(session) }

  stop(session) { const reader = this.readers.get(session); if (reader) reader.stopped = true }

  async #run(botId, session, reader) {
    let cursor = null, sentState = null, delay = 0
    try { const saved = await this.port.cursor(botId); if (saved?.session === session && typeof saved.cursor === 'string') cursor = saved.cursor } catch {}
    while (!reader.stopped && await this.current(session)) {
      let read
      try {
        read = (await this.client.call('stream_read', { session_id: session, ...(cursor ? { cursor } : {}), max_lines: MAX_LINES, wait_ms: WAIT_MS })).structuredContent
        if (!Array.isArray(read?.lines) || typeof read.cursor !== 'string') throw new Error('STREAM_READ_INVALID')
        const state = JSON.stringify(read.state ?? null)
        if (read.lines.length || state !== sentState) {
          const answer = await this.port.ingest({ botId, session, launch_id: read.launch_id, cursor_from: cursor, cursor_after: read.cursor, lines: read.lines, state: read.state })
          if (answer?.status === 'resync') { cursor = answer.cursor ?? null; await this.sleep(BACKOFF_FIRST_MS); continue }
          if (answer?.status !== 'stored') throw new Error('SEAT_STREAM_INGEST_INVALID')
          sentState = state
        }
        // A previous launch stays readable after a wake or restart (its launch_id differs from current_launch_id): once it is drained, read the current launch from its start.
        const old = read.current_launch_id && read.current_launch_id !== read.launch_id
        cursor = old && read.at_end ? null : read.cursor
        delay = 0
        if (read.state?.state === 'exited' && !old) return
      } catch (error) {
        // The launch's files are gone (seat closed): the cursor is stale, start over at the current launch.
        if (codeOf(error) === 'STREAM_CURSOR_STALE') { cursor = null; continue }
        // A seat that was launched before the stream tools (screen-based machine host) has no stream: nothing to read until its next launch starts a reader.
        if (codeOf(error) === 'STREAM_UNSUPPORTED') return
        if (!delay) process.stderr.write(`BellTeam machine stream: ${session}: ${codeOf(error) ?? error?.message}\n`)
        if (await this.gone(session).catch(() => false)) return
        delay = Math.min(BACKOFF_MAX_MS, delay ? delay * 2 : BACKOFF_FIRST_MS)
        await this.sleep(delay)
        continue
      }
    }
  }
}
