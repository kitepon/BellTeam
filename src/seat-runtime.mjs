import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createSeatProcessRunner } from './seat-process.mjs'
import { readImageBytes } from './message-assets.mjs'
import { createSeatStreamRunner } from './seat-stream.mjs'
import { validateMembersProjectRequest } from './members-project-files.mjs'
import { createMemoryProcess } from './memory-process.mjs'

export const SEAT_PROJECT_METHODS = ['ensureRoot', 'claim', 'initialize', 'remove', 'writeInstructions', 'prepareStartupContext', 'appendInstructions']
export const SEAT_MEMORY_METHODS = ['initialize', 'ensureScope', 'remember', 'reviseMemory', 'pinMemory', 'consolidateGrowth', 'recallMemory', 'recordKnowledge', 'searchKnowledge', 'rebuildKnowledgeIndex']
const projects = bots => [...bots.values()].map(({ id, project }) => ({ id, project }))

// Short-lived seat operations. No server environment or configuration document
// is sent to the child; each request supplies only its operation's inputs.
export class SeatRuntime {
  #harnessConfiguration = Promise.resolve()

  constructor({ root, home, run = createSeatProcessRunner(root, { environment: 'base' }),
    stream = createSeatStreamRunner(root, { environment: 'base' }), onModuleRestartLimit }) {
    this.root = root
    this.home = home
    this.run = run
    this.stream = stream
    this.memoryModule = createMemoryProcess({ root, run, onModuleRestartLimit })
    this.projectFiles = Object.fromEntries(SEAT_PROJECT_METHODS.map(method =>
      [method, (...args) => this.call('project', { method, args })]))
  }

  async call(action, input, options = {}) {
    const { stdout } = await this.run(process.execPath,
      [fileURLToPath(new URL('./run-seat-runtime.mjs', import.meta.url))], {
        input: JSON.stringify({ action, root: this.root, home: this.home, ...input }),
        ...options,
      })
    const response = JSON.parse(stdout)
    if (response.error) throw Object.assign(new Error(response.error.message), response.error)
    return response.result
  }

  configureHarnesses(bots, aiterm, callBridge) {
    return this.#configureHarnesses('configure-harnesses', bots, aiterm, callBridge)
  }

  aitermRegistration() {
    return this.call('aiterm-registration', {})
  }

  writeHarnessConfig(bots, aiterm, callBridge) {
    return this.#configureHarnesses('write-harness-config', bots, aiterm, callBridge)
  }

  #configureHarnesses(action, bots, aiterm, callBridge) {
    // Bootstrap and feature changes share this owner, including all child hook writers.
    const pending = this.#harnessConfiguration.then(() => this.call(action, {
      profiles: projects(bots), aiterm, callBridge: { enabled: callBridge.enabled },
    }))
    this.#harnessConfiguration = pending.catch(() => {})
    return pending
  }

  writeInstructions(home, instructions) {
    return this.call('global-instructions', { home, instructions })
  }

  membersProject(operation, params) {
    validateMembersProjectRequest(operation, params)
    return this.call('members-project', { operation, params }, { maxBuffer: 16 * 1024 * 1024 + 64 * 1024 })
  }

  configureMembersHarnesses(readBotIds, aiterm, callBridge) {
    const pending = this.#harnessConfiguration.then(async () => {
      const botIds = await readBotIds()
      if (!Array.isArray(botIds) || new Set(botIds).size !== botIds.length
        || botIds.some(id => typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(id)))
        throw Object.assign(new Error('MEMBERS_PROJECT_INVALID'), { code: 'MEMBERS_PROJECT_INVALID' })
      return this.call('configure-harnesses', { profiles: botIds.map(id => ({ id, project: join(this.root, 'bots', id) })),
        aiterm, callBridge: { enabled: Boolean(callBridge().enabled) } })
    })
    this.#harnessConfiguration = pending.catch(() => {})
    return pending
  }

  migrateThroughlineStorage() {
    return this.call('throughline-storage', {})
  }

  removeClaudeCopies(bots) {
    return this.call('remove-claude-copies', { profiles: projects(bots) })
  }

  memory(registry) {
    return this.memoryModule.memory(registry)
  }

  async readImage(image, maxBytes) {
    if (typeof image?.path !== 'string') return readImageBytes(image, maxBytes)
    const value = await this.call('read-image', { image, maxBytes }, { maxBuffer: Math.ceil(maxBytes * 1.5) + 65536 })
    return Buffer.from(value.data, 'base64')
  }

  writeTemporaryImage(path, bytes) {
    return this.call('write-image', { path, data: bytes.toString('base64') })
  }

  removeTemporaryImage(path) {
    return this.call('remove-image', { path })
  }

  characterSheets(projectPath) {
    return {
      list: botId => this.call('character-sheet-list', { project: projectPath(botId) }),
      open: (botId, file, options) => this.stream(process.execPath,
        [fileURLToPath(new URL('./run-seat-character-sheet.mjs', import.meta.url))], { project: projectPath(botId), file }, options),
    }
  }
}
