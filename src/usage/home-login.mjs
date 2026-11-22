// a485: the usage child's side of the login-billing home part (vendored, development release 0.16.0).
// One durable document (the library's fileHomeStore: atomic, 0600); every call that can change the set returns the new `homeLogin` row.
// The child has no timer and no stderr: the body drives `sweep` and prints the setup code (docs/architecture/modules/usage/app-sessions.md).
import { createHomePart, createHomeHandler, fileHomeStore } from './vendor/login-billing-home.mjs'

export const HOME_KINDS = Object.freeze(['apple', 'windows', 'linux', 'android'])
const ID22 = /^[A-Za-z0-9_-]{22}$/u
const ADDRESS_ACTIONS = new Set(['list', 'add', 'remove'])

export function createHomeLogin({ path, operator, fetch, now }) {
  const part = createHomePart({ operator, store: fileHomeStore(path), fetch, now, cannotJudgeMs: 'no limit', kinds: [...HOME_KINDS] })
  const handler = createHomeHandler(part)
  let published = null

  /** The row the body keeps: the guard's set and the per-session entitlement state. Only a changed row is returned. */
  async function changedRow() {
    const status = await part.status()
    const { hashes } = part.publishedSet()
    const states = Object.fromEntries(Object.values(hashes).map(id => [id, part.entitlement({ sessionId: id }).state]))
    const row = { v: 1, bound: status.bound, enforced: status.enforced, hashes, states }
    const text = JSON.stringify(row)
    if (text === published) return undefined
    published = text
    return row
  }
  const withRow = async value => ({ ...value, row: await changedRow() })

  return {
    /** The wire (docs/home-wire-v1.md). `bearer` is the Authorization header value only; nothing else of the request crosses. */
    async handle({ method, path: wirePath, bearer, body, peer }) {
      const headers = bearer ? { authorization: bearer } : {}
      const answer = await handler({ method, path: wirePath, headers, body, peer })
      // Contract 1.22: a proof that presented the setup code right but did not bind spent it; the host must be shown a new one.
      return withRow({ status: answer.status, headers: answer.headers, body: answer.body, ...(answer.events?.some(event => event.type === 'setup.needed') ? { setupNeeded: true } : {}) })
    },
    /** The product's timer (about once a minute). used / streaming are session ids the body saw in use. */
    async sweep({ used = [], streaming = [] } = {}) {
      await part.sweep({ used, streaming })
      return withRow({})
    },
    /** The row at start or after a usage exchange: always returned (the body has none yet). */
    async publish() {
      published = null
      return withRow({})
    },
    async setupCode() {
      const { code, expiresAt } = await part.setupCode()
      return { code, expiresAt, bound: (await part.status()).bound }
    },
    async status() { return part.status() },
    /** The host console (bellteam-console): never over HTTP. */
    async console({ op, id, action, address }) {
      switch (op) {
        case 'setup-code': return this.setupCode()
        case 'issue': return part.consoleIssue()
        case 'list': return withRow({ sessions: await part.sessions(), addresses: await part.addresses() })
        case 'revoke': {
          if (typeof id !== 'string' || !ID22.test(id)) throw Object.assign(new Error('LOGIN_INPUT_INVALID'), { code: 'LOGIN_INPUT_INVALID' })
          await part.consoleRevoke(id)
          return withRow({ ended: id })
        }
        case 'reset-owner': await part.resetOwner(); return withRow({ reset: true })
        case 'addresses': {
          if (!ADDRESS_ACTIONS.has(action)) throw Object.assign(new Error('LOGIN_INPUT_INVALID'), { code: 'LOGIN_INPUT_INVALID' })
          const addresses = action === 'add' ? await part.addAddress(address) : action === 'remove' ? await part.removeAddress(String(address)) : await part.addresses()
          return withRow({ addresses })
        }
        default: throw Object.assign(new Error('LOGIN_INPUT_INVALID'), { code: 'LOGIN_INPUT_INVALID' })
      }
    },
  }
}
