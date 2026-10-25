import { fileURLToPath } from 'node:url'
import { createSeatProcessRunner } from './seat-process.mjs'
import { readImageBytes } from './message-assets.mjs'

export const SEAT_PROJECT_METHODS = ['ensureRoot', 'claim', 'initialize', 'remove', 'writeInstructions', 'prepareStartupContext', 'appendInstructions']
export const SEAT_MEMORY_METHODS = ['initialize', 'remember', 'reviseMemory', 'pinMemory', 'consolidateGrowth', 'recallMemory', 'recordKnowledge', 'searchKnowledge', 'rebuildKnowledgeIndex']
const projects = bots => [...bots.values()].map(({ id, project }) => ({ id, project }))

// Short-lived seat operations. No server environment or configuration document
// is sent to the child; each request supplies only its operation's inputs.
export class SeatRuntime {
  constructor({ root, home, run = createSeatProcessRunner(root, { environment: 'base' }) }) {
    this.root = root
    this.home = home
    this.run = run
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
    return this.call('configure-harnesses', { profiles: projects(bots), aiterm,
      callBridge: { enabled: callBridge.enabled } })
  }

  aitermRegistration() {
    return this.call('aiterm-registration', {})
  }

  writeHarnessConfig(bots, aiterm, callBridge) {
    return this.call('write-harness-config', { profiles: projects(bots), aiterm,
      callBridge: { enabled: callBridge.enabled } })
  }

  writeInstructions(home, instructions) {
    return this.call('global-instructions', { home, instructions })
  }

  removeClaudeCopies(bots) {
    return this.call('remove-claude-copies', { profiles: projects(bots) })
  }

  throughlineChanged() {
    let previous = null
    return async () => {
      const signature = JSON.stringify(await this.call('throughline-signature', {}))
      const changed = signature !== previous
      previous = signature
      return changed
    }
  }

  memory(registry) {
    return Object.fromEntries(SEAT_MEMORY_METHODS.map(method => [method, args =>
      this.call('memory', { method, args, profiles: projects(registry) })]))
  }

  async readImage(image, maxBytes) {
    if (typeof image?.path !== 'string') return readImageBytes(image, maxBytes)
    const value = await this.call('read-image', { image, maxBytes }, { maxBuffer: Math.ceil(maxBytes * 1.5) + 65536 })
    return Buffer.from(value.data, 'base64')
  }
}
