// Registration and setup use Aiterm's public helpers; shared HOME remains SeatRuntime-owned.
import { access, constants } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { captureRuntime } from './runtime-selection.mjs'

export const MCP_LAZY_RELAY = '/usr/local/bin/mcp-lazy'
export const AITERM_DIST = '/usr/local/lib/node_modules/aiterm-mcp/dist'
const loadModule = path => import(pathToFileURL(path).href)
const providerFor = entry => createRequire(entry).resolve('aiterm-steer-delivery')

export async function aitermRelay({ path = MCP_LAZY_RELAY } = {}) {
  try { await access(path, constants.X_OK); return path } catch { return null }
}

// Match plain aiterm-setup so it preserves BellTeam's Codex/Grok timeout fields.
export async function aitermRegistration({ dist = AITERM_DIST, load = loadModule } = {}) {
  const { setupNodeExecutable } = await load(join(dist, 'setup-node.js'))
  return { command: setupNodeExecutable(), args: [join(dist, 'index.js')] }
}

// Persistent helpers stay image-owned across body recovery to previous-normal.
export async function aitermExecutionRegistration({ dist = AITERM_DIST, provider, load = loadModule, resolveProvider = providerFor } = {}) {
  const [{ setupNodeExecutable }, { localParentWorkerRuntime }] = await Promise.all([
    load(join(dist, 'setup-node.js')), load(join(dist, 'execution-parent-worker.js')),
  ])
  const scope = localParentWorkerRuntime.scope(), entry = join(dist, 'execution-native-server.js')
  return {
    command: setupNodeExecutable(),
    args: [entry, '--execution-interrupt', '--state-root', scope.state_root,
      '--socket', scope.multiplexer.key, '--steer-provider', provider ?? resolveProvider(entry)],
  }
}

// A live connection keeps its captured files; persistent registration remains image-owned.
export function aitermConnectionRegistration(registration, runtime, resolveProvider = providerFor) {
  const component = runtime.components['runtime-aiterm-mcp']
  const args = [...registration.args]
  if (args.includes('--execution-interrupt')) {
    args[0] = join(component.dist, 'execution-native-server.js')
    const provider = args.indexOf('--steer-provider')
    if (provider >= 0) args[provider + 1] = resolveProvider(args[0])
    return { command: registration.command, args }
  }
  if (registration.command === 'aiterm-mcp')
    return { command: component.origin === 'builtin' ? 'aiterm-mcp' : component.bin['aiterm-mcp'], args }
  return { ...registration, args }
}

export async function configureAitermHooks(home, { runtimeCapture, dist = AITERM_DIST, load = loadModule, codex, registration } = {}) {
  codex ??= (runtimeCapture ?? await captureRuntime()).components['runtime-codex'].bin.codex
  registration ??= await aitermRegistration({ dist, load })
  if (registration.args.includes('--execution-interrupt')) {
    const nativeDist = dirname(registration.args[0])
    const [{ configureNativeExecutionHooks }, { parseNativeExecutionArguments }] = await Promise.all([
      load(join(nativeDist, 'execution-native-setup.js')), load(join(nativeDist, 'execution-native-server.js')),
    ])
    const { expectedScope, providerFile } = parseNativeExecutionArguments(registration.args.slice(1))
    const { results } = await configureNativeExecutionHooks(home,
      { registration, expectedScope, providerFile, codexBinary: codex })
    return results
  }
  const { mergeClaudeParentHooks, mergeCursorParentHooks, ensureCodexParentSteer } = await load(join(dist, 'setup-integrations.js'))
  mergeClaudeParentHooks(join(home, '.claude/settings.json'), registration)
  mergeCursorParentHooks(join(home, '.cursor/hooks.json'), registration)
  if (!ensureCodexParentSteer) return { codex: null }
  return { codex: await ensureCodexParentSteer(home, { binary: codex }) }
}
