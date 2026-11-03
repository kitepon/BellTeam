import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const ID = /^[a-z0-9][a-z0-9-]{0,127}$/u
const FILE = /^[a-z0-9][a-z0-9-]{0,127}\.(png|jpg|webp|gif)$/u
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
const fail = code => { throw Object.assign(new Error(code), { code }) }
const ownerValid = owner => typeof owner === 'string' && ID.test(owner)
const botValid = bot => ownerValid(bot) && bot !== 'user'

// The factory is assembled once with the parent's fixed root, never with caller paths.
export function createConversationAssetReader({ root }) {
  return async function openConversationAsset(owner, file) {
    if (!ownerValid(owner) || typeof file !== 'string' || !FILE.test(file)) fail('IMAGE_ASSET_INVALID')
    const directory = owner === 'user' ? join(root, 'owner/messages/assets')
      : join(root, 'state/bots', owner, 'messages/assets')
    let handle
    try {
      handle = await open(join(directory, file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const info = await handle.stat()
      if (!info.isFile() || info.size > 25 * 1024 * 1024) fail('IMAGE_ASSET_INVALID')
      // Auto-close on EOF, error or stream.destroy() after HTTP disconnect.
      const stream = handle.createReadStream({ autoClose: true })
      return { mime: MIME[file.slice(file.lastIndexOf('.') + 1)], size: info.size, stream }
    } catch (error) {
      await handle?.close().catch(() => {})
      if (error.code === 'ENOENT') fail('IMAGE_ASSET_NOT_FOUND')
      if (error.code === 'ELOOP') fail('IMAGE_ASSET_INVALID')
      throw error
    }
  }
}

export function createConversationAssetGate({ readRemovalStates, assertContext }) {
  if (typeof readRemovalStates !== 'function' || typeof assertContext !== 'function') fail('IMAGE_GATE_INVALID')
  const removals = new Map(), saves = new Map(), leases = new WeakMap()
  let restored = false
  const ready = Promise.resolve().then(async () => {
    const state = await readRemovalStates()
    if (!Array.isArray(state?.removals)) fail('IMAGE_REMOVAL_STATE_INVALID')
    const ids = new Set()
    for (const removal of state.removals) {
      if (!botValid(removal?.botId) || ids.has(removal.botId) || typeof removal.active !== 'boolean'
        || removal.hasIntent !== true || typeof removal.retired !== 'boolean' || removal.active && removal.retired)
        fail('IMAGE_REMOVAL_STATE_INVALID')
      ids.add(removal.botId)
    }
    for (const id of ids) removals.set(id, { lease: randomUUID() })
    restored = true
  })
  ready.catch(() => {})
  const stateOf = lease => {
    const state = leases.get(lease)
    if (!state || state.ended) fail('IMAGE_SAVE_LEASE_INVALID')
    return state
  }
  const finish = state => {
    if (!state.finishing || state.pending.size || state.ended) return
    state.ended = true
    const group = saves.get(state.owner)
    group.delete(state)
    if (!group.size) saves.delete(state.owner)
    state.resolve()
  }
  const beginSave = async (owner, context) => {
    if (!ownerValid(owner)) fail('IMAGE_ASSET_INVALID')
    assertContext(context)
    if (owner !== 'user') await ready
    assertContext(context)
    if (owner !== 'user' && removals.has(owner)) fail('IMAGE_BOT_REMOVAL_PENDING')
    const lease = Object.freeze({}), state = { owner, context, pending: new Set(), finishing: false, ended: false }
    state.completion = new Promise(resolve => { state.resolve = resolve })
    leases.set(lease, state)
    const group = saves.get(owner) ?? new Set(); saves.set(owner, group); group.add(state)
    return lease
  }
  const trackCompletion = (lease, actual) => {
    const state = stateOf(lease)
    if (!actual || typeof actual.then !== 'function') fail('IMAGE_SAVE_COMPLETION_INVALID')
    if (state.pending.has(actual)) return
    state.pending.add(actual)
    const ended = () => { state.pending.delete(actual); finish(state) }
    void Promise.resolve(actual).then(ended, ended)
  }
  const endSave = lease => {
    const state = stateOf(lease)
    state.finishing = true; finish(state)
    return state.completion
  }
  return { initialize: () => ready, beginSave, trackCompletion, endSave,
    assertSave(lease, owner, context) {
      assertContext(context)
      const state = stateOf(lease)
      if (state.owner !== owner || state.context !== context) fail('IMAGE_SAVE_LEASE_INVALID')
    },
    async prepareBotAssetRemoval(botId, context) {
      if (!botValid(botId)) fail('IMAGE_ASSET_INVALID')
      assertContext(context)
      await ready
      assertContext(context)
      if (!removals.has(botId)) removals.set(botId, { lease: randomUUID() })
      const gate = removals.get(botId)
      await Promise.all([...(saves.get(botId) ?? [])].map(state => state.completion))
      return gate.lease
    },
    cancelBotAssetRemoval(botId, lease, state, context) {
      if (!botValid(botId)) fail('IMAGE_ASSET_INVALID')
      assertContext(context)
      const gate = removals.get(botId)
      if (!restored || !gate || gate.lease !== lease || state?.active !== true
        || state.hasIntent !== false || state.retired !== false) return false
      removals.delete(botId); return true
    },
  }
}
