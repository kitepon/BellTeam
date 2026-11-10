// Per-launch credential for a remote seat's LAN MCP (remote-seat-ingress.md).
// Only sha256 of the token is saved; the token lives in an opaque ref until the private launch channel reveals it.
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { writeAtomic } from './json-file.mjs'

const SESSION = /^[a-z0-9][a-z0-9-]{0,63}$/u
const hash = token => createHash('sha256').update(token).digest('hex')
const invalid = () => Object.assign(new Error('SEAT_CREDENTIAL_INVALID'), { code: 'SEAT_CREDENTIAL_INVALID', status: 400 })

export function createSeatCredentials({ path }) {
  const tokens = new WeakMap()
  let state = null
  let queue = Promise.resolve()
  const load = async () => {
    if (state) return state
    try { state = JSON.parse(await readFile(path, 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error; state = { version: 1, seats: {} } }
    return state
  }
  // One writer: a failed save keeps the previous file and in-memory state.
  const change = mutate => {
    const run = queue.then(async () => {
      const current = await load()
      const next = { version: 1, seats: { ...current.seats } }
      mutate(next.seats)
      await writeAtomic(path, next)
      state = next
    })
    queue = run.catch(() => {})
    return run
  }
  return Object.freeze({
    // kind 'fork' marks a read-only fork seat (remote-seat-ingress.md SK03); older rows without kind are main.
    async issue({ botId, sessionName, terminalId, kind = 'main' }) {
      if (![botId, sessionName, terminalId].every(value => typeof value === 'string' && SESSION.test(value))) throw invalid()
      if (kind !== 'main' && kind !== 'fork') throw invalid()
      const token = randomBytes(32).toString('base64url')
      await change(seats => { seats[sessionName] = { hash: hash(token), botId, terminalId, ...(kind === 'fork' ? { kind } : {}), issuedAt: new Date().toISOString() } })
      const ref = Object.freeze({ toJSON: () => '[seat credential]', toString: () => '[seat credential]' })
      tokens.set(ref, token)
      return ref
    },
    revoke({ sessionName }) {
      if (typeof sessionName !== 'string') throw invalid()
      return change(seats => { delete seats[sessionName] })
    },
    reveal(ref) {
      const token = tokens.get(ref)
      if (!token) throw invalid()
      return token
    },
    // Authorization header -> {botId, sessionName, terminalId, kind} or null.
    async verify(header) {
      const token = typeof header === 'string' ? /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(header)?.[1] : null
      if (!token) return null
      const digest = hash(token)
      const entry = Object.entries((await load()).seats).find(([, seat]) => seat.hash === digest)
      return entry ? { sessionName: entry[0], botId: entry[1].botId, terminalId: entry[1].terminalId, kind: entry[1].kind ?? 'main' } : null
    },
  })
}
