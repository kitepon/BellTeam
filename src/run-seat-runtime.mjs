// Executed by the fixed seat entry, after all UID/GID slots have changed.
import { isAbsolute, join } from 'node:path'
import { stat } from 'node:fs/promises'
import { ProjectFiles } from './project-files.mjs'
import { SEAT_PROJECT_METHODS, SEAT_MEMORY_METHODS } from './seat-runtime.mjs'
import { BellTeamMemory } from './memory-service.mjs'
import { configureHarnesses, writeHarnessConfig } from './harness-config.mjs'
import { writeGlobalInstructions } from './global-instructions.mjs'
import { removeSeatClaudeCopies } from './bot-environment.mjs'
import { readImageBytes } from './message-assets.mjs'
import { aitermExecutionRegistration } from './aiterm-hooks.mjs'
import { CharacterSheets } from './character-sheets.mjs'

async function operate(request) {
  const bots = new Map((request.profiles ?? []).map(bot => [bot.id, bot]))
  switch (request.action) {
    case 'aiterm-registration':
      return aitermExecutionRegistration()
    case 'project': {
      const projects = new ProjectFiles()
      if (!SEAT_PROJECT_METHODS.includes(request.method))
        throw new Error('SEAT_PROJECT_OPERATION_INVALID')
      return projects[request.method](...request.args)
    }
    case 'configure-harnesses':
      return configureHarnesses(bots, request.home, { aiterm: async () => request.aiterm, callBridge: request.callBridge })
    case 'write-harness-config':
      return writeHarnessConfig(bots, request.home, { aiterm: async () => request.aiterm, callBridge: request.callBridge })
    case 'global-instructions':
      return writeGlobalInstructions(request.home, request.instructions)
    case 'remove-claude-copies':
      return removeSeatClaudeCopies(bots)
    case 'throughline-signature':
      return Promise.all(['throughline.db', 'throughline.db-wal'].map(async name => {
        try { return (await stat(join(request.home, '.throughline', name))).mtimeMs }
        catch (error) { if (error.code === 'ENOENT') return 0; throw error }
      }))
    case 'memory': {
      if (!SEAT_MEMORY_METHODS.includes(request.method)) throw new Error('SEAT_MEMORY_OPERATION_INVALID')
      const memory = new BellTeamMemory({ registry: bots, root: request.root })
      return memory[request.method](request.args)
    }
    case 'read-image':
      return { data: (await readImageBytes(request.image, request.maxBytes)).toString('base64') }
    case 'character-sheet-list':
      if (!isAbsolute(request.project)) throw new Error('SEAT_RUNTIME_ARGUMENTS')
      return new CharacterSheets({ projectPath: () => request.project }).list(null)
    default: throw new Error('SEAT_RUNTIME_OPERATION_INVALID')
  }
}

try {
  if (process.getuid() !== 1000 || process.geteuid() !== 1000 || process.getgid() !== 1000)
    throw new Error('SEAT_RUNTIME_IDENTITY')
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const request = JSON.parse(Buffer.concat(chunks).toString())
  if (!isAbsolute(request.root) || !isAbsolute(request.home) || request.root !== process.cwd())
    throw new Error('SEAT_RUNTIME_ARGUMENTS')
  let response
  try { response = { result: await operate(request) ?? null } }
  catch (error) {
    response = { error: Object.fromEntries(['name', 'message', 'code', 'status'].filter(key => error[key] !== undefined).map(key => [key, error[key]])) }
  }
  process.stdout.write(JSON.stringify(response))
} catch {
  process.stderr.write('BELLTEAM_SEAT_RUNTIME_FAILED\n')
  process.exitCode = 1
}
